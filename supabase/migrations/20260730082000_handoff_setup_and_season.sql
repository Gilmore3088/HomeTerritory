-- Align the live async game with the July 2026 Territory handoff.

alter table public.groups add column if not exists board_scope text not null default 'fifty' check (board_scope in ('fifty','lower48'));
alter table public.groups add column if not exists opening_mode text not null default 'open' check (opening_mode in ('open','dealt'));
alter table public.groups add column if not exists difficulty text not null default 'standard' check (difficulty in ('casual','standard','hardcore'));
alter table public.groups add column if not exists timezone text not null default 'America/Los_Angeles';
alter table public.groups add column if not exists test_mode boolean not null default false;

alter table public.group_members add column if not exists home_state text references public.territories(id);
alter table public.group_members add column if not exists home_completed boolean not null default false;
create unique index if not exists one_home_state_per_group on public.group_members(group_id, home_state) where home_state is not null;

alter table public.seasons add column if not exists current_day integer not null default 1;

alter table public.game_sessions drop constraint if exists game_sessions_action_type_check;
alter table public.game_sessions add constraint game_sessions_action_type_check check (action_type in ('home','claim','attack','fortify','defend'));

create or replace function public.create_group_v2(
  p_name text,
  p_sports text[],
  p_season_length integer default 14,
  p_opening_mode text default 'open',
  p_board_scope text default 'fifty',
  p_difficulty text default 'standard',
  p_test_mode boolean default false
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_group uuid;
  v_code text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if char_length(trim(p_name)) < 2 then raise exception 'Group name is too short'; end if;
  if cardinality(p_sports) < 1 then raise exception 'Select at least one sport'; end if;
  if p_season_length not in (7, 10, 14, 30, 60) then raise exception 'Invalid season length'; end if;
  if p_opening_mode not in ('open','dealt') then raise exception 'Invalid opening mode'; end if;
  if p_board_scope not in ('fifty','lower48') then raise exception 'Invalid board scope'; end if;
  if p_difficulty not in ('casual','standard','hardcore') then raise exception 'Invalid difficulty'; end if;

  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists(select 1 from public.groups where invite_code = v_code);
  end loop;

  insert into public.groups(name, commissioner_id, invite_code, sports, season_length, opening_mode, board_scope, difficulty, test_mode)
  values (trim(p_name), v_user, v_code, p_sports, p_season_length, p_opening_mode, p_board_scope, p_difficulty, p_test_mode)
  returning id into v_group;

  insert into public.group_members(group_id, user_id, color_index) values (v_group, v_user, 0);
  return v_group;
end;
$$;

create or replace function public.set_home_state(p_group_id uuid, p_home_state text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_group public.groups;
begin
  select * into v_group from public.groups where id=p_group_id;
  if not found or v_group.status <> 'lobby' then raise exception 'Home ground is locked after the season starts'; end if;
  if not exists(select 1 from public.group_members where group_id=p_group_id and user_id=auth.uid()) then raise exception 'You are not in this group'; end if;
  if not exists(select 1 from public.territories where id=upper(p_home_state)) then raise exception 'State not found'; end if;
  if v_group.board_scope='lower48' and upper(p_home_state) in ('AK','HI') then raise exception 'That state is not on this board'; end if;
  update public.group_members set home_state=upper(p_home_state), home_completed=false where group_id=p_group_id and user_id=auth.uid();
exception when unique_violation then
  raise exception 'Another player already chose that home state';
end;
$$;

create or replace function public.start_season(p_group_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_group public.groups;
  v_season uuid;
  v_humans integer;
  v_missing integer;
  v_members integer;
  v_row record;
  v_owner uuid;
begin
  select * into v_group from public.groups where id=p_group_id for update;
  if not found then raise exception 'Group not found'; end if;
  if v_group.commissioner_id <> auth.uid() then raise exception 'Only the commissioner can start the season'; end if;
  if v_group.status <> 'lobby' then raise exception 'Season already started'; end if;

  select count(*) into v_humans from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and not coalesce(p.is_bot,false);
  if v_humans < 2 then raise exception 'At least two people are required'; end if;
  select count(*) into v_missing from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and not coalesce(p.is_bot,false) and gm.home_state is null;
  if v_missing > 0 then raise exception '% player(s) still need home ground', v_missing; end if;

  for v_row in select gm.user_id from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and coalesce(p.is_bot,false) and gm.home_state is null order by gm.color_index loop
    update public.group_members gm set home_state=(
      select t.id from public.territories t
      where (v_group.board_scope='fifty' or t.id not in ('AK','HI'))
        and not exists(select 1 from public.group_members x where x.group_id=p_group_id and x.home_state=t.id)
      order by md5(t.id || p_group_id::text) limit 1
    ), home_completed=true where gm.group_id=p_group_id and gm.user_id=v_row.user_id;
  end loop;

  insert into public.seasons(group_id, ends_at, current_day)
  values (p_group_id, now()+make_interval(days=>v_group.season_length), 1) returning id into v_season;

  insert into public.season_territories(season_id, territory_id)
  select v_season,id from public.territories where v_group.board_scope='fifty' or id not in ('AK','HI');

  update public.season_territories st set owner_id=gm.user_id, hold_level=case when coalesce(p.is_bot,false) then 2 else 1 end
  from public.group_members gm join public.profiles p on p.id=gm.user_id
  where gm.group_id=p_group_id and gm.home_state=st.territory_id and st.season_id=v_season;

  if v_group.opening_mode='dealt' then
    select count(*) into v_members from public.group_members where group_id=p_group_id;
    for v_row in
      select t.id, row_number() over(order by md5(t.id || v_season::text)) as rn
      from public.territories t
      where (v_group.board_scope='fifty' or t.id not in ('AK','HI'))
        and not exists(select 1 from public.group_members gm where gm.group_id=p_group_id and gm.home_state=t.id)
    loop
      select user_id into v_owner from public.group_members where group_id=p_group_id order by color_index offset ((v_row.rn-1)%v_members) limit 1;
      update public.season_territories set owner_id=v_owner,hold_level=1 where season_id=v_season and territory_id=v_row.id;
    end loop;
  end if;

  insert into public.player_actions(season_id,user_id) select v_season,user_id from public.group_members where group_id=p_group_id;
  update public.groups set status='active' where id=p_group_id;
  insert into public.activity_events(season_id,actor_id,event_type,message) values(v_season,auth.uid(),'season_started','The board is set. Home ground comes first.');
  return v_season;
end;
$$;
