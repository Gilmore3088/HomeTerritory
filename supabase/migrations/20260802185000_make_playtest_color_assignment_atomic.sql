create or replace function public.admin_add_group_member(p_group_id uuid,p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing integer;
  v_count integer;
  v_color integer;
begin
  perform 1 from public.groups where id=p_group_id for update;
  if not found then raise exception 'Group not found'; end if;

  select color_index into v_existing
  from public.group_members
  where group_id=p_group_id and user_id=p_user_id;
  if found then return v_existing; end if;

  select count(*) into v_count from public.group_members where group_id=p_group_id;
  if v_count>=8 then raise exception 'This playtest league is full'; end if;

  select candidate into v_color
  from generate_series(0,7) candidate
  where not exists (
    select 1 from public.group_members gm
    where gm.group_id=p_group_id and gm.color_index=candidate
  )
  order by candidate
  limit 1;

  if v_color is null then raise exception 'No player color is available'; end if;

  insert into public.group_members(group_id,user_id,color_index)
  values(p_group_id,p_user_id,v_color);

  return v_color;
end;
$$;

revoke all on function public.admin_add_group_member(uuid,uuid) from public,anon,authenticated;
grant execute on function public.admin_add_group_member(uuid,uuid) to service_role;
