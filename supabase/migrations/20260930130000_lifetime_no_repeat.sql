-- Phase 3, P3c-1: lifetime no-repeat serving.
--
-- The design goal ("a hundred games, a hundred different questions"): once a
-- player has seen a question family, they should never see that family again
-- in any later game, season or group -- not just within the current season's
-- 7-day window. A family (questions.family_key) covers every near-duplicate
-- phrasing of the same fact, so excluding by family also suppresses the
-- template siblings that would give the answer away.
--
-- public.user_question_history is the lifetime ledger: one row per
-- (player, family), upserted on every serve. It is written only by the
-- serving function (security definer) and readable only by service_role;
-- players cannot mine it for which questions exist.
--
-- public.serving_events is the ops trail for pool exhaustion: whenever the
-- picker cannot honor the lifetime guarantee it records which fallback stage
-- served instead, so the coverage dashboards (P3b-3) can see exactly where
-- the question bank is running thin, per state, from real play.
--
-- pick_next_question gains one stage at the front of the LIVE chain
-- (transcribed from 20260810120500_exhaustion_fallback_tier.sql, which
-- carries the served_tier stamp and tier-aware fallbacks):
--   1. lifetime-fresh: family never served to this player, ever (new)
--   2. season-fresh:   not served to them this season in 7 days (old stage 1)
--   3. session-unseen: closest tier, least-used (old stage 2)
--   4. last resort:    repeat rather than strand the streak  (old stage 3)
-- Stages 2-4 log a serving_event; stage ordering inside each is unchanged.

create table public.user_question_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  family_key text not null,
  question_id uuid,
  first_served_at timestamptz not null default now(),
  last_served_at timestamptz not null default now(),
  times_served integer not null default 1,
  primary key (user_id, family_key)
);

alter table public.user_question_history enable row level security;
revoke all on table public.user_question_history from public, anon, authenticated;
grant all on table public.user_question_history to service_role;

create table public.serving_events (
  id bigint generated always as identity primary key,
  event text not null,
  user_id uuid,
  season_id uuid,
  territory_id text,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index serving_events_territory_idx on public.serving_events(territory_id, created_at);

alter table public.serving_events enable row level security;
revoke all on table public.serving_events from public, anon, authenticated;
grant all on table public.serving_events to service_role;

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
