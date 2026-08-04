-- Phase 2a Task 1: extract `advance_season(p_season_id uuid)` from
-- `run_daily_tick()`'s per-season loop body so a future commissioner-driven
-- "advance the day" RPC (Phase 2a Task 2) can score/advance a single season
-- without looping over every active season in the database.
--
-- The body below is transcribed verbatim from the function's LIVE composed
-- definition (`select pg_get_functiondef('public.run_daily_tick()'::regprocedure)`
-- against the running stack, not any single migration file -- migrations
-- compose), with the `for v_season in ... loop` cursor replaced by a
-- `select ... for update` on the passed-in `p_season_id`. Every resolve_*
-- call, `run_test_bot_turns`, the `current_day` update, twilight decay, and
-- the scoring block (including the `last_scored_on < v_today` group-local-day
-- guard) are unchanged.
create or replace function public.advance_season(p_season_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons;
  v_group public.groups;
  v_member record;
  v_state_points integer;
  v_level_points integer;
  v_region_points integer;
  v_coast_points integer;
  v_sport_points integer;
  v_total integer;
  v_today date;
  v_day integer;
begin
  select * into v_season from public.seasons where id = p_season_id for update;
  if not found then
    return;
  end if;

  select * into v_group from public.groups where id = v_season.group_id;
  v_today := (now() at time zone coalesce(v_group.timezone, 'UTC'))::date;
  v_day := greatest(1, least(v_group.season_length, v_today - v_season.started_at::date + 1));

  perform public.resolve_expired_sessions(v_season.id);
  perform public.resolve_expired_attacks(v_season.id);
  perform public.run_test_bot_turns(v_season.id);

  update public.seasons set current_day = v_day where id = v_season.id and current_day is distinct from v_day;

  if v_season.last_scored_on < v_today then
    if v_day > greatest(1, v_group.season_length - 3) then
      update public.season_territories
        set hold_level = greatest(1, hold_level - 1), updated_at = now()
      where season_id = v_season.id and hold_level > 1 and contested = false;

      insert into public.activity_events(season_id, event_type, message)
      values (v_season.id, 'twilight_decay', 'Twilight phase: every fortified state lost one garrison level.');
    end if;

    for v_member in
      select user_id from public.group_members where group_id = v_season.group_id
    loop
      select count(*) into v_state_points
      from public.season_territories
      where season_id = v_season.id and owner_id = v_member.user_id;

      select count(*) into v_level_points
      from public.season_territories
      where season_id = v_season.id and owner_id = v_member.user_id and hold_level = 3;

      select count(*) * 5 into v_region_points
      from (
        select t.region
        from public.territories t
        join public.season_territories st on st.territory_id = t.id and st.season_id = v_season.id
        where st.owner_id = v_member.user_id
        group by t.region
        having count(*) = (select count(*) from public.territories t2 where t2.region = t.region)
      ) full_regions;

      select case when
        exists (
          select 1 from public.season_territories
          where season_id = v_season.id and owner_id = v_member.user_id
            and territory_id = any(array['WA','OR','CA','AK','HI'])
        ) and exists (
          select 1 from public.season_territories
          where season_id = v_season.id and owner_id = v_member.user_id
            and territory_id = any(array['ME','NH','MA','RI','CT','NY','NJ','DE','MD','VA','NC','SC','GA','FL'])
        ) then 3 else 0 end into v_coast_points;

      select case when count(distinct q.sport) >= 3 then 2 else 0 end into v_sport_points
      from public.question_attempts qa
      join public.questions q on q.id = qa.question_id
      join public.game_sessions gs on gs.id = qa.session_id
      where gs.season_id = v_season.id
        and qa.user_id = v_member.user_id
        and qa.is_correct = true
        and (qa.answered_at at time zone coalesce(v_group.timezone, 'UTC'))::date = v_today;

      v_total := coalesce(v_state_points, 0)
        + coalesce(v_level_points, 0)
        + coalesce(v_region_points, 0)
        + coalesce(v_coast_points, 0)
        + coalesce(v_sport_points, 0);

      insert into public.daily_score_events(season_id, user_id, scored_on, points)
      values (v_season.id, v_member.user_id, v_today, v_total)
      on conflict do nothing;

      if found then
        update public.player_actions
          set cumulative_score = cumulative_score + v_total, updated_at = now()
        where season_id = v_season.id and user_id = v_member.user_id;
      end if;
    end loop;

    update public.seasons set last_scored_on = v_today, current_day = v_day where id = v_season.id;
  end if;

  if v_season.ends_at <= now() then
    insert into public.season_recaps(season_id, recap)
    select v_season.id, jsonb_build_object(
      'winner', (
        select jsonb_build_object('user_id', pa.user_id, 'display_name', p.display_name, 'score', pa.cumulative_score)
        from public.player_actions pa
        join public.profiles p on p.id = pa.user_id
        where pa.season_id = v_season.id
        order by pa.cumulative_score desc
        limit 1
      ),
      'most_states', (
        select jsonb_build_object('user_id', st.owner_id, 'display_name', p.display_name, 'states', count(*))
        from public.season_territories st
        join public.profiles p on p.id = st.owner_id
        where st.season_id = v_season.id and st.owner_id is not null
        group by st.owner_id, p.display_name
        order by count(*) desc
        limit 1
      ),
      'ended_at', now()
    )
    on conflict (season_id) do nothing;

    update public.seasons set status = 'ended', current_day = v_group.season_length where id = v_season.id;
    update public.groups set status = 'ended' where id = v_season.group_id;
    insert into public.activity_events(season_id, event_type, message)
    values (v_season.id, 'season_ended', 'The season ended. Final scores are locked.');
  end if;
end;
$$;

-- `run_daily_tick()` now just fans out to `advance_season` for every active
-- season. Its `players_scored` return shape is preserved: since
-- `advance_season` returns void, the count of newly-inserted score events per
-- season is derived from a before/after row count on `daily_score_events`
-- rather than a counter threaded through the extracted function -- `found`
-- after the `on conflict do nothing` insert inside `advance_season` no longer
-- has an outer-scope variable to increment.
create or replace function public.run_daily_tick()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons;
  v_scored integer := 0;
  v_before bigint;
  v_after bigint;
begin
  for v_season in
    select * from public.seasons where status = 'active' for update skip locked
  loop
    select count(*) into v_before from public.daily_score_events where season_id = v_season.id;
    perform public.advance_season(v_season.id);
    select count(*) into v_after from public.daily_score_events where season_id = v_season.id;
    v_scored := v_scored + (v_after - v_before);
  end loop;

  return jsonb_build_object('players_scored', v_scored);
end;
$$;

-- Grant hygiene (Phase-1 convention, see 20260803180300_fix_security_definer_grants.sql):
-- advance_season is an internal helper -- no client calls it, and Task 2's
-- commissioner-facing RPC will call it server-side under service_role, not
-- forward client execute rights to it.
revoke all on function public.advance_season(uuid) from public, anon, authenticated;
grant execute on function public.advance_season(uuid) to service_role;

-- Re-assert run_daily_tick's existing grants (CREATE OR REPLACE does not
-- change grants, but this keeps the migration an honest, self-contained
-- statement of the function's access contract).
revoke execute on function public.run_daily_tick() from public, anon, authenticated;
grant execute on function public.run_daily_tick() to service_role;
