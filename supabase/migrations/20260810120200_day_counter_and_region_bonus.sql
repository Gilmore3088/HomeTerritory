-- Season-level game-day counter (backlog P2-day-counter) plus the
-- lower48 region-bonus fix (backlog P4).
--
-- The game-day counter: `groups.day_offset` shifts the whole group's local
-- date forward, and `group_local_date` -- the single helper every
-- day-boundary reader already goes through (scoring, fortify-once-per-day,
-- and now action refresh too) -- adds it. The commissioner's
-- `advance_group_day` can therefore fast-forward any number of days
-- independent of the wall calendar: each fast day bumps the offset, and the
-- whole engine (daily scoring, twilight decay, action refresh, fortify
-- windows, season end) coherently follows because they all read the same
-- shifted date. `advance_group_day(p_group_id)` keeps its old behavior for
-- the first call of a day (settle the current, unscored day without
-- shifting the calendar); once the current day is settled, another call
-- advances the calendar itself.
--
-- The region-bonus fix: `advance_season` compared a player's owned states
-- in a region against ALL of `public.territories` in that region, so on a
-- `lower48` board the Pacific region (AK/HI excluded from
-- `season_territories` but still counted) could never be completed. The
-- bonus now counts only territories actually in the season.
--
-- One deliberate artifact, noted rather than hidden: the sport-diversity
-- bonus matches answers by their real (un-shifted) group-local date, so a
-- multi-day fast-forward can credit the same real day's answers on more
-- than one fast day. Fast-forwarding is a commissioner/test lever; +2/day
-- is accepted over the alternative of the bonus silently never matching
-- again once an offset exists.

alter table public.groups add column if not exists day_offset integer not null default 0
  check (day_offset between 0 and 366);

create or replace function public.group_local_date(p_group_id uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select (now() at time zone coalesce(g.timezone, 'UTC'))::date + coalesce(g.day_offset, 0)
  from public.groups g
  where g.id = p_group_id;
$$;

revoke all on function public.group_local_date(uuid) from public, anon, authenticated;

-- Live body: 20260803180600_fix_refresh_actions_tick_fanout.sql; the inline
-- `(now() at time zone v_timezone)::date` becomes `group_local_date` so the
-- daily action refresh follows a fast-forwarded calendar too.
create or replace function public.refresh_player_actions(p_season_id uuid, p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.player_actions;
  v_days integer;
  v_test boolean;
  v_turn uuid;
  v_group_id uuid;
  v_today date;
begin
  select g.test_mode, s.current_turn_user_id, g.id
    into v_test, v_turn, v_group_id
  from public.seasons s
  join public.groups g on g.id = s.group_id
  where s.id = p_season_id;

  if not found then raise exception 'Season not found'; end if;

  v_today := public.group_local_date(v_group_id);

  insert into public.player_actions(season_id, user_id, actions_remaining, last_refresh_on)
  values (p_season_id, p_user_id, case when v_test and v_turn is distinct from p_user_id then 0 else 3 end, v_today)
  on conflict do nothing;

  if v_test then
    update public.player_actions
      set actions_remaining = 0, updated_at = now()
    where season_id = p_season_id and user_id <> v_turn and actions_remaining <> 0;

    select * into v_row
    from public.player_actions
    where season_id = p_season_id and user_id = p_user_id
    for update;

    return case when v_turn = p_user_id then v_row.actions_remaining else 0 end;
  end if;

  select * into v_row
  from public.player_actions
  where season_id = p_season_id and user_id = p_user_id
  for update;

  v_days := greatest(0, v_today - v_row.last_refresh_on);
  if v_days > 0 then
    update public.player_actions
      set actions_remaining = least(5, actions_remaining + (v_days * 3)),
          last_refresh_on = v_today,
          updated_at = now()
    where season_id = p_season_id and user_id = p_user_id
    returning * into v_row;
  end if;

  return v_row.actions_remaining;
end;
$$;

-- Live body: 20260804210000_remove_bot_players.sql, with four deliberate
-- changes: (1) `v_today` reads `group_local_date` (offset-aware); (2) the
-- region bonus counts only territories in the season; (3) the
-- sport-diversity bonus keeps matching answers by their real group-local
-- date; (4) the season-end check shifts `now()` by the day offset so a
-- fast-forwarded season ends on its fast-forwarded last day.
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
  v_today := public.group_local_date(v_group.id);
  v_day := greatest(1, least(v_group.season_length, v_today - v_season.started_at::date + 1));

  perform public.resolve_expired_sessions(v_season.id);
  perform public.resolve_expired_attacks(v_season.id);

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
        having count(*) = (
          select count(*)
          from public.territories t2
          join public.season_territories st2 on st2.territory_id = t2.id and st2.season_id = v_season.id
          where t2.region = t.region
        )
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
        and (qa.answered_at at time zone coalesce(v_group.timezone, 'UTC'))::date
          = (now() at time zone coalesce(v_group.timezone, 'UTC'))::date;

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

  if v_season.ends_at <= now() + make_interval(days => coalesce(v_group.day_offset, 0)) then
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

-- Commissioner fast-forward. The first call of a day keeps the old
-- one-argument semantics (settle the current, unscored day); once the day
-- is settled, each further day advances the group's calendar itself. The
-- old single-argument function is dropped so PostgREST sees exactly one
-- signature; existing `{ p_group_id }` calls still resolve via the default.
drop function if exists public.advance_group_day(uuid);

create function public.advance_group_day(p_group_id uuid, p_days integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_commish uuid;
  v_season_id uuid;
  v_status text;
  v_scored date;
  v_advanced integer := 0;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;
  if p_days is null or p_days < 1 or p_days > 60 then
    raise exception 'Advance between 1 and 60 days';
  end if;
  select commissioner_id into v_commish from public.groups where id = p_group_id;
  if v_commish is null then
    raise exception 'Group not found';
  end if;
  if v_commish <> v_uid then
    raise exception 'Only the commissioner can advance the day';
  end if;
  select id into v_season_id from public.seasons
    where group_id = p_group_id and status = 'active' limit 1;
  if v_season_id is null then
    raise exception 'No active season';
  end if;

  for i in 1..p_days loop
    select status, last_scored_on into v_status, v_scored
    from public.seasons where id = v_season_id;
    exit when v_status <> 'active';

    if v_scored >= public.group_local_date(p_group_id) then
      update public.groups set day_offset = day_offset + 1 where id = p_group_id;
    end if;

    perform public.advance_season(v_season_id);
    v_advanced := v_advanced + 1;
  end loop;

  return jsonb_build_object('ok', true, 'season_id', v_season_id, 'days_advanced', v_advanced);
end;
$$;

revoke execute on function public.advance_group_day(uuid, integer) from public, anon;
grant execute on function public.advance_group_day(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
