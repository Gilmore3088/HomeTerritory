# ETL: the facts warehouse pipeline

Feeds schema `facts` (see `supabase/migrations/20260930100000_facts_warehouse.sql`
and the design spec `docs/superpowers/specs/2026-09-30-p3-trivia-depth-design.md`).
Network fetching happens here in Node; all heavy derivation (state links,
question compilation) happens **in the database** via service-role RPCs so
the data never round-trips.

## Running

```bash
export SUPABASE_URL=...          # project URL (local stack or production)
export SUPABASE_SECRET_KEY=...   # service key; NEVER a publishable key
npm run etl -- wikidata-teams
npm run etl -- wikidata-championships
npm run etl -- wikidata-athletes        # long: 50 states x occupations
npm run etl -- wikidata-enrich          # careers + aliases, batched
npm run etl -- refresh-and-compile      # in-DB: state links + question compile
ETL_DRY_RUN=1 npm run etl -- wikidata-teams   # print, write nothing
```

Bulk seeds (one-time, re-run per data release):

```bash
# Lahman (MLB history): download + unzip the CSV release, then
npm run etl -- lahman /path/to/lahman/csv/dir
# nflverse draft picks:
curl -LO https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv
npm run etl -- nflverse-draft draft_picks.csv
```

## Design rules

- **Idempotent**: every writer upserts on the table's natural key; re-runs
  refresh, never duplicate.
- **No memorized IDs**: Wikidata occupation/league/championship QIDs resolve
  at runtime by English label; the 50-state QID map is fetched live and
  must match the pinned snapshot exactly (`wikidata-states.ts`) or the run
  aborts -- drift cannot silently re-map the warehouse.
- **Visible zeroes**: a label that stops resolving logs a warning and
  reports 0 rows in `facts.etl_runs` rather than failing silently or
  inventing data.
- **Era correctness**: relocated-franchise names resolve per season
  (`lib/nfl-teams.ts`); an unmapped (code, season) ships as
  `single_source`, which Gate B keeps out of compiled questions.
- **Notability gate**: athletes need >= 5 Wikidata sitelinks (also the raw
  prominence signal); Lahman players need HOF, a notable award, or a 10+
  season career.
- **Politeness**: per-host rate limiting + project User-Agent
  (`lib/http.ts`); Wikidata gets >= 2s between queries.

## GitHub Actions

`.github/workflows/etl.yml` runs the incremental set nightly. Owner setup:
repository secrets `ETL_SUPABASE_URL` and `ETL_SUPABASE_SECRET_KEY`
(production project URL + secret key). Manual dispatch takes a single job
name for reruns. Run results land in `facts.etl_runs`.

The nightly `refresh-and-compile` step also runs the operating gates
(service-role RPCs from `20260930140000_question_ops.sql`):

- `retire_flagged_questions()` retires generated questions whose live pass
  rate looks leaked/trivial (> 97% over 25+ attempts) or broken (< 5%),
  stamping `questions.retired_reason`.
- `starter_bank_cutover()` retires a state's handwritten starter bank once
  that state holds 500+ active generated questions. Reversible per
  question via `reactivate_question()`.
- `question_coverage()` is the state x tier x format bank map (with 7-day
  `pool_thin` counts from `public.serving_events`) for checking where the
  bank runs thin: `select * from question_coverage()` in the SQL editor.

## Current-season events + freshness

`espn-events [days]` (nightly; default yesterday+today) pulls completed
games for the four majors from ESPN's keyless site JSON into
`facts.events` — always `single_source`, so Gate B keeps them out of
compiled questions until an official source (MLB statsapi / NHL api-web,
backlog) cross-verifies. International venues are skipped. `report` prints
the per-source freshness table (and writes it to the GitHub run summary);
it exits nonzero when a nightly source's last run failed or its last
success is older than 48 hours, which fails the workflow — that is the
alert. Load check (2026-09-30): the serving picker's stage-1 query runs in
~9ms against 100k active questions with a 1,500-family lifetime ledger,
on the existing `questions_picker_idx`.

## Gate C (advisory LLM review)

`node --experimental-strip-types etl/gate-c.ts [batch]` asks Claude to
check never-reviewed generated questions for ambiguity, leaks and multiple
defensible answers. Findings land in `facts.fact_conflicts`
(kind `gate_c_flag`) for a human to act on; nothing auto-retires. Needs the
optional `ETL_ANTHROPIC_API_KEY` repository secret (exposed to the step as
`ANTHROPIC_API_KEY`); without it the step logs a notice and exits cleanly.

## Testing

`tests/etl/*.test.ts` (part of `npm test`) covers every pure parser against
fixtures snapshotted from the live sources -- `etl/fixtures/draft_picks.sample.csv`
is a slice of the real nflverse release chosen to exercise every
franchise-era boundary. No network or database in unit tests; the DB suite
(`tests/db/facts.test.ts`) proves the warehouse's privilege walls.
