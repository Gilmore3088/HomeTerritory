-- Finding 19: an off-turn player in a test league was rejected with "No moves
-- remaining" rather than "It is not your turn". `refresh_player_actions` zeroes
-- an off-turn player's moves and `game_begin_action` checked the balance before
-- the `enforce_test_turn_session` trigger ever fired, so the turn-specific
-- message was unreachable for claim, attack and fortify. The turn is checked
-- first now; defend stays exempt, as the trigger already had it.

create or replace function public.game_begin_action(
  p_season_id uuid,
  p_territory_id text,
  p_action_type text,
  p_attack_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_season public.seasons;
  v_state public.season_territories;
  v_attack public.attacks;
  v_session uuid;
  v_required integer := 1;
  v_tier integer := 1;
  v_actions integer;
  v_leader integer;
  v_player_score integer;
  v_owner_count integer;
  v_is_adjacent boolean;
  v_question jsonb;
  v_home text;
  v_home_done boolean;
  v_diff text;
  v_test boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_season from public.seasons where id = p_season_id and status = 'active';
  if not found then raise exception 'Active season not found'; end if;
  if not public.is_group_member(v_season.group_id, v_user) then raise exception 'You are not in this group'; end if;

  perform public.resolve_expired_sessions(p_season_id);
  perform public.resolve_expired_attacks(p_season_id);

  select * into v_state
  from public.season_territories
  where season_id = p_season_id and territory_id = p_territory_id
  for update;
  if not found then raise exception 'Territory not found'; end if;

  select difficulty, coalesce(test_mode, false) into v_diff, v_test from public.groups where id = v_season.group_id;

  -- A test league zeroes an off-turn player's moves, so the balance check below
  -- reached them first and answered "No moves remaining" -- making the
  -- enforce_test_turn_session trigger's real message unreachable for every
  -- action except defend, which is exempt from the turn gate.
  if v_test and p_action_type <> 'defend' and v_season.current_turn_user_id is distinct from v_user then
    raise exception 'It is not your turn';
  end if;
  select count(*) into v_owner_count from public.season_territories where season_id = p_season_id and owner_id = v_user;
  select exists(
    select 1
    from public.season_territories st
    join public.territories t on t.id = st.territory_id
    where st.season_id = p_season_id
      and st.owner_id = v_user
      and p_territory_id = any(t.adjacent)
  ) into v_is_adjacent;

  if p_action_type in ('claim', 'attack', 'fortify') then
    v_actions := public.refresh_player_actions(p_season_id, v_user);
    if v_actions < 1 then raise exception 'No moves remaining'; end if;
  end if;

  if p_action_type = 'home' then
    select home_state, home_completed into v_home, v_home_done
    from public.group_members
    where group_id = v_season.group_id and user_id = v_user;

    if v_home is null or v_home <> p_territory_id then raise exception 'Choose your home state'; end if;
    if v_home_done then raise exception 'Home ground is already settled'; end if;
    if v_state.owner_id <> v_user then raise exception 'Home ground ownership is missing'; end if;
    v_required := 1;
    v_tier := 2;

  elsif p_action_type = 'claim' then
    if v_state.owner_id is not null or v_state.contested then raise exception 'This state is not neutral'; end if;
    if v_owner_count > 0 and not v_is_adjacent then raise exception 'You must claim an adjacent state'; end if;
    if exists(
      select 1 from public.cooldowns
      where season_id = p_season_id and territory_id = p_territory_id
        and user_id = v_user and action_type = 'claim' and expires_at > now()
    ) then raise exception 'This state is cooling down'; end if;
    v_required := 1;
    v_tier := 1;

  elsif p_action_type = 'attack' then
    if v_state.owner_id is null or v_state.owner_id = v_user then raise exception 'Choose another player''s state'; end if;
    if v_state.contested or exists(
      select 1 from public.attacks
      where season_id = p_season_id and territory_id = p_territory_id and status = 'contested'
    ) then raise exception 'This state is already contested'; end if;
    if v_owner_count > 0 and not v_is_adjacent then raise exception 'You must attack an adjacent state'; end if;

    v_required := case when v_state.hold_level = 1 then 2 else 3 end;
    if v_diff = 'casual' then v_required := greatest(1, v_required - 1);
    elsif v_diff = 'hardcore' then v_required := v_required + 1;
    end if;

    v_tier := case when v_state.hold_level = 3 then 3 else 2 end;
    select coalesce(max(cumulative_score), 0) into v_leader from public.player_actions where season_id = p_season_id;
    select cumulative_score into v_player_score from public.player_actions where season_id = p_season_id and user_id = v_user;
    if v_leader > 0 and v_player_score < v_leader * .60 then v_required := greatest(1, v_required - 1); end if;

  elsif p_action_type = 'fortify' then
    if v_state.owner_id <> v_user then raise exception 'You do not own this state'; end if;
    if v_state.contested then raise exception 'A contested state cannot be fortified'; end if;
    if v_state.hold_level >= 3 then raise exception 'This state is already fully fortified'; end if;

    -- The day's fortify is claimed by the winning answer, not by opening the
    -- question, so a fortify lost to a wrong answer can be retried.
    if exists (
      select 1 from public.fortify_log
      where season_id = p_season_id and territory_id = p_territory_id
        and user_id = v_user and played_on = public.group_local_date(v_season.group_id)
    ) then raise exception 'You already fortified this state today'; end if;

    v_required := 1;
    v_tier := least(v_state.hold_level, 2);

  elsif p_action_type = 'defend' then
    select * into v_attack
    from public.attacks
    where id = p_attack_id and season_id = p_season_id and territory_id = p_territory_id
    for update;

    if not found or v_attack.status <> 'contested' then raise exception 'Active attack not found'; end if;
    if v_attack.defender_id <> v_user then raise exception 'Only the owner can defend'; end if;
    if v_attack.defense_deadline <= now() then
      perform public.resolve_attack_win(v_attack.id, 'timeout');
      raise exception 'The defense window expired';
    end if;
    if exists(
      select 1 from public.game_sessions
      where attack_id = v_attack.id and action_type = 'defend' and status in ('active', 'completed', 'failed')
    ) then raise exception 'This defense has already been played'; end if;

    v_required := 1;
    v_tier := v_attack.tier;
  else
    raise exception 'Invalid action type';
  end if;

  if p_action_type in ('claim', 'attack', 'fortify') then
    update public.player_actions
      set actions_remaining = actions_remaining - 1, updated_at = now()
    where season_id = p_season_id and user_id = v_user and actions_remaining > 0;
    if not found then raise exception 'No moves remaining'; end if;
  end if;

  insert into public.game_sessions(
    season_id, territory_id, user_id, action_type, attack_id, required_correct, tier
  ) values (
    p_season_id, p_territory_id, v_user, p_action_type, p_attack_id, v_required, v_tier
  ) returning id into v_session;

  v_question := public.pick_next_question(v_session);

  return jsonb_build_object(
    'session_id', v_session,
    'action_type', p_action_type,
    'territory_id', p_territory_id,
    'question', v_question,
    'required_correct', v_required,
    'correct_count', 0
  );
end;
$$;
