# Territory — Phase 2a: Foundation (data layer + turn process) Design

Date: 2026-08-04
Status: Approved (user pre-authorized autonomous execution)

## Background

Phase 1 stabilized the Territory MVP (merged to `main`). Phase 2 is the mobile
UX and visual redesign, and it decomposed into four sub-projects. This spec is
the first, **P2a Foundation** — the behavioral and structural groundwork the
visual redesign sits on. No visual restyle happens here; that is P2b.

The chosen visual direction for the whole of Phase 2 is **Broadcast** (light,
editorial, poster-bold, saturated team colors, the real US map as hero). It is
locked and applied in P2b. Reference mockup:
`.superpowers/brainstorm/*/content/three-real.html` (option 3).

## Phase 2 roadmap (each its own spec → plan → build)

- **P2a — Foundation (this document):** merge the dual-polling data layer into
  one source of truth; polish the async turn loop; add a commissioner
  "advance the day" control.
- **P2b — Design system + screen restyle (Broadcast):** design tokens (color,
  type, spacing, components) applied across every screen; UX papercut fixes
  (visual timer + distinct timeout copy, blocked-button reasons, custom
  dialogs replacing native `prompt`/`alert`); touch targets; onboarding and
  empty states.
- **P2c — Motion, juice & animated map:** claim/attack/defense/result moments,
  button feedback, living map (zoom/pan, tap ripples, fill animations, pulsing
  target).
- **P2d — PWA install:** wire the service worker + manifest so the group can
  install to their home screens.

Order: P2a → P2b → P2c, P2d slottable anytime. P2b restyles the functional
surfaces P2a builds.

## Play model (decided)

Real play with friends is **async daily moves**: everyone plays whenever they
want, each with a daily action budget; defenses and cooldowns run in real time;
nobody is blocked waiting on another player. "Your turn" means "you have moves
today." The existing **test-mode strict turn rotation** (one player at a time,
via `end_test_turn` / `enforce_test_turn_session`) stays as a solo-playtesting
aid only, clearly separated from real play — P2a does not remove it.

## Goal

One source of truth for game data, a coherent async turn loop, and a
commissioner-only "advance the day" control — the foundation the Broadcast
redesign will style. Functionally complete; visually minimal (Phase 1's
existing styles carry through until P2b).

## Codebase facts (verified 2026-08-04, `main`)

- `app/page.tsx` renders two siblings: `TerritoryGame` (owns data via the
  `useGameState(session)` hook) and `GameRuntimeControls` (owns its OWN
  data — a second `get_my_groups` + `group_snapshot` + `get_my_active_session`
  loop on a 5s interval + focus/visibilitychange, reading the same
  `territory_group` localStorage key). `useGameState` polls every 20s plus a
  realtime subscription. Result: duplicate RPC traffic and two components that
  can disagree about the selected league.
- `hooks/use-game-state.ts` is the single data owner for `TerritoryGame`. It
  exposes `groups`, `groupId`, `snapshot`, `operation`, `loadGroups`,
  `loadSnapshot`, `beginAction`, etc. Its `loadSnapshot` sets `operation` from
  `get_my_active_session` but **never clears it**:
  `if (operationResponse.data) setOperation(...)` has no `else` — a session
  resolved in another tab leaves a stale question card until a full reload
  (backlog P2 item).
- `components/game-runtime-controls.tsx` provides: logout, question report
  (native `window.prompt`/`alert`/`reload` — restyled in P2b, but its data
  wiring changes here), and the test-mode turn banner. It gates the turn
  banner on `snapshot.group.test_mode`.
- `lib/game-selection.ts` exports `pickActiveGroup(rows, saved, preferred)` —
  the membership-validated league picker from Phase 1's F22 fix. The unified
  data source uses it as the single selection authority.
- `run_daily_tick()` (latest def in `supabase/migrations/`) loops **all**
  active seasons inline (`for v_season in select * from public.seasons where
  status = 'active' for update skip locked`), calling
  `resolve_expired_sessions`, `resolve_expired_attacks`, and — when
  `last_scored_on < current_date` — an inline per-member scoring block. It is
  `security definer`, revoked from `public/anon/authenticated`, service-role
  only. There is **no per-group / per-season tick function**.
- Commissioner identity is `groups.commissioner_id`, surfaced as
  `snapshot.group.commissioner_id`. `group_local_date()` and
  `seasons.last_scored_on` exist (Phase 1 finding 11).

## Architecture — Approach 1: one shared data source

`useGameState` becomes the single owner of all game data, exposed through a
React context provided at `app/page.tsx`. Both the main game view and the
runtime controls consume that context; neither the turn banner nor the report
control fetches its own data.

- Create `hooks/game-data-context.tsx`: a `GameDataProvider` that calls
  `useSupabaseSession()` + `useGameState(session)` once and supplies the result
  via context, plus a `useGameData()` consumer hook.
- `app/page.tsx` wraps both children in `GameDataProvider`. `TerritoryGame`
  reads `useGameData()` instead of calling the hooks itself.
  `GameRuntimeControls` is refactored to read `useGameData()` — its local
  `load`, its 5s interval, its own session effect, and its own `get_my_groups`
  call are all deleted. The turn/logout/report actions call RPCs through the
  shared client and then call the context's `loadSnapshot` to refresh.
- One poll loop (the existing 20s + realtime), one selected-league value (via
  `pickActiveGroup`), one snapshot. The 5s duplicate poll is gone.

This is the smallest change to the Phase-1 structure, keeps the controls
presentational, and removes the league-disagreement class of bug for free.

## Async turn loop

The async "turn" is the daily-moves loop. P2a makes it coherent and functional
(polish/restyle is P2b):

- **Action budget** is already surfaced (HUD "Actions", mission dock). Keep.
- **Stale-operation fix:** in the unified `loadSnapshot`, reconcile `operation`
  with the server: when `get_my_active_session` returns no active session,
  clear the local operation (`setOperation(null)`) — UNLESS an operation was
  begun locally within a short guard window that the server may not yet
  reflect. Concretely: track the last `beginAction` timestamp; only clear on a
  poll when the server reports no session AND no begin happened since the last
  successful load. This fixes the stale card without nuking a just-started
  question.
- **"What changed while you were away":** the snapshot already returns
  `activity`. P2a exposes a lightweight "since last visit" marker — persist the
  last-seen activity timestamp (localStorage) and expose an unseen-count from
  the context so P2b can render a recap affordance. P2a ships the data, not the
  visual.
- **"Out of moves" state** already exists functionally (mission dock at zero
  actions). Keep; P2b restyles.

## Commissioner "advance the day"

A commissioner-only control that **settles the current day now** for **one
group's** season on demand, without exposing the global service-role
`run_daily_tick`.

Scope decision (made here to remove ambiguity): "Advance the day" means
**settle and score the current group-local day immediately** — resolve expired
sessions and attacks, and run the day's per-member scoring if it has not run
yet — rather than fast-forwarding across future calendar days. The game's day
is tied to the wall calendar (`current_date` / `group_local_date`), so real
day-to-day progress still tracks the calendar (one day per day); the
commissioner control lets the group settle scoring on demand instead of waiting
for the fixed UTC cron. A season-level game-day counter that would let the
commissioner fast-forward multiple days independent of the calendar is a
larger day-model change; it is explicitly deferred (backlog `P2-day-counter`)
and NOT built in P2a.

- **Refactor for DRY:** extract the per-season body of `run_daily_tick` into a
  new `public.advance_season(p_season_id uuid)` that does exactly what the
  current inline loop body does for one season — resolve expired sessions +
  attacks, and, when `last_scored_on < ` the group-local day, run the
  per-member scoring block and set `last_scored_on`. `run_daily_tick()` becomes
  a thin loop calling `advance_season` for each active season — identical
  global behavior, now reusable. `advance_season` is `security definer`,
  revoked from `public/anon/authenticated`, granted to `service_role` only
  (Phase 1 grant hygiene).
- **Commissioner wrapper:** new `public.advance_group_day(p_group_id uuid)` —
  `security definer`, verifies `auth.uid() = groups.commissioner_id` for the
  group (raise otherwise), resolves the group's active season, and calls
  `advance_season(season_id)`. Granted to `authenticated` (it self-checks the
  caller is the commissioner) and added to the Phase-1
  `security_definer_grants` allowlist test as client-callable.
- **Idempotency:** `advance_group_day` always runs resolution; scoring is
  guarded by the existing `last_scored_on` group-local-day check, so tapping it
  twice in one local day resolves attacks both times but scores at most once.
  This is the deliberate, safe behavior — settle early, never double-score.
- **UI:** a commissioner-only "Advance the day" control (functional button in
  P2a; styled in P2b), visible only when
  `snapshot.group.commissioner_id === snapshot.current_user_id`. On success it
  calls the context `loadSnapshot`. Non-commissioners never see it.

## Testing

- **DB (local stack):** `advance_season` scores once per group-local day and
  rolls the boundary; `run_daily_tick` still scores all active seasons via it
  (regression). `advance_group_day` succeeds for the commissioner, is rejected
  for a non-commissioner member and for a non-member, and is not
  anon/authenticated-executable outside the client-callable allowlist (extend
  the Phase-1 grants audit). Double-advance in one local day does not
  double-score.
- **Data merge:** a test (or a documented manual check) that only one
  `group_snapshot` fetch loop runs for the page and both surfaces read the same
  league. Regression for the stale-operation clear: a resolved session clears
  the operation on the next poll; a just-begun operation is NOT cleared by an
  interleaved poll.
- **Unit:** any pure logic extracted (e.g., unseen-activity count, the
  begin-guard reconciliation) gets node-test coverage.
- Full suite (`npm test`, `npm run test:db`, `npm run test:smoke`,
  `npm run typecheck`, `npm run build`, `npm run lint`) stays green.

## Out of scope (later sub-projects)

Broadcast design tokens and restyle, motion/juice, animated map, PWA wiring,
onboarding/empty-state visuals (P2b–P2d). The commissioner control, turn loop,
and report control are left functional-but-unstyled here; P2b styles them.

## Migration & deploy note

New SQL lands as forward-only migrations (never edit applied ones). Like the 12
Phase-1 migrations, these are not auto-applied to production until the
`SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD` GitHub Actions secrets are
configured and the deploy workflow runs — an owner action, tracked in the
backlog.

## Done criteria

- One data source: `GameDataProvider` supplies session/groups/snapshot/
  operation/turn state; `GameRuntimeControls` no longer fetches its own data;
  the 5s duplicate poll is gone; both surfaces agree on the selected league.
- Stale-operation bug fixed with the begin-guard reconciliation.
- `advance_season` extracted; `run_daily_tick` refactored to use it with
  unchanged global behavior; `advance_group_day` commissioner-gated and
  covered by grants + authorization tests.
- Commissioner-only "Advance the day" control works end to end against the
  local stack (verified in the browser); non-commissioners cannot see or call
  it.
- Full test suite green; new DB behavior covered.
