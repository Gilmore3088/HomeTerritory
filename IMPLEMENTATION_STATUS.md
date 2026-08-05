# Implementation status

## Phase 1 (Stabilize): complete

The application, database schema, RLS policies, authenticated RPC game engine,
realtime subscriptions, seed data, PWA shell, cron route, and CI workflow are
all in place and audited. The full season loop (create group, join, start
season, claim, attack, defend, score, daily tick) runs clean end-to-end on a
local Supabase stack; every audit finding is fixed or backlogged (none open);
`components/territory-game-v2.tsx` no longer exists as an 859-line monolith —
it is a coordinator plus focused components/hooks, every file under 300 lines.
See `docs/superpowers/audit-findings.md` ("Phase 1 closeout") for the full
criterion-by-criterion evidence.

A local Supabase stack (`supabase start` / `npm run stack:reset`, ports
shifted +1000 per `docs/superpowers/local-stack.md`) plus a three-layer test
suite now back the codebase:

- **Unit** (`npm test`) — pure game-logic and helper tests.
- **DB engine** (`npm run test:db`) — the PostgreSQL RPC functions exercised
  against the local stack, including race conditions, defense/attack timing,
  and security-definer grant checks.
- **Smoke** (`npm run test:smoke`) — one scripted three-player mini-season
  against the local stack.

`npm run typecheck`, `npm run build`, and `npm run lint` all pass clean.

## Phase 2a (Foundation): complete

The data layer is unified: `TerritoryGame` and `GameRuntimeControls` no longer
run two independent `group_snapshot` poll loops against the same
`territory_group` localStorage key — a single `GameDataProvider` drives one
poll loop that both consume, so the turn banner and the map always agree on
the selected league. The stale-operation bug is fixed: `loadSnapshot` now
clears a resolved session instead of leaving a stale question card behind
after a poll. A commissioner-gated `advance_group_day` RPC and its UI control
let the commissioner advance the current local day on demand rather than
waiting on the wall clock. See
`docs/superpowers/specs/2026-08-04-p2a-foundation-design.md` and
`docs/superpowers/plans/2026-08-04-p2a-foundation.md` for the design and task
breakdown.

## Phase 2b (Broadcast restyle): complete

Every screen renders in the Broadcast design system: auth, league entry,
lobby, game shell (map/HUD/mission dock), question arena with visual timer,
result posters, standings, activity feed, the in-app report dialog (native
`window.prompt`/`alert` are gone), season-complete panel, and the load-error
retry card. Result copy is action-aware — a timed-out defense reads "The
clock beat your defense. The attacker takes the state.", never a generic
"Time's up". Touch targets audited at 390px and 360px with Playwright: every
interactive control is ≥44px with zero horizontal overflow, and the
"Advance the day" control no longer overlaps the header league button on
narrow screens. Full click-through (auth → entry → map → question → result →
standings → feed → report → commissioner controls, plus attack/defense both
ways between two accounts) verified clean with no console errors. See
`docs/superpowers/plans/2026-08-04-p2b-broadcast-restyle.md`.

P2c (motion/juice + animated map) and P2d (PWA install) remain.

## Production deployment: pending owner action

The pre-Phase-1 schema and game engine (10 migrations, `202607300001` through
`20260802173100`) are already applied to the production Supabase project
(`gduvdnpxgdniogmxxlmg`). Phase 1's audit fixes added 12 more migrations
(`20260803180000` through `20260803181100`, fixing findings 1–11 and 19–21)
that are tested clean against the local stack but not yet deployed to
production — that push, plus connecting a Vercel project, environment
variables, auth URLs, and the cron secret, is owner action still to come.
Until then there is no public multiplayer URL. Deployment itself (migration
push, env wiring, auth URL configuration, cron, PWA installability) is Phase 5
of the roadmap in `docs/superpowers/specs/2026-08-03-stabilize-phase-design.md`
and follows Phases 2–4 (mobile UX/visual polish, trivia engine, strategy
depth), not Phase 1.

Phase 2a added two more migrations (`20260803233000_extract_advance_season.sql`
and `20260804000000_commissioner_advance_group_day.sql`), also tested clean
against the local stack. They are not yet deployed either, and await the same
owner action as Phase 1's outstanding twelve: the `SUPABASE_ACCESS_TOKEN` /
`SUPABASE_DB_PASSWORD` GitHub Actions secrets configured and the
`.github/workflows/deploy-supabase.yml` deploy workflow run.
