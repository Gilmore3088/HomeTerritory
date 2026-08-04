-- Finding 20: when a territory's pool was exhausted for the player, the fallback
-- (`order by attempt_count asc, random()`) ignored both the 7-day exclusion and
-- the session tier, so it could re-serve the question the player had just
-- answered -- including inside the same attack streak, making the remaining
-- answers free.
--
-- The fallback now excludes anything this session already served. A last-resort
-- branch keeps the old behavior only when the territory has fewer active
-- questions than the streak needs answers: repeating is better than raising
-- mid-streak, which would roll back the answer the player just got right.

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
    abs(public.adaptive_tier(q.tier, q.attempt_count, q.correct_count) - v_session.tier),
    random()
  limit 1;

  -- Pool exhausted for this player. Fall back to the least-used question that
  -- this session has not already served, so a streak can never be handed the
  -- answer it just gave.
  if not found then
    select q.* into v_question
    from public.questions q
    where q.territory_id = v_session.territory_id and q.active
      and not exists (
        select 1 from public.question_attempts qa
        where qa.session_id = p_session_id and qa.question_id = q.id
      )
    order by q.attempt_count asc, random()
    limit 1;
  end if;

  -- Last resort: the territory has fewer active questions than this streak needs
  -- answers. Repeating beats stranding the player mid-streak with an error that
  -- would roll back the answer they just got right.
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

  v_tier := public.adaptive_tier(v_question.tier, v_question.attempt_count, v_question.correct_count);
  v_expires := now() + case when v_tier = 3 then interval '45 seconds' else interval '30 seconds' end;

  insert into public.question_attempts(session_id, question_id, user_id, expires_at)
  values (p_session_id, v_question.id, v_session.user_id, v_expires)
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
