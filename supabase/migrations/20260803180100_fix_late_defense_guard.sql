-- Finding 3: nothing re-checked the attack between `game_begin_action` admitting
-- the defender and the answer landing. If the 24h deadline lapsed while the
-- defense question was open, any other player's snapshot ran
-- `resolve_expired_attacks` and transferred the state; the defender's correct
-- answer then reported "You defended X" and its unconditional
-- `set hold_level = least(3, hold_level + 1)` fortified the *attacker's* newly
-- taken state. The `update attacks ... where status = 'contested'` guard matched
-- zero rows and was silently ignored.
--
-- The defense now re-reads the attack under a row lock before it mutates
-- anything, and voids itself if the attack is no longer contested.

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

  -- The attack can be resolved by anyone's snapshot while this question is open,
  -- so re-read it under a lock before the winning answer is allowed to move the map.
  if v_session.action_type = 'defend' then
    select * into v_attack from public.attacks where id = v_session.attack_id for update;
    if not found or v_attack.status <> 'contested' then
      update public.game_sessions set correct_count = v_count, status = 'void' where id = p_session_id;
      return jsonb_build_object('status', 'void',
        'message', format('%s was already resolved before your answer landed.', v_state_name),
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
    select owner_id into v_defender from public.season_territories
    where season_id = v_session.season_id and territory_id = v_session.territory_id for update;
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
