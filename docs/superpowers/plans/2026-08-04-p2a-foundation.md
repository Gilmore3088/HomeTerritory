# Phase 2a Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the dual-polling data layer into one shared source of truth, fix the stale-question bug, and add a commissioner-only "advance the day" control (settle + score the current group-local day on demand) — the behavioral foundation the Broadcast redesign (P2b) will style.

**Architecture:** A single `GameDataProvider` (React context) owns all game data via the existing `useSupabaseSession` + `useGameState` hooks; `TerritoryGame` and `GameRuntimeControls` become consumers, eliminating the second poll loop. On the database, the per-season body of `run_daily_tick` is extracted into a reusable `advance_season(uuid)`, and a commissioner-gated `advance_group_day(uuid)` calls it for one group.

**Tech Stack:** TypeScript 5.9 (strict), React 19, Next.js 16, `@supabase/supabase-js` v2 + `@supabase/ssr`, node built-in test runner, Supabase CLI local stack (Postgres + GoTrue + PostgREST), CSS Modules.

## Global Constraints

- Branch `feat/p2a-foundation` (already created; spec committed there).
- Conventional commits ending with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- After every task: `npm test`, `npm run typecheck`, `npm run build`, `npm run lint` all pass/exit 0. Tasks that touch the DB also keep `npm run test:db` green.
- App source files under 300 lines. No new npm dependencies. No `console.log`. No emojis in code.
- SQL changes are NEW forward-only migrations named `supabase/migrations/2026MMDDHHMMSS_<slug>.sql`. NEVER edit an applied migration. Run `supabase db reset` after adding one to prove the chain replays.
- Never run destructive SQL against the production project `gduvdnpxgdniogmxxlmg`. All DB work is against the local stack only. New migrations are NOT auto-deployed to production (owner action, backlog).
- No visual restyle in P2a — leave existing Phase-1 styles; P2b restyles. New UI here is functional-but-plain.

## Environment (local stack)

- Stack runs via `npm run stack:start` (started with `-x vector -x logflare`; `npm run stack:reset` for a clean board). API at `http://127.0.0.1:55321` (ports are +1000 from Supabase defaults; see `docs/superpowers/local-stack.md`).
- **Use the LEGACY JWT keys** for `test:db` (the `sb_publishable`/`sb_secret` keys 401 against the local edge runtime). Export before `npm run test:db`:
  `SUPABASE_TEST_URL=http://127.0.0.1:55321`, `SUPABASE_TEST_ANON_KEY=<legacy anon eyJ...>`, `SUPABASE_TEST_SERVICE_KEY=<legacy service eyJ...>`. The legacy keys are printed by `supabase status` (anon key = "anon key", service = "service_role key").
- If GoTrue flakes with `AuthRetryableFetchError`, `docker restart supabase_kong_HomeTerritory` and retry once — a known local quirk, not a failure.

## Codebase Facts (verified 2026-08-04, `main` + spec on branch)

- `app/page.tsx` renders `<TerritoryGame />` then `<GameRuntimeControls />` as siblings. Both are client components.
- `components/territory-game.tsx` calls `useSupabaseSession()` and `useGameState(session)` itself (it is the coordinator). `useGameState` returns `{ groups, groupId, setGroupId, snapshot, operation, setOperation, result, setResult, busy, setBusy, toast, notify, loadGroups, loadSnapshot, beginAction }` (see `hooks/use-game-state.ts`).
- `components/game-runtime-controls.tsx` currently owns its OWN data: `useSupabaseSession()` for the session, then a `load(session)` callback doing `get_my_groups` → `pickActiveGroup` → `group_snapshot` + `get_my_active_session`, on a 5s `setInterval` + `focus`/`visibilitychange` listeners. It derives a `RuntimeState` for the turn banner / logout / report. Its report action uses `window.prompt`/`window.alert`/`window.location.reload()` (kept as-is in P2a; restyled in P2b).
- `hooks/use-game-state.ts` `loadSnapshot`: `if (operationResponse.data) setOperation(...)` with **no else** — the stale-operation bug.
- `lib/game-selection.ts` exports `pickActiveGroup(rows, saved, preferred?)` (membership-validated). `hooks/use-supabase-session.ts` exports `useSupabaseSession(): { session, authReady }`.
- `snapshot.group.commissioner_id` and `snapshot.current_user_id` exist on the `Snapshot` type in `lib/game-types.ts`. `snapshot.activity` is `FeedRow[]` with `created_at`.
- DB: `run_daily_tick()` loops all active seasons inline and (per season) calls `resolve_expired_sessions`, `resolve_expired_attacks`, `run_test_bot_turns`, updates `seasons.current_day`, and — when `seasons.last_scored_on < ` the group-local day — runs twilight decay + a per-member scoring block. Its CURRENT definition is the composition of several migrations; treat the **live** definition on the stack as the source of truth (Task 1 reads it via `pg_get_functiondef`). It is `security definer`, service-role only. Commissioner is `groups.commissioner_id`. `seasons.last_scored_on` and the group-local-day expression exist.
- `tests/db/audit.test.ts` has a grants audit with a `CLIENT_CALLABLE` allowlist (~12 RPCs) and an `AUTHENTICATED_EXECUTE_OTHER` exceptions list, asserting no other security-definer function is `authenticated`-executable. It calls `security_definer_grants()`.
- `tests/db/helpers.ts` exports `admin`, `createTestUser(displayName)`, `correctAnswerFor(sessionId)`, `answerUntilResolved(user, sessionId)`.

---

### Task 1: Extract `advance_season` and refactor `run_daily_tick`

**Files:**
- Create: `supabase/migrations/<timestamp>_extract_advance_season.sql`
- Test: `tests/db/advance.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `public.advance_season(p_season_id uuid) returns void` (security definer, service-role only) — does exactly what `run_daily_tick`'s per-season loop body does for one season. `run_daily_tick()` unchanged in observable behavior. Task 2 calls `advance_season`.

- [ ] **Step 1: Capture the live source of truth**

Run (stack up): `docker exec supabase_db_HomeTerritory psql -U postgres -d postgres -c "\sf public.run_daily_tick"` (or `select pg_get_functiondef('public.run_daily_tick()'::regprocedure);`). This prints the CURRENT composed definition. The body of the `for v_season in ... loop ... end loop` is what moves into `advance_season(p_season_id)`, parameterized by season id instead of the loop variable. Do NOT reconstruct it from a single migration file — migrations compose.

- [ ] **Step 2: Write the failing test**

Create `tests/db/advance.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, answerUntilResolved, createTestUser } from "./helpers.ts";

async function startedSeason(commish: SupabaseClient, mate: SupabaseClient, home1: string, home2: string) {
  const created = await commish.rpc("create_group_v2", {
    p_name: "Advance League", p_sports: ["NFL"], p_season_length: 14,
    p_opening_mode: "open", p_board_scope: "fifty", p_difficulty: "standard", p_test_mode: true,
  });
  assert.equal(created.error, null);
  const groupId = created.data as string;
  const snap = await commish.rpc("group_snapshot", { p_group_id: groupId });
  const invite = (snap.data as { group: { invite_code: string } }).group.invite_code;
  await mate.rpc("join_group", { p_invite_code: invite });
  await commish.rpc("set_home_state", { p_group_id: groupId, p_home_state: home1 });
  await mate.rpc("set_home_state", { p_group_id: groupId, p_home_state: home2 });
  await commish.rpc("start_season", { p_group_id: groupId });
  const after = await commish.rpc("group_snapshot", { p_group_id: groupId });
  return { groupId, seasonId: (after.data as { season: { id: string } }).season.id };
}

test("advance_season scores a season's held territories once per local day", async () => {
  const a = await createTestUser("AdvA");
  const b = await createTestUser("AdvB");
  const { seasonId } = await startedSeason(a, b, "TX", "NY");

  // Backdate last_scored_on so scoring is due (mirrors tests/db/audit.test.ts).
  await admin.from("seasons").update({ last_scored_on: "2000-01-01" }).eq("id", seasonId);
  const first = await admin.rpc("advance_season", { p_season_id: seasonId });
  assert.equal(first.error, null);
  const { data: events, error } = await admin
    .from("daily_score_events").select("scored_on").eq("season_id", seasonId);
  assert.equal(error, null);
  assert.ok((events ?? []).length > 0, "advance_season recorded score events");

  // Second call same local day: resolves but does not double-score.
  const before = (events ?? []).length;
  await admin.rpc("advance_season", { p_season_id: seasonId });
  const { data: events2 } = await admin
    .from("daily_score_events").select("scored_on").eq("season_id", seasonId);
  assert.equal((events2 ?? []).length, before, "no double-scoring within one local day");
});

test("run_daily_tick still scores active seasons via advance_season", async () => {
  const a = await createTestUser("TickA");
  const b = await createTestUser("TickB");
  const { seasonId } = await startedSeason(a, b, "CA", "FL");
  await admin.from("seasons").update({ last_scored_on: "2000-01-01" }).eq("id", seasonId);
  const tick = await admin.rpc("run_daily_tick");
  assert.equal(tick.error, null);
  const { data: events } = await admin
    .from("daily_score_events").select("scored_on").eq("season_id", seasonId);
  assert.ok((events ?? []).length > 0, "run_daily_tick scored via advance_season");
});
```

- [ ] **Step 3: Run to verify it fails**

Run (env exported): `npm run test:db`
Expected: FAIL — `advance_season` does not exist (`function public.advance_season(uuid) does not exist`).

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/<timestamp>_extract_advance_season.sql`:
- `create or replace function public.advance_season(p_season_id uuid) returns void language plpgsql security definer set search_path = public as $$ ... $$;` — paste the per-season loop body from Step 1, replacing the loop variable `v_season` with a `select * into v_season from public.seasons where id = p_season_id for update;` at the top (keep every `resolve_*`, `run_test_bot_turns`, `current_day` update, twilight-decay, and scoring statement identical; keep the `last_scored_on <` group-local-day guard).
- `create or replace function public.run_daily_tick() returns jsonb language plpgsql security definer set search_path = public as $$ declare v_season public.seasons; v_scored integer := 0; begin for v_season in select * from public.seasons where status = 'active' for update skip locked loop perform public.advance_season(v_season.id); v_scored := v_scored + 1; end loop; return jsonb_build_object('seasons', v_scored); end; $$;` — preserve its existing return-shape contract if other code depends on it; if the original returned a different jsonb shape, match it.
- Grants (Phase-1 hygiene): `revoke execute on function public.advance_season(uuid) from public, anon, authenticated; grant execute on function public.advance_season(uuid) to service_role;` and re-assert the existing `run_daily_tick` grants.

- [ ] **Step 5: Replay + run to verify it passes**

Run: `npm run stack:reset` then `npm run test:db`
Expected: PASS (both new tests, and the existing suite stays green). If GoTrue flakes, restart kong and rerun.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/ tests/db/advance.test.ts
git commit -m "refactor(db): extract advance_season from run_daily_tick"
```

---

### Task 2: Commissioner `advance_group_day` RPC

**Files:**
- Create: `supabase/migrations/<timestamp>_commissioner_advance_group_day.sql`
- Modify: `tests/db/advance.test.ts` (add authorization + idempotency tests)
- Modify: `tests/db/audit.test.ts` (add `advance_group_day` to the `CLIENT_CALLABLE` allowlist)

**Interfaces:**
- Consumes: Task 1 `advance_season(uuid)`.
- Produces: `public.advance_group_day(p_group_id uuid) returns jsonb` — security definer, granted to `authenticated`, self-checks `auth.uid() = groups.commissioner_id`. Task 7's UI calls it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/db/advance.test.ts`:

```ts
test("advance_group_day: commissioner advances, others are rejected", async () => {
  const commish = await createTestUser("Commish");
  const member = await createTestUser("Member");
  const outsider = await createTestUser("Outsider");
  const created = await commish.rpc("create_group_v2", {
    p_name: "Gate League", p_sports: ["NFL"], p_season_length: 14,
    p_opening_mode: "open", p_board_scope: "fifty", p_difficulty: "standard", p_test_mode: true,
  });
  const groupId = created.data as string;
  const snap = await commish.rpc("group_snapshot", { p_group_id: groupId });
  const invite = (snap.data as { group: { invite_code: string } }).group.invite_code;
  await member.rpc("join_group", { p_invite_code: invite });
  await commish.rpc("set_home_state", { p_group_id: groupId, p_home_state: "TX" });
  await member.rpc("set_home_state", { p_group_id: groupId, p_home_state: "NY" });
  await commish.rpc("start_season", { p_group_id: groupId });

  const asMember = await member.rpc("advance_group_day", { p_group_id: groupId });
  assert.ok(asMember.error, "non-commissioner member is rejected");
  const asOutsider = await outsider.rpc("advance_group_day", { p_group_id: groupId });
  assert.ok(asOutsider.error, "non-member is rejected");
  const asCommish = await commish.rpc("advance_group_day", { p_group_id: groupId });
  assert.equal(asCommish.error, null, "commissioner succeeds");
});

test("advance_group_day scores at most once per local day", async () => {
  const commish = await createTestUser("Commish2");
  const member = await createTestUser("Member2");
  const created = await commish.rpc("create_group_v2", {
    p_name: "Idem League", p_sports: ["NFL"], p_season_length: 14,
    p_opening_mode: "open", p_board_scope: "fifty", p_difficulty: "standard", p_test_mode: true,
  });
  const groupId = created.data as string;
  const snap = await commish.rpc("group_snapshot", { p_group_id: groupId });
  const invite = (snap.data as { group: { invite_code: string } }).group.invite_code;
  await member.rpc("join_group", { p_invite_code: invite });
  await commish.rpc("set_home_state", { p_group_id: groupId, p_home_state: "CA" });
  await member.rpc("set_home_state", { p_group_id: groupId, p_home_state: "FL" });
  await commish.rpc("start_season", { p_group_id: groupId });
  const seasonId = ((await commish.rpc("group_snapshot", { p_group_id: groupId }))
    .data as { season: { id: string } }).season.id;
  await admin.from("seasons").update({ last_scored_on: "2000-01-01" }).eq("id", seasonId);

  await commish.rpc("advance_group_day", { p_group_id: groupId });
  const c1 = ((await admin.from("daily_score_events").select("scored_on").eq("season_id", seasonId)).data ?? []).length;
  await commish.rpc("advance_group_day", { p_group_id: groupId });
  const c2 = ((await admin.from("daily_score_events").select("scored_on").eq("season_id", seasonId)).data ?? []).length;
  assert.equal(c2, c1, "second same-day advance does not double-score");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:db`
Expected: FAIL — `advance_group_day` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/<timestamp>_commissioner_advance_group_day.sql`:

```sql
create or replace function public.advance_group_day(p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_commish uuid;
  v_season_id uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;
  select commissioner_id into v_commish from public.groups where id = p_group_id;
  if v_commish is null then
    raise exception 'Group not found';
  end if;
  if v_commish <> v_uid then
    raise exception 'Only the commissioner can advance the day';
  end if;
  select id into v_season_id from public.seasons
    where group_id = p_group_id and status = 'active' limit 1;
  if v_season_id is null then
    raise exception 'No active season';
  end if;
  perform public.advance_season(v_season_id);
  return jsonb_build_object('ok', true, 'season_id', v_season_id);
end;
$$;

revoke execute on function public.advance_group_day(uuid) from public, anon;
grant execute on function public.advance_group_day(uuid) to authenticated;
```

- [ ] **Step 4: Add to the grants allowlist**

In `tests/db/audit.test.ts`, add `"advance_group_day"` to the `CLIENT_CALLABLE` allowlist set (with a comment: `// commissioner-gated day advance, called from the game shell`). This keeps the "no unexpected authenticated-executable security-definer function" audit green.

- [ ] **Step 5: Replay + verify pass**

Run: `npm run stack:reset` then `npm run test:db`
Expected: PASS (new authorization + idempotency tests, the grants audit, and the whole suite).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/ tests/db/advance.test.ts tests/db/audit.test.ts
git commit -m "feat(db): add commissioner-gated advance_group_day"
```

---

### Task 3: Pure turn-reconciliation helpers

**Files:**
- Create: `lib/turn-reconcile.ts`
- Test: `tests/turn-reconcile.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `shouldClearOperation(input: { serverHasSession: boolean; beganAtMs: number | null; loadStartedAtMs: number }): boolean` — true only when the server reports no active session AND no `beginAction` happened at/after this load started (so a just-begun local operation is never wiped by an interleaved poll).
  - `unseenActivityCount(activity: Array<{ created_at: string }>, lastSeenIso: string | null): number` — count of activity rows newer than `lastSeenIso` (all of them when `lastSeenIso` is null).

Note: `unseenActivityCount` is built and tested here so the "what changed while you were away" data is ready, but it is intentionally NOT wired into the context in P2a — it has no consumer until P2b's recap affordance renders it. Wiring it (with the localStorage last-seen timestamp + a `markActivitySeen()` action) lands with P2b to avoid shipping dead code. This is a deliberate deviation from the spec's "ship the data now" wording, in favor of YAGNI.

- [ ] **Step 1: Write the failing tests**

Create `tests/turn-reconcile.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { shouldClearOperation, unseenActivityCount } from "../lib/turn-reconcile.ts";

test("shouldClearOperation clears only a resolved session with no newer begin", () => {
  // Server still has the session: never clear.
  assert.equal(shouldClearOperation({ serverHasSession: true, beganAtMs: null, loadStartedAtMs: 100 }), false);
  // Server has none and nothing begun since load started: clear.
  assert.equal(shouldClearOperation({ serverHasSession: false, beganAtMs: null, loadStartedAtMs: 100 }), true);
  assert.equal(shouldClearOperation({ serverHasSession: false, beganAtMs: 50, loadStartedAtMs: 100 }), true);
  // A begin happened at/after this load started: do NOT clear (race guard).
  assert.equal(shouldClearOperation({ serverHasSession: false, beganAtMs: 100, loadStartedAtMs: 100 }), false);
  assert.equal(shouldClearOperation({ serverHasSession: false, beganAtMs: 150, loadStartedAtMs: 100 }), false);
});

test("unseenActivityCount counts rows newer than last seen", () => {
  const activity = [
    { created_at: "2026-08-04T10:00:00Z" },
    { created_at: "2026-08-04T09:00:00Z" },
    { created_at: "2026-08-04T08:00:00Z" },
  ];
  assert.equal(unseenActivityCount(activity, null), 3);
  assert.equal(unseenActivityCount(activity, "2026-08-04T08:30:00Z"), 2);
  assert.equal(unseenActivityCount(activity, "2026-08-04T10:00:00Z"), 0);
  assert.equal(unseenActivityCount([], "2026-08-04T10:00:00Z"), 0);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test`
Expected: FAIL — cannot find module `../lib/turn-reconcile.ts`.

- [ ] **Step 3: Implement**

Create `lib/turn-reconcile.ts`:

```ts
export function shouldClearOperation(input: {
  serverHasSession: boolean;
  beganAtMs: number | null;
  loadStartedAtMs: number;
}): boolean {
  if (input.serverHasSession) return false;
  if (input.beganAtMs !== null && input.beganAtMs >= input.loadStartedAtMs) return false;
  return true;
}

export function unseenActivityCount(
  activity: Array<{ created_at: string }>,
  lastSeenIso: string | null,
): number {
  if (!lastSeenIso) return activity.length;
  const cutoff = new Date(lastSeenIso).getTime();
  return activity.filter((row) => new Date(row.created_at).getTime() > cutoff).length;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/turn-reconcile.ts tests/turn-reconcile.test.ts
git commit -m "test(turn): add pure operation-reconciliation helpers"
```

---

### Task 4: `GameDataProvider` context + wire the coordinator

**Files:**
- Create: `hooks/game-data-context.tsx`
- Modify: `app/page.tsx`
- Modify: `components/territory-game.tsx`

**Interfaces:**
- Consumes: `useSupabaseSession` (`hooks/use-supabase-session.ts`), `useGameState` (`hooks/use-game-state.ts`), `shouldClearOperation`/`unseenActivityCount` (Task 3, used later in Task 6).
- Produces:
  - `GameDataProvider({ children }: { children: React.ReactNode }): JSX.Element`
  - `useGameData(): GameData` where `GameData = { session: Session | null; authReady: boolean } & ReturnType<typeof useGameState>`. Task 5 and Task 7 consume `useGameData()`.

- [ ] **Step 1: Create the provider**

Create `hooks/game-data-context.tsx`:

```tsx
"use client";

import { createContext, useContext } from "react";
import type { Session } from "@supabase/supabase-js";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { useGameState } from "@/hooks/use-game-state";

type GameData = { session: Session | null; authReady: boolean } & ReturnType<typeof useGameState>;

const GameDataContext = createContext<GameData | null>(null);

export function GameDataProvider({ children }: { children: React.ReactNode }) {
  const { session, authReady } = useSupabaseSession();
  const game = useGameState(session);
  return <GameDataContext.Provider value={{ session, authReady, ...game }}>{children}</GameDataContext.Provider>;
}

export function useGameData(): GameData {
  const ctx = useContext(GameDataContext);
  if (!ctx) throw new Error("useGameData must be used within GameDataProvider");
  return ctx;
}
```

- [ ] **Step 2: Wrap the page**

Rewrite `app/page.tsx`:

```tsx
import GameRuntimeControls from "@/components/game-runtime-controls";
import TerritoryGame from "@/components/territory-game";
import { GameDataProvider } from "@/hooks/game-data-context";

export default function HomePage() {
  return (
    <GameDataProvider>
      <TerritoryGame />
      <GameRuntimeControls />
    </GameDataProvider>
  );
}
```

- [ ] **Step 3: Make the coordinator consume the context**

In `components/territory-game.tsx`, delete the local `const { session, authReady } = useSupabaseSession();` and `const { ... } = useGameState(session);` lines and their imports of those two hooks; replace with `const { session, authReady, groups, groupId, setGroupId, snapshot, operation, setOperation, result, setResult, busy, setBusy, toast, notify, loadGroups, loadSnapshot, beginAction } = useGameData();` (import `useGameData` from `@/hooks/game-data-context`). Everything else in the coordinator stays identical.

- [ ] **Step 4: Verify build + behavior**

Run: `npm test && npm run typecheck && npm run build && npm run lint`
Expected: all pass/exit 0. (`GameRuntimeControls` still fetches its own data at this point — that is Task 5. Both mounting under the provider is fine.)

- [ ] **Step 5: Commit**

```bash
git add hooks/game-data-context.tsx app/page.tsx components/territory-game.tsx
git commit -m "refactor(data): add GameDataProvider and consume it in the coordinator"
```

---

### Task 5: Make `GameRuntimeControls` a context consumer

**Files:**
- Modify: `components/game-runtime-controls.tsx`

**Interfaces:**
- Consumes: `useGameData()` (Task 4).
- Produces: no new exports; removes the second poll loop.

- [ ] **Step 1: Replace its data source**

In `components/game-runtime-controls.tsx`, delete: the `load` callback, the 5s `setInterval` effect, the `focus`/`visibilitychange` listeners, the `get_my_groups`/`pickActiveGroup`/`group_snapshot`/`get_my_active_session` calls, the local `RuntimeState`/`GroupRow`/`ActiveSession`/`Snapshot` types used only for that fetch, and the `useSupabaseSession` import. Derive the same `RuntimeState` fields from the shared context instead:

```tsx
import { useGameData } from "@/hooks/game-data-context";
// ...
const { session, snapshot, operation, loadSnapshot } = useGameData();
const state = useMemo(() => {
  if (!session || !snapshot) return null;
  const hasDefense = Boolean(
    snapshot.attacks?.some((a) => a.defender_id === snapshot.current_user_id && a.status === "contested"),
  );
  return {
    groupId: snapshot.group.id,
    testMode: Boolean(snapshot.group.test_mode),
    isMyTurn: snapshot.is_my_turn !== false,
    currentTurnName: snapshot.season?.current_turn_name ?? "Another player",
    turnNumber: snapshot.season?.turn_number ?? 1,
    movesRemaining: snapshot.actions_remaining ?? 0,
    hasDefense,
    activeAttemptId: operation?.question?.attempt_id ?? null,
  };
}, [session, snapshot, operation]);
```

Keep the `endTurn`, `reportQuestion`, and `logout` handlers, but after a successful `end_test_turn`/`report_question` call `await loadSnapshot()` (the shared refresh) instead of the old local `load(session)`; `logout` stays as-is. Keep the existing `waiting` body-dataset effect, driven by the derived `state`. The `Snapshot` type import now comes from the context's data (use `snapshot` fields directly); if a local structural type is still needed for `attacks`, reference `lib/game-types.ts`.

- [ ] **Step 2: Verify only one poll loop remains**

Run: `grep -n "setInterval\|get_my_groups\|group_snapshot\|get_my_active_session" components/game-runtime-controls.tsx`
Expected: no matches (all data now flows from the shared context; the only polling is `useGameState`'s single 20s loop + realtime).

- [ ] **Step 3: Full check**

Run: `npm test && npm run typecheck && npm run build && npm run lint`
Expected: all pass/exit 0.

- [ ] **Step 4: Commit**

```bash
git add components/game-runtime-controls.tsx
git commit -m "refactor(data): drive runtime controls from the shared context"
```

---

### Task 6: Fix the stale-operation bug via reconciliation

**Files:**
- Modify: `hooks/use-game-state.ts`
- Test: `tests/db/advance.test.ts` (add a resolved-session reconciliation probe) OR a documented manual check if a DB probe is impractical

**Interfaces:**
- Consumes: `shouldClearOperation` (Task 3).
- Produces: `useGameState` now clears `operation` when the server session resolved, guarded against wiping a just-begun operation. Adds a `beganAtRef` updated in `beginAction`.

- [ ] **Step 1: Track begin time and reconcile in loadSnapshot**

In `hooks/use-game-state.ts`:
- Add `import { shouldClearOperation } from "@/lib/turn-reconcile";` and a `const beganAtRef = useRef<number | null>(null);` (import `useRef`).
- In `beginAction`, set `beganAtRef.current = Date.now();` immediately after a successful `game_begin_action` (right before/after `setOperation(data as ActiveOperation)`).
- In `loadSnapshot`, capture `const loadStartedAtMs = Date.now();` at the top. After the `Promise.all`, replace the operation handling:

```ts
if (operationResponse.data) {
  setOperation(operationResponse.data as ActiveOperation);
} else if (shouldClearOperation({
  serverHasSession: false,
  beganAtMs: beganAtRef.current,
  loadStartedAtMs,
})) {
  setOperation(null);
}
```

(Leave `snapshot` handling unchanged.)

- [ ] **Step 2: Add a reconciliation probe**

Append to `tests/db/advance.test.ts` a test that begins a claim, resolves the underlying `game_sessions` row via the `admin` client (set its status to resolved / delete the pending `question_attempts` so `get_my_active_session` returns null), then asserts a fresh `get_my_active_session` returns null — proving the server-side signal the hook keys off. (The React state transition itself is covered by the Task 3 unit test; this proves the RPC returns null once resolved.)

```ts
test("get_my_active_session returns null after the session resolves", async () => {
  const a = await createTestUser("ReconA");
  const b = await createTestUser("ReconB");
  const { groupId, seasonId } = await startedSeason(a, b, "TX", "NY");
  const begun = await a.rpc("game_begin_action", {
    p_season_id: seasonId, p_territory_id: "TX", p_action_type: "home", p_attack_id: null,
  });
  assert.equal(begun.error, null);
  const sessionId = (begun.data as { session_id: string }).session_id;
  await answerUntilResolved(a, sessionId);
  const active = await a.rpc("get_my_active_session", { p_group_id: groupId });
  assert.equal(active.data, null, "no active session after resolution");
});
```

- [ ] **Step 3: Full check**

Run: `npm test && npm run test:db && npm run typecheck && npm run build && npm run lint`
Expected: all pass/exit 0.

- [ ] **Step 4: Commit**

```bash
git add hooks/use-game-state.ts tests/db/advance.test.ts
git commit -m "fix(turn): clear resolved operation without wiping a fresh one"
```

---

### Task 7: Commissioner "Advance the day" control

**Files:**
- Modify: `hooks/use-game-state.ts` (add `advanceGroupDay` to the returned API)
- Modify: `components/game-runtime-controls.tsx` (render the commissioner-only button)

**Interfaces:**
- Consumes: `advance_group_day` RPC (Task 2), `useGameData` (Task 4).
- Produces: `useGameState` returns `advanceGroupDay: () => Promise<void>` (also surfaced through `useGameData` since the provider spreads `useGameState`).

- [ ] **Step 1: Add the action to the hook**

In `hooks/use-game-state.ts`, add:

```ts
async function advanceGroupDay() {
  if (!snapshot) return;
  setBusy(true);
  const { error } = await supabase.rpc("advance_group_day", { p_group_id: snapshot.group.id });
  setBusy(false);
  if (error) notify(error.message, true);
  else {
    notify("The day advanced.");
    loadSnapshot();
  }
}
```

Add `advanceGroupDay` to the returned object. (It flows through `useGameData` automatically.)

- [ ] **Step 2: Render the commissioner-only control**

In `components/game-runtime-controls.tsx`, pull `advanceGroupDay` and `snapshot` from `useGameData()`. Compute `const isCommissioner = Boolean(snapshot && snapshot.group.commissioner_id === snapshot.current_user_id);`. Render a plain button (existing CSS module styles; P2b restyles) only when `isCommissioner` and there is an active season:

```tsx
{isCommissioner && snapshot?.season && (
  <button type="button" className={styles.logout} onClick={() => advanceGroupDay()} disabled={Boolean(busy)}>
    Advance the day
  </button>
)}
```

(Reusing an existing style class keeps P2a unstyled-but-functional; do not add new CSS here.)

- [ ] **Step 3: Manual + automated check**

Run: `npm test && npm run typecheck && npm run build && npm run lint`
Expected: all pass. (Controller performs the browser verification: commissioner sees and can click the button; a non-commissioner member does not see it; clicking advances/scoring updates the snapshot.)

- [ ] **Step 4: Commit**

```bash
git add hooks/use-game-state.ts components/game-runtime-controls.tsx
git commit -m "feat(turn): commissioner advance-the-day control"
```

---

### Task 8: Final validation and closeout

**Files:**
- Modify: `docs/superpowers/backlog.md`
- Modify: `IMPLEMENTATION_STATUS.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the spec's done criteria, checked and recorded.

- [ ] **Step 1: Clean-room run**

Run (env exported): `npm run stack:reset && npm test && npm run test:db && npm run test:smoke && npm run typecheck && npm run build && npm run lint`
Expected: all pass. Capture counts.

- [ ] **Step 2: One-poll + commissioner verification (controller/browser)**

Against the local stack, sign in as the commissioner of a started season, confirm exactly one `group_snapshot` poll loop drives the page (not two), the turn banner and map agree on the league, the "Advance the day" button appears only for the commissioner and updates the snapshot on click, and a resolved question no longer leaves a stale card after a poll.

- [ ] **Step 3: Record the deferral and status**

In `docs/superpowers/backlog.md`, add a `P2-day-counter` row: "Season-level game-day counter so the commissioner can fast-forward multiple days independent of the wall calendar — deferred from P2a; advance_group_day currently settles the current local day only." In `IMPLEMENTATION_STATUS.md`, note P2a foundation complete (data layer unified, commissioner advance added) and that P2b (Broadcast restyle) is next; new P2a migrations await the same owner-run production deploy as Phase 1's.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/backlog.md IMPLEMENTATION_STATUS.md
git commit -m "docs(status): record P2a foundation closeout"
```
