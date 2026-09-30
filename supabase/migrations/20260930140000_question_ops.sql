-- Phase 3, P3b-3: operating the generated bank.
--
-- Four pieces, all service-role only, all called from the nightly ETL run
-- (etl/run.ts refresh-and-compile) or the SQL editor:
--   * question_coverage(): the state x tier x format map of the bank, with
--     7-day pool_thin counts, so "where are we thin" is one query.
--   * retire_flagged_questions(): telemetry gate. A generated question that
--     enough players have answered with a suspicious pass rate (leaked /
--     trivial, or broken / wrong) retires itself with a recorded reason.
--     Handwritten questions are never touched -- those belong to the
--     player-report flow (finding 9) and operator review.
--   * starter_bank_cutover(): once a state's generated coverage clears the
--     floor (default 500 active), the handwritten starter rows retire so
--     depth comes from the warehouse. Reversible per-question through
--     reactivate_question().
--   * Gate D canary weight, inside pick_next_question: a freshly generated
--     question (validation_status 'generated_v1', under 3 attempts) is
--     passed over 70% of the time when an equally suitable alternative
--     exists, so new compiles soak in gradually instead of flooding play.

alter table public.questions add column retired_reason text;
-- Gate C bookkeeping: when the advisory LLM reviewer (etl/gate-c.ts) last
-- looked at a generated question, so the nightly batch never re-reviews.
alter table public.questions add column gate_c_reviewed_at timestamptz;

create or replace function public.question_coverage()
returns table (
  territory_id text,
  tier integer,
  format text,
  generated_active bigint,
  handwritten_active bigint,
  families bigint,
  pool_thin_7d bigint
)
language sql
security definer
set search_path = public
as $$
  select t.id as territory_id,
         q.tier,
         q.format,
         count(*) filter (where q.template_id is not null) as generated_active,
         count(*) filter (where q.template_id is null) as handwritten_active,
         count(distinct q.family_key) as families,
         (select count(*) from public.serving_events se
           where se.territory_id = t.id
             and se.event = 'pool_thin'
             and se.created_at > now() - interval '7 days') as pool_thin_7d
  from public.territories t
  join public.questions q on q.territory_id = t.id and q.active
  group by t.id, q.tier, q.format
  order by t.id, q.tier, q.format;
$$;

revoke all on function public.question_coverage() from public, anon, authenticated;
grant execute on function public.question_coverage() to service_role;

create or replace function public.retire_flagged_questions(
  p_min_attempts integer default 25,
  p_too_easy numeric default 0.97,
  p_too_hard numeric default 0.05
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_easy integer;
  v_hard integer;
begin
  update public.questions q
  set active = false,
      retired_reason = 'telemetry_too_easy'
  where q.active
    and q.template_id is not null
    and q.attempt_count >= p_min_attempts
    and q.correct_count::numeric / q.attempt_count > p_too_easy;
  get diagnostics v_easy = row_count;

  update public.questions q
  set active = false,
      retired_reason = 'telemetry_too_hard'
  where q.active
    and q.template_id is not null
    and q.attempt_count >= p_min_attempts
    and q.correct_count::numeric / q.attempt_count < p_too_hard;
  get diagnostics v_hard = row_count;

  return jsonb_build_object('retired_too_easy', v_easy, 'retired_too_hard', v_hard);
end;
$$;

revoke all on function public.retire_flagged_questions(integer, numeric, numeric) from public, anon, authenticated;
grant execute on function public.retire_flagged_questions(integer, numeric, numeric) to service_role;

create or replace function public.starter_bank_cutover(p_floor integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_states text[];
  v_retired integer;
begin
  select coalesce(array_agg(territory_id), '{}') into v_states
  from (
    select q.territory_id
    from public.questions q
    where q.active and q.template_id is not null
    group by q.territory_id
    having count(*) >= p_floor
  ) ready
  where exists (
    select 1 from public.questions h
    where h.territory_id = ready.territory_id and h.active and h.template_id is null
  );

  update public.questions q
  set active = false,
      retired_reason = 'starter_cutover'
  where q.active
    and q.template_id is null
    and q.territory_id = any(v_states);
  get diagnostics v_retired = row_count;

  return jsonb_build_object('states_cut_over', v_states, 'starter_questions_retired', v_retired);
end;
$$;

revoke all on function public.starter_bank_cutover(integer) from public, anon, authenticated;
grant execute on function public.starter_bank_cutover(integer) to service_role;

-- Gate D: canary weight. Body transcribed from the LIVE definition
-- (20260930130000_lifetime_no_repeat.sql); the only change is one sort key
-- in stage 1 -- fallback stages stay maximally permissive on purpose.
create or replace function public.pick_next_question(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.game_sessions;
  v_question public.questions;
  v_attempt uuid;
  v_expires timestamptz;
  v_tier integer;
  v_sports text[];
  v_stage text := 'lifetime_fresh';
begin
  select gs.* into v_session from public.game_sessions gs where gs.id = p_session_id for update;
  if not found then raise exception 'Game session not found'; end if;

  select g.sports into v_sports
  from public.seasons s
  join public.groups g on g.id = s.group_id
  where s.id = v_session.season_id;

  -- Stage 1: the lifetime guarantee. Only families this player has never
  -- seen, in any season, plus the existing season-level 7-day shield.
  select q.* into v_question
  from public.questions q
  where q.territory_id = v_session.territory_id
    and q.active
    and not exists (
      select 1
      from public.user_question_history h
      where h.user_id = v_session.user_id
        and h.family_key = coalesce(q.family_key, q.id::text)
    )
    and not exists (
      select 1
      from public.season_question_seen sqs
      where sqs.season_id = v_session.season_id
        and sqs.question_id = q.id
        and sqs.served_to = v_session.user_id
        and sqs.served_at > now() - interval '7 days'
    )
  order by
    case when q.sport = any(v_sports) then 0 else 1 end,
    abs(public.adaptive_tier(q.tier, q.attempt_count, q.correct_count) - v_session.tier),
    -- Gate D: an untested generated question usually yields to an equally
    -- suitable alternative, so fresh compiles enter play as a trickle.
    case when q.validation_status = 'generated_v1'
           and q.attempt_count < 3
           and random() < 0.7
         then 1 else 0 end,
    random()
  limit 1;

  -- Stage 2: every family is exhausted for this player. Serve the least
  -- recently relevant thing the season shield still allows -- the old
  -- primary pool -- and leave a trail for the coverage dashboards.
  if not found then
    v_stage := 'season_fresh';
    select q.* into v_question
    from public.questions q
    where q.territory_id = v_session.territory_id
      and q.active
      and not exists (
        select 1
        from public.season_question_seen sqs
        where sqs.season_id = v_session.season_id
          and sqs.question_id = q.id
          and sqs.served_to = v_session.user_id
          and sqs.served_at > now() - interval '7 days'
      )
    order by
      case when q.sport = any(v_sports) then 0 else 1 end,
      abs(public.adaptive_tier(q.tier, q.attempt_count, q.correct_count) - v_session.tier),
      random()
    limit 1;
  end if;

  -- Stage 3: pool exhausted for this player this season. Fall back to the
  -- closest-tier, least-used question that this session has not already
  -- served, so a streak can never be handed the answer it just gave.
  if not found then
    v_stage := 'session_unseen';
    select q.* into v_question
    from public.questions q
    where q.territory_id = v_session.territory_id and q.active
      and not exists (
        select 1 from public.question_attempts qa
        where qa.session_id = p_session_id and qa.question_id = q.id
      )
    order by
      abs(public.adaptive_tier(q.tier, q.attempt_count, q.correct_count) - v_session.tier),
      q.attempt_count asc,
      random()
    limit 1;
  end if;

  -- Last resort: the territory has fewer active questions than this streak needs
  -- answers. Repeating beats stranding the player mid-streak with an error that
  -- would roll back the answer they just got right.
  if not found then
    v_stage := 'repeat';
    select q.* into v_question
    from public.questions q
    where q.territory_id = v_session.territory_id and q.active
    order by q.attempt_count asc, random()
    limit 1;
  end if;

  if not found then raise exception 'This state has no active questions'; end if;

  if v_stage <> 'lifetime_fresh' then
    insert into public.serving_events(event, user_id, season_id, territory_id, detail)
    values ('pool_thin', v_session.user_id, v_session.season_id, v_session.territory_id,
            jsonb_build_object('stage', v_stage, 'question_id', v_question.id));
  end if;

  insert into public.season_question_seen(season_id, question_id, served_to, served_at)
  values (v_session.season_id, v_question.id, v_session.user_id, now())
  on conflict (season_id, question_id, served_to)
  do update set served_at = excluded.served_at;

  insert into public.user_question_history(user_id, family_key, question_id)
  values (v_session.user_id, coalesce(v_question.family_key, v_question.id::text), v_question.id)
  on conflict (user_id, family_key)
  do update set
    last_served_at = now(),
    times_served = public.user_question_history.times_served + 1,
    question_id = excluded.question_id;

  v_tier := public.adaptive_tier(v_question.tier, v_question.attempt_count, v_question.correct_count);
  v_expires := now() + case when v_tier = 3 then interval '45 seconds' else interval '30 seconds' end;

  insert into public.question_attempts(session_id, question_id, user_id, expires_at, served_tier)
  values (p_session_id, v_question.id, v_session.user_id, v_expires, v_tier)
  returning id into v_attempt;

  update public.game_sessions set current_attempt_id = v_attempt where id = p_session_id;

  return jsonb_build_object(
    'attempt_id', v_attempt,
    'text', v_question.question_text,
    'format', v_question.format,
    'options', public.shuffle_options(v_question.options, v_attempt),
    'tier', v_tier,
    'sport', v_question.sport,
    'link_type', v_question.link_type,
    'expires_at', v_expires
  );
end;
$$;
