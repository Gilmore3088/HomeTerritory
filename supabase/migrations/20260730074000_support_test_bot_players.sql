alter table public.profiles add column if not exists is_bot boolean not null default false;

alter table public.profiles drop constraint if exists profiles_id_fkey;

create or replace function public.start_season(p_group_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_group public.groups;
  v_season uuid;
  v_count integer;
begin
  select * into v_group from public.groups where id = p_group_id for update;
  if not found then raise exception 'Group not found'; end if;
  if v_group.commissioner_id <> auth.uid() then raise exception 'Only the commissioner can start the season'; end if;
  if v_group.status <> 'lobby' then raise exception 'Season already started'; end if;
  select count(*) into v_count from public.group_members where group_id = p_group_id;
  if v_count < 3 then raise exception 'At least three players are required'; end if;

  insert into public.seasons(group_id, ends_at)
  values (p_group_id, now() + make_interval(days => v_group.season_length)) returning id into v_season;

  insert into public.season_territories(season_id, territory_id)
  select v_season, id from public.territories;

  insert into public.player_actions(season_id, user_id)
  select v_season, user_id from public.group_members where group_id = p_group_id;

  with bot_rows as (
    select gm.user_id, row_number() over(order by gm.joined_at, gm.user_id) as rn
    from public.group_members gm
    join public.profiles p on p.id = gm.user_id
    where gm.group_id = p_group_id and p.is_bot
  ), state_rows as (
    select id, row_number() over(order by name) as rn
    from public.territories
  )
  update public.season_territories st
  set owner_id = b.user_id, hold_level = 1, updated_at = now()
  from bot_rows b
  join state_rows s on s.rn = b.rn
  where st.season_id = v_season and st.territory_id = s.id;

  update public.groups set status = 'active' where id = p_group_id;
  insert into public.activity_events(season_id, actor_id, event_type, message)
  values (v_season, auth.uid(), 'season_started', 'The season started. The map is open.');
  return v_season;
end;
$$;

revoke execute on function public.start_season(uuid) from public, anon;
grant execute on function public.start_season(uuid) to authenticated;
