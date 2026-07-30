create or replace function public.group_snapshot(p_group_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_group public.groups; v_season public.seasons; v_members jsonb; v_territories jsonb:='[]'::jsonb; v_attacks jsonb:='[]'::jsonb;
  v_scores jsonb:='[]'::jsonb; v_activity jsonb:='[]'::jsonb; v_actions integer:=0;
begin
  if not public.is_group_member(p_group_id,auth.uid()) then raise exception 'Group access denied'; end if;
  select * into v_group from public.groups where id=p_group_id;
  select * into v_season from public.seasons where group_id=p_group_id order by created_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('user_id',gm.user_id,'display_name',p.display_name,'color_index',gm.color_index,'home_state',gm.home_state,'home_completed',gm.home_completed,'is_bot',coalesce(p.is_bot,false)) order by gm.color_index),'[]'::jsonb)
    into v_members from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id;
  if v_season.id is not null then
    perform public.resolve_expired_sessions(v_season.id); perform public.resolve_expired_attacks(v_season.id); v_actions:=public.refresh_player_actions(v_season.id,auth.uid());
    select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'region',t.region,'adjacent',t.adjacent,'owner_id',st.owner_id,'hold_level',st.hold_level,'contested',st.contested) order by t.name),'[]'::jsonb)
      into v_territories from public.territories t join public.season_territories st on st.territory_id=t.id where st.season_id=v_season.id;
    select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'territory_id',a.territory_id,'attacker_id',a.attacker_id,'defender_id',a.defender_id,'status',a.status,'defense_deadline',a.defense_deadline,'tier',a.tier) order by a.created_at desc),'[]'::jsonb)
      into v_attacks from public.attacks a where a.season_id=v_season.id and a.status='contested';
    select coalesce(jsonb_agg(jsonb_build_object('user_id',gm.user_id,'display_name',p.display_name,'color_index',gm.color_index,'cumulative_score',coalesce(pa.cumulative_score,0),'state_count',(select count(*) from public.season_territories st where st.season_id=v_season.id and st.owner_id=gm.user_id)) order by coalesce(pa.cumulative_score,0) desc,p.display_name),'[]'::jsonb)
      into v_scores from public.group_members gm join public.profiles p on p.id=gm.user_id left join public.player_actions pa on pa.season_id=v_season.id and pa.user_id=gm.user_id where gm.group_id=p_group_id;
    select coalesce(jsonb_agg(event order by event.created_at desc),'[]'::jsonb) into v_activity from (select id,message,created_at,territory_id from public.activity_events where season_id=v_season.id order by created_at desc limit 30) event;
  end if;
  return jsonb_build_object('current_user_id',auth.uid(),'group',jsonb_build_object('id',v_group.id,'name',v_group.name,'commissioner_id',v_group.commissioner_id,'invite_code',v_group.invite_code,'sports',v_group.sports,'status',v_group.status,'test_mode',v_group.test_mode,'opening_mode',v_group.opening_mode,'difficulty',v_group.difficulty,'board_scope',v_group.board_scope),
    'season',case when v_season.id is null then null else jsonb_build_object('id',v_season.id,'status',v_season.status,'started_at',v_season.started_at,'ends_at',v_season.ends_at,'current_day',v_season.current_day) end,
    'members',v_members,'territories',v_territories,'attacks',v_attacks,'scores',v_scores,'activity',v_activity,'actions_remaining',v_actions);
end;
$$;

revoke execute on function public.create_group_v2(text,text[],integer,text,text,text,boolean) from public,anon;
revoke execute on function public.set_home_state(uuid,text) from public,anon;
revoke execute on function public.get_my_active_session(uuid) from public,anon;
revoke execute on function public.test_refill_actions(uuid) from public,anon;
grant execute on function public.create_group_v2(text,text[],integer,text,text,text,boolean) to authenticated;
grant execute on function public.set_home_state(uuid,text) to authenticated;
grant execute on function public.get_my_active_session(uuid) to authenticated;
grant execute on function public.test_refill_actions(uuid) to authenticated;
