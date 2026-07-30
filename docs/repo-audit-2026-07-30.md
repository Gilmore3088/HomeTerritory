# HomeTerritory repository audit — 2026-07-30

Scope: full read of the application code, all Supabase migrations, the edge
function, workflows, and configs, plus an empirical run of the verification
suite on a clean checkout of `main` (commit `5ac74e0`).

## Verification results

| Check | Result |
| --- | --- |
| `npm test` | ✅ 5/5 pass |
| `npm run typecheck` | ✅ clean |
| `npm run build` | ✅ succeeds |
| `npm run lint` | ❌ crashes (ESLint 10 / `eslint-plugin-react` incompatibility) |

CI runs test + typecheck + build but **not** lint, so the broken lint script
is invisible in CI.

## What is genuinely good

- Server-authoritative design is real: every gameplay mutation goes through
  `security definer` RPCs with `search_path` pinned, RLS is enabled on every
  table, direct grants on sensitive tables (`questions`, `game_sessions`,
  `question_attempts`, …) are revoked, and internal functions have `execute`
  revoked from `public/anon/authenticated`.
- Partial unique indexes (`one_active_season_per_group`,
  `one_contested_attack_per_territory`) and `for update` locking give the
  engine correct concurrency semantics; RPCs are atomic so failures roll back
  cleanly (e.g. the action cost when the question pool is empty).
- Secrets discipline is right: nothing secret is committed, deploys use GitHub
  Actions secrets, the cron route requires `CRON_SECRET`, and the admin client
  is server-only.

## Critical / High findings

### 1. Resumed questions leak the correct answer (gameplay-breaking)
`get_my_active_session` (migration `…082100`) returns
`v_question.options` **raw**. The seed data builds options with the correct
answer as the **first array element** (`jsonb_build_array(f.subject, …)`);
only `pick_next_question` shuffles them at serve time. So any player who
refreshes the page mid-question resumes it with the correct answer reliably
in position 1. Fix: persist the shuffled order on the attempt (or shuffle
deterministically per attempt) and return that.

### 2. `test-signup` edge function writes home-state to the wrong table
`home_state` / `home_completed` live on `group_members` (migration
`…082000`), but `supabase/functions/test-signup/index.ts` reads and writes
them on `profiles`. Those PostgREST calls fail — and the errors are
discarded (`data` destructured, `error` ignored) — so a late joiner into an
active league gets a territory assigned in `season_territories` but their
`group_members.home_state` is never set. The function reports success while
half its work silently failed. Fix the table, and check every `error`.

### 3. `test-signup` lets anyone with an invite code take over unconfirmed accounts
For an existing **unconfirmed** user, the function calls
`admin.auth.admin.updateUserById(user.id, { password, email_confirm: true })`
— i.e. it resets the password and confirms the email of an account the caller
does not control, gated only by possession of any valid playtest invite code.
Invite codes are shown to every league member and included in every
`group_snapshot`, so they are not secrets. The endpoint is also
unauthenticated, `Access-Control-Allow-Origin: *`, unrate-limited, and its
`listUsers({ perPage: 1000 })` duplicate-email check breaks past 1000 users.
Acceptable for a closed playtest, but this must not survive into anything
public. Minimum fix: only "recover" an unconfirmed account when the requester
proves control of the email (send a confirmation), or drop the recovery path.

### 4. Home-ground question can be re-rolled indefinitely
`game_submit_answer` sets `home_completed = true` whether the home answer is
right or wrong — but the **timeout** path (`resolve_expired_sessions`) only
handles `claim` and `defend`. A `home` session that expires just becomes
`failed`, `home_completed` stays false, and `game_begin_action('home')` costs
no action. A player can therefore open the home question, let it time out
whenever they don't know the answer, and repeat until they draw one they
know — a guaranteed hold-level-2 start — burning the season's shared question
pool for their state along the way. Fix: mark `home_completed` (and set hold
to 1) when a home session times out.

### 5. No lockfile committed
`package-lock.json` is untracked while every dependency uses `^` ranges and
CI runs `npm install` (not `npm ci`). Builds are unreproducible and a bad
upstream release lands directly in CI/production. Related: `.npmrc` sets
`legacy-peer-deps=true` to paper over `react-simple-maps@3.0.0` not
supporting React 19 — that dependency (used only by the legacy UI) is
effectively unmaintained against this stack. Commit the lockfile and switch
CI to `npm ci`.

## Medium findings

### 6. Two parallel auth systems that don't share a session
The root page (`components/territory-game-v2.tsx`) creates its own
`supabase-js` client with a **hardcoded** URL and publishable key
(localStorage sessions), while `/login`, `/app`, and `/g/[groupId]` use
`@supabase/ssr` cookie sessions via `lib/supabase/*` and env vars. Signing in
on one surface does not sign you in on the other. The hardcoded key is a
publishable key (client-safe by design), but it bypasses
`NEXT_PUBLIC_SUPABASE_*` config, contradicts `.env.example`/README, and pins
the client bundle to one project.

### 7. The legacy UI is live and broken
`/app` + `/g/[groupId]` + `components/game-client.tsx` + all of
`app/api/**` implement the pre-handoff flow: v1 `create_group`
(14/30/60-day seasons), a 3-player minimum, and no home-state step. But the
current `start_season` (migration `…082000`) requires every human to have a
home state — which the legacy lobby has no UI to set — so the legacy "Start
season" button can never succeed. Either delete the legacy surface (pages,
components, API routes, `lib/game-rules.ts`, `lib/types.ts` as appropriate)
or gate it out; today it's reachable, drifting, and misleading.

### 8. Stuck question state in the new UI, and question-report is gone
- If an active session expires server-side, `get_my_active_session` returns
  null but `loadSnapshot` only ever **sets** `operation`
  (`if (operationResponse.data) setOperation(...)`) — it never clears it, and
  `QuestionArena` has no abandon/close path. A user whose session dies gets a
  dead question screen with no exit until they answer into an RPC error.
- The README-advertised one-tap question quarantine (`report_question`) has
  no button in the v2 UI — the feature only exists in the legacy client.

### 9. Two disagreeing adjacency sources
The DB's `territories.adjacent` (e.g. AK ↔ WA/OR/CA/HI) and
`data/adjacency.json` (AK ↔ WA/HI only, per its own audit note) disagree.
The v2 client mostly prefers the server's arrays but the rival "front"
computation always uses the local `ADJ`, so the UI and the server disagree
about legality around AK/HI. Similarly, `lib/game-rules.ts` re-implements
engine rules in TypeScript but is imported **only by the tests** — the test
suite exercises a copy, not the engine. Pick one source of truth.

### 10. Season question pool exhausts quickly
`season_question_seen` is keyed on `(season_id, question_id)`, so a question
seen by *any* player is dead for the whole season, and the starter bank has
only 11 questions per state (a single tier-2 attack burns up to 3).
Long-lived leagues will hit "temporarily out of unused questions" on
frequently contested states. Consider per-player seen-tracking plus reuse
after N days, or a larger bank, before real seasons run.

### 11. Docs/behavior drift
README still says: 3-player minimum (now 2 humans), season lengths 14/30/60
(v2 allows 7/10/14/30/60), "correct answers are not sent to the browser"
(v2 returns `correct_answer` in every answer response — defensible
post-answer, but the claim is stale), and describes the card-grid flow that
no longer exists on `/`.

## Low / nits

- `profiles` is readable by **all** authenticated users, leaking display
  names across groups; and the bot migration dropped the FK to `auth.users`,
  so deleting an auth user now orphans a profile (no cascade).
- No guard against multiple concurrent active `game_sessions` per user;
  `get_my_active_session` resumes only the latest.
- `tsconfig.json` maps `@/data/us-states.json` → `./data/us-states.ts` so a
  `.json` import resolves to a TS module — it works (Next honors tsconfig
  paths) but is a trap for anyone reading the import.
- `create_group_v2` doesn't validate sport strings (arbitrary text is
  accepted into `groups.sports`).
- Cron route: token comparison isn't constant-time (low risk).
- `run_daily_tick` scores only `current_date`; a missed cron day is skipped,
  not back-filled (`last_scored_on` jumps).
- CI has no SQL-level tests; the only tests are 5 unit tests on the
  duplicated rules module (see finding 9).

## Suggested priority order

1. Fix the resumed-question answer leak (#1) — one-line-ish SQL fix, biggest
   gameplay integrity hole.
2. Fix `test-signup` table bug + unconfirmed-account recovery (#2, #3).
3. Close the home-question re-roll loophole (#4).
4. Commit `package-lock.json`, switch CI to `npm ci`, fix or remove the lint
   script and add lint to CI (#5, #8-lint).
5. Decide the fate of the legacy UI/API surface (#7) and unify auth (#6).
6. Re-add question reporting and an escape hatch to the v2 question screen
   (#8), reconcile adjacency sources (#9), refresh the README (#11).
