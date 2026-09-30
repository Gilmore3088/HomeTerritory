# Phase 3 (Trivia Depth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Design rationale, schema detail,
> source matrix, and scale math live in
> `docs/superpowers/specs/2026-09-30-p3-trivia-depth-design.md` — read it
> first; this file is the task breakdown.

**Goal:** Replace the static 550-question bank with a question *factory*:
a provenance-stamped facts warehouse fed nightly from public sports data, a
template compiler producing 60k+ verified questions (≥500 per state floor),
lifetime per-user no-repeat serving, and the PvP modes (live duels,
defender's choice, daily gauntlet, rivalry ledger) that make the depth
playable with friends.

**Global constraints** (house rules, same as P1/P2):
- Every task ends with `npm test && npm run typecheck && npm run build &&
  npm run lint` green; DB tasks also keep `test:db`/`test:smoke` green (CI
  `engine` job gates this).
- No client-readable facts or templates: schema `facts` gets NO grants to
  anon/authenticated; the grants audit tests must be extended FIRST (P3a-1)
  so a leak fails CI by default.
- Migrations compose: transcribe live definitions, never historical files
  (the `served_tier` incident is the cautionary tale).
- App source files under 300 lines; ETL scripts exempt but one-source-per-file.
- Conventional commits ending with the session's attribution lines.

**Sequencing:** P3a → P3b → P3c ship serially (each is useful alone);
P3d (PvP modes) can start once P3c serves generated questions; P3e (ops
hardening) trails. Owner-action checkpoints are marked ⚑.

---

### P3a — Facts warehouse + first three sources

*Outcome: `facts` schema live; Wikidata + Lahman + nflverse ingested;
≥25k entity rows state-linked; zero client exposure, audit-tested.*

- [ ] **Task 1: Schema migration** — `facts` schema: `athletes`, `teams`,
  `venues`, `championships`, `awards`, `drafts`, `season_results`,
  `leaders`, `events`, `colleges`, `geo`, `state_links`, `aliases`,
  `prominence`, `question_templates`, plus `etl_runs` (source, started,
  finished, rows, error) and `fact_conflicts` (review queue). Provenance
  block on every entity table. No grants beyond service_role. **Extend
  `tests/db/audit.test.ts`**: enumerate `facts.*` and assert zero
  anon/authenticated privileges (table AND function), so the leak-guard is
  born before the data is.
- [ ] **Task 2: ETL harness** — `etl/lib/` (typed Supabase writer, upsert-by
  `(source, source_key)`, rate limiter, raw-response snapshot to Storage,
  run logging to `etl_runs`); `etl/README.md`; unit tests for the resolver
  merge rules.
- [ ] **Task 3: Wikidata ingester** (`etl/sources/wikidata.ts`) — SPARQL
  batches: US major-league athletes/teams/venues/championships + aliases +
  coordinates/elevation; QID becomes the canonical entity key. Target:
  athletes ≥15k, venues ≥400, aliases ≥60k.
- [ ] **Task 4: Bulk seeds** — `etl/seed-lahman.ts` (MLB 1871→) and
  `etl/seed-nflverse.ts` (rosters, draft 1970→, schedules 1999→); Kaggle
  snapshots for NCAA tournament + Olympics + Stanley Cup history as
  `etl/fixtures/` with a documented refresh procedure. Entity-resolve
  against Wikidata QIDs; unresolved → `fact_conflicts`.
- [ ] **Task 5: State-linker** — derive `state_links` (team_plays_in,
  born_in, college_in, venue_in, champion_from, drafted_out_of, hof_from)
  with primary/secondary strength; coverage report: every state ≥150
  primary-linked entities or the gap is listed.
- [ ] **Task 6: Nightly workflow** — `.github/workflows/etl.yml` (cron,
  manual dispatch), running incremental Wikidata refresh; secrets wiring
  documented. ⚑ *Owner: add `SUPABASE_URL`/`SUPABASE_SECRET_KEY` ETL
  secrets to Actions.*

### P3b — Question compiler

*Outcome: templates × facts → ≥40k generated questions in
`public.questions`, 4-gate validated, every state ≥500 active.*

- [ ] **Task 1: Questions-table migration** — add `template_id`,
  `fact_refs`, `family_key`, `prominence` to `public.questions`; partial
  index on `(territory_id, family_key) where active`; back-fill
  `family_key` for hand-written rows (= their id).
- [ ] **Task 2: Compiler core** (`etl/compile/`) — template loader, slot
  renderer, answer/distractor SQL executor, alias assembly from
  `facts.aliases`, tier assignment from `facts.prominence`, family-key
  hashing, idempotent upsert by `(template_id, family_key)`. Gate A lint
  suite as pure unit tests (answer-leak, option-collision via
  `answer_matches` round-trip, alias self-match).
- [ ] **Task 3: Template catalog v1** — the ~50 templates from the spec's
  catalog table, seeded as rows via migration; each template lands with 3
  golden-instance tests (compile → exact expected question/answer/aliases).
- [ ] **Task 4: Gate B + prominence** — cross-verification job promoting
  facts to `cross_verified`; Wikipedia-pageviews prominence scorer;
  quarantine pool for `single_source` compiles.
- [ ] **Task 5: Gate C reviewer batch** — `etl/review/gate-c.ts` calling
  the Claude API (batched, cheapest adequate model) for
  ambiguity/era-trap/phrasing flags → `fact_conflicts` queue. Runs in the
  nightly workflow after compile. ⚑ *Owner: `ANTHROPIC_API_KEY` secret +
  ~$25 initial budget.*
- [ ] **Task 6: Coverage gate + bank cutover** — `state × tier` coverage
  view; compiler backfill loop until every state ≥500 active generated
  questions; THEN a migration deactivates `starter_seed_v2` (same
  retirement pattern as v1). Smoke test proves a full mini-season on
  generated questions only.

### P3c — Serving: lifetime no-repeat

*Outcome: no player ever sees a question or its near-duplicate twice,
provably, with pool-thinness alarms instead of silent repeats.*

- [ ] **Task 1: Ledger migration** — `public.user_question_history`
  (user_id, question_id, family_key, served_at; PK (user_id, question_id),
  index (user_id, family_key)); RLS: owner-read only; written inside
  `pick_next_question` (live-definition transcription!).
- [ ] **Task 2: Picker exclusions** — family-ever-seen, then id-ever-seen,
  ahead of the existing in-season rules; fallback ladder logs `pool_thin`
  activity events (service-visible, not player-visible). DB tests: serve N
  questions to one user across two seasons, assert zero family repeats;
  thin-pool fallback still never repeats within a streak.
- [ ] **Task 3: Serving mix** — novelty weighting (70/20/10
  deep/recent/fresh per spec) + canary weight for Gate-D new questions
  (low weight until 10 clean attempts); telemetry-driven nightly
  retirement job (outlier correct-rates, report-flagged) with template/fact
  counters.
- [ ] **Task 4: Reviewer UI** — `/review` route gated by
  `profiles.is_reviewer`; queues (reports, fact conflicts, Gate C flags);
  actions as service-mediated RPCs (edit aliases, retire question/family,
  dispute fact, reactivate). Closes the P3 reviewer backlog item.

### P3d — PvP depth

*Outcome: the modes that make friends fight: live duels, defender's
choice, wager attacks, daily gauntlet, rivalry ledger, season awards.*

- [ ] **Task 1: Rivalry ledger** — `pvp_ledger` migration + engine writes on
  every attack/defense resolution; lifetime H2H on standings + recap.
- [ ] **Task 2: Defender's choice** — defense flow offers the league's
  sports; `game_begin_action('defend')` takes `p_sport`; picker honors it.
- [ ] **Task 3: Live duels** — Realtime presence per season; when attacker
  + defender both present at attack completion, both get the same question
  simultaneously, first server-graded correct answer wins; async path
  untouched as default. DB race tests mirror the concurrent-attack suite.
- [ ] **Task 4: Wager attacks** — 2-action attack variant, t3 free-fill
  only, no-garrison-raise on successful defense; UI in TerritorySheet;
  engine + tests.
- [ ] **Task 5: Daily gauntlet** — league-shared daily 5-pack from
  fresh-fact pool (the deliberate uniqueness exception), bonus scoring
  line, its own leaderboard strip; compiled by the nightly job.
- [ ] **Task 6: Season awards** — recap enrichment (Best Defender, Sharpest
  Sport, Fastest Gun, Upset of the Season) from existing + new telemetry.

### P3e — Ops hardening

- [ ] Freshness dashboard (per-source `etl_runs` age, row deltas) + failure
  alerts into the nightly workflow summary.
- [ ] Current-season incremental sources: ESPN JSON + MLB/NHL official +
  balldontlie + CFBD deltas feeding `facts.events`/fresh pool. ⚑ *Owner:
  CFBD + balldontlie free keys.*
- [ ] "Data sources" attribution page (Retrosheet notice et al.).
- [ ] Load/limit review: questions table at 100k+ rows (index health,
  picker EXPLAIN), Storage snapshot retention policy.

---

## Milestones & rough effort

| Milestone | Proof | Est. sessions |
|---|---|---|
| M1 (P3a) | 25k+ state-linked facts, leak-guard tests green | 2–3 |
| M2 (P3b) | 40k+ generated questions, all states ≥500, starter bank retired | 3–4 |
| M3 (P3c) | lifetime no-repeat proven by DB tests; reviewer UI live | 1–2 |
| M4 (P3d) | duels + gauntlet + ledger playable two-window | 2–3 |
| M5 (P3e) | nightly pipeline self-reporting, attribution shipped | 1 |

## Out of scope (deliberately)

- Non-US sports/leagues beyond what the sources give for free (the map is
  US states; soccer/F1/Olympics enter only via US-linked facts).
- User-generated questions (moderation surface too large for now).
- Paid data providers (SportsDataIO, Sportradar) — revisit only if a free
  source dies.
- ML-personalized difficulty per player (the adaptive tier + prominence
  ladder is enough until there's real usage data).
