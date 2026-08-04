-- Finding 8: the `fortify_log` row was written at *begin* time, so a fortify lost
-- to a wrong answer still consumed the day's one fortify for that state -- and
-- the move too. The player was told "You already fortified this state today"
-- when they had in fact failed it.
--
-- `game_begin_action` now only *checks* the log, and the winning answer claims
-- the day. Claiming it on the answer also closes the gap the old code left open
-- in the other direction: two fortify sessions on the same state could no longer
-- both be admitted, because the insert -- not the check -- is what decides, and
-- a session that loses the race gets its move back.

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

  select difficulty into v_diff from public.groups where id = v_season.group_id;
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
        and user_id = v_user and played_on = current_date
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

create or replace function public.game_submit_answer(p_session_id uuid, p_answer text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_session public.game_sessions;
  v_attempt public.question_attempts;
  v_question public.questions;
  v_attack public.attacks;
  v_correct boolean;
  v_count integer;
  v_next jsonb;
  v_state_name text;
  v_player_name text;
  v_attack_id uuid;
  v_defender uuid;
  v_contested boolean;
  v_group uuid;
begin
  select * into v_session from public.game_sessions where id = p_session_id for update;
  if not found or v_session.user_id <> v_user then raise exception 'Game session not found'; end if;
  if v_session.status <> 'active' then raise exception 'This trivia session is already closed'; end if;

  select * into v_attempt from public.question_attempts where id = v_session.current_attempt_id for update;
  if not found or v_attempt.answered_at is not null then raise exception 'Question attempt is already closed'; end if;

  select * into v_question from public.questions where id = v_attempt.question_id;
  v_correct := now() <= v_attempt.expires_at and public.answer_matches(v_question, p_answer);
  update public.question_attempts set answer_text = p_answer, is_correct = v_correct, answered_at = now() where id = v_attempt.id;

  select name into v_state_name from public.territories where id = v_session.territory_id;
  select display_name into v_player_name from public.profiles where id = v_user;
  select group_id into v_group from public.seasons where id = v_session.season_id;

  if v_session.action_type = 'home' then
    update public.game_sessions set status = 'completed', correct_count = case when v_correct then 1 else 0 end where id = p_session_id;
    update public.season_territories
      set hold_level = case when v_correct then 2 else 1 end, updated_at = now()
    where season_id = v_session.season_id and territory_id = v_session.territory_id and owner_id = v_user;
    update public.group_members set home_completed = true where group_id = v_group and user_id = v_user;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'home_ground', v_session.territory_id,
      case when v_correct then format('%s holds home ground in %s. Dug in at 2.', v_player_name, v_state_name)
      else format('%s fumbles home ground in %s. Starts exposed.', v_player_name, v_state_name) end);
    return jsonb_build_object('status', 'completed',
      'message', case when v_correct then format('Correct. %s begins dug in.', v_state_name)
        else format('Incorrect. You keep %s, but it starts exposed.', v_state_name) end,
      'correct_answer', v_question.correct_answer);
  end if;

  if not v_correct then
    update public.game_sessions set status = 'failed' where id = p_session_id;
    if v_session.action_type = 'claim' then
      insert into public.cooldowns(season_id, territory_id, user_id, action_type, expires_at)
      values (v_session.season_id, v_session.territory_id, v_user, 'claim', now() + interval '6 hours')
      on conflict (season_id, territory_id, user_id, action_type) do update set expires_at = excluded.expires_at;
    elsif v_session.action_type = 'defend' then
      perform public.resolve_attack_win(v_session.attack_id, 'incorrect');
    end if;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'answer_missed', v_session.territory_id, format('%s missed a question in %s.', v_player_name, v_state_name));
    return jsonb_build_object('status', 'failed',
      'message', case when v_session.action_type = 'defend' then 'Incorrect. The attacker takes the state.' else 'Incorrect. The map does not change.' end,
      'correct_answer', v_question.correct_answer);
  end if;

  v_count := v_session.correct_count + 1;
  if v_count < v_session.required_correct then
    update public.game_sessions set correct_count = v_count where id = p_session_id;
    v_next := public.pick_next_question(p_session_id);
    return jsonb_build_object('status', 'active', 'message', 'Correct. Keep the run alive.', 'question', v_next,
      'correct_count', v_count, 'required_correct', v_session.required_correct, 'correct_answer', v_question.correct_answer);
  end if;

  -- Both an attack and a defense depend on a row someone else can settle while
  -- this question is open, so re-read it under a lock before the winning answer
  -- is allowed to move the map.
  if v_session.action_type = 'attack' then
    select owner_id, contested into v_defender, v_contested
    from public.season_territories
    where season_id = v_session.season_id and territory_id = v_session.territory_id
    for update;

    if v_contested or exists (
      select 1 from public.attacks
      where season_id = v_session.season_id and territory_id = v_session.territory_id and status = 'contested'
    ) then
      update public.game_sessions set correct_count = v_count, status = 'void' where id = p_session_id;
      update public.player_actions
        set actions_remaining = least(5, actions_remaining + 1), updated_at = now()
      where season_id = v_session.season_id and user_id = v_user;
      return jsonb_build_object('status', 'void',
        'message', format('%s went under attack before your run finished. Your move was returned.', v_state_name),
        'correct_answer', v_question.correct_answer);
    end if;

  elsif v_session.action_type = 'defend' then
    select * into v_attack from public.attacks where id = v_session.attack_id for update;
    if not found or v_attack.status <> 'contested' then
      update public.game_sessions set correct_count = v_count, status = 'void' where id = p_session_id;
      return jsonb_build_object('status', 'void',
        'message', format('%s was already resolved before your answer landed.', v_state_name),
        'correct_answer', v_question.correct_answer);
    end if;

  elsif v_session.action_type = 'fortify' then
    insert into public.fortify_log(season_id, territory_id, user_id)
    values (v_session.season_id, v_session.territory_id, v_user)
    on conflict do nothing;

    if not found then
      update public.game_sessions set correct_count = v_count, status = 'void' where id = p_session_id;
      update public.player_actions
        set actions_remaining = least(5, actions_remaining + 1), updated_at = now()
      where season_id = v_session.season_id and user_id = v_user;
      return jsonb_build_object('status', 'void',
        'message', format('%s was already fortified today. Your move was returned.', v_state_name),
        'correct_answer', v_question.correct_answer);
    end if;
  end if;

  update public.game_sessions set correct_count = v_count, status = 'completed' where id = p_session_id;

  if v_session.action_type = 'claim' then
    update public.season_territories set owner_id = v_user, hold_level = 1, updated_at = now()
    where season_id = v_session.season_id and territory_id = v_session.territory_id;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'state_claimed', v_session.territory_id, format('%s claimed %s.', v_player_name, v_state_name));
    return jsonb_build_object('status', 'completed', 'message', format('Correct. %s is yours.', v_state_name), 'correct_answer', v_question.correct_answer);

  elsif v_session.action_type = 'attack' then
    insert into public.attacks(season_id, territory_id, attacker_id, defender_id, tier, defense_deadline)
    values (v_session.season_id, v_session.territory_id, v_user, v_defender, v_session.tier, now() + interval '24 hours')
    returning id into v_attack_id;
    update public.season_territories set contested = true, last_contested_at = now(), updated_at = now()
    where season_id = v_session.season_id and territory_id = v_session.territory_id;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'attack_started', v_session.territory_id, format('%s put %s under attack.', v_player_name, v_state_name));
    return jsonb_build_object('status', 'contested', 'message', format('Run complete. %s has 24 hours to defend.', v_state_name),
      'attack_id', v_attack_id, 'correct_answer', v_question.correct_answer);

  elsif v_session.action_type = 'fortify' then
    update public.season_territories set hold_level = least(3, hold_level + 1), updated_at = now()
    where season_id = v_session.season_id and territory_id = v_session.territory_id;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'state_fortified', v_session.territory_id, format('%s fortified %s.', v_player_name, v_state_name));
    return jsonb_build_object('status', 'completed', 'message', format('Correct. %s is stronger.', v_state_name), 'correct_answer', v_question.correct_answer);

  elsif v_session.action_type = 'defend' then
    update public.attacks set status = 'repelled', resolved_at = now() where id = v_session.attack_id and status = 'contested';
    update public.season_territories set contested = false, hold_level = least(3, hold_level + 1), updated_at = now()
    where season_id = v_session.season_id and territory_id = v_session.territory_id;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'attack_repelled', v_session.territory_id, format('%s defended %s.', v_player_name, v_state_name));
    return jsonb_build_object('status', 'completed', 'message', format('Correct. You defended %s and raised its hold.', v_state_name),
      'correct_answer', v_question.correct_answer);
  end if;

  raise exception 'Unsupported game state';
end;
$$;
