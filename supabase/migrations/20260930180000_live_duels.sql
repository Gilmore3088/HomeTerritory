-- Phase 3, P3d task 3: live duels.
--
-- When both fighters are at the table the async dance is optional: the
-- DEFENDER proposes a duel on a contested attack, the ATTACKER accepts,
-- and both face the SAME question at the same moment -- first correct
-- answer, graded server-side under the duel row's lock, wins the state on
-- the spot. Nobody can be forced into one: an unaccepted proposal lapses
-- after five minutes and the ordinary 24-hour async defense stays exactly
-- as it was. Presence (who is online right now) is a client-side Realtime
-- concern that only gates the UI affordance; the database only ever
-- requires both parties' explicit consent.
--
-- Settlement truth table (first to submit a CORRECT answer wins; the row
-- lock serializes ties):
--   defender correct first  -> attack repelled, garrison rules as usual
--                              (wager attacks still raise nothing)
--   attacker correct first  -> resolve_attack_win(..., 'duel')
--   both wrong / clock out  -> duel is void, the async path continues
-- A duel found settled, lapsed or orphaned (attack no longer contested)
-- reports that instead of acting.

create table public.duels (
  id uuid primary key default gen_random_uuid(),
  attack_id uuid not null references public.attacks(id) unique,
  season_id uuid not null references public.seasons(id) on delete cascade,
  territory_id text not null,
  attacker_id uuid not null,
  defender_id uuid not null,
  question_id uuid references public.questions(id),
  status text not null default 'proposed'
    check (status in ('proposed', 'active', 'settled', 'void')),
  proposed_at timestamptz not null default now(),
  started_at timestamptz,
  expires_at timestamptz,
  winner_id uuid,
  attacker_answer text,
  attacker_answered_at timestamptz,
  attacker_correct boolean,
  defender_answer text,
  defender_answered_at timestamptz,
  defender_correct boolean
);

create index duels_season_idx on public.duels(season_id, status);

alter table public.duels enable row level security;
revoke all on table public.duels from public, anon, authenticated;
grant all on table public.duels to service_role;

-- The defender throws down the gauntlet on an attack they must defend.
create or replace function public.duel_propose(p_attack_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_attack public.attacks;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_attack from public.attacks where id = p_attack_id for update;
  if not found or v_attack.status <> 'contested' then raise exception 'Active attack not found'; end if;
  if v_attack.defender_id <> v_user then raise exception 'Only the defender can propose a duel'; end if;
  if v_attack.defense_deadline <= now() then raise exception 'The defense window expired'; end if;
  if exists (
    select 1 from public.game_sessions
    where attack_id = p_attack_id and action_type = 'defend' and status in ('active', 'completed', 'failed')
  ) then raise exception 'This defense has already been played'; end if;

  -- A lapsed or voided earlier duel clears the way for a fresh proposal.
  delete from public.duels
  where attack_id = p_attack_id
    and (status = 'void' or (status = 'proposed' and proposed_at < now() - interval '5 minutes'));
  insert into public.duels(attack_id, season_id, territory_id, attacker_id, defender_id)
  values (p_attack_id, v_attack.season_id, v_attack.territory_id, v_attack.attacker_id, v_attack.defender_id);

  return jsonb_build_object('status', 'proposed');
exception when unique_violation then
  raise exception 'A duel is already proposed for this attack';
end;
$$;

revoke all on function public.duel_propose(uuid) from public, anon;
grant execute on function public.duel_propose(uuid) to authenticated, service_role;

-- The attacker accepts: the shared question is chosen now and the clock
-- starts for both.
create or replace function public.duel_accept(p_attack_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_duel public.duels;
  v_attack public.attacks;
  v_question public.questions;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_duel from public.duels where attack_id = p_attack_id for update;
  if not found or v_duel.status <> 'proposed' then raise exception 'No open duel proposal'; end if;
  if v_duel.attacker_id <> v_user then raise exception 'Only the attacker can accept a duel'; end if;
  if v_duel.proposed_at < now() - interval '5 minutes' then
    update public.duels set status = 'void' where id = v_duel.id;
    raise exception 'The duel proposal lapsed';
  end if;
  select * into v_attack from public.attacks where id = p_attack_id for update;
  if v_attack.status <> 'contested' or v_attack.defense_deadline <= now() then
    update public.duels set status = 'void' where id = v_duel.id;
    raise exception 'Active attack not found';
  end if;
  if exists (
    select 1 from public.game_sessions
    where attack_id = p_attack_id and action_type = 'defend' and status in ('active', 'completed', 'failed')
  ) then
    update public.duels set status = 'void' where id = v_duel.id;
    raise exception 'This defense has already been played';
  end if;

  -- The shared question: the state's pool at the attack's tier, free-fill
  -- for a wager, preferring a family NEITHER player has ever seen. One
  -- question for two players is the duel's own uniqueness exception, and
  -- it burns the family for both.
  select q.* into v_question
  from public.questions q
  where q.territory_id = v_duel.territory_id
    and q.active
    and (not v_attack.wager or q.format = 'free_fill')
  order by
    (exists (select 1 from public.user_question_history h
             where h.user_id in (v_duel.attacker_id, v_duel.defender_id)
               and h.family_key = coalesce(q.family_key, q.id::text))),
    abs(public.adaptive_tier(q.tier, q.attempt_count, q.correct_count) - v_attack.tier),
    random()
  limit 1;
  if not found then raise exception 'This state has no active questions'; end if;

  insert into public.user_question_history(user_id, family_key, question_id)
  select p, coalesce(v_question.family_key, v_question.id::text), v_question.id
  from unnest(array[v_duel.attacker_id, v_duel.defender_id]) as p
  on conflict (user_id, family_key)
  do update set last_served_at = now(), question_id = excluded.question_id;

  update public.duels
  set status = 'active', question_id = v_question.id,
      started_at = now(), expires_at = now() + interval '60 seconds'
  where id = v_duel.id;

  insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
  select v_duel.season_id, v_user, 'duel_started', v_duel.territory_id,
         format('%s accepted a live duel for %s.',
                (select display_name from public.profiles where id = v_user),
                (select name from public.territories where id = v_duel.territory_id));

  return public.duel_state(v_duel.season_id);
end;
$$;

revoke all on function public.duel_accept(uuid) from public, anon;
grant execute on function public.duel_accept(uuid) to authenticated, service_role;

-- My duels in a season: proposals waiting on me, and the live one with its
-- question. Lapsed proposals and clocked-out duels are settled lazily here.
create or replace function public.duel_state(p_season_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_season public.seasons;
  v_duel record;
  v_rows jsonb := '[]'::jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_season from public.seasons where id = p_season_id;
  if not found then raise exception 'Season not found'; end if;
  if not public.is_group_member(v_season.group_id, v_user) then raise exception 'You are not in this group'; end if;

  -- Lazy sweep: a duel whose clock ran out with no winner is void.
  update public.duels
  set status = 'void'
  where season_id = p_season_id and status = 'active' and expires_at <= now() and winner_id is null;

  for v_duel in
    select d.*, q.question_text, q.format, q.options,
           pa.display_name as attacker_name, pd.display_name as defender_name
    from public.duels d
    left join public.questions q on q.id = d.question_id
    join public.profiles pa on pa.id = d.attacker_id
    join public.profiles pd on pd.id = d.defender_id
    where d.season_id = p_season_id
      and (d.attacker_id = v_user or d.defender_id = v_user)
      and (d.status in ('proposed', 'active')
           or (d.status = 'settled' and d.started_at > now() - interval '5 minutes'))
    order by d.proposed_at desc
  loop
    v_rows := v_rows || jsonb_build_object(
      'attack_id', v_duel.attack_id,
      'territory_id', v_duel.territory_id,
      'status', v_duel.status,
      'attacker_name', v_duel.attacker_name,
      'defender_name', v_duel.defender_name,
      'i_am', case when v_duel.attacker_id = v_user then 'attacker' else 'defender' end,
      'winner_id', v_duel.winner_id,
      'expires_at', v_duel.expires_at,
      'question', case when v_duel.status = 'active' then jsonb_build_object(
        'text', v_duel.question_text,
        'format', v_duel.format,
        'options', public.shuffle_options(v_duel.options, v_duel.id)
      ) end,
      'answered', case when v_duel.attacker_id = v_user
                       then v_duel.attacker_answered_at is not null
                       else v_duel.defender_answered_at is not null end
    );
  end loop;

  return v_rows;
end;
$$;

revoke all on function public.duel_state(uuid) from public, anon;
grant execute on function public.duel_state(uuid) to authenticated, service_role;

-- One shot each. First correct answer, graded here under the duel lock,
-- moves the map immediately.
create or replace function public.duel_answer(p_attack_id uuid, p_answer text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_duel public.duels;
  v_attack public.attacks;
  v_question public.questions;
  v_correct boolean;
  v_is_attacker boolean;
  v_other_missed boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_duel from public.duels where attack_id = p_attack_id for update;
  if not found then raise exception 'No live duel here'; end if;
  if v_user not in (v_duel.attacker_id, v_duel.defender_id) then raise exception 'This is not your duel'; end if;
  -- Losing the race to a settled duel is an outcome, not an error.
  if v_duel.status = 'settled' then
    return jsonb_build_object('status', 'settled', 'winner_id', v_duel.winner_id,
      'message', case when v_duel.winner_id = v_user then 'You already won this duel.'
                      else 'Too late — your opponent answered first.' end);
  end if;
  if v_duel.status <> 'active' then raise exception 'No live duel here'; end if;
  v_is_attacker := v_user = v_duel.attacker_id;
  if (v_is_attacker and v_duel.attacker_answered_at is not null)
     or (not v_is_attacker and v_duel.defender_answered_at is not null) then
    raise exception 'You already answered';
  end if;

  select * into v_question from public.questions where id = v_duel.question_id;
  v_correct := now() <= v_duel.expires_at and public.answer_matches(v_question, p_answer);

  if v_is_attacker then
    update public.duels
    set attacker_answer = p_answer, attacker_answered_at = now(), attacker_correct = v_correct
    where id = v_duel.id returning * into v_duel;
  else
    update public.duels
    set defender_answer = p_answer, defender_answered_at = now(), defender_correct = v_correct
    where id = v_duel.id returning * into v_duel;
  end if;

  if v_correct then
    -- The attack row is the final arbiter: if it settled some other way
    -- while this duel ran, the duel dies rather than double-resolving.
    select * into v_attack from public.attacks where id = p_attack_id for update;
    if v_attack.status <> 'contested' then
      update public.duels set status = 'void' where id = v_duel.id;
      return jsonb_build_object('status', 'void', 'correct', true,
        'message', 'The attack was settled before the duel finished.');
    end if;

    update public.duels set status = 'settled', winner_id = v_user where id = v_duel.id;
    if v_is_attacker then
      perform public.resolve_attack_win(p_attack_id, 'duel');
    else
      update public.attacks set status = 'repelled', resolved_at = now() where id = p_attack_id;
      update public.season_territories
      set contested = false,
          hold_level = least(3, hold_level + case when v_attack.wager then 0 else 1 end),
          updated_at = now()
      where season_id = v_duel.season_id and territory_id = v_duel.territory_id;
      insert into public.pvp_ledger(group_id, season_id, territory_id, attacker_id, defender_id, outcome, reason, wager)
      select s.group_id, v_duel.season_id, v_duel.territory_id, v_duel.attacker_id, v_duel.defender_id,
             'defender_held', 'duel', v_attack.wager
      from public.seasons s where s.id = v_duel.season_id;
      insert into public.activity_events(season_id, actor_id, event_type, territory_id, message)
      values (v_duel.season_id, v_user, 'attack_repelled', v_duel.territory_id,
        format('%s won the duel and held %s.',
               (select display_name from public.profiles where id = v_user),
               (select name from public.territories where id = v_duel.territory_id)));
    end if;
    return jsonb_build_object('status', 'won', 'correct', true,
      'correct_answer', v_question.correct_answer,
      'message', 'First correct answer. The state is settled.');
  end if;

  -- Wrong: if the other side already missed too, the duel dies and the
  -- ordinary async defense window carries on untouched.
  v_other_missed := case when v_is_attacker then v_duel.defender_correct is false
                         else v_duel.attacker_correct is false end;
  if v_other_missed then
    update public.duels set status = 'void' where id = v_duel.id;
    return jsonb_build_object('status', 'void', 'correct', false,
      'correct_answer', v_question.correct_answer,
      'message', 'Both missed. The duel is off; the async defense continues.');
  end if;

  return jsonb_build_object('status', 'waiting', 'correct', false,
    'correct_answer', v_question.correct_answer,
    'message', 'Missed. If your opponent answers correctly, they win.');
end;
$$;

revoke all on function public.duel_answer(uuid, text) from public, anon;
grant execute on function public.duel_answer(uuid, text) to authenticated, service_role;

-- An active duel parks the async defense button so the two paths cannot
-- race each other from the defender's own hands; a mere proposal blocks
-- nothing. (Transcribing only the defend guard would mean re-stating the
-- whole of game_begin_action again; instead the guard lives in a trigger
-- so the engine function stays at its live definition.)
create or replace function public.block_defense_during_duel()
returns trigger
language plpgsql
as $$
begin
  if new.action_type = 'defend' and exists (
    select 1 from public.duels d
    where d.attack_id = new.attack_id and d.status = 'active' and d.expires_at > now()
  ) then
    raise exception 'A live duel is underway for this state';
  end if;
  return new;
end;
$$;

create trigger block_defense_during_duel_trigger
before insert on public.game_sessions
for each row execute function public.block_defense_during_duel();
