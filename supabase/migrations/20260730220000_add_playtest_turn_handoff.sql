alter table public.seasons
  add column if not exists current_turn_user_id uuid,
  add column if not exists turn_number integer not null default 1,
  add column if not exists turn_started_at timestamptz not null default now();

update public.seasons s
set current_turn_user_id = g.commissioner_id,
    turn_started_at = coalesce(s.started_at, now())
from public.groups g
where g.id = s.group_id
  and g.test_mode = true
  and s.status = 'active'
  and s.current_turn_user_id is null;

create or replace function public.enforce_test_turn_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_test boolean;
  v_turn uuid;
begin
  select g.test_mode, s.current_turn_user_id
    into v_test, v_turn
  from public.seasons s
  join public.groups g on g.id = s.group_id
  where s.id = new.season_id;

  if coalesce(v_test, false)
     and new.action_type <> 'defend'
     and v_turn is distinct from new.user_id then
    raise exception 'It is not your turn';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_test_turn_session_trigger on public.game_sessions;
create trigger enforce_test_turn_session_trigger
before insert on public.game_sessions
for each row execute function public.enforce_test_turn_session();

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
  v_human_count integer;
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

  select count(*) into v_human_count
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  where gm.group_id = p_group_id and not coalesce(p.is_bot, false);
  if v_human_count < 2 then raise exception 'At least two human players are required to rotate turns'; end if;

  select color_index into v_current_color
  from public.group_members
  where group_id = p_group_id and user_id = v_user;

  select gm.user_id, p.display_name into v_next, v_next_name
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  where gm.group_id = p_group_id
    and not coalesce(p.is_bot, false)
    and gm.color_index > v_current_color
  order by gm.color_index
  limit 1;

  if v_next is null then
    select gm.user_id, p.display_name into v_next, v_next_name
    from public.group_members gm
    join public.profiles p on p.id = gm.user_id
    where gm.group_id = p_group_id and not coalesce(p.is_bot, false)
    order by gm.color_index
    limit 1;
  end if;

  if v_next is null or v_next = v_user then raise exception 'No next human player is available'; end if;

  update public.player_actions
    set actions_remaining = 0, updated_at = now()
  where season_id = v_season.id and user_id = v_user;

  insert into public.player_actions(season_id, user_id, actions_remaining, last_refresh_on)
  values(v_season.id, v_next, 3, current_date)
  on conflict (season_id, user_id)
  do update set actions_remaining = 3, last_refresh_on = current_date, updated_at = now();

  delete from public.fortify_log
  where season_id = v_season.id and user_id = v_next and played_on = current_date;

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

revoke all on function public.end_test_turn(uuid) from public;
grant execute on function public.end_test_turn(uuid) to authenticated;

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
  select coalesce(jsonb_agg(jsonb_build_object('user_id',gm.user_id,'display_name',p.display_name,'color_index',gm.color_index,'home_state',gm.home_state,'home_completed',gm.home_completed,'is_bot',coalesce(p.is_bot,false)) order by gm.color_index),'[]'::jsonb)
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

-- Future test seasons start with the first human player and only that player receives actions.
create or replace function public.start_season(p_group_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.groups; v_season uuid; v_humans integer; v_missing integer; v_members integer;
  v_row record; v_owner uuid; v_first_human uuid;
begin
  select * into v_group from public.groups where id=p_group_id for update;
  if not found then raise exception 'Group not found'; end if;
  if v_group.commissioner_id <> auth.uid() then raise exception 'Only the commissioner can start the season'; end if;
  if v_group.status <> 'lobby' then raise exception 'Season already started'; end if;

  select count(*) into v_humans from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and not coalesce(p.is_bot,false);
  if v_humans < 2 then raise exception 'At least two people are required'; end if;
  select count(*) into v_missing from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and not coalesce(p.is_bot,false) and gm.home_state is null;
  if v_missing > 0 then raise exception '% player(s) still need home ground', v_missing; end if;

  select gm.user_id into v_first_human from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and not coalesce(p.is_bot,false) order by gm.color_index limit 1;

  for v_row in select gm.user_id from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and coalesce(p.is_bot,false) and gm.home_state is null order by gm.color_index loop
    update public.group_members gm set home_state=(select t.id from public.territories t where (v_group.board_scope='fifty' or t.id not in ('AK','HI')) and not exists(select 1 from public.group_members x where x.group_id=p_group_id and x.home_state=t.id) order by md5(t.id || p_group_id::text) limit 1), home_completed=true where gm.group_id=p_group_id and gm.user_id=v_row.user_id;
  end loop;

  insert into public.seasons(group_id, ends_at, current_day, current_turn_user_id, turn_number, turn_started_at)
  values (p_group_id, now()+make_interval(days=>v_group.season_length), 1, case when v_group.test_mode then v_first_human else null end, 1, now()) returning id into v_season;

  insert into public.season_territories(season_id, territory_id) select v_season,id from public.territories where v_group.board_scope='fifty' or id not in ('AK','HI');
  update public.season_territories st set owner_id=gm.user_id, hold_level=case when coalesce(p.is_bot,false) then 2 else 1 end from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and gm.home_state=st.territory_id and st.season_id=v_season;

  if v_group.opening_mode='dealt' then
    select count(*) into v_members from public.group_members where group_id=p_group_id;
    for v_row in select t.id, row_number() over(order by md5(t.id || v_season::text)) as rn from public.territories t where (v_group.board_scope='fifty' or t.id not in ('AK','HI')) and not exists(select 1 from public.group_members gm where gm.group_id=p_group_id and gm.home_state=t.id) loop
      select user_id into v_owner from public.group_members where group_id=p_group_id order by color_index offset ((v_row.rn-1)%v_members) limit 1;
      update public.season_territories set owner_id=v_owner,hold_level=1 where season_id=v_season and territory_id=v_row.id;
    end loop;
  end if;

  insert into public.player_actions(season_id,user_id,actions_remaining)
  select v_season,user_id,case when v_group.test_mode and user_id<>v_first_human then 0 else 3 end from public.group_members where group_id=p_group_id;
  update public.groups set status='active' where id=p_group_id;
  insert into public.activity_events(season_id,actor_id,event_type,message) values(v_season,auth.uid(),'season_started','The board is set. Home ground comes first.');
  return v_season;
end;
$$;
