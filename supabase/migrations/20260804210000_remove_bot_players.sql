-- Bots are gone. They were playtest scaffolding (20260730074000), and a
-- trivia game has no honest bot opponent -- a bot either knows every answer
-- or is a dice roll. Decision recorded 2026-08-04.
--
-- This migration:
--   1. redefines start_season / end_test_turn / group_snapshot /
--      advance_season without their bot branches (live definitions
--      transcribed; migrations compose, older files are history),
--   2. drops run_test_bot_turns and bot_action_log,
--   3. deletes bot rows and any profiles orphaned from auth.users (the
--      20260730074000 FK drop made those possible),
--   4. drops profiles.is_bot and restores profiles_id_fkey, closing the
--      account-deletion gap tracked in docs/superpowers/backlog.md (P5).

-- ---------------------------------------------------------------- functions

-- Live body: 20260803180700_fix_group_local_day_boundaries.sql, bot branches
-- removed (human-only counts, bot home auto-assign loop, bot hold_level 2).
create or replace function public.start_season(p_group_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.groups; v_season uuid; v_members integer; v_missing integer;
  v_row record; v_owner uuid; v_first uuid; v_today date;
begin
  select * into v_group from public.groups where id=p_group_id for update;
  if not found then raise exception 'Group not found'; end if;
  if v_group.commissioner_id <> auth.uid() then raise exception 'Only the commissioner can start the season'; end if;
  if v_group.status <> 'lobby' then raise exception 'Season already started'; end if;
  v_today := public.group_local_date(p_group_id);

  select count(*) into v_members from public.group_members where group_id=p_group_id;
  if v_members < 2 then raise exception 'At least two players are required'; end if;
  select count(*) into v_missing from public.group_members where group_id=p_group_id and home_state is null;
  if v_missing > 0 then raise exception '% player(s) still need home ground', v_missing; end if;

  select user_id into v_first from public.group_members where group_id=p_group_id order by color_index limit 1;

  insert into public.seasons(group_id, ends_at, current_day, current_turn_user_id, turn_number, turn_started_at, last_scored_on)
  values (p_group_id, now()+make_interval(days=>v_group.season_length), 1, case when v_group.test_mode then v_first else null end, 1, now(), v_today) returning id into v_season;

  insert into public.season_territories(season_id, territory_id) select v_season,id from public.territories where v_group.board_scope='fifty' or id not in ('AK','HI');
  update public.season_territories st set owner_id=gm.user_id, hold_level=1 from public.group_members gm where gm.group_id=p_group_id and gm.home_state=st.territory_id and st.season_id=v_season;

  if v_group.opening_mode='dealt' then
    for v_row in select t.id, row_number() over(order by md5(t.id || v_season::text)) as rn from public.territories t where (v_group.board_scope='fifty' or t.id not in ('AK','HI')) and not exists(select 1 from public.group_members gm where gm.group_id=p_group_id and gm.home_state=t.id) loop
      select user_id into v_owner from public.group_members where group_id=p_group_id order by color_index offset ((v_row.rn-1)%v_members) limit 1;
      update public.season_territories set owner_id=v_owner,hold_level=1 where season_id=v_season and territory_id=v_row.id;
    end loop;
  end if;

  insert into public.player_actions(season_id,user_id,actions_remaining,last_refresh_on)
  select v_season,user_id,case when v_group.test_mode and user_id<>v_first then 0 else 3 end,v_today from public.group_members where group_id=p_group_id;
  update public.groups set status='active' where id=p_group_id;
  insert into public.activity_events(season_id,actor_id,event_type,message) values(v_season,auth.uid(),'season_started','The board is set. Home ground comes first.');
  return v_season;
end;
$$;

-- Live body: 20260803180700_fix_group_local_day_boundaries.sql. The
-- profiles-join human filters and the two-human floor become a plain
-- member count; rotation walks every member by color_index.
create or replace function public.end_test_turn(p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_group public.groups;
  v_season public.seasons;
  v_current_color integer;
  v_next uuid;
  v_next_name text;
  v_member_count integer;
  v_active_sessions integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_group from public.groups where id = p_group_id for update;
  if not found then raise exception 'Group not found'; end if;
  if not v_group.test_mode then raise exception 'End turn is only available in test leagues'; end if;
  if not public.is_group_member(p_group_id, v_user) then raise exception 'You are not in this group'; end if;

  select * into v_season
  from public.seasons
  where group_id = p_group_id and status = 'active'
  order by created_at desc
  limit 1
  for update;

  if not found then raise exception 'Active season not found'; end if;

  if v_season.current_turn_user_id is null then
    update public.seasons
      set current_turn_user_id = v_user, turn_started_at = now()
      where id = v_season.id
      returning * into v_season;
  end if;

  if v_season.current_turn_user_id <> v_user then raise exception 'It is not your turn'; end if;

  select count(*) into v_active_sessions
  from public.game_sessions
  where season_id = v_season.id and user_id = v_user and status = 'active';
  if v_active_sessions > 0 then raise exception 'Finish the active question before ending your turn'; end if;

  select count(*) into v_member_count
  from public.group_members
  where group_id = p_group_id;
  if v_member_count < 2 then raise exception 'At least two players are required to rotate turns'; end if;

  select color_index into v_current_color
  from public.group_members
  where group_id = p_group_id and user_id = v_user;

  select gm.user_id, p.display_name into v_next, v_next_name
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  where gm.group_id = p_group_id
    and gm.color_index > v_current_color
  order by gm.color_index
  limit 1;

  if v_next is null then
    select gm.user_id, p.display_name into v_next, v_next_name
    from public.group_members gm
    join public.profiles p on p.id = gm.user_id
    where gm.group_id = p_group_id
    order by gm.color_index
    limit 1;
  end if;

  if v_next is null or v_next = v_user then raise exception 'No next player is available'; end if;

  update public.player_actions
    set actions_remaining = 0, updated_at = now()
  where season_id = v_season.id and user_id = v_user;

  insert into public.player_actions(season_id, user_id, actions_remaining, last_refresh_on)
  values(v_season.id, v_next, 3, public.group_local_date(p_group_id))
  on conflict (season_id, user_id)
  do update set actions_remaining = 3, last_refresh_on = public.group_local_date(p_group_id), updated_at = now();

  delete from public.fortify_log
  where season_id = v_season.id and user_id = v_next and played_on = public.group_local_date(p_group_id);

  update public.seasons
    set current_turn_user_id = v_next,
        turn_number = turn_number + 1,
        turn_started_at = now()
  where id = v_season.id;

  insert into public.activity_events(season_id, actor_id, event_type, message)
  values(v_season.id, v_user, 'turn_ended', format('Turn complete. %s is up next.', v_next_name));

  return jsonb_build_object(
    'ok', true,
    'next_user_id', v_next,
    'next_display_name', v_next_name,
    'turn_number', v_season.turn_number + 1
  );
end;
$$;

-- Live body: 20260730220000_add_playtest_turn_handoff.sql, minus the
-- members' is_bot key.
create or replace function public.group_snapshot(p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.groups; v_season public.seasons; v_members jsonb; v_territories jsonb:='[]'::jsonb; v_attacks jsonb:='[]'::jsonb;
  v_scores jsonb:='[]'::jsonb; v_activity jsonb:='[]'::jsonb; v_actions integer:=0; v_turn_name text;
begin
  if not public.is_group_member(p_group_id,auth.uid()) then raise exception 'Group access denied'; end if;
  select * into v_group from public.groups where id=p_group_id;
  select * into v_season from public.seasons where group_id=p_group_id order by created_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('user_id',gm.user_id,'display_name',p.display_name,'color_index',gm.color_index,'home_state',gm.home_state,'home_completed',gm.home_completed) order by gm.color_index),'[]'::jsonb)
    into v_members from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id;
  if v_season.id is not null then
    perform public.resolve_expired_sessions(v_season.id); perform public.resolve_expired_attacks(v_season.id); v_actions:=public.refresh_player_actions(v_season.id,auth.uid());
    select display_name into v_turn_name from public.profiles where id=v_season.current_turn_user_id;
    select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'region',t.region,'adjacent',t.adjacent,'owner_id',st.owner_id,'hold_level',st.hold_level,'contested',st.contested) order by t.name),'[]'::jsonb)
      into v_territories from public.territories t join public.season_territories st on st.territory_id=t.id where st.season_id=v_season.id;
    select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'territory_id',a.territory_id,'attacker_id',a.attacker_id,'defender_id',a.defender_id,'status',a.status,'defense_deadline',a.defense_deadline,'tier',a.tier) order by a.created_at desc),'[]'::jsonb)
      into v_attacks from public.attacks a where a.season_id=v_season.id and a.status='contested';
    select coalesce(jsonb_agg(jsonb_build_object('user_id',gm.user_id,'display_name',p.display_name,'color_index',gm.color_index,'cumulative_score',coalesce(pa.cumulative_score,0),'state_count',(select count(*) from public.season_territories st where st.season_id=v_season.id and st.owner_id=gm.user_id)) order by coalesce(pa.cumulative_score,0) desc,p.display_name),'[]'::jsonb)
      into v_scores from public.group_members gm join public.profiles p on p.id=gm.user_id left join public.player_actions pa on pa.season_id=v_season.id and pa.user_id=gm.user_id where gm.group_id=p_group_id;
    select coalesce(jsonb_agg(event order by event.created_at desc),'[]'::jsonb) into v_activity from (select id,message,created_at,territory_id from public.activity_events where season_id=v_season.id order by created_at desc limit 30) event;
  end if;
  return jsonb_build_object('current_user_id',auth.uid(),'group',jsonb_build_object('id',v_group.id,'name',v_group.name,'commissioner_id',v_group.commissioner_id,'invite_code',v_group.invite_code,'sports',v_group.sports,'status',v_group.status,'test_mode',v_group.test_mode,'opening_mode',v_group.opening_mode,'difficulty',v_group.difficulty,'board_scope',v_group.board_scope),
    'season',case when v_season.id is null then null else jsonb_build_object('id',v_season.id,'status',v_season.status,'started_at',v_season.started_at,'ends_at',v_season.ends_at,'current_day',v_season.current_day,'current_turn_user_id',v_season.current_turn_user_id,'current_turn_name',v_turn_name,'turn_number',v_season.turn_number,'turn_started_at',v_season.turn_started_at) end,
    'members',v_members,'territories',v_territories,'attacks',v_attacks,'scores',v_scores,'activity',v_activity,'actions_remaining',v_actions,
    'is_my_turn',case when not coalesce(v_group.test_mode,false) then true else v_season.current_turn_user_id=auth.uid() end);
end;
$$;

-- Live body: 20260803233000_extract_advance_season.sql, minus the single
-- `perform public.run_test_bot_turns(v_season.id);` line.
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

-- ---------------------------------------------------------------- drops

drop function if exists public.run_test_bot_turns(uuid);
drop table if exists public.bot_action_log;

-- ---------------------------------------------------------------- data

-- Doomed profiles: anything flagged is_bot, plus anything orphaned from
-- auth.users (possible only while the FK was down). Clean their references
-- in FK-dependency order, then the profiles themselves.
create temporary table doomed on commit drop as
  select id from public.profiles where coalesce(is_bot, false)
  union
  select p.id from public.profiles p left join auth.users u on u.id = p.id where u.id is null;

-- question_reports does not cascade from question_attempts; clear reports
-- tied to doomed reporters or doomed users' attempts first.
delete from public.question_reports
where reported_by in (select id from doomed)
   or attempt_id in (select qa.id from public.question_attempts qa where qa.user_id in (select id from doomed));

delete from public.game_sessions where user_id in (select id from doomed);
delete from public.season_question_seen where served_to in (select id from doomed);

update public.season_territories st
set contested = false, updated_at = now()
where contested and exists (
  select 1 from public.attacks a
  where a.season_id = st.season_id and a.territory_id = st.territory_id
    and a.status = 'contested'
    and (a.attacker_id in (select id from doomed) or a.defender_id in (select id from doomed))
);
delete from public.attacks where attacker_id in (select id from doomed) or defender_id in (select id from doomed);

update public.season_territories set owner_id = null, hold_level = 1, updated_at = now()
where owner_id in (select id from doomed);

delete from public.cooldowns where user_id in (select id from doomed);
delete from public.fortify_log where user_id in (select id from doomed);
delete from public.daily_score_events where user_id in (select id from doomed);
delete from public.player_actions where user_id in (select id from doomed);
update public.activity_events set actor_id = null where actor_id in (select id from doomed);
update public.seasons set current_turn_user_id = null where current_turn_user_id in (select id from doomed);
delete from public.group_members where user_id in (select id from doomed);

-- Groups commissioned by a doomed profile are unrecoverable test debris.
-- Their seasons cascade on group delete, but question_reports on those
-- seasons' attempts do not -- clear those first.
delete from public.question_reports
where attempt_id in (
  select qa.id
  from public.question_attempts qa
  join public.game_sessions gs on gs.id = qa.session_id
  join public.seasons s on s.id = gs.season_id
  where s.group_id in (select id from public.groups where commissioner_id in (select id from doomed))
);
delete from public.groups where commissioner_id in (select id from doomed);

delete from public.profiles where id in (select id from doomed);

-- ---------------------------------------------------------------- schema

alter table public.profiles drop column if exists is_bot;

alter table public.profiles
  add constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade;

-- ---------------------------------------------------------------- grants

-- create or replace preserves grants; re-asserted per the Phase-1 convention
-- (20260803180300_fix_security_definer_grants.sql) so this file states its
-- functions' full access contract.
revoke execute on function public.start_season(uuid) from public, anon;
grant execute on function public.start_season(uuid) to authenticated;
revoke execute on function public.end_test_turn(uuid) from public, anon;
grant execute on function public.end_test_turn(uuid) to authenticated;
revoke execute on function public.group_snapshot(uuid) from public, anon;
grant execute on function public.group_snapshot(uuid) to authenticated;
revoke all on function public.advance_season(uuid) from public, anon, authenticated;
grant execute on function public.advance_season(uuid) to service_role;

-- PostgREST caches the schema; tell it the shape changed.
notify pgrst, 'reload schema';
