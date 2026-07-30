create or replace function public.create_group(p_name text, p_sports text[], p_season_length integer default 30)
returns uuid
language plpgsql
security definer set search_path = public, pg_catalog
as $$
declare
  v_user uuid := auth.uid();
  v_group uuid;
  v_code text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if char_length(trim(p_name)) < 2 then raise exception 'Group name is too short'; end if;
  if cardinality(p_sports) < 1 then raise exception 'Select at least one sport'; end if;
  if p_season_length not in (14, 30, 60) then raise exception 'Invalid season length'; end if;

  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists(select 1 from public.groups where invite_code = v_code);
  end loop;

  insert into public.groups(name, commissioner_id, invite_code, sports, season_length)
  values (trim(p_name), v_user, v_code, p_sports, p_season_length)
  returning id into v_group;

  insert into public.group_members(group_id, user_id, color_index)
  values (v_group, v_user, 0);

  return v_group;
end;
$$;

revoke execute on function public.create_group(text, text[], integer) from public, anon;
grant execute on function public.create_group(text, text[], integer) to authenticated;
