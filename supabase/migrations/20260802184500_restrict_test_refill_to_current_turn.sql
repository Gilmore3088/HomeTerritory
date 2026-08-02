create or replace function public.test_refill_actions(p_group_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.groups;
  v_season public.seasons;
begin
  select * into v_group from public.groups where id=p_group_id;
  if not found or not v_group.test_mode then raise exception 'This is not a test league'; end if;
  if v_group.commissioner_id<>auth.uid() then raise exception 'Only the commissioner can refill test moves'; end if;

  select * into v_season
  from public.seasons
  where group_id=p_group_id and status='active'
  order by created_at desc limit 1;
  if not found then raise exception 'Active season not found'; end if;
  if v_season.current_turn_user_id<>auth.uid() then raise exception 'It is not your turn'; end if;

  update public.player_actions
  set actions_remaining=3,updated_at=now()
  where season_id=v_season.id and user_id=auth.uid();

  delete from public.fortify_log
  where season_id=v_season.id and user_id=auth.uid() and played_on=current_date;

  insert into public.activity_events(season_id,actor_id,event_type,message)
  values(v_season.id,auth.uid(),'test_refill','Test moves were refilled.');

  return 3;
end;
$$;
