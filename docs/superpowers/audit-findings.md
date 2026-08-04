# Phase 1 audit findings

Severity: blocker (game unplayable / data corrupting), bug (wrong behavior,
playable around), papercut (annoyance; fix only if trivial, else backlog).

| # | Severity | Area | Finding | Repro | Status |
|---|----------|------|---------|-------|--------|
| 1 | blocker | `get_my_active_session` / `territory-game-v2.tsx` | The resume path returned `questions.options` verbatim instead of shuffling it the way `pick_next_question` does, and every seeded multiple-choice row stores the correct answer at index 0. Not only a manual-refresh problem: `territory-game-v2.tsx`'s `loadSnapshot` calls `get_my_active_session` and feeds the result to `setOperation` (`:209`) on mount, on every realtime event and on a 20s interval, and `QuestionArena` renders `question.options` straight into the answer buttons (`:830`) — so the live question re-ordered itself with the answer first, unprompted. (`GameRuntimeControls` also polls the RPC every 5s but reads only `question.attempt_id`, so it never rendered the leak.) Directly contradicted the README's "correct answers are not sent to the browser". **Fixed** by `public.shuffle_options(options, attempt_id)`, one helper now used by both `pick_next_question` and `get_my_active_session`: the order is unpredictable *and* stable for the life of the attempt, so a poll can no longer re-order a question mid-answer. | `tests/db/audit.test.ts` "resuming a question serves a stable option order that does not leak the answer". Before the fix: begin any claim, call `get_my_active_session`, compare `question.options[0]` to `questions.correct_answer`; it matched on 10/10 calls. | fixed |
| 2 | blocker | `app/api/cron/tick/route.ts` | Auth can be bypassed with a forged header. The handler accepts a request when `x-vercel-cron-schedule === "5 8 * * *"` *or* the bearer secret matches, and that header is fully caller-controlled. Any unauthenticated internet caller can execute `run_daily_tick()` under the service-role key — advancing `current_day`, applying twilight decay, resolving attacks, running bot turns and ending seasons. Contradicts the README's "the daily tick requires the server secret key and a separate cron secret". | Dev server on :3100 against the local stack: `curl -s -H 'x-vercel-cron-schedule: 5 8 * * *' http://127.0.0.1:3100/api/cron/tick` → `200 {"ok":true,...}`. No header at all → `401`. Wrong schedule value → `401`. | fixed |
| 3 | bug | `game_submit_answer` (20260730082200) | Nothing re-checks the attack between `game_begin_action` admitting a defender and the answer landing. If the 24h deadline lapses mid-question, another player's snapshot runs `resolve_expired_attacks` and transfers the state; the defender's correct answer then returns `status: 'completed'` with "You defended X" **and** its unconditional `update season_territories set hold_level = least(3, hold_level + 1)` fortifies the *attacker's* newly taken state. The `update attacks ... where status = 'contested'` guard matches zero rows and is silently ignored. | `tests/db/audit.test.ts` "a defense answered after the deadline cannot strengthen the new owner". Observed before the fix: after timeout owner=attacker/hold=1; after the late correct answer owner=attacker/hold=**2**, attack row still `won`, response `completed`. **Fixed:** the defense now re-reads the attack under a row lock before it moves the map and returns `status: 'void'` if it is no longer contested. | fixed |
| 4 | bug | `game_begin_action` (20260802173000) vs `territory-game-v2.tsx` | The stabilize migration added `fortify` to the action-charging branch, so fortifying now costs one of the three daily actions and is refused at zero with "No moves remaining". The UI still shows "Your own states can still be fortified for free" on the actions-spent card, and `TerritorySheet` only disables the button for `claim`/`attack`, so the fortify button stays enabled and throws. **Resolved in the UI's favour of the engine:** charging for fortify is the deliberate behavior of the stabilize migration, so the copy and the disable rule were corrected instead. The rule now lives in `isTerritoryActionBlocked` (`lib/game-rules.ts`), which also keeps the border requirement off fortify — your own state is not necessarily adjacent to another of your states. | `tests/db/audit.test.ts` "fortify spends one move and is refused once moves run out" plus `tests/game-rules.test.ts` "fortify is blocked at zero moves, like claim and attack". Measured: actions 3 → 2 after one fortify; at 0 actions `game_begin_action('fortify')` → "No moves remaining". | fixed |
| 5 | bug | `game_begin_action` / `game_submit_answer` | Two players can each open an attack session on the same state, because the contested check runs only at begin time and no row is reserved. The first streak to finish inserts the `attacks` row; the second violates `one_contested_attack_per_territory`, and the raw Postgres error reaches the player. Their winning answer is rolled back while the action spent at begin stays spent. **Fixed:** the winning answer re-reads the territory `for update` before inserting the attack; a player who loses the race gets `status: 'void'` and their move back. | `tests/db/audit.test.ts` "a second attacker on the same state fails cleanly instead of raising a constraint error". Observed before the fix: `duplicate key value violates unique constraint "one_contested_attack_per_territory"`. | fixed |
| 6 | bug | `run_test_bot_turns` (20260802173100) | `SECURITY DEFINER` with no caller check at all — it validates only that the season is active and the group is `test_mode`. Its `revoke all on function ... from public` does not remove the `anon`/`authenticated` grants Supabase's default privileges hand to every new function, so the function is reachable **unauthenticated**. **Fixed:** the function is an internal helper -- `run_daily_tick` drives it and no client calls it -- so EXECUTE is revoked from `public, anon, authenticated` and granted only to `service_role`. An `auth.uid()` caller check was deliberately *not* added: the tick runs with no authenticated user and would have broken. | `tests/db/audit.test.ts` "run_test_bot_turns is not reachable by any client role". Before the fix: `has_function_privilege('anon', ...)` → `t`; anon client `rpc('run_test_bot_turns')` → `{"actions":0}` with no error; a plain (non-commissioner) member call also succeeded. | fixed |
| 7 | bug | `end_test_turn` (20260730220000) | Same ineffective revoke pattern (`revoke all ... from public` only). `anon` retains EXECUTE and reaches the function body; it is saved from abuse only by the internal `if v_user is null then raise 'Authentication required'`. The grant, not the guard, is the thing that is wrong — the same mistake produced finding 6, which has no guard. | `has_function_privilege('anon', 'public.end_test_turn(uuid)', 'EXECUTE')` → `t`; anon `rpc('end_test_turn')` returns "Authentication required" rather than a permission error. Compare `run_daily_tick`, which used `revoke ... from public, anon, authenticated` and correctly returns "permission denied for function run_daily_tick". **Fixed at the pattern, not just the two functions:** `end_test_turn`, `run_test_bot_turns`, `enforce_test_turn_session` and `sync_question_attempt_stats` all had the ineffective revoke; all four are now revoked from `anon` (and from `authenticated` where no client needs them). `public.security_definer_grants()` was added so `tests/db/audit.test.ts` "no security-definer function in public is executable by anon" enumerates every security-definer function on every run and fails the moment a future migration re-arms the trap. | fixed |
| 8 | bug | `game_begin_action` 'fortify' branch | The `fortify_log` row is written at *begin* time, so a fortify lost to a wrong answer still consumes the day's one fortify for that state — and the action too. The player is told "You already fortified this state today" when they in fact failed it. | Begin a fortify, answer wrong (`status: failed`), begin the same fortify again → "You already fortified this state today". | open |
| 9 | bug | `report_question` (initial schema) | A single report sets `questions.active = false` **globally**, with no threshold, no reviewer, and no per-season scoping. The bank holds only 11 questions per state, shared by every league, so a handful of reports permanently strips a state's trivia from the whole product. `question_reports` has no uniqueness constraint, so one account can report repeatedly. | `tests/db/audit.test.ts` "report_question quarantines the question, voids the session, and refunds the action" asserts `questions.active === false` after one report (the probe restores it). Deactivating all of a state's questions makes `game_begin_action` fail with "This state has no active questions" (cleanly — the action is refunded by the rollback). | open |
| 10 | bug | `refresh_player_actions` (20260802173000) | The function opens with `perform public.run_daily_tick()`, and `run_daily_tick` loops **every active season in the database**. `refresh_player_actions` is called by `group_snapshot` and by `game_begin_action`, so every page load and every move runs a full cross-tenant scoring pass. The UI amplifies it: `GameRuntimeControls` polls `group_snapshot` every 5s and `TerritoryGameV2` every 20s, per open tab. It also creates a cross-group deadlock surface (each caller updates other groups' `player_actions` rows while holding locks on its own). | Timed on the local stack with 50 active seasons: `run_daily_tick()` = 7.2ms idle, 13.5ms when scoring is due (108 players). Cost is O(all active seasons) per snapshot, so it grows with total product usage rather than with the caller's own league. | open |
| 11 | bug | `seasons.last_scored_on`, `player_actions.last_refresh_on`, `fortify_log.played_on` | Mixed day boundaries. All three columns DEFAULT to `current_date`, which is the database's **UTC** date, while `run_daily_tick` and `refresh_player_actions` compare against `(now() at time zone groups.timezone)::date`. A season started while the UTC date is already ahead of the group's local date (17:00–24:00 PT for the default `America/Los_Angeles`) stamps a `last_scored_on` one day in its own future and silently skips a scoring day. `test_refill_actions` and `end_test_turn` also clear `fortify_log` by UTC `current_date`, so the once-per-day fortify rolls over at UTC midnight while actions roll over at group-local midnight. DST itself is handled correctly — the zone is named, not an offset — the defect is the unit mismatch. | `tests/db/audit.test.ts` "a season's last_scored_on is stamped in the group's local day, not UTC" (skipped; clock-dependent by nature — the two dates only differ for part of each day). Column defaults confirmed via `information_schema.columns`: all three are `CURRENT_DATE`. | open |
| 12 | papercut | `groups.timezone` | The column exists, defaults to `'America/Los_Angeles'`, and drives every day boundary in `run_daily_tick` / `refresh_player_actions` / `run_test_bot_turns` — but nothing ever sets it. `create_group_v2` takes no timezone parameter and no UI or RPC writes it, so every league in the product scores on Pacific time regardless of where its players live. | `grep -rn timezone app components lib supabase/migrations` returns only the column definition and the read sites. | open |
| 13 | bug | `app/api/**` | Seven of the eight API routes are dead code. The UI calls Supabase RPCs directly (`components/territory-game-v2.tsx`, `components/game-runtime-controls.tsx`); `grep -rn "/api/" app components lib` outside `app/api/` returns nothing. Only `/api/cron/tick` is wired, via `vercel.json`. They have also drifted: `app/api/groups/route.ts` calls the superseded `create_group` v1 (no `test_mode`, no `opening_mode`, and a 14/30/60 season-length whitelist the v2 RPC no longer uses), so anything that did call it would create a league the current UI cannot start. Auth itself is correct in all seven — each uses `lib/supabase/server.ts` and `getUser()` before the RPC. | `grep -rn "/api/" app components lib \| grep -v '^app/api/'` → no matches. `app/api/groups/route.ts:20` calls `create_group`; the UI calls `create_group_v2` at `components/territory-game-v2.tsx:449`. | open |
| 14 | bug | `supabase/functions/test-signup/index.ts` | Account-takeover path. When the submitted email matches an **existing unconfirmed** account, the function calls `admin.auth.admin.updateUserById` to set the caller's password and `email_confirm: true` — so anyone holding a valid playtest invite code can seize any unconfirmed account by knowing its address. The invite-code gate itself is correct (the group is looked up and `test_mode` verified *before* any account is created), the service key is never returned, and errors do not leak it. Also worth tightening: `Access-Control-Allow-Origin: *` on an endpoint that creates confirmed accounts. | Code review of `index.ts:54-65`. | open |
| 15 | papercut | `supabase/functions/test-signup/index.ts` | The existing-account lookup is `listUsers({ page: 1, perPage: 1000 })` and scans only that first page. Past 1000 users a returning player is treated as new and `createUser` fails with a duplicate-email error instead of the intended recovery path. Use `getUserByEmail`/a filtered query instead of paging the whole user table. | Code review of `index.ts:48-51`. | open |
| 16 | bug | tooling (`npm run lint`) | `eslint .` crashes repo-wide on the first file, so the lint gate provides zero coverage: `TypeError: Error while loading rule 'react/display-name': contextOrFilename.getFilename is not a function` (`eslint-plugin-react/lib/util/version.js:31`). ESLint 10.8.0 + `eslint-config-next` 16.2.9. Pre-existing, not introduced by this phase — but Task 11 runs lint as a closeout gate, so it must be resolved (pin/upgrade the plugin, or drop `react/display-name`) rather than deferred. | `npm run lint` → crash on `app/api/cron/tick/route.ts`; reproduces on any single file, including untouched ones. | open |
| 17 | papercut | landing page dev overlay | The "1 Issue" badge on `http://localhost:3000` signed out is a React hydration mismatch whose cause is **external**: a browser extension injects `data-scribe-recorder-ready` onto `<html>` before React hydrates, so the server HTML and the client tree disagree on an attribute the app never writes. Not a code defect and not reproducible in a clean profile or in production for users without that extension. **Recommendation: no fix.** `suppressHydrationWarning` on `<html>` in `app/layout.tsx` would silence it, but it suppresses *all* attribute mismatches on that element for every visitor and would mask genuine hydration regressions in an app that already renders a lot of client state — a bad trade for a warning only this machine sees. Re-check in a clean profile before spending anything on it. | Open `http://localhost:3000` signed out with the extension enabled; overlay reports the `data-scribe-recorder-ready` attribute mismatch on `<html>`. | no fix (recommended) |
| 18 | papercut | `README.md` | Five stale claims that would mislead the next contributor. (a) "Three-player minimum" — `start_season` requires two humans. (b) "No coast-to-coast or sport-diversity bonus yet" — `run_daily_tick` awards both (3 and 2 points). (c) "Daily scoring is UTC rather than group-local time" — scoring now uses `groups.timezone`; only the column defaults are still UTC (finding 11). (d) "Server-side answer checking; correct answers are not sent to the browser" — false, see finding 1; `game_submit_answer` also returns `correct_answer` on every response, including mid-streak. (e) "Installable PWA shell" — `components/pwa-register.tsx` is imported nowhere and `app/layout.tsx` emits no `<link rel="manifest">`, so `public/sw.js` and `public/manifest.webmanifest` are never used. | Compare `README.md` "What works" / "Current intentional MVP limits" against `supabase/migrations/20260730220000_add_playtest_turn_handoff.sql:205`, `20260802173100_complete_stabilization_functions.sql:222-240`, and `grep -rn PwaRegister app components`. | open |
| 19 | papercut | `game_begin_action` + test-mode turns | An off-turn player in a test league is rejected with **"No moves remaining"**, not "It is not your turn". `refresh_player_actions` zeroes the off-turn player's actions and `game_begin_action` checks the balance before the `enforce_test_turn_session` trigger ever fires, so the turn-specific message is unreachable for claim/attack/fortify. | `tests/db/audit.test.ts` "test-mode turn rotation blocks off-turn moves, rotates on end_test_turn, and allows off-turn defense" — the probe accepts either message and records the observed one. | open |
| 21 | bug | `pick_next_question` (20260802173000) vs `territory-game-v2.tsx` | The adaptive selector sorts by a question's *observed* difficulty — once a row has 5+ attempts it is treated as tier 1 above a 75% correct rate and tier 3 below 45% — but two downstream consumers still read the row's *stored* `tier`. The answer timer is `case when v_question.tier = 3 then 45s else 30s end`, so an empirically hard question stored as tier 1 gets 30 seconds while an easy one stored as tier 3 gets 45; and the UI header prints "TIER {question.tier}", so a two-answer attack can be labelled "TIER 3" or "TIER 1". Selection and presentation disagree about what tier means. | Discovered as intermittent failure of `tests/db/audit.test.ts` probe 3 (~40% of suite runs, never in isolation): a tier-2 attack served a stored-tier-3 question once the bank accumulated history. Confirmed: `select tier, count(*) filter (where attempt_count >= 5 and correct_count::numeric/attempt_count >= .75) from questions where territory_id='OR' group by tier` → 2 of the 4 tier-3 rows had flipped to adaptive tier 1. The probe now asserts `required_correct` (the real cost) and no longer asserts the served row's tier. | open |
| 20 | papercut | `pick_next_question` (20260802173000) | When a territory's pool is exhausted for the player, the fallback branch (`order by attempt_count asc, random()`) ignores both the 7-day exclusion and the session tier, so it can re-serve the question the player just answered — including inside the same attack streak, making the remaining answers free. Harmless with the full 11-question bank; reachable once finding 9's quarantines bite. | Deactivate every question for a territory except the one already served, then answer correctly mid-streak: the same question comes back and the streak completes. | open |

## Code review conclusions per file

### Migrations, chronologically

**`202607300001_initial_schema.sql`** — Schema, RLS and the first cut of the
engine. RLS is enabled on all 17 tables and the read policies are correctly
scoped through `is_group_member`; `questions`, `game_sessions`,
`question_attempts`, `season_question_seen`, `cooldowns`, `fortify_log` and
`question_reports` are revoked from `anon`/`authenticated` entirely, so the
answer bank is genuinely unreadable by clients. Every player-facing RPC is
`security definer` with `set search_path = public` and re-derives the caller
from `auth.uid()` rather than trusting a parameter — the right shape. The
internal helpers (`refresh_player_actions`, `resolve_*`, `pick_next_question`,
`run_daily_tick`, `answer_matches`, `normalize_answer`, `handle_new_user`) use
the full `revoke ... from public, anon, authenticated` form and are confirmed
unreachable by clients. Locking is mostly right: `game_begin_action` takes
`for update` on the `season_territories` row, `game_submit_answer` on the
`game_sessions` and `question_attempts` rows, `resolve_attack_win` on the
`attacks` row, and both resolvers use `for update ... skip locked`. Two gaps:
the attack *insert* is not covered by the territory lock (finding 5), and
`report_question` mutates the shared `questions` table (finding 9). Everything
here except those two is sound.

**`202607300728_fix_create_group_invite_generator.sql`** — Swaps
`gen_random_bytes` for `gen_random_uuid` in the invite-code loop and adds
`pg_catalog` to the search path. Correct and self-contained; the uniqueness loop
still re-checks `groups.invite_code` before exiting. No findings.

**`20260730074000_support_test_bot_players.sql`** — Adds `profiles.is_bot` and
**drops `profiles_id_fkey`**, so `profiles.id` no longer references
`auth.users`. That is deliberate (bot profiles have no auth user) but it removes
the cascade that used to clean up a deleted user's profile, and every table that
references `profiles(id)` now points at rows with no auth backing. Worth knowing
before any account-deletion work; not a Phase 1 defect. The bot home-state
assignment here is superseded twice over.

**`20260730082000_handoff_setup_and_season.sql`** — Adds the group options
(`board_scope`, `opening_mode`, `difficulty`, `timezone`, `test_mode`), home
states, and `create_group_v2` / `set_home_state`. `set_home_state` correctly
verifies lobby status, membership, a real territory id and the `lower48` board
restriction, and converts the unique-index violation into a friendly message.
`start_season` moves to a two-human minimum. Note the `timezone` column is
introduced here and never written again (finding 12), and the region bonus in
`run_daily_tick` compares against `count(*) from territories`, which a
`lower48` board can never satisfy for the Pacific region — reachable only if the
UI ever exposes `board_scope`, which it does not (it hardcodes `'fifty'`), so
it goes to the backlog rather than the findings table.

**`20260730082100_handoff_active_operations.sql`** — `get_my_active_session`,
`test_refill_actions`, and the home-action-aware `game_begin_action`.
`test_refill_actions` correctly gates on both `test_mode` and commissioner.
`get_my_active_session` is the source of finding 1: it hand-builds the question
payload and passes `v_question.options` straight through, unlike
`pick_next_question` which shuffles.

**`20260730082200_handoff_answer_resolution.sql`** — The last definition of
`game_submit_answer`; the two stabilize migrations do **not** redefine it
despite the trailing comment in `...173000` claiming otherwise. Confirms the
'home' special case (always `completed`; correctness only decides hold level
1 vs 2) and is where finding 3's unguarded defense branch lives. It also returns
`correct_answer` on *every* response, including the mid-streak `active` one —
harmless for the question just answered, but it is the line that makes the
README's "correct answers are not sent to the browser" untrue even before
finding 1.

**`20260730082300_handoff_snapshot_and_grants.sql`** — Snapshot rebuild plus
grants. The grants here use the correct `revoke ... from public, anon` form.
No findings.

**`20260730220000_add_playtest_turn_handoff.sql`** — Turn state, the
`enforce_test_turn_session` BEFORE INSERT trigger (correctly exempting
`defend`), `end_test_turn`, and the turn-aware `start_season`. `end_test_turn`
verifies test mode, membership, turn ownership, no active session, and a
two-human minimum before rotating — thorough. Its `revoke all ... from public`
is the ineffective form (finding 7). The turn gate itself is enforced at the
`game_sessions` insert, which is the right layer, but the action-balance check
upstream masks its error message (finding 19).

**`20260802173000_stabilize_turn_scoring_questions_and_bots.sql`** — The
strongest migration in the set. It fixes a real double-spend: the action
decrement moved from the middle of each branch to a single guarded
`update ... where actions_remaining > 0` + `if not found then raise` after all
validation, so a rejected action no longer charges the player and the balance
cannot go negative. `season_question_seen`'s primary key becomes
`(season_id, question_id, served_to)` with a 7-day window, which fixes
per-season question starvation. `pick_next_question` gains difficulty-adaptive
tier selection and a fallback (finding 20). `refresh_player_actions` gains
group-local dates — and the `run_daily_tick()` fan-out of finding 10. Adding
`fortify` to the charging branch is the origin of finding 4.

**`20260802173100_complete_stabilization_functions.sql`** — `run_daily_tick`
rewrite, `run_test_bot_turns`, and the `sync_question_attempt_stats` trigger.
Scoring idempotency is correct: `insert into daily_score_events ... on conflict
do nothing` followed by `if found` means a repeat tick in the same day adds
nothing (verified — second call scored 0 and left `cumulative_score`
unchanged), and the `for update skip locked` on seasons means concurrent ticks
do not double-score. Season end is idempotent too (`season_recaps ... on
conflict (season_id) do nothing`). `run_test_bot_turns` is the weak point
(finding 6). `sync_question_attempt_stats` recomputes from the full attempt
history rather than incrementing, so it is safe under retries, but it runs a
`count(*)` over `question_attempts` for every answered attempt — fine now,
worth an index later.

### API routes

`app/api/cron/tick/route.ts` — finding 2. Beyond the bypass: it correctly uses
`createAdminClient()` (server-side secret key) rather than the user client, and
`run_daily_tick` itself is idempotent per group-local day, so repeated same-day
calls are harmless *once* the auth hole is closed. There is no `POST` handler,
so `POST` returns 405; Vercel Cron issues `GET`, so that is fine.

`app/api/game/{begin,answer,report,snapshot}/route.ts` and
`app/api/groups/{,join,[groupId]/start}/route.ts` — all seven enforce auth
correctly: each builds the client from `lib/supabase/server.ts` (cookie-bound,
RLS-respecting) and returns 401 from `getUser()` before touching an RPC. None
of them trusts a client-supplied user id. They are, however, entirely unused by
the UI and `app/api/groups/route.ts` has drifted to the superseded v1 RPC
(finding 13) — deletion candidates.

### Edge function

`supabase/functions/test-signup/index.ts` — The invite code **is** validated
before any account is created: the group is fetched by `invite_code` with
`.eq("test_mode", true)` and a miss returns 403 before `createUser` is reached.
The service key is read from `Deno.env`, never echoed, and error bodies carry
only Supabase's own messages. Input validation on display name, email, password
length and the 8-character code is present. The problems are the unconfirmed-
account takeover path (finding 14), the 1000-user page cap (finding 15), and
the wildcard CORS origin.

### UTC edges

`run_daily_tick` called twice in one day is a no-op (measured). Called across a
DST boundary it is correct, because the day boundary comes from a named zone
(`now() at time zone 'America/Los_Angeles'`), which shifts with DST rather than
drifting like a fixed offset would; the 23-hour and 25-hour days each produce
exactly one `daily_score_events` row per member. `refresh_player_actions` is
likewise DST-safe and its `greatest(0, ...)` guard means a backwards clock
never grants actions. The real defect is the UTC-vs-group-local mismatch in the
column defaults (finding 11), plus `vercel.json`'s single `5 8 * * *` UTC cron:
08:05 UTC is 00:05 PST / 01:05 PDT, so it lands after local midnight for the
hardcoded Pacific zone, but any group in a zone east of UTC-8 would be scored
before its own local midnight the moment finding 12 is fixed.

### Realtime

All four tables the client subscribes to — `season_territories`, `attacks`,
`activity_events`, `player_actions` — are members of the `supabase_realtime`
publication (verified via `pg_publication_tables`), and all four carry the
`season_id` column the channel filters use. Replica identity is `default` (the
primary key) on all four: `season_territories` and `player_actions` include
`season_id` in their PK so even DELETE events would match the filter, while
`attacks` and `activity_events` key on `id` alone — DELETE events there would
not match, but the engine never deletes from either table. No finding. Two
phones on the same league should see each other's moves; production realtime is
still worth the two-device check because RLS-filtered Postgres Changes behave
differently under a real project's connection limits than under a local stack.

## Coverage notes

- `tests/db/audit.test.ts` holds 23 probes: 17 pass and pin current behavior,
  6 are skipped with a comment naming the finding they block on (1, 3, 4, 5, 6,
  11). `npm run test:db` is green: 21 pass, 6 skipped, 0 fail across both files,
  verified over five consecutive runs after the finding-21 fix.
- Findings 2, 7, 12, 13, 14, 15, 16, 18 are verified outside the DB harness
  (curl against an isolated dev server, `has_function_privilege`, grep, `npm run
  lint`) and have no probe in `tests/db/`.
- Finding 17 was reproduced in the browser by the controller; the recommendation
  above is this task's.
