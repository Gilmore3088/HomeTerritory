# Territory — Phase 1: Stabilize (Design)

Date: 2026-08-03
Status: Approved pending user review

## Background

Territory is an asynchronous, private-group sports trivia game where correct
answers claim and steal U.S. states. The MVP is code-complete: Supabase auth,
groups, a server-authoritative PostgreSQL game engine, realtime map updates,
550 seed questions, a PWA shell, and a Vercel cron scoring route. Database
migrations are already applied to the production Supabase project
(`gduvdnpxgdniogmxxlmg`). There is no public deployment yet.

The owner's goal is a polished playtest for a friend group, then a live
deployment, evolving the game into a deeper competitive strategy + trivia
experience. Play style stays asynchronous seasons as designed.

## Roadmap (five phases, each with its own spec)

1. **Stabilize** (this document) — correctness audit, bug fixes, code health,
   test coverage.
2. **Mobile UX and visual polish** — map feel, touch targets, loading states,
   design pass.
3. **Trivia engine** — AI-generated (Claude API), difficulty-tiered question
   bank with validation and in-game reporting.
4. **Strategy depth and competitive meta** — region bonuses, comeback
   mechanics, attack alerts, streaks, season awards, balance tuning.
5. **Go live** — Vercel deployment, auth URL configuration, cron, PWA
   installability. A preview deployment to friends happens after Phase 2 so
   Phases 3–4 are informed by real play.

## Phase 1 goal and scope

Phase 1 ends with a game the owner can confidently hand to friends knowing the
mechanics work, built on code that is safe to change:

- The full season loop (create group → join ×3 → start season → claim →
  attack → defend → score → daily tick) runs without errors.
- Known warnings and rendering issues are fixed.
- Game logic has real test coverage.
- The 859-line `components/territory-game-v2.tsx` monolith is split into
  focused files.

Out of scope: visual redesign, new mechanics, trivia content, notifications,
deployment. Bugs are fixed; feel issues are recorded in a backlog for later
phases.

## Known issues at time of writing

- Three components (`territory-game-v2.tsx`, `game-runtime-controls.tsx`,
  `logout-control.tsx`) each create their own module-level Supabase client
  instead of sharing `lib/supabase/client.ts`, producing the "Multiple
  GoTrueClient instances" warning and a risk of divergent auth state.
- The Next.js dev overlay reports one issue on the landing page.
- `components/territory-game-v2.tsx` is an 859-line component containing
  auth, league entry, map, question flow, results, and toasts.
- Test coverage is a single file (`tests/game-rules.test.ts`, 5 tests).

## Audit method

Two passes, in order:

**Systematic playthrough.** Drive a full season locally with three accounts
(migrations support test-bot players): create a group, join via invite code,
start the season, then exercise every mechanic — neutral claims,
adjacency-legal and -illegal attacks, defense windows, timer expiry, action
exhaustion, cooldowns, the underdog discount, question quarantine, and the
cron tick endpoint. Every deviation is logged to
`docs/superpowers/audit-findings.md` with repro steps and severity
(blocker / bug / papercut).

**Code-level review.** Focused review of the server-authoritative surface:
SQL functions in `supabase/migrations/`, the six API routes under
`app/api/` (game answer/begin/report/snapshot, groups, cron tick), and RLS
policies. Target bug classes playtesting can miss: race
conditions on simultaneous attacks, timezone/UTC edge cases in the daily
tick, state reachable only through refresh-mid-question, and auth edge cases
from the triple-client bug.

Findings are fixed in severity order; each fix carries a regression test
where the logic allows it.

## Code health refactor

Three targeted moves, no rewrite. Runs after blocker fixes, before papercut
fixes.

1. **One browser Supabase client.** Delete the three module-level
   `createClient` calls; all components import the shared client from
   `lib/supabase/client.ts`. Single source of truth for auth state.
2. **Split `territory-game-v2.tsx` along existing seams.** A thin
   coordinator plus focused components: `auth-stage.tsx`,
   `league-entry.tsx`, `game-map.tsx`, `question-panel.tsx`, and a
   `use-game-state.ts` hook owning snapshot/realtime/operation state. Every
   file lands under 300 lines. Behavior and CSS modules unchanged, verified
   by replaying the loop after the split.
3. **Consolidate duplicated logic.** Session-watching and error-message
   helpers repeated across components collapse into shared utilities in
   `lib/`.

## Testing strategy

Priority order:

1. **Pure-logic unit tests** — expand `tests/game-rules.test.ts` to cover
   adjacency, scoring math, underdog discounts, hold levels, and
   timer/cooldown calculations plus audit-surfaced edge cases. Runs via the
   existing `npm test` (node test runner).
2. **Database function tests** — the PostgreSQL RPC functions are the real
   engine. A harness runs them against the Supabase CLI local stack,
   covering claim, attack resolution, timeout resolution, defense, daily
   tick, and contested cases such as two players attacking the same state.
3. **End-to-end smoke test** — one scripted three-player mini-season against
   the local stack, run before anything ships.

Regression rule: every bug fixed during the audit gets a test that would
have caught it, at the layer where the bug lived.

## Workflow

- Branch off `main` (e.g. `fix/stabilize-mvp`), conventional commits, one
  concern per commit.
- `docs/superpowers/audit-findings.md` is the running checklist.
- Deferred observations (UX papercuts, feature ideas, balance notes) go to
  `docs/superpowers/backlog.md` tagged with their future phase.
- Limitation: Supabase Realtime multi-device behavior against the production
  project cannot be fully verified locally. Realtime is tested against the
  local stack; anything doubtful is flagged for a two-phone check by the
  owner.

## Done criteria

- Three-account season loop runs clean end-to-end (scripted smoke test
  passes).
- Zero known blockers or bugs in the findings doc; papercuts triaged to the
  backlog.
- No console warnings in normal play (GoTrueClient warning and landing-page
  overlay issue fixed).
- `territory-game-v2.tsx` no longer exists as a monolith; all files under
  ~300 lines.
- Test suite covers game rules and critical DB functions; `npm test`,
  `npm run typecheck`, and `npm run build` all pass.
