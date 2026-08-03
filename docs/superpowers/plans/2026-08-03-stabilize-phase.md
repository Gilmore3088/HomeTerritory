# Territory Phase 1: Stabilize — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Territory game loop provably correct and the codebase safe to change: one shared Supabase client, dead code removed, the 859-line monolith split, and a three-layer test suite (pure rules, DB engine, E2E smoke) that passes end to end.

**Architecture:** Next.js 16 App Router client app over a server-authoritative PostgreSQL game engine (Supabase RPC functions defined in `supabase/migrations/`). The browser never decides game outcomes; it calls RPCs (`game_begin_action`, `game_submit_answer`, `group_snapshot`, …) and renders snapshots. Testing therefore targets three layers: pure TS helpers (`lib/`), the SQL functions (via a local Supabase stack), and one scripted end-to-end season.

**Tech Stack:** TypeScript 5.9 (strict), React 19, Next.js 16 (Turbopack), `@supabase/supabase-js` v2 + `@supabase/ssr`, node built-in test runner (`node --experimental-strip-types --test`), Supabase CLI local stack (Postgres + GoTrue + PostgREST), CSS Modules.

## Global Constraints

- All work happens on branch `fix/stabilize-mvp` (already created; spec is committed there).
- Conventional commits: `fix(...)`, `refactor(...)`, `test(...)`, `chore(...)`, `docs(...)`.
- Every task ends with `npm test`, `npm run typecheck`, and `npm run build` all passing.
- Source files stay under 300 lines (user rule). No emojis in code. No `console.log` left in committed code.
- No new npm dependencies. The Supabase CLI (`/opt/homebrew/bin/supabase`, v2.84.2) is the only external tool.
- Secrets live only in `.env.local` (untracked). Never commit or print `SUPABASE_SECRET_KEY` or local-stack service keys. The publishable key is safe to appear in output but should come from env, not source.
- The production Supabase project is `gduvdnpxgdniogmxxlmg`. **Never run destructive SQL against it.** All DB tests and audit playthroughs run against the local stack (`http://127.0.0.1:54321`).
- The spec is `docs/superpowers/specs/2026-08-03-stabilize-phase-design.md`. Deferred observations go to `docs/superpowers/backlog.md`, audit results to `docs/superpowers/audit-findings.md`.

## Codebase Facts (verified 2026-08-03, commit c5e7d14)

Read this before any task — it is the context a fresh engineer lacks:

- `app/page.tsx` renders exactly two components: `TerritoryGameV2` (components/territory-game-v2.tsx, 859 lines — auth, lobby, map, questions, everything) and `GameRuntimeControls` (components/game-runtime-controls.tsx, 240 lines — logout button, question-report button, test-mode turn banner).
- `app/login/page.tsx`, `app/app/page.tsx`, `app/g/[groupId]/page.tsx` are all bare `redirect("/")` stubs.
- **Dead code** (referenced by nothing reachable): `components/game-client.tsx`, `dashboard-client.tsx`, `end-turn-control.tsx` + `.module.css`, `logout-control.tsx` + `.module.css`, `login-form.tsx`, `app-header.tsx`.
- Both live components hardcode the production URL + publishable key and create their own `@supabase/supabase-js` client at module scope (`territory-game-v2.tsx:16-20`, `game-runtime-controls.tsx:7-12`). `lib/supabase/client.ts` (the correct, env-driven `createBrowserClient` factory) is only used by dead code. This causes the "Multiple GoTrueClient instances" console warning.
- `tsconfig.json` contains a booby trap: `"@/data/us-states.json"` is path-aliased to `./data/us-states.ts`. The import in `territory-game-v2.tsx:12` looks like JSON but loads TS.
- Tests: one file, `tests/game-rules.test.ts` (5 tests) covering `lib/game-rules.ts`. Script: `"test": "node --experimental-strip-types --test tests/*.test.ts"` — note the glob only matches the top level, so subdirectories can hold opt-in suites.
- DB engine functions (in `supabase/migrations/*.sql`): `create_group_v2`, `join_group`, `set_home_state`, `start_season`, `game_begin_action`, `game_submit_answer`, `get_my_active_session`, `get_my_groups`, `group_snapshot`, `end_test_turn`, `enforce_test_turn_session`, `run_test_bot_turns`, `test_refill_actions`, `report_question`, `resolve_attack_win`, `resolve_expired_attacks`, `resolve_expired_sessions`, `run_daily_tick`, `refresh_player_actions`, `pick_next_question`, `answer_matches`, `normalize_answer`, `handle_new_user`, `is_group_member`, `sync_question_attempt_stats`, `create_group`.
- Key tables: `groups`, `group_members`, `profiles` (id → auth.users, `display_name`), `seasons`, `season_territories`, `territories`, `attacks`, `game_sessions`, `question_attempts` (`session_id`, `question_id`, `answer_text`, `is_correct`, `served_at`, `answered_at`), `questions` (`question_text`, `options` jsonb, `correct_answer`, `aliases`, `tier`, `format`), `player_actions`, `activity_events`, `daily_score_events`, `cooldowns`.
- `supabase/` has `migrations/` and `functions/test-signup/` but **no `config.toml`** — the CLI project is not initialized yet.
- Test-mode groups use a turn rotation (`end_test_turn`, `enforce_test_turn_session`). Read `supabase/migrations/20260730220000_add_playtest_turn_handoff.sql` and `20260802173000_stabilize_turn_scoring_questions_and_bots.sql` before writing DB tests — they define whose turn it is and what non-turn players may do.

---

### Task 1: Unify the browser Supabase client

**Files:**
- Modify: `lib/supabase/client.ts`
- Modify: `components/territory-game-v2.tsx:11-20`
- Modify: `components/game-runtime-controls.tsx:4-12`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `createClient(): SupabaseClient` from `@/lib/supabase/client` — a memoized singleton every later task and component uses. Call sites keep the local idiom `const supabase = createClient();` at module scope.

- [ ] **Step 1: Make the factory a memoized singleton**

Replace the body of `lib/supabase/client.ts` with:

```ts
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | undefined;

export function createClient(): SupabaseClient {
  if (browserClient) return browserClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase public environment variables are missing.");
  browserClient = createBrowserClient(url, key);
  return browserClient;
}
```

- [ ] **Step 2: Point `territory-game-v2.tsx` at it**

Delete lines 16-20 (the `SUPABASE_URL`/`SUPABASE_KEY` constants and `createClient(...)` call). Change line 11 from

```ts
import { createClient, type Session, type User } from "@supabase/supabase-js";
```

to

```ts
import type { Session, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();
```

- [ ] **Step 3: Point `game-runtime-controls.tsx` at it**

Delete lines 7-12. Change line 4 the same way:

```ts
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();
```

- [ ] **Step 4: Verify no stray client constructors remain**

Run: `grep -rn "createClient(" components/ app/ lib/ | grep -v "lib/supabase"`
Expected: no output.

- [ ] **Step 5: Full check**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 6: Manual warning check**

Run `npm run dev`, open `http://localhost:3000`, open the browser console.
Expected: no "Multiple GoTrueClient instances" warning. Sign-in still works (auth state is preserved because both old clients used the same default storage key).

- [ ] **Step 7: Commit**

```bash
git add lib/supabase/client.ts components/territory-game-v2.tsx components/game-runtime-controls.tsx
git commit -m "fix(auth): share one browser Supabase client across components"
```

---

### Task 2: Delete dead legacy components

**Files:**
- Delete: `components/game-client.tsx`, `components/dashboard-client.tsx`, `components/end-turn-control.tsx`, `components/end-turn-control.module.css`, `components/logout-control.tsx`, `components/logout-control.module.css`, `components/login-form.tsx`, `components/app-header.tsx`

**Interfaces:**
- Consumes: Task 1 (so no deleted file is the last user of `lib/supabase/client.ts`).
- Produces: a components directory containing only live code; later tasks may assume every file in `components/` is reachable from `app/page.tsx`.

- [ ] **Step 1: Prove they are unreferenced**

Run: `grep -rn "game-client\|dashboard-client\|end-turn-control\|logout-control\|login-form\|app-header" app/ components/ lib/ --include="*.ts" --include="*.tsx" | grep -v "^components/game-client\|^components/dashboard-client\|^components/end-turn-control\|^components/logout-control\|^components/login-form\|^components/app-header"`
Expected: no output (only self/mutual references inside the doomed files).

- [ ] **Step 2: Delete**

```bash
git rm components/game-client.tsx components/dashboard-client.tsx \
  components/end-turn-control.tsx components/end-turn-control.module.css \
  components/logout-control.tsx components/logout-control.module.css \
  components/login-form.tsx components/app-header.tsx
```

- [ ] **Step 3: Full check**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass. If the build fails on a missing import, Step 1 was wrong — restore and re-check.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(components): remove unreachable legacy components"
```

---

### Task 3: Remove the misleading `us-states.json` alias

**Files:**
- Modify: `tsconfig.json` (paths block)
- Modify: `components/territory-game-v2.tsx:12`

**Interfaces:**
- Consumes: nothing.
- Produces: map data is imported as `import mapData from "@/data/us-states";` — Task 9 copies this import into `lib/game-constants.ts`.

- [ ] **Step 1: Fix the import**

Change `components/territory-game-v2.tsx` line 12 from `import mapData from "@/data/us-states.json";` to `import mapData from "@/data/us-states";`.

- [ ] **Step 2: Drop the alias**

In `tsconfig.json`, delete the `"@/data/us-states.json": ["./data/us-states.ts"],` entry, leaving only `"@/*": ["./*"]`.

- [ ] **Step 3: Full check and commit**

Run: `npm test && npm run typecheck && npm run build` — all pass, then:

```bash
git add tsconfig.json components/territory-game-v2.tsx
git commit -m "chore(config): drop json-to-ts path alias for map data"
```

---

### Task 4: Extract pure helpers and expand unit tests

**Files:**
- Create: `lib/game-format.ts`
- Modify: `components/territory-game-v2.tsx` (remove `dayNumber`, `timeLeft`, `edgeErrorMessage` at lines 161-186; import them)
- Test: `tests/game-format.test.ts` (new), `tests/game-rules.test.ts` (expand)

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 9):
  - `dayNumber(season: { started_at: string; current_day?: number } | null, now?: number): number`
  - `timeLeft(value: string, now?: number): string`
  - `edgeErrorMessage(error: unknown): Promise<string>`

The current implementations live at `components/territory-game-v2.tsx:161-186`. They move verbatim except both time helpers gain an injectable `now` parameter (defaulting to `Date.now()`) so tests are deterministic.

- [ ] **Step 1: Write the failing tests**

Create `tests/game-format.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { dayNumber, edgeErrorMessage, timeLeft } from "../lib/game-format.ts";

const DAY = 86_400_000;

test("dayNumber prefers the server-provided current_day", () => {
  assert.equal(dayNumber({ started_at: new Date(0).toISOString(), current_day: 7 }), 7);
});

test("dayNumber computes from started_at and never returns below one", () => {
  const start = new Date("2026-08-01T00:00:00Z").getTime();
  assert.equal(dayNumber({ started_at: new Date(start).toISOString() }, start + 1000), 1);
  assert.equal(dayNumber({ started_at: new Date(start).toISOString() }, start + 2 * DAY + 1000), 3);
  assert.equal(dayNumber(null), 0);
});

test("timeLeft renders hours, minutes, and expiry", () => {
  const now = new Date("2026-08-01T00:00:00Z").getTime();
  const at = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(timeLeft(at(-1), now), "expired");
  assert.equal(timeLeft(at(5 * 60_000), now), "5m");
  assert.equal(timeLeft(at(3 * 3_600_000 + 20 * 60_000), now), "3h 20m");
});

test("edgeErrorMessage unwraps a function error response body", async () => {
  const error = Object.assign(new Error("non-2xx"), {
    context: new Response(JSON.stringify({ error: "Invite code not found" })),
  });
  assert.equal(await edgeErrorMessage(error), "Invite code not found");
  assert.equal(await edgeErrorMessage(new Error("plain failure")), "plain failure");
  assert.equal(await edgeErrorMessage("not an error"), "The request could not be completed.");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `../lib/game-format.ts`.

- [ ] **Step 3: Create `lib/game-format.ts`**

Move the three functions from `components/territory-game-v2.tsx:161-186`, adding the `now` parameters:

```ts
export function dayNumber(
  season: { started_at: string; current_day?: number } | null,
  now: number = Date.now(),
): number {
  if (!season) return 0;
  if (season.current_day) return season.current_day;
  return Math.max(1, Math.floor((now - new Date(season.started_at).getTime()) / 86_400_000) + 1);
}

export function timeLeft(value: string, now: number = Date.now()): string {
  const ms = new Date(value).getTime() - now;
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export async function edgeErrorMessage(error: unknown): Promise<string> {
  if (error && typeof error === "object" && "context" in error) {
    const response = (error as { context?: Response }).context;
    if (response) {
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) return body.error;
      } catch {
        // Fall through to the normal Error message.
      }
    }
  }
  return error instanceof Error ? error.message : "The request could not be completed.";
}
```

In `territory-game-v2.tsx`, delete the local definitions (lines 161-186, keeping `memberColor` — it depends on component-local constants until Task 9) and add `import { dayNumber, edgeErrorMessage, timeLeft } from "@/lib/game-format";`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (new file green, existing 5 still green).

- [ ] **Step 5: Add edge-case tests for game-rules**

Append to `tests/game-rules.test.ts`:

```ts
test("refreshedActions ignores negative elapsed days and respects the cap", () => {
  assert.equal(refreshedActions({ currentActions: 2, elapsedDays: -3 }), 2);
  assert.equal(refreshedActions({ currentActions: 5, elapsedDays: 0 }), 5);
  assert.equal(refreshedActions({ currentActions: 0, elapsedDays: 100 }), 5);
});

test("normalizeAnswer flattens whitespace runs and strips symbols", () => {
  assert.equal(normalizeAnswer("  L.A.\tLakers \n"), "l a lakers");
  assert.equal(normalizeAnswer("49ers!"), "49ers");
  assert.equal(normalizeAnswer(""), "");
});

test("canAttackTerritory treats missing adjacency entries as no border", () => {
  assert.equal(
    canAttackTerritory({ targetId: "HI", ownedTerritoryIds: ["CA"], adjacencyByTerritory: {} }),
    false,
  );
});
```

- [ ] **Step 6: Full check and commit**

Run: `npm test && npm run typecheck && npm run build` — all pass, then:

```bash
git add lib/game-format.ts tests/game-format.test.ts tests/game-rules.test.ts components/territory-game-v2.tsx
git commit -m "test(rules): extract pure format helpers and cover edge cases"
```

---

### Task 5: Stand up the Supabase local stack

**Files:**
- Create: `supabase/config.toml` (via `supabase init`)
- Create: `docs/superpowers/local-stack.md`
- Modify: `package.json` (scripts only)
- Modify: `.gitignore` (add `supabase/.temp` if `supabase init` creates it)

**Interfaces:**
- Consumes: Task 1 (app reads Supabase URL/key from env, so it can point at the local stack).
- Produces: a running local stack at `http://127.0.0.1:54321` with all migrations applied and 550 seed questions; env variable names `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_KEY` that Tasks 6, 7, and 10 read.

- [ ] **Step 1: Initialize the CLI project**

Run from the repo root: `supabase init`
Expected: creates `supabase/config.toml`; existing `migrations/` and `functions/` are untouched. Answer "no" to any VS Code settings prompt.

- [ ] **Step 2: Start the stack and apply migrations**

Run: `supabase start` (first run downloads containers; needs Docker running), then `supabase db reset` (applies every file in `supabase/migrations/` in order).
Expected: both succeed. If a migration fails locally, that is an audit finding (record it in Task 7's findings doc) — production already has these applied, so a local failure means ordering or idempotency problems.

- [ ] **Step 3: Verify seed data**

Run: `supabase status` (note the API URL, anon key, service_role key), then:

```bash
psql "$(supabase status -o json | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d).DB_URL))")" \
  -c "select count(*) from public.questions;" -t
```

Expected: `550`.

- [ ] **Step 4: Add npm scripts**

In `package.json` scripts, add:

```json
"stack:start": "supabase start",
"stack:reset": "supabase db reset",
"stack:stop": "supabase stop",
"test:db": "node --experimental-strip-types --test tests/db/*.test.ts",
"test:smoke": "node --experimental-strip-types --test tests/smoke/*.test.ts"
```

(`tests/db/` and `tests/smoke/` arrive in Tasks 6 and 10; the scripts are inert until then.)

- [ ] **Step 5: Document the workflow**

Create `docs/superpowers/local-stack.md` containing: prerequisites (Docker), the three stack commands, how to read keys from `supabase status`, how to run the app against the stack —

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<anon key from supabase status> \
npm run dev
```

(shell env overrides `.env.local` in Next.js), how to serve the signup edge function (`supabase functions serve test-signup`), and how to export test env vars:

```bash
export SUPABASE_TEST_URL=http://127.0.0.1:54321
export SUPABASE_TEST_ANON_KEY=<anon key>
export SUPABASE_TEST_SERVICE_KEY=<service_role key>
```

- [ ] **Step 6: Verify the app runs against the stack**

Start dev with the env overrides above, open `http://localhost:3000`.
Expected: landing page renders; sign-in against the local stack fails cleanly for a nonexistent user (proves it is not talking to production).

- [ ] **Step 7: Commit**

```bash
git add supabase/config.toml package.json docs/superpowers/local-stack.md .gitignore
git commit -m "chore(stack): add supabase local stack config and scripts"
```

---

### Task 6: DB engine test harness and core tests

**Files:**
- Create: `tests/db/helpers.ts`
- Create: `tests/db/engine.test.ts`

**Interfaces:**
- Consumes: Task 5 (running stack + `SUPABASE_TEST_*` env vars; `npm run test:db` script).
- Produces (reused by Task 10):
  - `admin: SupabaseClient` (service-role client)
  - `createTestUser(displayName: string): Promise<SupabaseClient>` (signed-in per-user client)
  - `correctAnswerFor(sessionId: string): Promise<string>`
  - `answerUntilResolved(user: SupabaseClient, sessionId: string): Promise<{ status: string; message?: string }>`

Before writing assertions, read `supabase/migrations/20260730220000_add_playtest_turn_handoff.sql` and `20260802173000_stabilize_turn_scoring_questions_and_bots.sql` to confirm two things the tests below assume: (a) in test-mode groups only the current-turn player may begin claim/attack actions (defenses excepted), and (b) `end_test_turn` advances the rotation. Also read `handle_new_user` in `202607300001_initial_schema.sql` to confirm which `user_metadata` key populates `profiles.display_name`, and adjust `createTestUser` if it is not `display_name`. If reality differs from an assumption, fix the test to match the code and note the surprise in `docs/superpowers/backlog.md`.

- [ ] **Step 1: Write the harness**

Create `tests/db/helpers.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_TEST_SERVICE_KEY ?? "";
const anonKey = process.env.SUPABASE_TEST_ANON_KEY ?? "";

if (!serviceKey || !anonKey) {
  throw new Error("Set SUPABASE_TEST_ANON_KEY and SUPABASE_TEST_SERVICE_KEY (see docs/superpowers/local-stack.md).");
}

export const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

export async function createTestUser(displayName: string): Promise<SupabaseClient> {
  const email = `${crypto.randomUUID()}@playtest.local`;
  const password = "playtest-password-1";
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  if (created.error) throw created.error;
  const user = createClient(url, anonKey, { auth: { persistSession: false } });
  const signIn = await user.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return user;
}

export async function correctAnswerFor(sessionId: string): Promise<string> {
  const { data, error } = await admin
    .from("question_attempts")
    .select("questions(correct_answer)")
    .eq("session_id", sessionId)
    .is("answered_at", null)
    .order("served_at", { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  return (data as unknown as { questions: { correct_answer: string } }).questions.correct_answer;
}

export async function answerUntilResolved(
  user: SupabaseClient,
  sessionId: string,
): Promise<{ status: string; message?: string }> {
  for (let round = 0; round < 5; round += 1) {
    const answer = await correctAnswerFor(sessionId);
    const { data, error } = await user.rpc("game_submit_answer", {
      p_session_id: sessionId,
      p_answer: answer,
    });
    if (error) throw error;
    const result = data as { status: string; message?: string };
    if (result.status !== "active") return result;
  }
  throw new Error("Session did not resolve within five correct answers.");
}
```

- [ ] **Step 2: Write the failing core test**

Create `tests/db/engine.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, answerUntilResolved, correctAnswerFor, createTestUser } from "./helpers.ts";

type Snapshot = {
  current_user_id: string;
  group: { id: string; invite_code: string; status: string };
  season: null | { id: string; status: string };
  members: Array<{ user_id: string; display_name: string; home_state?: string | null }>;
  territories: Array<{ id: string; owner_id: string | null; hold_level: number; contested: boolean }>;
  actions_remaining: number;
};

async function snapshot(user: SupabaseClient, groupId: string): Promise<Snapshot> {
  const { data, error } = await user.rpc("group_snapshot", { p_group_id: groupId });
  if (error) throw error;
  return data as Snapshot;
}

async function begin(user: SupabaseClient, seasonId: string, territory: string, kind: string) {
  const { data, error } = await user.rpc("game_begin_action", {
    p_season_id: seasonId,
    p_territory_id: territory,
    p_action_type: kind,
    p_attack_id: null,
  });
  if (error) throw error;
  return data as { session_id: string };
}

test("full lobby-to-claim flow works for three players", async () => {
  const alice = await createTestUser("Alice");
  const bob = await createTestUser("Bob");
  const cara = await createTestUser("Cara");

  const createdGroup = await alice.rpc("create_group_v2", {
    p_name: "Engine Test League",
    p_sports: ["NFL", "MLB"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  assert.equal(createdGroup.error, null);
  const groupId = createdGroup.data as string;

  const invite = (await snapshot(alice, groupId)).group.invite_code;
  assert.equal((await bob.rpc("join_group", { p_invite_code: invite })).error, null);
  assert.equal((await cara.rpc("join_group", { p_invite_code: invite })).error, null);

  for (const [user, home] of [[alice, "WA"], [bob, "FL"], [cara, "ME"]] as const) {
    const saved = await user.rpc("set_home_state", { p_group_id: groupId, p_home_state: home });
    assert.equal(saved.error, null);
  }

  assert.equal((await alice.rpc("start_season", { p_group_id: groupId })).error, null);
  const started = await snapshot(alice, groupId);
  assert.ok(started.season, "season should exist after start_season");
  const seasonId = started.season!.id;

  const home = await begin(alice, seasonId, "WA", "home");
  const result = await answerUntilResolved(alice, home.session_id);
  assert.notEqual(result.status, "failed");

  const after = await snapshot(alice, groupId);
  const wa = after.territories.find((territory) => territory.id === "WA");
  assert.equal(wa?.owner_id, after.current_user_id);
});

test("wrong answers fail a session and the correct answer is disclosed", async () => {
  const dana = await createTestUser("Dana");
  const erin = await createTestUser("Erin");
  const createdGroup = await dana.rpc("create_group_v2", {
    p_name: "Failure League",
    p_sports: ["NFL"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  const groupId = createdGroup.data as string;
  const invite = (await snapshot(dana, groupId)).group.invite_code;
  await erin.rpc("join_group", { p_invite_code: invite });
  await dana.rpc("set_home_state", { p_group_id: groupId, p_home_state: "TX" });
  await erin.rpc("set_home_state", { p_group_id: groupId, p_home_state: "NY" });
  await dana.rpc("start_season", { p_group_id: groupId });
  const seasonId = (await snapshot(dana, groupId)).season!.id;

  const session = await begin(dana, seasonId, "TX", "home");
  const submitted = await dana.rpc("game_submit_answer", {
    p_session_id: session.session_id,
    p_answer: "definitely wrong answer xyzzy",
  });
  assert.equal(submitted.error, null);
  const outcome = submitted.data as { status: string };
  assert.ok(["failed", "active"].includes(outcome.status));
});

test("a non-member cannot read another group's snapshot", async () => {
  const frank = await createTestUser("Frank");
  const grace = await createTestUser("Grace");
  const createdGroup = await frank.rpc("create_group_v2", {
    p_name: "Private League",
    p_sports: ["NBA"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  const groupId = createdGroup.data as string;
  const denied = await grace.rpc("group_snapshot", { p_group_id: groupId });
  assert.ok(denied.error, "outsider snapshot should be rejected");
});

test("correctAnswerFor helper reads the served question", async () => {
  const henry = await createTestUser("Henry");
  const iris = await createTestUser("Iris");
  const createdGroup = await henry.rpc("create_group_v2", {
    p_name: "Helper League",
    p_sports: ["NFL"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  const groupId = createdGroup.data as string;
  const invite = (await snapshot(henry, groupId)).group.invite_code;
  await iris.rpc("join_group", { p_invite_code: invite });
  await henry.rpc("set_home_state", { p_group_id: groupId, p_home_state: "OH" });
  await iris.rpc("set_home_state", { p_group_id: groupId, p_home_state: "GA" });
  await henry.rpc("start_season", { p_group_id: groupId });
  const seasonId = (await snapshot(henry, groupId)).season!.id;
  const session = await begin(henry, seasonId, "OH", "home");
  const answer = await correctAnswerFor(session.session_id);
  assert.ok(answer.length > 0);
});
```

- [ ] **Step 3: Run to verify current behavior**

Run: `npm run test:db` (with the stack up and env vars exported).
Expected: tests compile and run. Any failure is either a harness assumption to fix (turn semantics, metadata key — see the note above Step 1) or a genuine engine bug. Engine bugs do NOT get fixed here — record them in `docs/superpowers/audit-findings.md` (created properly in Task 7; start the file now if needed) and mark the failing assertion with a linking comment.

- [ ] **Step 4: Iterate until harness assumptions match reality**

Adjust helper/test details (RPC parameter names, response field names) until the only failures left are genuine engine bugs or everything passes. `npm test` (unit suite) must stay green and must not require the stack.

- [ ] **Step 5: Commit**

```bash
git add tests/db/
git commit -m "test(db): add engine harness and core RPC coverage"
```

---

### Task 7: Audit playthrough and code review

**Files:**
- Create: `docs/superpowers/audit-findings.md`
- Create: `docs/superpowers/backlog.md`
- Test: `tests/db/audit.test.ts` (new probes for suspected bugs)

**Interfaces:**
- Consumes: Tasks 5-6 (stack + harness).
- Produces: the findings doc that drives Task 8, and the backlog file future phases start from.

- [ ] **Step 1: Create the findings scaffold**

`docs/superpowers/audit-findings.md` starts as:

```markdown
# Phase 1 audit findings

Severity: blocker (game unplayable / data corrupting), bug (wrong behavior,
playable around), papercut (annoyance; fix only if trivial, else backlog).

| # | Severity | Area | Finding | Repro | Status |
|---|----------|------|---------|-------|--------|
```

`docs/superpowers/backlog.md` starts as:

```markdown
# Territory backlog

Deferred observations, tagged by future phase (P2 UX/visual, P3 trivia,
P4 strategy/meta, P5 go-live).

| Phase | Item | Source |
|-------|------|--------|
```

- [ ] **Step 2: Scripted playthrough sweep**

Extend the harness with probes in `tests/db/audit.test.ts` for every mechanic on the spec's checklist. Write one test per mechanic using the Task 6 pattern (helpers + `begin` + `answerUntilResolved`); the mechanics and their expected behavior:

1. Neutral claim succeeds on an adjacent unowned state and consumes one action (`actions_remaining` drops by 1 in the next snapshot).
2. Claim on a non-adjacent state is rejected once the player owns territory.
3. Attack on an adjacent enemy state with a correct-answer streak transfers ownership or creates a contested attack with a `defense_deadline` (assert whichever the code does — record the answer in the findings doc if it contradicts the README).
4. A second attack on an already-contested state is rejected ("one active attack per state").
5. Defense: the defender calls `game_begin_action` with `p_action_type: 'defend'` and the attack id; a correct answer keeps the state.
6. Expired attacks resolve via `resolve_expired_attacks` (set `defense_deadline` into the past with the `admin` client, call the function, assert resolution).
7. Expired question sessions resolve via `resolve_expired_sessions` the same way.
8. Fortify raises `hold_level` (max 3) and is blocked on contested states.
9. `test_refill_actions` grants actions only in test-mode groups.
10. `report_question` quarantines the question and refunds the action.
11. `run_daily_tick` writes `daily_score_events` for held territories.
12. Turn rotation: non-turn player cannot begin claim/attack; `end_test_turn` advances; defense is allowed off-turn.
13. Action exhaustion: with `actions_remaining` at 0 (spend them all or set via `admin` on `player_actions`), `game_begin_action` for claim/attack is rejected; fortify behaves per the code (assert what it does, note if it contradicts the UI copy "your own states can still be fortified for free").
14. Cooldowns: after a failed attack on a state, an immediate retry is rejected while a row exists in `cooldowns`; expire it via `admin` and the retry succeeds.
15. Underdog discount: seed an imbalanced board via `admin` updates to `season_territories`, then assert the trailing player's `game_begin_action` response reports a lower `required_correct` than the leader gets for the same target hold level.
16. Cron endpoint: with the dev server running against the stack, `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/tick` returns 200, and an unauthenticated call returns 401.

Every deviation between observed and expected goes in the findings table with severity and repro. Keep the probes as permanent tests where they pass; mark known-failing ones with a comment naming the finding number.

- [ ] **Step 3: Manual browser pass**

Run the app against the local stack (Task 5 Step 6) with the edge function served. In two browser profiles (or one normal + one incognito), sign up via the UI (exercises `test-signup`), play the lobby → home state → claim → attack flow on real screens, and specifically:
- Reproduce the landing-page dev-overlay issue: open `http://localhost:3000` signed out, open the overlay, copy the exact error text into the findings doc.
- Refresh mid-question; the question should resume (spec: "resumes unfinished questions after refresh").
- Let a question timer hit zero on screen; verify the auto-submit outcome renders.
- Watch the second profile's map update in realtime after the first profile claims (local stack runs realtime; note any doubts about production realtime in the findings doc as flagged-for-two-phone-check).
UX annoyances that are not bugs go to the backlog with phase tags, not the findings table.

- [ ] **Step 4: Code review of the authoritative surface**

Read, in order, with the findings doc open:
1. Each migration in `supabase/migrations/` chronologically — for every `security definer` function ask: does it verify the caller's membership/turn? Does it lock rows (`for update`) before read-modify-write on `season_territories`, `player_actions`, `attacks`? Can two concurrent calls double-spend an action or double-resolve an attack?
2. `app/api/cron/tick/route.ts` — verify it requires `CRON_SECRET`, uses the server-side key, and is idempotent for repeated calls in the same day.
3. `app/api/game/*/route.ts` and `app/api/groups/route.ts` — verify auth is enforced (they should use `lib/supabase/server.ts`, not trust the client), and note whether they are used at all by the current UI (the UI calls RPCs directly; unused routes are candidates for deletion — findings doc).
4. `supabase/functions/test-signup/` — verify the invite code is validated before account creation and the secret key is not exposed.
5. UTC edges in `run_daily_tick` and `refresh_player_actions`: what happens when called twice in one UTC day, or across a DST boundary for US users.
Record every suspicion as a finding with a probe test where feasible.

- [ ] **Step 5: Commit the audit artifacts**

```bash
git add docs/superpowers/audit-findings.md docs/superpowers/backlog.md tests/db/audit.test.ts
git commit -m "docs(audit): record phase 1 playthrough and review findings"
```

---

### Task 8: Fix audit findings

**Files:**
- Modify: determined by the findings table (SQL fixes land as **new** migration files `supabase/migrations/<timestamp>_fix_<slug>.sql` — never edit an applied migration; TS fixes edit the relevant source file)
- Test: every fix adds or un-skips a test at the layer where the bug lived

**Interfaces:**
- Consumes: Task 7's findings table.
- Produces: an empty blocker/bug list; the landing-page overlay issue and any engine bugs from Task 6 Step 3 resolved.

This task is a loop, run once per finding, in severity order (blockers, then bugs; papercuts only if the fix is under ~10 lines, else move to backlog):

- [ ] **Step 1: Write the failing regression test** for the finding (DB probe in `tests/db/`, unit test in `tests/`, or — for pure UI findings like the dev overlay — a written manual repro in the findings row).
- [ ] **Step 2: Run it to confirm it fails** for the reason the finding describes.
- [ ] **Step 3: Implement the minimal fix.** For SQL: create a new timestamped migration with `create or replace function ...` and run `supabase db reset` to prove the full chain still applies cleanly.
- [ ] **Step 4: Run the full relevant suites** — `npm test`, `npm run test:db`, `npm run typecheck`, `npm run build`.
- [ ] **Step 5: Update the finding's Status column** to `fixed (<commit>)`.
- [ ] **Step 6: Commit** — one commit per finding: `fix(<area>): <finding summary>`.

Exit condition: findings table has zero open blockers/bugs, and the dev server console shows no warnings or overlay issues on the landing page and in normal play.

**Deploying SQL fixes to production is part of this task's definition of done for migrations only** — after all fixes land, run the existing GitHub Actions "Deploy Supabase database" workflow from `main` per README (requires the owner's repo secrets; if they are not configured, note it in the findings doc and tell the user — do not paste any token into the repo).

---

### Task 9: Split the monolith

**Files:**
- Create: `lib/game-types.ts`, `lib/game-constants.ts`, `hooks/use-supabase-session.ts`, `hooks/use-game-state.ts`, `components/auth-stage.tsx`, `components/league-entry.tsx`, `components/lobby-stage.tsx`, `components/territory-map.tsx`, `components/game-shell.tsx`, `components/game-overlays.tsx`, `components/question-arena.tsx`, `components/territory-game.tsx`
- Delete (at the end): `components/territory-game-v2.tsx`
- Modify: `app/page.tsx` (import path), `components/game-runtime-controls.tsx` (use the session hook)
- Keep: `components/territory-game-v2.module.css` unchanged — all new components import it as `import styles from "./territory-game-v2.module.css";` (renaming the CSS module is churn; backlog it for Phase 2).

**Interfaces:**
- Consumes: Tasks 1-4 (shared client, clean imports, `lib/game-format.ts`).
- Produces:
  - `lib/game-types.ts`: exports the interfaces currently at `territory-game-v2.tsx:57-156` verbatim — `GroupRow`, `Member`, `Territory`, `Attack`, `ScoreRow`, `FeedRow`, `Snapshot`, `Question`, `ActiveOperation`, `ResultState`, `ToastState`, `type View = "map" | "standings" | "feed"`.
  - `lib/game-constants.ts`: exports the constants at lines 22-55 plus `memberColor` (line 158) — `PATHS`, `CENTROIDS`, `ADJ`, `PLAYER_COLORS`, `NEUTRAL`, `INK`, `PAPER`, `DANGER`, `STATE_NAMES`, `ALL_STATES`, `MAP_LABELS`, `LEADERS`, `SPORTS`, `memberColor`. Imports `mapData from "@/data/us-states"` and `adjacencyData from "@/data/adjacency.json"`.
  - `hooks/use-supabase-session.ts`: `useSupabaseSession(): { session: Session | null; authReady: boolean }`
  - `hooks/use-game-state.ts`: `useGameState(session: Session | null): GameState` (shape below)
  - Components with the exact prop types already present in the monolith (see per-file map).

Extraction order matters — leaves first, coordinator last, `npm run typecheck` after every step. The dev server should stay running against the local stack; click through after each extraction.

- [ ] **Step 1: Extract `lib/game-types.ts`** — move lines 57-156 verbatim, `export` each interface and the `View` type. In `territory-game-v2.tsx` replace them with `import type { ... } from "@/lib/game-types";`. Typecheck.

- [ ] **Step 2: Extract `lib/game-constants.ts`** — move lines 22-55 and `memberColor` (lines 158-160). Top of file:

```ts
import mapData from "@/data/us-states";
import adjacencyData from "@/data/adjacency.json";
import type { Member, ScoreRow } from "@/lib/game-types";
```

Export everything. Replace in the monolith with imports. Typecheck.

- [ ] **Step 3: Extract `hooks/use-supabase-session.ts`** — new file:

```ts
"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

export function useSupabaseSession(): { session: Session | null; authReady: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setAuthReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!mounted) return;
      setSession(next);
      setAuthReady(true);
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return { session, authReady };
}
```

Use it in `game-runtime-controls.tsx`: delete its `session` state and the first `useEffect` (lines 105-123), call `const { session } = useSupabaseSession();`, and trigger `load(session)` from a `useEffect` on `[session, load]`. Typecheck; verify logout still works in the browser.

- [ ] **Step 4: Extract `hooks/use-game-state.ts`** — moves the state block (lines 189-298) into a hook returning everything the coordinator needs:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { ActiveOperation, GroupRow, ResultState, Snapshot, ToastState } from "@/lib/game-types";

const supabase = createClient();

export interface GameState {
  groups: GroupRow[];
  groupId: string | null;
  setGroupId: (id: string | null) => void;
  snapshot: Snapshot | null;
  operation: ActiveOperation | null;
  setOperation: (operation: ActiveOperation | null) => void;
  result: ResultState | null;
  setResult: (result: ResultState | null) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  toast: ToastState | null;
  notify: (text: string, error?: boolean) => void;
  loadGroups: (preferred?: string | null) => Promise<void>;
  loadSnapshot: (target?: string | null) => Promise<void>;
  beginAction: (kind: string, state: string, attackId?: string) => Promise<void>;
}

export function useGameState(session: Session | null): GameState {
  // State declarations: move lines 191-201 here unchanged (groups, groupId,
  // snapshot, operation, result, busy, toast — view/selected/front/leaguePicker
  // stay in the coordinator; they are presentation state).
  // Callbacks and effects: move notify (203-206), loadGroups (208-220),
  // loadSnapshot (222-238), the session-driven reset effect (252-260), the
  // snapshot-load effect (262-264), the realtime channel + 20s polling effect
  // (266-281), and beginAction (283-298) here unchanged, replacing references
  // to the removed auth effect with the session parameter.
  // Return every field of GameState.
}
```

The comment lines above are the move instructions, not code to keep — the hook body is the moved code. Typecheck.

- [ ] **Step 5: Extract leaf components, one commit each.** For each, create the file with `"use client";`, the imports it needs (`styles` from `./territory-game-v2.module.css`, constants from `@/lib/game-constants`, types from `@/lib/game-types`, helpers from `@/lib/game-format`, and `createClient` where the component calls RPCs directly), move the function verbatim, `export default` it, and update the monolith to import it. Source line ranges in the current file:
  - `components/territory-map.tsx` ← `TerritoryMap` (lines 677-731).
  - `components/auth-stage.tsx` ← `AuthStage` (lines 383-459). Calls `supabase.auth.signInWithPassword` and `supabase.functions.invoke("test-signup")` — needs the shared client and `edgeErrorMessage`.
  - `components/league-entry.tsx` ← `LeagueEntry` (lines 461-517). Needs `SPORTS` and the shared client.
  - `components/lobby-stage.tsx` ← `LobbyStage` (lines 519-582). Needs `TerritoryMap`, `STATE_NAMES`, `ALL_STATES`, `memberColor`, shared client.
  - `components/game-overlays.tsx` ← `StandingsOverlay`, `FeedOverlay`, `LeaguePicker` (lines 783-793) as named exports, plus the three-line `Loading` helper (lines 379-381) as a named export — it is shared by the coordinator and `QuestionArena`.
  - `components/question-arena.tsx` ← `QuestionArena` (lines 795-859). Needs shared client, `STATE_NAMES`, and `Loading` from `./game-overlays`.
  - `components/game-shell.tsx` ← `GameShell`, `HudMetric`, `MissionDock`, `TerritorySheet` (lines 584-781 minus TerritoryMap). Needs `TerritoryMap`, constants, `dayNumber`/`timeLeft`, types.
  After each extraction: `npm run typecheck`, click the affected screen, `git add -A && git commit -m "refactor(game): extract <name> component"`.

- [ ] **Step 6: Write the coordinator `components/territory-game.tsx`** — the remaining shell (target: under 120 lines):

```ts
"use client";

import { useState } from "react";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { useGameState } from "@/hooks/use-game-state";
import type { View } from "@/lib/game-types";
import styles from "./territory-game-v2.module.css";
import AuthStage from "./auth-stage";
import LeagueEntry from "./league-entry";
import LobbyStage from "./lobby-stage";
import GameShell from "./game-shell";
import QuestionArena from "./question-arena";
import { LeaguePicker, Loading } from "./game-overlays";

export default function TerritoryGame() {
  const { session, authReady } = useSupabaseSession();
  const game = useGameState(session);
  const [view, setView] = useState<View>("map");
  const [selected, setSelected] = useState<string | null>(null);
  const [front, setFront] = useState<string | null>(null);
  const [leaguePicker, setLeaguePicker] = useState(false);

  // Stage selection: reproduce the branch chain from territory-game-v2.tsx
  // lines 300-377 exactly, substituting game.* accessors and the local
  // presentation state above. The refill handler (lines 364-373) moves here
  // unchanged, calling the shared client via game state's beginAction pattern.
}
```

The commented lines are instructions: the render logic moves from the old file's lines 300-377 with `game.` prefixes. Update `app/page.tsx` to `import TerritoryGame from "@/components/territory-game";` and render `<TerritoryGame />`. Delete `components/territory-game-v2.tsx` (`git rm`).

- [ ] **Step 7: Verify size and behavior**

Run: `wc -l components/*.tsx hooks/*.ts lib/game-*.ts | sort -rn | head -8`
Expected: every file under 300 lines.
Then the full loop in the browser against the local stack: sign in, lobby, claim, question, standings, feed, league picker, logout.
Run: `npm test && npm run test:db && npm run typecheck && npm run build` — all pass.

- [ ] **Step 8: Final split commit**

```bash
git add -A
git commit -m "refactor(game): replace monolith with coordinator and focused components"
```

---

### Task 10: End-to-end smoke test

**Files:**
- Create: `tests/smoke/mini-season.test.ts`

**Interfaces:**
- Consumes: Task 6 helpers (`createTestUser`, `answerUntilResolved`, `admin`), Task 5 stack, and — for turn rotation — the semantics confirmed in Task 6.
- Produces: `npm run test:smoke` — the pre-ship gate named in the spec's done criteria.

- [ ] **Step 1: Write the scripted mini-season**

One linear test that proves the whole pipe (import helpers via a relative path `../db/helpers.ts`):

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, answerUntilResolved, createTestUser } from "../db/helpers.ts";

test("a three-player mini-season plays end to end", async () => {
  // 1. Three users, one group, everyone joined.
  const players: Array<{ name: string; client: SupabaseClient; home: string }> = [
    { name: "Smoke-A", client: await createTestUser("Smoke-A"), home: "WA" },
    { name: "Smoke-B", client: await createTestUser("Smoke-B"), home: "OR" },
    { name: "Smoke-C", client: await createTestUser("Smoke-C"), home: "CA" },
  ];
  const [a, b, c] = players;
  const created = await a.client.rpc("create_group_v2", {
    p_name: "Smoke Season",
    p_sports: ["NFL"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  assert.equal(created.error, null);
  const groupId = created.data as string;
  const snap = async (u: SupabaseClient) => {
    const { data, error } = await u.rpc("group_snapshot", { p_group_id: groupId });
    assert.equal(error, null);
    return data as {
      season: null | { id: string };
      group: { invite_code: string };
      current_user_id: string;
      territories: Array<{ id: string; owner_id: string | null }>;
      scores: Array<{ user_id: string; cumulative_score: number }>;
    };
  };
  const invite = (await snap(a.client)).group.invite_code;
  for (const p of [b, c]) {
    assert.equal((await p.client.rpc("join_group", { p_invite_code: invite })).error, null);
  }

  // 2. Homes locked, season started.
  for (const p of players) {
    assert.equal(
      (await p.client.rpc("set_home_state", { p_group_id: groupId, p_home_state: p.home })).error,
      null,
    );
  }
  assert.equal((await a.client.rpc("start_season", { p_group_id: groupId })).error, null);
  const seasonId = (await snap(a.client)).season!.id;

  // 3. Each player secures home ground, rotating turns as required.
  for (const p of players) {
    const begun = await p.client.rpc("game_begin_action", {
      p_season_id: seasonId,
      p_territory_id: p.home,
      p_action_type: "home",
      p_attack_id: null,
    });
    assert.equal(begun.error, null, `${p.name} begins home action`);
    const outcome = await answerUntilResolved(p.client, (begun.data as { session_id: string }).session_id);
    assert.notEqual(outcome.status, "failed", `${p.name} secures home`);
    await p.client.rpc("end_test_turn", { p_group_id: groupId });
  }
  const afterHomes = await snap(a.client);
  for (const p of players) {
    const territory = afterHomes.territories.find((t) => t.id === p.home);
    assert.ok(territory?.owner_id, `${p.home} is owned after home round`);
  }

  // 4. Player A claims an adjacent neutral state (ID borders WA and OR).
  const claim = await a.client.rpc("game_begin_action", {
    p_season_id: seasonId,
    p_territory_id: "ID",
    p_action_type: "claim",
    p_attack_id: null,
  });
  assert.equal(claim.error, null);
  const claimOutcome = await answerUntilResolved(a.client, (claim.data as { session_id: string }).session_id);
  assert.notEqual(claimOutcome.status, "failed");

  // 5. Daily tick produces score events.
  const tick = await admin.rpc("run_daily_tick");
  assert.equal(tick.error, null);
  const { data: events, error: eventsError } = await admin
    .from("daily_score_events")
    .select("id")
    .limit(1);
  assert.equal(eventsError, null);
  assert.ok((events ?? []).length > 0, "daily tick recorded score events");
});
```

Adjust the turn-rotation choreography (step 3) to whatever Task 6 confirmed — for example if `start_season` gives the first turn to the commissioner only, rotate with `end_test_turn` before B and C act, and if `run_daily_tick` takes parameters, pass what the migration defines.

- [ ] **Step 2: Run it**

Run: `npm run test:smoke`
Expected: PASS against a freshly reset stack (`npm run stack:reset` first for a clean board).

- [ ] **Step 3: Commit**

```bash
git add tests/smoke/
git commit -m "test(smoke): script a three-player mini-season"
```

---

### Task 11: Final validation and closeout

**Files:**
- Modify: `IMPLEMENTATION_STATUS.md`, `docs/superpowers/audit-findings.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the spec's done criteria, checked and recorded.

- [ ] **Step 1: Clean-room run**

```bash
npm run stack:reset && npm test && npm run test:db && npm run test:smoke \
  && npm run typecheck && npm run build && npm run lint
```

Expected: all pass.

- [ ] **Step 2: Manual loop replay** — full click-through on the local stack (sign up via edge function, lobby, home, claim, attack, defend from second profile, standings, feed, report question, logout). Console stays free of warnings/errors; dev overlay shows zero issues.

- [ ] **Step 3: Verify done criteria against the spec** — walk the spec's "Done criteria" list; for each, add a line to the bottom of `docs/superpowers/audit-findings.md` under a `## Phase 1 closeout` heading: criterion, evidence (test name or commit). File-size check: `wc -l components/*.tsx hooks/*.ts lib/*.ts | awk '$1 > 300'` prints nothing.

- [ ] **Step 4: Update `IMPLEMENTATION_STATUS.md`** — replace the "Requires owner authorization" framing with the current truth: code stabilized (Phase 1 complete), local stack + three-layer test suite exist, deployment remains Phase 5.

- [ ] **Step 5: Commit and hand off**

```bash
git add IMPLEMENTATION_STATUS.md docs/superpowers/audit-findings.md
git commit -m "docs(status): record phase 1 stabilization closeout"
```

Then tell the user Phase 1 is complete, summarize findings fixed vs backlogged, and recommend the two-phone realtime sanity check plus starting the Phase 2 (UX/visual) brainstorm.
