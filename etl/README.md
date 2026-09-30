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

## Testing

`tests/etl/*.test.ts` (part of `npm test`) covers every pure parser against
fixtures snapshotted from the live sources -- `etl/fixtures/draft_picks.sample.csv`
is a slice of the real nflverse release chosen to exercise every
franchise-era boundary. No network or database in unit tests; the DB suite
(`tests/db/facts.test.ts`) proves the warehouse's privilege walls.
