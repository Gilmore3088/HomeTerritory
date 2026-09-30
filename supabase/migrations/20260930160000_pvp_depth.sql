-- Phase 3, P3d: the modes that make friends fight.
--
-- 1. Rivalry ledger: every attack resolution (taken, held, timed out)
--    lands in public.pvp_ledger, so head-to-head history survives seasons
--    and groups. Surfaced through pvp_rivalries() on standings/recap.
-- 2. Defender's choice: game_begin_action('defend') takes p_sport; the
--    picker treats the chosen sport as the strongest preference for that
--    session. Choosing is optional and never filters -- if the state has
--    no question in that sport, the usual order applies.
-- 3. Wager attacks: p_wager on an attack spends 2 actions instead of 1,
--    runs at tier 3 with free-fill questions only (both the run and the
--    defense), and a successful defense does NOT raise the garrison --
--    the attacker buys a harder, scarier fight; the defender holds but
--    gains nothing. A voided wager refunds both actions.
-- 4. Season awards: the end-of-season recap gains Best Defender, Sharpest
--    Sport, Fastest Gun, Upset of the Season and the season's hottest
--    rivalry, computed from attempts + the ledger.
--
-- Function bodies are transcribed from the LIVE definitions (dumped from a
-- fully migrated database, not from any single older migration file);
-- changes are marked [P3d].

-- --------------------------------------------------------------- ledger

create table public.pvp_ledger (
  id bigint generated always as identity primary key,
  group_id uuid not null,
  season_id uuid not null,
  territory_id text not null,
  attacker_id uuid not null,
  defender_id uuid not null,
  outcome text not null check (outcome in ('attacker_won', 'defender_held')),
  reason text not null,
  wager boolean not null default false,
  created_at timestamptz not null default now()
);

create index pvp_ledger_pair_idx on public.pvp_ledger(attacker_id, defender_id);
create index pvp_ledger_season_idx on public.pvp_ledger(season_id);

alter table public.pvp_ledger enable row level security;
revoke all on table public.pvp_ledger from public, anon, authenticated;
grant all on table public.pvp_ledger to service_role;

alter table public.attacks add column wager boolean not null default false;
alter table public.game_sessions
  add column sport_preference text,
  add column wager boolean not null default false,
  add column actions_spent integer not null default 1;

-- Lifetime head-to-head between this group's members (across all their
-- groups and seasons -- rivalries follow the people, not the league).
create or replace function public.pvp_rivalries(p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_rows jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not public.is_group_member(p_group_id, v_user) then raise exception 'You are not in this group'; end if;

  select coalesce(jsonb_agg(row_to_json(pairs)), '[]'::jsonb) into v_rows
  from (
    select l.attacker_id,
           pa.display_name as attacker_name,
           l.defender_id,
           pd.display_name as defender_name,
           count(*) filter (where l.outcome = 'attacker_won') as states_taken,
           count(*) filter (where l.outcome = 'defender_held') as defenses_held,
           count(*) filter (where l.wager) as wager_fights,
           max(l.created_at) as last_clash
    from public.pvp_ledger l
    join public.profiles pa on pa.id = l.attacker_id
    join public.profiles pd on pd.id = l.defender_id
    where l.attacker_id in (select user_id from public.group_members where group_id = p_group_id)
      and l.defender_id in (select user_id from public.group_members where group_id = p_group_id)
    group by l.attacker_id, pa.display_name, l.defender_id, pd.display_name
    order by count(*) desc, max(l.created_at) desc
  ) pairs;

  return v_rows;
end;
$$;

revoke all on function public.pvp_rivalries(uuid) from public, anon;
grant execute on function public.pvp_rivalries(uuid) to authenticated, service_role;

-- ------------------------------------------- attacker wins write the ledger

create or replace function public.resolve_attack_win(p_attack_id uuid, p_reason text default 'timeout'::text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attack public.attacks;
  v_state_name text;
  v_attacker_name text;
begin
  select * into v_attack from public.attacks where id = p_attack_id for update;
  if not found or v_attack.status <> 'contested' then return; end if;
  update public.attacks set status = 'won', resolved_at = now() where id = p_attack_id;
  update public.season_territories
    set owner_id = v_attack.attacker_id, hold_level = 1, contested = false, updated_at = now()
    where season_id = v_attack.season_id and territory_id = v_attack.territory_id;
  -- [P3d] the rivalry ledger records every taken state, with how.
  insert into public.pvp_ledger(group_id, season_id, territory_id, attacker_id, defender_id, outcome, reason, wager)
  select s.group_id, v_attack.season_id, v_attack.territory_id, v_attack.attacker_id, v_attack.defender_id,
         'attacker_won', p_reason, v_attack.wager
  from public.seasons s where s.id = v_attack.season_id;
  select name into v_state_name from public.territories where id = v_attack.territory_id;
  select display_name into v_attacker_name from public.profiles where id = v_attack.attacker_id;
  insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
  values (v_attack.season_id, v_attack.attacker_id, 'state_stolen', v_attack.territory_id,
    format('%s took %s%s', v_attacker_name, v_state_name, case when p_reason = 'timeout' then ' after the defense expired.' else '.' end));
end;
$$;

-- --------------------------------------------------- begin action (new args)

-- The old 4-argument signature must go, or PostgREST sees two candidates
-- for every call that omits the new defaulted arguments.
drop function public.game_begin_action(uuid, text, text, uuid);

create or replace function public.game_begin_action(
  p_season_id uuid,
  p_territory_id text,
  p_action_type text,
  p_attack_id uuid default null::uuid,
  p_sport text default null,
  p_wager boolean default false
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
  v_cost integer := 1;            -- [P3d] wager attacks spend 2
  v_sport_pref text := null;      -- [P3d] defender's choice
  v_group_sports text[];
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  -- [P3d] the new knobs only mean something on their own action types.
  if p_sport is not null and p_action_type <> 'defend' then
    raise exception 'Choosing a sport is for defenses';
  end if;
  if p_wager and p_action_type <> 'attack' then
    raise exception 'Only an attack can be a wager';
  end if;

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
    if p_wager then v_cost := 2; end if;
    v_actions := public.refresh_player_actions(p_season_id, v_user);
    if v_actions < v_cost then
      raise exception '%', case when p_wager then 'A wager attack needs two moves' else 'No moves remaining' end;
    end if;
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
    -- [P3d] a wager is always fought at the top tier.
    if p_wager then v_tier := 3; end if;
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

    -- [P3d] defender's choice: any of the league's sports, checked here so
    -- a typo is an error, not a silent no-op.
    if p_sport is not null then
      select sports into v_group_sports from public.groups where id = v_season.group_id;
      if not (p_sport = any(coalesce(v_group_sports, '{}'))) then
        raise exception 'That sport is not in this league';
      end if;
      v_sport_pref := p_sport;
    end if;

    v_required := 1;
    v_tier := v_attack.tier;
  else
    raise exception 'Invalid action type';
  end if;

  if p_action_type in ('claim', 'attack', 'fortify') then
    update public.player_actions
      set actions_remaining = actions_remaining - v_cost, updated_at = now()
    where season_id = p_season_id and user_id = v_user and actions_remaining >= v_cost;
    if not found then raise exception 'No moves remaining'; end if;
  end if;

  insert into public.game_sessions(
    season_id, territory_id, user_id, action_type, attack_id, required_correct, tier,
    sport_preference, wager, actions_spent
  ) values (
    p_season_id, p_territory_id, v_user, p_action_type, p_attack_id, v_required, v_tier,
    -- [P3d] a wager defense inherits the free-fill constraint through the
    -- attack row; the session carries the attacker's own wager flag and the
    -- defender's sport choice.
    v_sport_pref, p_wager or (p_action_type = 'defend' and v_attack.wager), v_cost
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

revoke all on function public.game_begin_action(uuid, text, text, uuid, text, boolean) from public, anon;
grant execute on function public.game_begin_action(uuid, text, text, uuid, text, boolean) to authenticated, service_role;

-- ------------------------------------------------------- submit answer

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
      -- [P3d] refund what the session actually cost (a wager spent 2).
      update public.player_actions
        set actions_remaining = least(5, actions_remaining + v_session.actions_spent), updated_at = now()
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
        set actions_remaining = least(5, actions_remaining + v_session.actions_spent), updated_at = now()
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
    -- [P3d] the attack row carries the wager so the defense and the
    -- resolution both know the stakes.
    insert into public.attacks(season_id, territory_id, attacker_id, defender_id, tier, defense_deadline, wager)
    values (v_session.season_id, v_session.territory_id, v_user, v_defender, v_session.tier, now() + interval '24 hours', v_session.wager)
    returning id into v_attack_id;
    update public.season_territories set contested = true, last_contested_at = now(), updated_at = now()
    where season_id = v_session.season_id and territory_id = v_session.territory_id;
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'attack_started', v_session.territory_id,
      format('%s put %s under attack%s', v_player_name, v_state_name,
             case when v_session.wager then ' — a wager, tier 3.' else '.' end));
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
    -- [P3d] holding against a wager earns no garrison: the attacker bought
    -- that concession with the second action.
    update public.season_territories
      set contested = false,
          hold_level = least(3, hold_level + case when v_attack.wager then 0 else 1 end),
          updated_at = now()
    where season_id = v_session.season_id and territory_id = v_session.territory_id;
    -- [P3d] held defenses write the rivalry ledger (wins are written by
    -- resolve_attack_win).
    insert into public.pvp_ledger(group_id, season_id, territory_id, attacker_id, defender_id, outcome, reason, wager)
    values (v_group, v_session.season_id, v_session.territory_id, v_attack.attacker_id, v_user, 'defender_held', 'repelled', v_attack.wager);
    insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
    values (v_session.season_id, v_user, 'attack_repelled', v_session.territory_id, format('%s defended %s.', v_player_name, v_state_name));
    return jsonb_build_object('status', 'completed',
      'message', case when v_attack.wager
        then format('Correct. You held %s against a wager attack.', v_state_name)
        else format('Correct. You defended %s and raised its hold.', v_state_name) end,
      'correct_answer', v_question.correct_answer);
  end if;

  raise exception 'Unsupported game state';
end;
$$;

-- ----------------------------------------- picker: sport choice, free-fill

-- Transcribed from the LIVE definition (20260930140000_question_ops.sql).
-- [P3d] changes: the session's sport_preference outranks the league-sport
-- preference in stages 1-2, and a wager session (attack run or its defense)
-- only accepts free-fill questions in stages 1-3. The last resort stays
-- unfiltered: serving something always beats stranding a run.
create or replace function public.pick_next_question(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.game_sessions;
  v_question public.questions;
  v_attempt uuid;
  v_expires timestamptz;
  v_tier integer;
  v_sports text[];
  v_stage text := 'lifetime_fresh';
begin
  select gs.* into v_session from public.game_sessions gs where gs.id = p_session_id for update;
  if not found then raise exception 'Game session not found'; end if;

  select g.sports into v_sports
  from public.seasons s
  join public.groups g on g.id = s.group_id
  where s.id = v_session.season_id;

  -- Stage 1: the lifetime guarantee. Only families this player has never
  -- seen, in any season, plus the existing season-level 7-day shield.
  select q.* into v_question
  from public.questions q
  where q.territory_id = v_session.territory_id
    and q.active
    and (not v_session.wager or q.format = 'free_fill')
    and not exists (
      select 1
      from public.user_question_history h
      where h.user_id = v_session.user_id
        and h.family_key = coalesce(q.family_key, q.id::text)
    )
    and not exists (
      select 1
      from public.season_question_seen sqs
      where sqs.season_id = v_session.season_id
        and sqs.question_id = q.id
        and sqs.served_to = v_session.user_id
        and sqs.served_at > now() - interval '7 days'
    )
  order by
    case when v_session.sport_preference is not null and q.sport = v_session.sport_preference then -1
         when q.sport = any(v_sports) then 0 else 1 end,
    abs(public.adaptive_tier(q.tier, q.attempt_count, q.correct_count) - v_session.tier),
    -- Gate D: an untested generated question usually yields to an equally
    -- suitable alternative, so fresh compiles enter play as a trickle.
    case when q.validation_status = 'generated_v1'
           and q.attempt_count < 3
           and random() < 0.7
         then 1 else 0 end,
    random()
  limit 1;

  -- Stage 2: every family is exhausted for this player. Serve the least
  -- recently relevant thing the season shield still allows -- the old
  -- primary pool -- and leave a trail for the coverage dashboards.
  if not found then
    v_stage := 'season_fresh';
    select q.* into v_question
    from public.questions q
    where q.territory_id = v_session.territory_id
      and q.active
      and (not v_session.wager or q.format = 'free_fill')
      and not exists (
        select 1
        from public.season_question_seen sqs
        where sqs.season_id = v_session.season_id
          and sqs.question_id = q.id
          and sqs.served_to = v_session.user_id
          and sqs.served_at > now() - interval '7 days'
      )
    order by
      case when v_session.sport_preference is not null and q.sport = v_session.sport_preference then -1
           when q.sport = any(v_sports) then 0 else 1 end,
      abs(public.adaptive_tier(q.tier, q.attempt_count, q.correct_count) - v_session.tier),
      random()
    limit 1;
  end if;

  -- Stage 3: pool exhausted for this player this season. Fall back to the
  -- closest-tier, least-used question that this session has not already
  -- served, so a streak can never be handed the answer it just gave.
  if not found then
    v_stage := 'session_unseen';
    select q.* into v_question
    from public.questions q
    where q.territory_id = v_session.territory_id and q.active
      and (not v_session.wager or q.format = 'free_fill')
      and not exists (
        select 1 from public.question_attempts qa
        where qa.session_id = p_session_id and qa.question_id = q.id
      )
    order by
      abs(public.adaptive_tier(q.tier, q.attempt_count, q.correct_count) - v_session.tier),
      q.attempt_count asc,
      random()
    limit 1;
  end if;

  -- Last resort: the territory has fewer active questions than this streak needs
  -- answers. Repeating beats stranding the player mid-streak with an error that
  -- would roll back the answer they just got right.
  if not found then
    v_stage := 'repeat';
    select q.* into v_question
    from public.questions q
    where q.territory_id = v_session.territory_id and q.active
    order by q.attempt_count asc, random()
    limit 1;
  end if;

  if not found then raise exception 'This state has no active questions'; end if;

  if v_stage <> 'lifetime_fresh' then
    insert into public.serving_events(event, user_id, season_id, territory_id, detail)
    values ('pool_thin', v_session.user_id, v_session.season_id, v_session.territory_id,
            jsonb_build_object('stage', v_stage, 'question_id', v_question.id));
  end if;

  insert into public.season_question_seen(season_id, question_id, served_to, served_at)
  values (v_session.season_id, v_question.id, v_session.user_id, now())
  on conflict (season_id, question_id, served_to)
  do update set served_at = excluded.served_at;

  insert into public.user_question_history(user_id, family_key, question_id)
  values (v_session.user_id, coalesce(v_question.family_key, v_question.id::text), v_question.id)
  on conflict (user_id, family_key)
  do update set
    last_served_at = now(),
    times_served = public.user_question_history.times_served + 1,
    question_id = excluded.question_id;

  v_tier := public.adaptive_tier(v_question.tier, v_question.attempt_count, v_question.correct_count);
  v_expires := now() + case when v_tier = 3 then interval '45 seconds' else interval '30 seconds' end;

  insert into public.question_attempts(session_id, question_id, user_id, expires_at, served_tier)
  values (p_session_id, v_question.id, v_session.user_id, v_expires, v_tier)
  returning id into v_attempt;

  update public.game_sessions set current_attempt_id = v_attempt where id = p_session_id;

  return jsonb_build_object(
    'attempt_id', v_attempt,
    'text', v_question.question_text,
    'format', v_question.format,
    'options', public.shuffle_options(v_question.options, v_attempt),
    'tier', v_tier,
    'sport', v_question.sport,
    'link_type', v_question.link_type,
    'expires_at', v_expires
  );
end;
$$;

-- ------------------------------------------------- season awards in recap

-- Transcribed from the LIVE definition; [P3d] the end-of-season recap gains
-- an awards block computed from attempts and the rivalry ledger. Every
-- award is null when the season produced no qualifying play.
create or replace function public.advance_season(p_season_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons;
  v_group public.groups;
  v_member record;
  v_state_points integer;
  v_level_points integer;
  v_region_points integer;
  v_coast_points integer;
  v_sport_points integer;
  v_total integer;
  v_today date;
  v_day integer;
begin
  select * into v_season from public.seasons where id = p_season_id for update;
  if not found then
    return;
  end if;

  select * into v_group from public.groups where id = v_season.group_id;
  v_today := public.group_local_date(v_group.id);
  v_day := greatest(1, least(v_group.season_length, v_today - v_season.started_at::date + 1));

  perform public.resolve_expired_sessions(v_season.id);
  perform public.resolve_expired_attacks(v_season.id);

  update public.seasons set current_day = v_day where id = v_season.id and current_day is distinct from v_day;

  if v_season.last_scored_on < v_today then
    if v_day > greatest(1, v_group.season_length - 3) then
      update public.season_territories
        set hold_level = greatest(1, hold_level - 1), updated_at = now()
      where season_id = v_season.id and hold_level > 1 and contested = false;

      insert into public.activity_events(season_id, event_type, message)
      values (v_season.id, 'twilight_decay', 'Twilight phase: every fortified state lost one garrison level.');
    end if;

    for v_member in
      select user_id from public.group_members where group_id = v_season.group_id
    loop
      select count(*) into v_state_points
      from public.season_territories
      where season_id = v_season.id and owner_id = v_member.user_id;

      select count(*) into v_level_points
      from public.season_territories
      where season_id = v_season.id and owner_id = v_member.user_id and hold_level = 3;

      select count(*) * 5 into v_region_points
      from (
        select t.region
        from public.territories t
        join public.season_territories st on st.territory_id = t.id and st.season_id = v_season.id
        where st.owner_id = v_member.user_id
        group by t.region
        having count(*) = (
          select count(*)
          from public.territories t2
          join public.season_territories st2 on st2.territory_id = t2.id and st2.season_id = v_season.id
          where t2.region = t.region
        )
      ) full_regions;

      select case when
        exists (
          select 1 from public.season_territories
          where season_id = v_season.id and owner_id = v_member.user_id
            and territory_id = any(array['WA','OR','CA','AK','HI'])
        ) and exists (
          select 1 from public.season_territories
          where season_id = v_season.id and owner_id = v_member.user_id
            and territory_id = any(array['ME','NH','MA','RI','CT','NY','NJ','DE','MD','VA','NC','SC','GA','FL'])
        ) then 3 else 0 end into v_coast_points;

      select case when count(distinct q.sport) >= 3 then 2 else 0 end into v_sport_points
      from public.question_attempts qa
      join public.questions q on q.id = qa.question_id
      join public.game_sessions gs on gs.id = qa.session_id
      where gs.season_id = v_season.id
        and qa.user_id = v_member.user_id
        and qa.is_correct = true
        and (qa.answered_at at time zone coalesce(v_group.timezone, 'UTC'))::date
          = (now() at time zone coalesce(v_group.timezone, 'UTC'))::date;

      v_total := coalesce(v_state_points, 0)
        + coalesce(v_level_points, 0)
        + coalesce(v_region_points, 0)
        + coalesce(v_coast_points, 0)
        + coalesce(v_sport_points, 0);

      insert into public.daily_score_events(season_id, user_id, scored_on, points)
      values (v_season.id, v_member.user_id, v_today, v_total)
      on conflict do nothing;

      if found then
        update public.player_actions
          set cumulative_score = cumulative_score + v_total, updated_at = now()
        where season_id = v_season.id and user_id = v_member.user_id;
      end if;
    end loop;

    update public.seasons set last_scored_on = v_today, current_day = v_day where id = v_season.id;
  end if;

  if v_season.ends_at <= now() + make_interval(days => coalesce(v_group.day_offset, 0)) then
    insert into public.season_recaps(season_id, recap)
    select v_season.id, jsonb_build_object(
      'winner', (
        select jsonb_build_object('user_id', pa.user_id, 'display_name', p.display_name, 'score', pa.cumulative_score)
        from public.player_actions pa
        join public.profiles p on p.id = pa.user_id
        where pa.season_id = v_season.id
        order by pa.cumulative_score desc
        limit 1
      ),
      'most_states', (
        select jsonb_build_object('user_id', st.owner_id, 'display_name', p.display_name, 'states', count(*))
        from public.season_territories st
        join public.profiles p on p.id = st.owner_id
        where st.season_id = v_season.id and st.owner_id is not null
        group by st.owner_id, p.display_name
        order by count(*) desc
        limit 1
      ),
      -- [P3d] the awards block.
      'awards', jsonb_build_object(
        'best_defender', (
          select jsonb_build_object('user_id', l.defender_id, 'display_name', p.display_name, 'defenses_held', count(*))
          from public.pvp_ledger l
          join public.profiles p on p.id = l.defender_id
          where l.season_id = v_season.id and l.outcome = 'defender_held'
          group by l.defender_id, p.display_name
          order by count(*) desc, max(l.created_at) asc
          limit 1
        ),
        'sharpest_sport', (
          select jsonb_build_object('user_id', qa.user_id, 'display_name', p.display_name, 'sport', q.sport,
                                    'correct', count(*) filter (where qa.is_correct),
                                    'attempts', count(*))
          from public.question_attempts qa
          join public.game_sessions gs on gs.id = qa.session_id
          join public.questions q on q.id = qa.question_id
          join public.profiles p on p.id = qa.user_id
          where gs.season_id = v_season.id and qa.answered_at is not null
          group by qa.user_id, p.display_name, q.sport
          having count(*) >= 5
          order by count(*) filter (where qa.is_correct)::numeric / count(*) desc, count(*) desc
          limit 1
        ),
        'fastest_gun', (
          select jsonb_build_object('user_id', qa.user_id, 'display_name', p.display_name,
                                    'avg_seconds', round(avg(extract(epoch from qa.answered_at - qa.served_at))::numeric, 1))
          from public.question_attempts qa
          join public.game_sessions gs on gs.id = qa.session_id
          join public.profiles p on p.id = qa.user_id
          where gs.season_id = v_season.id and qa.is_correct
          group by qa.user_id, p.display_name
          having count(*) >= 5
          order by avg(qa.answered_at - qa.served_at) asc
          limit 1
        ),
        'upset', (
          select jsonb_build_object('attacker_id', l.attacker_id, 'attacker_name', pa.display_name,
                                    'defender_id', l.defender_id, 'defender_name', pd.display_name,
                                    'territory_id', l.territory_id, 'score_gap', sd.cumulative_score - sa.cumulative_score)
          from public.pvp_ledger l
          join public.player_actions sa on sa.season_id = l.season_id and sa.user_id = l.attacker_id
          join public.player_actions sd on sd.season_id = l.season_id and sd.user_id = l.defender_id
          join public.profiles pa on pa.id = l.attacker_id
          join public.profiles pd on pd.id = l.defender_id
          where l.season_id = v_season.id and l.outcome = 'attacker_won'
            and sd.cumulative_score > sa.cumulative_score
          order by sd.cumulative_score - sa.cumulative_score desc, l.created_at asc
          limit 1
        ),
        'rivalry', (
          select jsonb_build_object('a_id', pair.a, 'a_name', pa.display_name,
                                    'b_id', pair.b, 'b_name', pb.display_name,
                                    'clashes', pair.clashes)
          from (
            select least(l.attacker_id::text, l.defender_id::text)::uuid as a,
                   greatest(l.attacker_id::text, l.defender_id::text)::uuid as b,
                   count(*) as clashes
            from public.pvp_ledger l
            where l.season_id = v_season.id
            group by 1, 2
            order by count(*) desc, max(l.created_at) desc
            limit 1
          ) pair
          join public.profiles pa on pa.id = pair.a
          join public.profiles pb on pb.id = pair.b
        )
      ),
      'ended_at', now()
    )
    on conflict (season_id) do nothing;

    update public.seasons set status = 'ended', current_day = v_group.season_length where id = v_season.id;
    update public.groups set status = 'ended' where id = v_season.group_id;
    insert into public.activity_events(season_id, event_type, message)
    values (v_season.id, 'season_ended', 'The season ended. Final scores are locked.');
  end if;
end;
$$;
