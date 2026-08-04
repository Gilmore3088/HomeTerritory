-- Finding 11: `seasons.last_scored_on`, `player_actions.last_refresh_on` and
-- `fortify_log.played_on` all DEFAULT to `current_date` -- the database's UTC
-- date -- while `run_daily_tick` and `refresh_player_actions` compare against
-- `(now() at time zone groups.timezone)::date`. A season started while the UTC
-- date was already ahead of the group's local date stamped a `last_scored_on`
-- one day in its own future and silently skipped a scoring day, and the
-- once-per-day fortify rolled over at UTC midnight while moves rolled over at
-- group-local midnight.
--
-- Every writer now stamps the group's local day through one helper. The column
-- defaults are deliberately left in place as a last-resort fallback; nothing in
-- the engine relies on them any more.

create or replace function public.group_local_date(p_group_id uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select (now() at time zone coalesce(g.timezone, 'UTC'))::date
  from public.groups g
  where g.id = p_group_id;
$$;

revoke all on function public.group_local_date(uuid) from public, anon, authenticated;

create or replace function public.start_season(p_group_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.groups; v_season uuid; v_humans integer; v_missing integer; v_members integer;
  v_row record; v_owner uuid; v_first_human uuid; v_today date;
begin
  select * into v_group from public.groups where id=p_group_id for update;
  if not found then raise exception 'Group not found'; end if;
  if v_group.commissioner_id <> auth.uid() then raise exception 'Only the commissioner can start the season'; end if;
  if v_group.status <> 'lobby' then raise exception 'Season already started'; end if;
  v_today := public.group_local_date(p_group_id);

  select count(*) into v_humans from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and not coalesce(p.is_bot,false);
  if v_humans < 2 then raise exception 'At least two people are required'; end if;
  select count(*) into v_missing from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and not coalesce(p.is_bot,false) and gm.home_state is null;
  if v_missing > 0 then raise exception '% player(s) still need home ground', v_missing; end if;

  select gm.user_id into v_first_human from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and not coalesce(p.is_bot,false) order by gm.color_index limit 1;

  for v_row in select gm.user_id from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and coalesce(p.is_bot,false) and gm.home_state is null order by gm.color_index loop
    update public.group_members gm set home_state=(select t.id from public.territories t where (v_group.board_scope='fifty' or t.id not in ('AK','HI')) and not exists(select 1 from public.group_members x where x.group_id=p_group_id and x.home_state=t.id) order by md5(t.id || p_group_id::text) limit 1), home_completed=true where gm.group_id=p_group_id and gm.user_id=v_row.user_id;
  end loop;

  insert into public.seasons(group_id, ends_at, current_day, current_turn_user_id, turn_number, turn_started_at, last_scored_on)
  values (p_group_id, now()+make_interval(days=>v_group.season_length), 1, case when v_group.test_mode then v_first_human else null end, 1, now(), v_today) returning id into v_season;

  insert into public.season_territories(season_id, territory_id) select v_season,id from public.territories where v_group.board_scope='fifty' or id not in ('AK','HI');
  update public.season_territories st set owner_id=gm.user_id, hold_level=case when coalesce(p.is_bot,false) then 2 else 1 end from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id and gm.home_state=st.territory_id and st.season_id=v_season;

  if v_group.opening_mode='dealt' then
    select count(*) into v_members from public.group_members where group_id=p_group_id;
    for v_row in select t.id, row_number() over(order by md5(t.id || v_season::text)) as rn from public.territories t where (v_group.board_scope='fifty' or t.id not in ('AK','HI')) and not exists(select 1 from public.group_members gm where gm.group_id=p_group_id and gm.home_state=t.id) loop
      select user_id into v_owner from public.group_members where group_id=p_group_id order by color_index offset ((v_row.rn-1)%v_members) limit 1;
      update public.season_territories set owner_id=v_owner,hold_level=1 where season_id=v_season and territory_id=v_row.id;
    end loop;
  end if;

  insert into public.player_actions(season_id,user_id,actions_remaining,last_refresh_on)
  select v_season,user_id,case when v_group.test_mode and user_id<>v_first_human then 0 else 3 end,v_today from public.group_members where group_id=p_group_id;
  update public.groups set status='active' where id=p_group_id;
  insert into public.activity_events(season_id,actor_id,event_type,message) values(v_season,auth.uid(),'season_started','The board is set. Home ground comes first.');
  return v_season;
end;
$$;

create or replace function public.end_test_turn(p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_group public.groups;
  v_season public.seasons;
  v_current_color integer;
  v_next uuid;
  v_next_name text;
  v_human_count integer;
  v_active_sessions integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_group from public.groups where id = p_group_id for update;
  if not found then raise exception 'Group not found'; end if;
  if not v_group.test_mode then raise exception 'End turn is only available in test leagues'; end if;
  if not public.is_group_member(p_group_id, v_user) then raise exception 'You are not in this group'; end if;

  select * into v_season
  from public.seasons
  where group_id = p_group_id and status = 'active'
  order by created_at desc
  limit 1
  for update;

  if not found then raise exception 'Active season not found'; end if;

  if v_season.current_turn_user_id is null then
    update public.seasons
      set current_turn_user_id = v_user, turn_started_at = now()
      where id = v_season.id
      returning * into v_season;
  end if;

  if v_season.current_turn_user_id <> v_user then raise exception 'It is not your turn'; end if;

  select count(*) into v_active_sessions
  from public.game_sessions
  where season_id = v_season.id and user_id = v_user and status = 'active';
  if v_active_sessions > 0 then raise exception 'Finish the active question before ending your turn'; end if;

  select count(*) into v_human_count
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  where gm.group_id = p_group_id and not coalesce(p.is_bot, false);
  if v_human_count < 2 then raise exception 'At least two human players are required to rotate turns'; end if;

  select color_index into v_current_color
  from public.group_members
  where group_id = p_group_id and user_id = v_user;

  select gm.user_id, p.display_name into v_next, v_next_name
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  where gm.group_id = p_group_id
    and not coalesce(p.is_bot, false)
    and gm.color_index > v_current_color
  order by gm.color_index
  limit 1;

  if v_next is null then
    select gm.user_id, p.display_name into v_next, v_next_name
    from public.group_members gm
    join public.profiles p on p.id = gm.user_id
    where gm.group_id = p_group_id and not coalesce(p.is_bot, false)
    order by gm.color_index
    limit 1;
  end if;

  if v_next is null or v_next = v_user then raise exception 'No next human player is available'; end if;

  update public.player_actions
    set actions_remaining = 0, updated_at = now()
  where season_id = v_season.id and user_id = v_user;

  insert into public.player_actions(season_id, user_id, actions_remaining, last_refresh_on)
  values(v_season.id, v_next, 3, public.group_local_date(p_group_id))
  on conflict (season_id, user_id)
  do update set actions_remaining = 3, last_refresh_on = public.group_local_date(p_group_id), updated_at = now();

  delete from public.fortify_log
  where season_id = v_season.id and user_id = v_next and played_on = public.group_local_date(p_group_id);

  update public.seasons
    set current_turn_user_id = v_next,
        turn_number = turn_number + 1,
        turn_started_at = now()
  where id = v_season.id;

  insert into public.activity_events(season_id, actor_id, event_type, message)
  values(v_season.id, v_user, 'turn_ended', format('Turn complete. %s is up next.', v_next_name));

  return jsonb_build_object(
    'ok', true,
    'next_user_id', v_next,
    'next_display_name', v_next_name,
    'turn_number', v_season.turn_number + 1
  );
end;
$$;

create or replace function public.test_refill_actions(p_group_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare v_group public.groups; v_season uuid;
begin
  select * into v_group from public.groups where id=p_group_id;
  if not found or not v_group.test_mode then raise exception 'This is not a test league'; end if;
  if v_group.commissioner_id<>auth.uid() then raise exception 'Only the commissioner can refill test actions'; end if;
  select id into v_season from public.seasons where group_id=p_group_id and status='active' order by created_at desc limit 1;
  update public.player_actions set actions_remaining=3,updated_at=now() where season_id=v_season and user_id=auth.uid();
  delete from public.fortify_log where season_id=v_season and user_id=auth.uid() and played_on=public.group_local_date(p_group_id);
  insert into public.activity_events(season_id,actor_id,event_type,message) values(v_season,auth.uid(),'test_refill','Test actions were refilled.');
  return 3;
end;
$$;

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
    insert into public.fortify_log(season_id, territory_id, user_id, played_on)
    values (v_session.season_id, v_session.territory_id, v_user, public.group_local_date(v_group))
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
