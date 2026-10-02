-- Playtest feedback: fortify was free, so a player holding several states could
-- chain free questions indefinitely ("unlimited turns"). Fortify now spends an
-- action like claims and attacks, and reporting a fortify question refunds it.

create or replace function public.game_begin_action(
  p_season_id uuid,
  p_territory_id text,
  p_action_type text,
  p_attack_id uuid default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid:=auth.uid(); v_season public.seasons; v_state public.season_territories; v_attack public.attacks;
  v_session uuid; v_required integer:=1; v_tier integer:=1; v_actions integer; v_leader integer; v_player_score integer;
  v_owner_count integer; v_is_adjacent boolean; v_question jsonb; v_home text; v_home_done boolean; v_diff text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_season from public.seasons where id=p_season_id and status='active';
  if not found then raise exception 'Active season not found'; end if;
  if not public.is_group_member(v_season.group_id,v_user) then raise exception 'You are not in this group'; end if;
  perform public.resolve_expired_sessions(p_season_id); perform public.resolve_expired_attacks(p_season_id);
  select * into v_state from public.season_territories where season_id=p_season_id and territory_id=p_territory_id for update;
  if not found then raise exception 'Territory not found'; end if;
  select difficulty into v_diff from public.groups where id=v_season.group_id;
  select count(*) into v_owner_count from public.season_territories where season_id=p_season_id and owner_id=v_user;
  select exists(select 1 from public.season_territories st join public.territories t on t.id=st.territory_id where st.season_id=p_season_id and st.owner_id=v_user and p_territory_id=any(t.adjacent)) into v_is_adjacent;

  if p_action_type in ('claim','attack','fortify') then
    v_actions:=public.refresh_player_actions(p_season_id,v_user); if v_actions<1 then raise exception 'No attack actions remaining'; end if;
  end if;

  if p_action_type='home' then
    select home_state,home_completed into v_home,v_home_done from public.group_members where group_id=v_season.group_id and user_id=v_user;
    if v_home is null or v_home<>p_territory_id then raise exception 'Choose your home state'; end if;
    if v_home_done then raise exception 'Home ground is already settled'; end if;
    if v_state.owner_id<>v_user then raise exception 'Home ground ownership is missing'; end if;
    if exists(select 1 from public.game_sessions where season_id=p_season_id and user_id=v_user and action_type='home' and status='active') then raise exception 'Your home question is already in play'; end if;
    v_required:=1; v_tier:=2;
  elsif p_action_type='claim' then
    if v_state.owner_id is not null or v_state.contested then raise exception 'This state is not neutral'; end if;
    if v_owner_count>0 and not v_is_adjacent then raise exception 'You must claim an adjacent state'; end if;
    if exists(select 1 from public.cooldowns where season_id=p_season_id and territory_id=p_territory_id and user_id=v_user and action_type='claim' and expires_at>now()) then raise exception 'This state is cooling down'; end if;
    update public.player_actions set actions_remaining=actions_remaining-1,updated_at=now() where season_id=p_season_id and user_id=v_user;
    v_required:=1;v_tier:=1;
  elsif p_action_type='attack' then
    if v_state.owner_id is null or v_state.owner_id=v_user then raise exception 'Choose another player''s state'; end if;
    if v_state.contested or exists(select 1 from public.attacks where season_id=p_season_id and territory_id=p_territory_id and status='contested') then raise exception 'This state is already contested'; end if;
    if v_owner_count>0 and not v_is_adjacent then raise exception 'You must attack an adjacent state'; end if;
    v_required:=case when v_state.hold_level=1 then 2 else 3 end;
    if v_diff='casual' then v_required:=greatest(1,v_required-1); elsif v_diff='hardcore' then v_required:=v_required+1; end if;
    v_tier:=case when v_state.hold_level=3 then 3 else 2 end;
    select coalesce(max(cumulative_score),0) into v_leader from public.player_actions where season_id=p_season_id;
    select cumulative_score into v_player_score from public.player_actions where season_id=p_season_id and user_id=v_user;
    if v_leader>0 and v_player_score<v_leader*.60 then v_required:=greatest(1,v_required-1); end if;
    update public.player_actions set actions_remaining=actions_remaining-1,updated_at=now() where season_id=p_season_id and user_id=v_user;
  elsif p_action_type='fortify' then
    if v_state.owner_id<>v_user then raise exception 'You do not own this state'; end if;
    if v_state.contested then raise exception 'A contested state cannot be fortified'; end if;
    if v_state.hold_level>=3 then raise exception 'This state is already fully fortified'; end if;
    insert into public.fortify_log(season_id,territory_id,user_id) values(p_season_id,p_territory_id,v_user) on conflict do nothing;
    if not found then raise exception 'You already fortified this state today'; end if;
    update public.player_actions set actions_remaining=actions_remaining-1,updated_at=now() where season_id=p_season_id and user_id=v_user;
    v_required:=1;v_tier:=least(v_state.hold_level,2);
  elsif p_action_type='defend' then
    select * into v_attack from public.attacks where id=p_attack_id and season_id=p_season_id and territory_id=p_territory_id for update;
    if not found or v_attack.status<>'contested' then raise exception 'Active attack not found'; end if;
    if v_attack.defender_id<>v_user then raise exception 'Only the owner can defend'; end if;
    if v_attack.defense_deadline<=now() then perform public.resolve_attack_win(v_attack.id,'timeout');raise exception 'The defense window expired'; end if;
    if exists(select 1 from public.game_sessions where attack_id=v_attack.id and action_type='defend' and status in ('active','completed','failed')) then raise exception 'This defense has already been played'; end if;
    v_required:=1;v_tier:=v_attack.tier;
  else raise exception 'Invalid action type'; end if;

  insert into public.game_sessions(season_id,territory_id,user_id,action_type,attack_id,required_correct,tier)
  values(p_season_id,p_territory_id,v_user,p_action_type,p_attack_id,v_required,v_tier) returning id into v_session;
  v_question:=public.pick_next_question(v_session);
  return jsonb_build_object('session_id',v_session,'action_type',p_action_type,'territory_id',p_territory_id,'question',v_question,'required_correct',v_required,'correct_count',0);
end;
$$;

create or replace function public.report_question(p_attempt_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_attempt public.question_attempts;
  v_session public.game_sessions;
begin
  select * into v_attempt from public.question_attempts where id = p_attempt_id for update;
  if not found or v_attempt.user_id <> auth.uid() then raise exception 'Attempt not found'; end if;
  select * into v_session from public.game_sessions where id = v_attempt.session_id for update;
  if v_session.status <> 'active' then raise exception 'This session is already resolved'; end if;

  update public.questions set active = false where id = v_attempt.question_id;
  insert into public.question_reports(question_id, attempt_id, reported_by, reason)
  values (v_attempt.question_id, v_attempt.id, auth.uid(), left(coalesce(p_reason, 'Question reported'), 500));
  update public.question_attempts set answered_at = now(), answer_text = '[reported]' where id = v_attempt.id;
  update public.game_sessions set status = 'void' where id = v_session.id;

  if v_session.action_type in ('claim', 'attack', 'fortify') then
    update public.player_actions set actions_remaining = least(5, actions_remaining + 1), updated_at = now()
    where season_id = v_session.season_id and user_id = auth.uid();
  end if;
  if v_session.action_type = 'fortify' then
    delete from public.fortify_log where season_id = v_session.season_id and territory_id = v_session.territory_id and user_id = auth.uid() and played_on = current_date;
  end if;

  return jsonb_build_object('status', 'void', 'message', 'Question quarantined and action refunded.');
end;
$$;
