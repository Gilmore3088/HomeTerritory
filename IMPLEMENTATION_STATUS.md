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

## Phase 2b + gap-closing wave (2026-08-10): complete

Every incomplete feature surfaced by the 2026-08-10 system review is closed
in code:

- **Broadcast restyle finished.** Loading, toast, auth, league entry, lobby,
  overlays, league picker, question screen (with a visual countdown bar) and
  the result posters all speak the locked Broadcast light language; dead
  legacy classes are gone from `globals.css`.
- **UX papercuts.** Timeouts say "Time's up" instead of reading as wrong
  answers; blocked territory actions explain themselves; the report flow is
  an in-app dialog; the turn banner auto-clears; tab refocus refreshes the
  data layer; a twilight-decay banner warns before and during the final-days
  garrison decay.
- **Login unstick.** An auth watchdog breaks the cross-tab `getSession`
  stall, and the league-entry screen waits for the first `get_my_groups`
  read instead of flashing at (or stranding) players who have leagues.
- **League options + timezone.** The create form exposes season length
  (7–60; the table constraint now matches), opening mode, board scope,
  difficulty and a validated timezone that `create_group_v2` finally writes.
- **Game-day counter.** `groups.day_offset` + offset-aware
  `group_local_date` let `advance_group_day(p_group_id, p_days)` fast-forward
  whole days — scoring, action refresh, fortify windows and season end move
  together. Verified against a scratch Postgres 16: five taps produced five
  scored days.
- **Engine fixes.** Region bonus scoped to the season's territories (lower48
  Pacific is completable); exhaustion fallback prefers the closest tier;
  `create_group` v1's stale grant revoked (audit-tested); quarantine gained a
  service-role `reactivate_question` undo.
- **PWA + push.** The service worker and manifest actually load now; opt-in
  web-push defense alerts ship end to end (subscription table under RLS,
  server-verified send route, sw handlers) behind VAPID env keys.
- **Question bank v2.** The single-subject starter bank is deactivated in
  favor of 550 hand-written `starter_seed_v2` questions — 11 per state with
  distinct subjects and sport codes that match the engine's `SPORTS` filter.
- **Infra.** CI gained an `engine` job that boots the Supabase CLI stack and
  runs the DB + smoke suites on every push/PR; `test-signup` CORS is scoped
  by an `ALLOWED_ORIGINS` secret; the `db reset` seed WARN is gone.

Balance ruling recorded: defense has never consumed an action in the current
engine — the playtest confusion was the test-mode turn model — so the fix is
legibility (the dock and turn banner now say defending is free), not an
economy change.

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
and `20260804000000_commissioner_advance_group_day.sql`), the bot removal one
more, and the 2026-08-10 gap-closing wave seven more (`20260810120000` through
`20260810130000`: v1 revoke, timezone + season lengths, day counter + region
bonus, question reactivation, push subscriptions, exhaustion-fallback tier,
diversified question bank). All of them apply clean in order — verified
against a scratch Postgres 16 with Supabase shims — and all await the same
owner action: the `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD` GitHub
Actions secrets configured and the `.github/workflows/deploy-supabase.yml`
deploy workflow run. New optional owner configuration on top of the existing
Vercel/auth wiring: VAPID keys (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) to enable push alerts, and the
`ALLOWED_ORIGINS` secret on the `test-signup` edge function to scope its
CORS.

## Phase 3 (Trivia depth — the question factory): complete

Design: `docs/superpowers/specs/2026-09-30-p3-trivia-depth-design.md`; plan:
`docs/superpowers/plans/2026-09-30-p3-trivia-depth.md`. Built on the branch's
seven `202609301*`/`202609300*` migrations plus `etl/`, all verified against a
scratch Postgres 16 running the full migration chain from zero, with the DB
suites extended (`compiler`, `norepeat`, `ops`, `review`, `pvp`).

- **P3a — facts warehouse + ETL.** Service-role-only `facts` schema (17
  tables, provenance on every row, `facts_privilege_audit()` leak guard in
  CI); `etl/` harness with Wikidata (teams/venues/championships/athletes/
  enrichment, live-verified query shapes, pinned 50-state QID map with
  drift abort), Lahman and nflverse-draft seeds (era-correct franchise
  mapping derived from the real data), nightly `etl.yml`.
- **P3b — question compiler.** In-database `compile_questions()`:
  templates-as-data × facts → `public.questions`, Gate A lint (answer
  leaks, distractors an `answer_matches` grader could accept), Gate B
  (only gold/cross-verified facts compile), idempotent by
  `(template_id, family_key)`, retirement never resurrected. Template
  catalog v1: 22 templates with co-tenancy exclusion, unambiguity margins
  on comparisons (verified comparators only), golden tests in CI.
- **P3b ops.** `question_coverage()` (state × tier × format map with
  pool-thin telemetry), `retire_flagged_questions()` (live pass-rate
  gate), `starter_bank_cutover()` (500/state floor), Gate D canary weight
  in the picker, `etl/gate-c.ts` advisory Claude review filing
  `gate_c_flag` conflicts.
- **P3c — serving + review.** Lifetime no-repeat by question family
  (`user_question_history`, written on every serve; fallback stages
  logged to `serving_events`); reviewer role (`profiles.is_reviewer`),
  `review_queue`/`review_decide` RPCs and the `/review` page.
- **P3d — PvP depth.** `pvp_ledger` rivalry history across seasons and
  groups (`pvp_rivalries()` on standings), defender's choice
  (`p_sport` on defend), wager attacks (2 moves, tier-3 free-fill, no
  garrison on a successful defense), and season awards in the recap
  (Best Defender, Sharpest Sport, Fastest Gun, Upset, Rivalry).

Deliberately deferred from P3d/P3e (backlogged, in the plan doc): live
duels (Realtime presence), the daily gauntlet, freshness dashboard,
current-season incremental sources, and the attribution page.

New owner actions on deploy: expose the `facts` schema in the production
API settings (Dashboard → API → Exposed schemas, mirroring
`supabase/config.toml`); add `ETL_SUPABASE_URL` + `ETL_SUPABASE_SECRET_KEY`
Actions secrets (nightly ETL), optionally `ETL_ANTHROPIC_API_KEY` (Gate C);
flip `profiles.is_reviewer` for whoever reviews questions; run the Lahman
and nflverse seed jobs once by hand (`etl/README.md`).
