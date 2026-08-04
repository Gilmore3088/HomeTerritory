-- Finding 1: `pick_next_question` shuffled a question's options before returning
-- them, but `get_my_active_session` passed `questions.options` straight through.
-- Every seeded multiple-choice row stores the correct answer at index 0, and the
-- client re-reads the active session on every realtime event and on a 5s/20s
-- poll, so the live question's buttons re-ordered themselves with the answer
-- first within seconds of opening any question.
--
-- The shuffle now lives in one helper used by both call sites, seeded by the
-- attempt id. That removes the leak *and* makes the order stable for the life of
-- the attempt, so a poll can no longer re-order a question the player is
-- answering.

create or replace function public.shuffle_options(p_options jsonb, p_seed uuid)
returns jsonb
language sql
immutable
set search_path = public, pg_catalog
as $$
  select coalesce(jsonb_agg(value order by md5(p_seed::text || value)), '[]'::jsonb)
  from jsonb_array_elements_text(coalesce(p_options, '[]'::jsonb)) as value;
$$;

revoke all on function public.shuffle_options(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.shuffle_options(jsonb, uuid) to service_role;

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
  v_sports text[];
begin
  select gs.* into v_session from public.game_sessions gs where gs.id = p_session_id for update;
  if not found then raise exception 'Game session not found'; end if;

  select g.sports into v_sports
  from public.seasons s
  join public.groups g on g.id = s.group_id
  where s.id = v_session.season_id;

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
    abs(
      case
        when q.attempt_count >= 5 and q.correct_count::numeric / nullif(q.attempt_count, 0) >= .75 then 1
        when q.attempt_count >= 5 and q.correct_count::numeric / nullif(q.attempt_count, 0) < .45 then 3
        else q.tier
      end - v_session.tier
    ),
    random()
  limit 1;

  if not found then
    select q.* into v_question
    from public.questions q
    where q.territory_id = v_session.territory_id and q.active
    order by q.attempt_count asc, random()
    limit 1;
  end if;

  if not found then raise exception 'This state has no active questions'; end if;

  insert into public.season_question_seen(season_id, question_id, served_to, served_at)
  values (v_session.season_id, v_question.id, v_session.user_id, now())
  on conflict (season_id, question_id, served_to)
  do update set served_at = excluded.served_at;

  v_expires := now() + case when v_question.tier = 3 then interval '45 seconds' else interval '30 seconds' end;

  insert into public.question_attempts(session_id, question_id, user_id, expires_at)
  values (p_session_id, v_question.id, v_session.user_id, v_expires)
  returning id into v_attempt;

  update public.game_sessions set current_attempt_id = v_attempt where id = p_session_id;

  return jsonb_build_object(
    'attempt_id', v_attempt,
    'text', v_question.question_text,
    'format', v_question.format,
    'options', public.shuffle_options(v_question.options, v_attempt),
    'tier', v_question.tier,
    'sport', v_question.sport,
    'link_type', v_question.link_type,
    'expires_at', v_expires
  );
end;
$$;

create or replace function public.get_my_active_session(p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season uuid;
  v_session public.game_sessions;
  v_attempt public.question_attempts;
  v_question public.questions;
begin
  if not public.is_group_member(p_group_id, auth.uid()) then raise exception 'Group access denied'; end if;

  select id into v_season
  from public.seasons
  where group_id = p_group_id and status = 'active'
  order by created_at desc
  limit 1;
  if v_season is null then return null; end if;

  perform public.resolve_expired_sessions(v_season);

  select * into v_session
  from public.game_sessions
  where season_id = v_season and user_id = auth.uid() and status = 'active'
  order by created_at desc
  limit 1;
  if not found then return null; end if;

  select * into v_attempt from public.question_attempts where id = v_session.current_attempt_id and answered_at is null;
  if not found then return null; end if;

  select * into v_question from public.questions where id = v_attempt.question_id;

  return jsonb_build_object(
    'session_id', v_session.id,
    'action_type', v_session.action_type,
    'territory_id', v_session.territory_id,
    'required_correct', v_session.required_correct,
    'correct_count', v_session.correct_count,
    'question', jsonb_build_object(
      'attempt_id', v_attempt.id,
      'text', v_question.question_text,
      'format', v_question.format,
      'options', public.shuffle_options(v_question.options, v_attempt.id),
      'tier', v_question.tier,
      'sport', v_question.sport,
      'link_type', v_question.link_type,
      'expires_at', v_attempt.expires_at
    )
  );
end;
$$;
