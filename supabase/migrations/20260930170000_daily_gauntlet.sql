-- Phase 3, P3d task 5: the daily gauntlet.
--
-- One shared 5-pack per league per local day: every member faces the SAME
-- five questions -- the deliberate exception to lifetime uniqueness, because
-- comparing scores on an identical gauntlet is the fun. The pack
-- materializes lazily on the first request of the day (newest question per
-- sport first, so fresh compiles headline it), grading and timing are
-- entirely server-side, and finishing pays a bonus straight into the
-- season's cumulative score:
--     bonus = correct answers, +2 for a perfect 5.
-- It never touches daily_score_events -- that table's (season, user, day)
-- primary key belongs to advance_season's base scoring, and a gauntlet row
-- there would silently block it.
--
-- Gauntlet serves DO write user_question_history: once a player has seen an
-- answer here, territory play must never hand them that family again.

create table public.gauntlet_packs (
  season_id uuid not null references public.seasons(id) on delete cascade,
  played_on date not null,
  question_ids uuid[] not null,
  created_at timestamptz not null default now(),
  primary key (season_id, played_on)
);

create table public.gauntlet_runs (
  season_id uuid not null references public.seasons(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  played_on date not null,
  current_index integer not null default 0,
  served_at timestamptz,
  correct_count integer not null default 0,
  total_seconds numeric not null default 0,
  finished_at timestamptz,
  bonus_awarded integer,
  primary key (season_id, user_id, played_on)
);

alter table public.gauntlet_packs enable row level security;
alter table public.gauntlet_runs enable row level security;
revoke all on table public.gauntlet_packs, public.gauntlet_runs from public, anon, authenticated;
grant all on table public.gauntlet_packs, public.gauntlet_runs to service_role;

-- Today's gauntlet: the pack (materialized if needed), my run state, and
-- the league leaderboard for the day.
create or replace function public.gauntlet_today(p_season_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_season public.seasons;
  v_today date;
  v_pack public.gauntlet_packs;
  v_run public.gauntlet_runs;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_season from public.seasons where id = p_season_id and status = 'active';
  if not found then raise exception 'Active season not found'; end if;
  if not public.is_group_member(v_season.group_id, v_user) then raise exception 'You are not in this group'; end if;

  v_today := public.group_local_date(v_season.group_id);

  select * into v_pack from public.gauntlet_packs where season_id = p_season_id and played_on = v_today;
  if not found then
    -- Newest question of each sport first, then second-newest, so the pack
    -- leads with fresh material and still spreads across sports.
    insert into public.gauntlet_packs(season_id, played_on, question_ids)
    select p_season_id, v_today, coalesce(array_agg(id), '{}')
    from (
      select id from (
        select q.id, row_number() over (partition by q.sport order by q.created_at desc, q.id) as rn,
               q.created_at
        from public.questions q
        where q.active
      ) ranked
      order by rn, created_at desc, id
      limit 5
    ) picks
    on conflict (season_id, played_on) do nothing;
    select * into v_pack from public.gauntlet_packs where season_id = p_season_id and played_on = v_today;
  end if;

  select * into v_run from public.gauntlet_runs
  where season_id = p_season_id and user_id = v_user and played_on = v_today;

  return jsonb_build_object(
    'played_on', v_today,
    'size', coalesce(array_length(v_pack.question_ids, 1), 0),
    'my_run', case when v_run.user_id is null then null else jsonb_build_object(
      'current_index', v_run.current_index,
      'correct_count', v_run.correct_count,
      'total_seconds', round(v_run.total_seconds, 1),
      'finished', v_run.finished_at is not null,
      'bonus', v_run.bonus_awarded
    ) end,
    'leaderboard', coalesce((
      select jsonb_agg(row_to_json(board))
      from (
        select r.user_id, p.display_name, r.correct_count, round(r.total_seconds, 1) as total_seconds
        from public.gauntlet_runs r
        join public.profiles p on p.id = r.user_id
        where r.season_id = p_season_id and r.played_on = v_today and r.finished_at is not null
        order by r.correct_count desc, r.total_seconds asc, r.finished_at asc
      ) board
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.gauntlet_today(uuid) from public, anon;
grant execute on function public.gauntlet_today(uuid) to authenticated, service_role;

-- Serve the player's current gauntlet question. Re-fetching never resets
-- the clock; the first serve of each question stamps it.
create or replace function public.gauntlet_next(p_season_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_season public.seasons;
  v_today date;
  v_pack public.gauntlet_packs;
  v_run public.gauntlet_runs;
  v_question public.questions;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_season from public.seasons where id = p_season_id and status = 'active';
  if not found then raise exception 'Active season not found'; end if;
  if not public.is_group_member(v_season.group_id, v_user) then raise exception 'You are not in this group'; end if;

  v_today := public.group_local_date(v_season.group_id);
  select * into v_pack from public.gauntlet_packs where season_id = p_season_id and played_on = v_today;
  if not found or coalesce(array_length(v_pack.question_ids, 1), 0) = 0 then
    raise exception 'No gauntlet today';
  end if;

  insert into public.gauntlet_runs(season_id, user_id, played_on)
  values (p_season_id, v_user, v_today)
  on conflict (season_id, user_id, played_on) do nothing;

  select * into v_run from public.gauntlet_runs
  where season_id = p_season_id and user_id = v_user and played_on = v_today
  for update;
  if v_run.finished_at is not null then raise exception 'You already ran today''s gauntlet'; end if;

  -- A packed question can vanish (deleted in a test reset, or purged by an
  -- operator); skip it rather than strand every run for the day.
  loop
    select * into v_question from public.questions
    where id = v_pack.question_ids[v_run.current_index + 1];
    exit when found;
    update public.gauntlet_runs set current_index = current_index + 1, served_at = null
    where season_id = p_season_id and user_id = v_user and played_on = v_today
    returning * into v_run;
    if v_run.current_index >= array_length(v_pack.question_ids, 1) then
      update public.gauntlet_runs set finished_at = now(), bonus_awarded = coalesce(bonus_awarded, correct_count)
      where season_id = p_season_id and user_id = v_user and played_on = v_today;
      raise exception 'You already ran today''s gauntlet';
    end if;
  end loop;

  if v_run.served_at is null then
    update public.gauntlet_runs set served_at = now()
    where season_id = p_season_id and user_id = v_user and played_on = v_today
    returning * into v_run;
  end if;

  -- The family is burned for this player the moment they see it.
  insert into public.user_question_history(user_id, family_key, question_id)
  values (v_user, coalesce(v_question.family_key, v_question.id::text), v_question.id)
  on conflict (user_id, family_key)
  do update set last_served_at = now(), question_id = excluded.question_id;

  return jsonb_build_object(
    'index', v_run.current_index,
    'of', array_length(v_pack.question_ids, 1),
    'text', v_question.question_text,
    'format', v_question.format,
    'options', public.shuffle_options(v_question.options, md5(v_user::text || v_question.id::text)::uuid),
    'sport', v_question.sport,
    'expires_at', v_run.served_at + interval '45 seconds'
  );
end;
$$;

revoke all on function public.gauntlet_next(uuid) from public, anon;
grant execute on function public.gauntlet_next(uuid) to authenticated, service_role;

-- Grade the current question, advance, and on the last one settle the run:
-- leaderboard row plus the cumulative-score bonus, exactly once.
create or replace function public.gauntlet_answer(p_season_id uuid, p_answer text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_season public.seasons;
  v_today date;
  v_pack public.gauntlet_packs;
  v_run public.gauntlet_runs;
  v_question public.questions;
  v_correct boolean;
  v_seconds numeric;
  v_size integer;
  v_bonus integer;
  v_player_name text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_season from public.seasons where id = p_season_id and status = 'active';
  if not found then raise exception 'Active season not found'; end if;
  if not public.is_group_member(v_season.group_id, v_user) then raise exception 'You are not in this group'; end if;

  v_today := public.group_local_date(v_season.group_id);
  select * into v_pack from public.gauntlet_packs where season_id = p_season_id and played_on = v_today;
  if not found then raise exception 'No gauntlet today'; end if;
  v_size := array_length(v_pack.question_ids, 1);

  select * into v_run from public.gauntlet_runs
  where season_id = p_season_id and user_id = v_user and played_on = v_today
  for update;
  if not found or v_run.served_at is null then raise exception 'Fetch the question first'; end if;
  if v_run.finished_at is not null then raise exception 'You already ran today''s gauntlet'; end if;

  select * into v_question from public.questions where id = v_pack.question_ids[v_run.current_index + 1];
  if not found then raise exception 'Fetch the question first'; end if;
  v_seconds := least(60, extract(epoch from now() - v_run.served_at));
  v_correct := now() <= v_run.served_at + interval '45 seconds'
    and public.answer_matches(v_question, p_answer);

  update public.gauntlet_runs
  set current_index = v_run.current_index + 1,
      served_at = null,
      correct_count = correct_count + case when v_correct then 1 else 0 end,
      total_seconds = total_seconds + v_seconds
  where season_id = p_season_id and user_id = v_user and played_on = v_today
  returning * into v_run;

  if v_run.current_index >= v_size then
    v_bonus := v_run.correct_count + case when v_run.correct_count = v_size then 2 else 0 end;
    update public.gauntlet_runs
    set finished_at = now(), bonus_awarded = v_bonus
    where season_id = p_season_id and user_id = v_user and played_on = v_today;
    update public.player_actions
    set cumulative_score = cumulative_score + v_bonus, updated_at = now()
    where season_id = p_season_id and user_id = v_user;
    select display_name into v_player_name from public.profiles where id = v_user;
    insert into public.activity_events(season_id, actor_id, event_type, message)
    values (p_season_id, v_user, 'gauntlet_finished',
      format('%s ran the daily gauntlet: %s/%s for +%s points.', v_player_name, v_run.correct_count, v_size, v_bonus));
    return jsonb_build_object(
      'status', 'finished',
      'correct', v_correct,
      'correct_answer', v_question.correct_answer,
      'correct_count', v_run.correct_count,
      'of', v_size,
      'total_seconds', round(v_run.total_seconds, 1),
      'bonus', v_bonus
    );
  end if;

  return jsonb_build_object(
    'status', 'active',
    'correct', v_correct,
    'correct_answer', v_question.correct_answer,
    'correct_count', v_run.correct_count,
    'index', v_run.current_index,
    'of', v_size
  );
end;
$$;

revoke all on function public.gauntlet_answer(uuid, text) from public, anon;
grant execute on function public.gauntlet_answer(uuid, text) to authenticated, service_role;
