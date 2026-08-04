# Remove Bot Players Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove bot players from the game entirely — schema, engine functions, client UI, and tests — and restore the `profiles.id -> auth.users.id` foreign key that was dropped solely to let bots exist without auth accounts.

**Architecture:** One additive migration redefines the four live functions that reference bots (`start_season`, `end_test_turn`, `group_snapshot`, `advance_season`) from their current live definitions with the bot branches deleted, drops `run_test_bot_turns` and `bot_action_log`, cleans existing bot/orphan rows, drops `profiles.is_bot`, and restores `profiles_id_fkey`. Client and tests then drop their `is_bot` handling. Migrations in this repo compose — old migration files are history and are never edited.

**Tech Stack:** Postgres/plpgsql (Supabase migrations), TypeScript 5.9 strict, React 19 / Next.js 16, node built-in test runner (`tests/db/*` need `SUPABASE_TEST_ANON_KEY`/`SUPABASE_TEST_SERVICE_KEY` from `npx supabase status` against the local stack at `http://127.0.0.1:55321`).

## Global Constraints

- Branch: this worktree's branch (created from `origin/main`). Conventional commits ending with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- After every task: `npm test`, `npm run typecheck`, `npm run build`, `npm run lint` all exit 0. DB tasks additionally run `npm run test:db` (stack env exported).
- Never edit an existing migration file — new migration only: `supabase/migrations/20260804210000_remove_bot_players.sql`.
- Apply the new migration to the running local stack with `npx supabase migration up` (do NOT `stack:reset`; the seeded leagues, including the bot-containing "Solo vs Bots" group, are the live proof the data cleanup works).
- Decision context (user, 2026-08-04): bots were test scaffolding only; a trivia game cannot have meaningful bot opponents. The "solo-vs-bots turn mode" priority from `docs/HANDOFF.md` is dead — do not build any replacement for it in this plan.
- No new npm dependencies. No `console.log`. No emojis in code.

## Bot surface (verified against live definitions, 2026-08-04)

| Piece | Live definition lives in | Action |
| --- | --- | --- |
| `profiles.is_bot` column | `20260730074000_support_test_bot_players.sql` | drop column |
| dropped `profiles_id_fkey` | same file (line 3) | restore FK |
| `bot_action_log` table | `20260802173000_..._and_bots.sql` | drop table |
| `run_test_bot_turns(uuid)` | `20260802173100_complete_stabilization_functions.sql` | drop function |
| `start_season(uuid)` | `20260803180700_fix_group_local_day_boundaries.sql` | redefine, bot branches removed |
| `end_test_turn(uuid)` | `20260803180700_fix_group_local_day_boundaries.sql` | redefine, human-only filters removed |
| `group_snapshot(uuid)` | `20260730220000_add_playtest_turn_handoff.sql` | redefine, `is_bot` key removed |
| `advance_season(uuid)` | `20260803233000_extract_advance_season.sql` | redefine, `perform run_test_bot_turns` removed |
| `lib/game-types.ts:16` `is_bot?: boolean` | — | remove field |
| `components/lobby-stage.tsx:26,68` | — | drop human/bot split |
| `tests/db/audit.test.ts:983-996` finding-6 probe | — | replace with function-gone assertion |
| `docs/superpowers/local-stack.md:92` "runs bot turns" | — | reword |
| `docs/superpowers/backlog.md` P5 `profiles_id_fkey` item | — | mark resolved |

All other `is_bot` hits in migrations are superseded function versions (history — leave untouched). `resolve_attack_win(id, reason)` takes a free-text reason; the `'bot_defense'` caller dies with `run_test_bot_turns`, no change to `resolve_attack_win` itself.

---

### Task 1: Migration — schema + engine, TDD via a new DB test file

**Files:**
- Create: `supabase/migrations/20260804210000_remove_bot_players.sql`
- Test: `tests/db/remove-bots.test.ts`

**Interfaces:**
- Consumes: `tests/db/helpers.ts` exports `admin` (service-role client), `createTestUser(displayName)` (returns a signed-in `SupabaseClient`).
- Produces: `group_snapshot` members entries WITHOUT an `is_bot` key (Task 2's client types rely on this); `start_season` error copy `At least two players are required`; `end_test_turn` error copy `At least two players are required to rotate turns`.

- [ ] **Step 1: Write the failing tests** — `tests/db/remove-bots.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { admin, createTestUser } from "./helpers.ts";

// The engine after bot removal: no is_bot column, no bot_action_log, no
// run_test_bot_turns, profiles_id_fkey restored, and snapshot/start/rotate
// all reasoning about members only.

test("profiles.is_bot column is gone", async () => {
  const probe = await admin.from("profiles").select("is_bot").limit(1);
  assert.ok(probe.error, "selecting is_bot should fail once the column is dropped");
});

test("bot_action_log table is gone", async () => {
  const probe = await admin.from("bot_action_log").select("*").limit(1);
  assert.ok(probe.error, "bot_action_log should no longer exist");
});

test("run_test_bot_turns no longer exists for any role", async () => {
  const probe = await admin.rpc("run_test_bot_turns", {
    p_season_id: "00000000-0000-0000-0000-000000000000",
  });
  assert.ok(probe.error, "the function should be dropped");
  assert.match(probe.error!.message, /could not find|does not exist|schema cache/i);
});

test("profiles_id_fkey is restored against auth.users", async () => {
  // An insert with no matching auth user must now be rejected.
  const ghost = crypto.randomUUID();
  const ins = await admin.from("profiles").insert({ id: ghost, display_name: "Ghost" });
  assert.ok(ins.error, "profiles without an auth.users row must be rejected");
  assert.match(ins.error!.message, /foreign key|violates/i);
});

test("no profile rows survive without an auth user, and none are bots", async () => {
  // The migration's cleanup pass: every remaining profile joins to auth.users.
  // Verified via the restored FK above plus a direct orphan count through the
  // service role (auth schema is reachable with the service key via rpc-less
  // select on profiles only, so assert emptiness indirectly: the FK insert
  // rejection in the previous test proves enforcement; here just assert the
  // seeded bot profiles are gone by display_name convention).
  const bots = await admin.from("profiles").select("id, display_name").ilike("display_name", "%(bot)%");
  assert.equal(bots.error, null);
  assert.deepEqual(bots.data, [], "seeded bot profiles should have been deleted");
});

test("start_season requires two members and seeds all homes at hold 1", async () => {
  const solo = await createTestUser("Sol");
  const create = await solo.rpc("create_group_v2", {
    p_name: "No Bots Solo", p_sports: ["NFL"], p_season_length: 14,
    p_opening_mode: "open", p_board_scope: "fifty", p_difficulty: "standard", p_test_mode: true,
  });
  assert.equal(create.error, null);
  const groupId = create.data as string;
  const home = await solo.rpc("set_home_state", { p_group_id: groupId, p_home_state: "MT" });
  assert.equal(home.error, null);

  const aloneStart = await solo.rpc("start_season", { p_group_id: groupId });
  assert.ok(aloneStart.error, "a single member cannot start a season");
  assert.match(aloneStart.error!.message, /at least two players/i);

  const rival = await createTestUser("Riv");
  const { data: inviteRows } = await admin.from("groups").select("invite_code").eq("id", groupId).single();
  const join = await rival.rpc("join_group", { p_invite_code: inviteRows!.invite_code });
  assert.equal(join.error, null);
  const rivalHome = await rival.rpc("set_home_state", { p_group_id: groupId, p_home_state: "WY" });
  assert.equal(rivalHome.error, null);

  const start = await solo.rpc("start_season", { p_group_id: groupId });
  assert.equal(start.error, null, start.error?.message);

  const holds = await admin
    .from("season_territories")
    .select("territory_id, hold_level, owner_id")
    .eq("season_id", start.data as string)
    .not("owner_id", "is", null);
  assert.equal(holds.error, null);
  for (const row of holds.data!) {
    assert.equal(row.hold_level, 1, "every seeded home starts at hold 1 (the bot=2 branch is gone)");
  }

  const snap = await solo.rpc("group_snapshot", { p_group_id: groupId });
  assert.equal(snap.error, null);
  const members = (snap.data as { members: Array<Record<string, unknown>> }).members;
  assert.equal(members.length, 2);
  for (const member of members) {
    assert.equal("is_bot" in member, false, "snapshot members no longer carry is_bot");
  }

  const rotate = await solo.rpc("end_test_turn", { p_group_id: groupId });
  assert.equal(rotate.error, null, rotate.error?.message);
  assert.equal((rotate.data as { next_user_id: string }).next_user_id !== null, true);
});
```

- [ ] **Step 2: Run to verify the suite fails today** — with the stack env exported:

Run: `npm run test:db -- --test-name-pattern ""` — or directly: `node --experimental-strip-types --test tests/db/remove-bots.test.ts`
Expected: FAIL — `is_bot` selects fine, `bot_action_log` exists, `run_test_bot_turns` returns a role error (exists), ghost-profile insert succeeds, bot profiles present.

- [ ] **Step 3: Write the migration** — `supabase/migrations/20260804210000_remove_bot_players.sql`. The four function bodies are the LIVE definitions transcribed with only the bot logic removed (live sources noted above — re-verify against `select pg_get_functiondef(...)` if in doubt):

```sql
-- Bots are gone. They were playtest scaffolding (20260730074000), and a
-- trivia game has no honest bot opponent -- a bot either knows every answer
-- or is a dice roll. Decision recorded 2026-08-04.
--
-- This migration:
--   1. redefines start_season / end_test_turn / group_snapshot /
--      advance_season without their bot branches (live defs transcribed),
--   2. drops run_test_bot_turns and bot_action_log,
--   3. deletes bot rows and any profiles orphaned from auth.users (the
--      20260730074000 FK drop made those possible),
--   4. drops profiles.is_bot and restores profiles_id_fkey,
--      closing the account-deletion gap tracked in docs/superpowers/backlog.md (P5).

-- ---------------------------------------------------------------- functions

create or replace function public.start_season(p_group_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.groups; v_season uuid; v_members integer; v_missing integer;
  v_row record; v_owner uuid; v_first uuid; v_today date;
begin
  select * into v_group from public.groups where id=p_group_id for update;
  if not found then raise exception 'Group not found'; end if;
  if v_group.commissioner_id <> auth.uid() then raise exception 'Only the commissioner can start the season'; end if;
  if v_group.status <> 'lobby' then raise exception 'Season already started'; end if;
  v_today := public.group_local_date(p_group_id);

  select count(*) into v_members from public.group_members where group_id=p_group_id;
  if v_members < 2 then raise exception 'At least two players are required'; end if;
  select count(*) into v_missing from public.group_members where group_id=p_group_id and home_state is null;
  if v_missing > 0 then raise exception '% player(s) still need home ground', v_missing; end if;

  select user_id into v_first from public.group_members where group_id=p_group_id order by color_index limit 1;

  insert into public.seasons(group_id, ends_at, current_day, current_turn_user_id, turn_number, turn_started_at, last_scored_on)
  values (p_group_id, now()+make_interval(days=>v_group.season_length), 1, case when v_group.test_mode then v_first else null end, 1, now(), v_today) returning id into v_season;

  insert into public.season_territories(season_id, territory_id) select v_season,id from public.territories where v_group.board_scope='fifty' or id not in ('AK','HI');
  update public.season_territories st set owner_id=gm.user_id, hold_level=1 from public.group_members gm where gm.group_id=p_group_id and gm.home_state=st.territory_id and st.season_id=v_season;

  if v_group.opening_mode='dealt' then
    for v_row in select t.id, row_number() over(order by md5(t.id || v_season::text)) as rn from public.territories t where (v_group.board_scope='fifty' or t.id not in ('AK','HI')) and not exists(select 1 from public.group_members gm where gm.group_id=p_group_id and gm.home_state=t.id) loop
      select user_id into v_owner from public.group_members where group_id=p_group_id order by color_index offset ((v_row.rn-1)%v_members) limit 1;
      update public.season_territories set owner_id=v_owner,hold_level=1 where season_id=v_season and territory_id=v_row.id;
    end loop;
  end if;

  insert into public.player_actions(season_id,user_id,actions_remaining,last_refresh_on)
  select v_season,user_id,case when v_group.test_mode and user_id<>v_first then 0 else 3 end,v_today from public.group_members where group_id=p_group_id;
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
  v_member_count integer;
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

  select count(*) into v_member_count
  from public.group_members
  where group_id = p_group_id;
  if v_member_count < 2 then raise exception 'At least two players are required to rotate turns'; end if;

  select color_index into v_current_color
  from public.group_members
  where group_id = p_group_id and user_id = v_user;

  select gm.user_id, p.display_name into v_next, v_next_name
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  where gm.group_id = p_group_id
    and gm.color_index > v_current_color
  order by gm.color_index
  limit 1;

  if v_next is null then
    select gm.user_id, p.display_name into v_next, v_next_name
    from public.group_members gm
    join public.profiles p on p.id = gm.user_id
    where gm.group_id = p_group_id
    order by gm.color_index
    limit 1;
  end if;

  if v_next is null or v_next = v_user then raise exception 'No next player is available'; end if;

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

create or replace function public.group_snapshot(p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.groups; v_season public.seasons; v_members jsonb; v_territories jsonb:='[]'::jsonb; v_attacks jsonb:='[]'::jsonb;
  v_scores jsonb:='[]'::jsonb; v_activity jsonb:='[]'::jsonb; v_actions integer:=0; v_turn_name text;
begin
  if not public.is_group_member(p_group_id,auth.uid()) then raise exception 'Group access denied'; end if;
  select * into v_group from public.groups where id=p_group_id;
  select * into v_season from public.seasons where group_id=p_group_id order by created_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('user_id',gm.user_id,'display_name',p.display_name,'color_index',gm.color_index,'home_state',gm.home_state,'home_completed',gm.home_completed) order by gm.color_index),'[]'::jsonb)
    into v_members from public.group_members gm join public.profiles p on p.id=gm.user_id where gm.group_id=p_group_id;
  if v_season.id is not null then
    perform public.resolve_expired_sessions(v_season.id); perform public.resolve_expired_attacks(v_season.id); v_actions:=public.refresh_player_actions(v_season.id,auth.uid());
    select display_name into v_turn_name from public.profiles where id=v_season.current_turn_user_id;
    select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'region',t.region,'adjacent',t.adjacent,'owner_id',st.owner_id,'hold_level',st.hold_level,'contested',st.contested) order by t.name),'[]'::jsonb)
      into v_territories from public.territories t join public.season_territories st on st.territory_id=t.id where st.season_id=v_season.id;
    select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'territory_id',a.territory_id,'attacker_id',a.attacker_id,'defender_id',a.defender_id,'status',a.status,'defense_deadline',a.defense_deadline,'tier',a.tier) order by a.created_at desc),'[]'::jsonb)
      into v_attacks from public.attacks a where a.season_id=v_season.id and a.status='contested';
    select coalesce(jsonb_agg(jsonb_build_object('user_id',gm.user_id,'display_name',p.display_name,'color_index',gm.color_index,'cumulative_score',coalesce(pa.cumulative_score,0),'state_count',(select count(*) from public.season_territories st where st.season_id=v_season.id and st.owner_id=gm.user_id)) order by coalesce(pa.cumulative_score,0) desc,p.display_name),'[]'::jsonb)
      into v_scores from public.group_members gm join public.profiles p on p.id=gm.user_id left join public.player_actions pa on pa.season_id=v_season.id and pa.user_id=gm.user_id where gm.group_id=p_group_id;
    select coalesce(jsonb_agg(event order by event.created_at desc),'[]'::jsonb) into v_activity from (select id,message,created_at,territory_id from public.activity_events where season_id=v_season.id order by created_at desc limit 30) event;
  end if;
  return jsonb_build_object('current_user_id',auth.uid(),'group',jsonb_build_object('id',v_group.id,'name',v_group.name,'commissioner_id',v_group.commissioner_id,'invite_code',v_group.invite_code,'sports',v_group.sports,'status',v_group.status,'test_mode',v_group.test_mode,'opening_mode',v_group.opening_mode,'difficulty',v_group.difficulty,'board_scope',v_group.board_scope),
    'season',case when v_season.id is null then null else jsonb_build_object('id',v_season.id,'status',v_season.status,'started_at',v_season.started_at,'ends_at',v_season.ends_at,'current_day',v_season.current_day,'current_turn_user_id',v_season.current_turn_user_id,'current_turn_name',v_turn_name,'turn_number',v_season.turn_number,'turn_started_at',v_season.turn_started_at) end,
    'members',v_members,'territories',v_territories,'attacks',v_attacks,'scores',v_scores,'activity',v_activity,'actions_remaining',v_actions,
    'is_my_turn',case when not coalesce(v_group.test_mode,false) then true else v_season.current_turn_user_id=auth.uid() end);
end;
$$;

-- advance_season: live body from 20260803233000 with the single
-- `perform public.run_test_bot_turns(v_season.id);` line removed. Transcribe
-- the rest verbatim (resolve_expired_sessions / resolve_expired_attacks /
-- current_day update / twilight decay / scoring loop / season-end recap).

-- [implementer: copy the full body from
--  supabase/migrations/20260803233000_extract_advance_season.sql lines 14-149,
--  deleting only the run_test_bot_turns perform line.]

-- ---------------------------------------------------------------- drops

drop function if exists public.run_test_bot_turns(uuid);
drop table if exists public.bot_action_log;

-- ---------------------------------------------------------------- data

-- Doomed profiles: anything flagged is_bot, plus anything orphaned from
-- auth.users (possible only while the FK was down). Clean their references in
-- FK-dependency order, then the profiles themselves.
create temporary table doomed on commit drop as
  select id from public.profiles where coalesce(is_bot, false)
  union
  select p.id from public.profiles p left join auth.users u on u.id = p.id where u.id is null;

-- question_reports has no cascade from question_attempts; clear reports tied
-- to doomed reporters or doomed users' attempts first.
delete from public.question_reports
where reported_by in (select id from doomed)
   or attempt_id in (select qa.id from public.question_attempts qa where qa.user_id in (select id from doomed));

delete from public.game_sessions where user_id in (select id from doomed);
delete from public.season_question_seen where served_to in (select id from doomed);

update public.season_territories st
set contested = false, updated_at = now()
where contested and exists (
  select 1 from public.attacks a
  where a.season_id = st.season_id and a.territory_id = st.territory_id
    and a.status = 'contested'
    and (a.attacker_id in (select id from doomed) or a.defender_id in (select id from doomed))
);
delete from public.attacks where attacker_id in (select id from doomed) or defender_id in (select id from doomed);

update public.season_territories set owner_id = null, hold_level = 1, updated_at = now()
where owner_id in (select id from doomed);

delete from public.cooldowns where user_id in (select id from doomed);
delete from public.fortify_log where user_id in (select id from doomed);
delete from public.daily_score_events where user_id in (select id from doomed);
delete from public.player_actions where user_id in (select id from doomed);
update public.activity_events set actor_id = null where actor_id in (select id from doomed);
update public.seasons set current_turn_user_id = null where current_turn_user_id in (select id from doomed);
delete from public.group_members where user_id in (select id from doomed);

-- Groups commissioned by a doomed profile are unrecoverable test debris.
-- Their seasons cascade, but question_reports on those seasons' attempts do
-- not -- clear those first.
delete from public.question_reports
where attempt_id in (
  select qa.id
  from public.question_attempts qa
  join public.game_sessions gs on gs.id = qa.session_id
  join public.seasons s on s.id = gs.season_id
  where s.group_id in (select id from public.groups where commissioner_id in (select id from doomed))
);
delete from public.groups where commissioner_id in (select id from doomed);

delete from public.profiles where id in (select id from doomed);

-- ---------------------------------------------------------------- schema

alter table public.profiles drop column if exists is_bot;

alter table public.profiles
  add constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade;
```

Grant hygiene note: `create or replace` preserves each function's existing grants (start_season / end_test_turn / group_snapshot: authenticated; advance_season: service_role) — re-assert them at the end of the migration anyway, matching the Phase-1 convention:

```sql
revoke execute on function public.start_season(uuid) from public, anon;
grant execute on function public.start_season(uuid) to authenticated;
revoke execute on function public.end_test_turn(uuid) from public, anon;
grant execute on function public.end_test_turn(uuid) to authenticated;
revoke execute on function public.group_snapshot(uuid) from public, anon;
grant execute on function public.group_snapshot(uuid) to authenticated;
revoke all on function public.advance_season(uuid) from public, anon, authenticated;
grant execute on function public.advance_season(uuid) to service_role;
```

- [ ] **Step 4: Apply and verify** —

Run: `npx supabase migration up` (against the running stack)
Then: `node --experimental-strip-types --test tests/db/remove-bots.test.ts` (stack env exported)
Expected: migration applies cleanly (the seeded "Solo vs Bots" group's bots are deleted by the data pass); all new tests PASS.

- [ ] **Step 5: Run the whole DB suite** — `npm run test:db`. Expected: the finding-6 probe in `audit.test.ts` FAILS (it asserts `run_test_bot_turns` exists but is unreachable — the function is now gone and the error shape changes). That failure is Task 3's job; every other test passes. If anything ELSE fails, stop and investigate before continuing.

- [ ] **Step 6: Commit** —

```bash
git add supabase/migrations/20260804210000_remove_bot_players.sql tests/db/remove-bots.test.ts
git commit -m "feat(engine): remove bot players and restore profiles_id_fkey"
```

---

### Task 2: Client cleanup

**Files:**
- Modify: `lib/game-types.ts:16` (remove `is_bot`)
- Modify: `components/lobby-stage.tsx:26-27,68-69` (drop the human/bot split)

**Interfaces:**
- Consumes: Task 1's snapshot shape (members without `is_bot`).
- Produces: nothing new — `Snapshot["members"]` element type loses `is_bot`.

- [ ] **Step 1: Remove the type field** — in `lib/game-types.ts`, delete the `is_bot?: boolean;` line from the member type.

- [ ] **Step 2: Simplify the lobby** — in `components/lobby-stage.tsx`:
  - Line 26: delete `const humans = snapshot.members.filter((member) => !member.is_bot);`
  - Line 27: `const homesReady = snapshot.members.every((member) => member.home_state);`
  - Line 68 player rail: `<small>{member.home_state ?? "Choosing"}</small>` (drop the `member.is_bot ? "Bot" : ...` branch).
  - Line 69 start gate: replace both `humans.length < 2` occurrences with `snapshot.members.length < 2`; keep the copy `"Two people required"`.

- [ ] **Step 3: Checks** — `npm test && npm run typecheck && npm run build && npm run lint` all exit 0. (`tsc` failing on any other `is_bot` usage would flag a missed reference — there are none as of the survey.)

- [ ] **Step 4: Commit** —

```bash
git add lib/game-types.ts components/lobby-stage.tsx
git commit -m "refactor(ui): drop bot handling from lobby and member types"
```

---

### Task 3: Update the audit suite for the dropped function

**Files:**
- Modify: `tests/db/audit.test.ts:983-996` (the finding-6 probe)

**Interfaces:**
- Consumes: Task 1 (function dropped).
- Produces: nothing.

- [ ] **Step 1: Replace the probe** — the current test asserts `run_test_bot_turns` errors for member and commissioner clients (unreachable-by-role). Replace the whole test with a gone-entirely assertion, keeping the finding-6 provenance comment:

```ts
// Finding 6 (historical): run_test_bot_turns was SECURITY DEFINER with no
// caller check, locked to service_role in 20260803180300. Bots were removed
// outright in 20260804210000 -- the durable guarantee is now that the
// function does not exist for anyone, including the service role.
test("run_test_bot_turns does not exist", async () => {
  const probe = await admin.rpc("run_test_bot_turns", { p_season_id: seasonId });
  assert.ok(probe.error, "the function should be gone from the schema");
  assert.match(probe.error!.message, /could not find|does not exist|schema cache/i);
});
```

Keep whatever `seasonId` fixture the surrounding tests already use (the current probe references one — reuse it unchanged).

- [ ] **Step 2: Run the DB suite** — `npm run test:db` (stack env exported). Expected: all pass, including the two grant-allowlist enumerations (they never listed `run_test_bot_turns`, and `rows.length >= 20` still holds).

- [ ] **Step 3: Commit** —

```bash
git add tests/db/audit.test.ts
git commit -m "test(db): finding-6 probe now asserts run_test_bot_turns is gone"
```

---

### Task 4: Docs on main — backlog + local-stack

**Files:**
- Modify: `docs/superpowers/backlog.md` (the P5 `profiles_id_fkey` row)
- Modify: `docs/superpowers/local-stack.md:92` ("runs bot turns")
- Check: `docs/handoff-implementation.md`, `README.md`, `IMPLEMENTATION_STATUS.md` — `grep -in "bot" <file>` (excluding "bottom"/"both"); fix any hit the survey missed.

**Interfaces:** none.

- [ ] **Step 1: Backlog** — strike the P5 row about `profiles_id_fkey` (the one beginning "`20260730074000_support_test_bot_players.sql` drops `profiles_id_fkey`") the way earlier closed items are handled in that file (`~~...~~ **Done in ... (commit).**` with a one-line note that bots were removed and the FK restored in `20260804210000_remove_bot_players.sql`).

- [ ] **Step 2: local-stack.md** — reword line 92 so the daily-tick description no longer claims it "runs bot turns" (it now resolves sessions/attacks, scores, decays, ends seasons).

- [ ] **Step 3: Sweep** — run the greps in the Files block; fix any real bot reference found.

- [ ] **Step 4: Checks + commit** — `npm test` (docs cannot break it, but keep the gate uniform):

```bash
git add docs/superpowers/backlog.md docs/superpowers/local-stack.md
git commit -m "docs: record bot removal and restored profiles FK"
```

---

### Task 5: Closeout — full suite

**Files:** none new.

- [ ] **Step 1: Full verification** — with stack env exported:

Run: `npm test && npm run test:db && npm run test:smoke && npm run typecheck && npm run build && npm run lint`
Expected: all exit 0. Capture the test counts for the merge/PR description.

- [ ] **Step 2: Manual sanity (optional but cheap)** — `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<anon> npm run dev`, log in as `commish@playtest.local` / `playtest-password-1`, confirm the lobby renders and the "Advance Demo League" board still loads (its two human players are untouched by the data pass).

- [ ] **Step 3: Done** — hand off to superpowers:finishing-a-development-branch. Out-of-branch follow-ups to raise at finish time:
  - `docs/HANDOFF.md` lives only on `feat/p2b-broadcast`: its "#1 solo-vs-bots" priority is dead — update it there (or after merge) to record the bot-removal decision and promote login/session cleanup to #1.
  - `.superpowers/sdd/2026-08-04-p2b-broadcast-restyle/seed-vs-bots*.mjs` are untracked scripts in the primary checkout that reference `profiles.is_bot` — delete them.
  - Memory note `hometerritory-playtest.md` names solo-vs-bots as priority #1 — update after merge.
