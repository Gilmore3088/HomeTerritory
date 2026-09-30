// ETL entrypoint:  node --experimental-strip-types etl/run.ts <job> [arg]
// Jobs:
//   wikidata-teams           teams + venues for the pro leagues
//   wikidata-athletes        per-state notable athletes (long; nightly)
//   wikidata-championships   title editions per league
//   wikidata-enrich          careers + aliases for ingested athletes
//   lahman <dir>             seed from an unzipped Lahman CSV directory
//   nflverse-draft <file>    seed from nflverse draft_picks.csv
//   espn-events [days]       current-season finals into facts.events
//   wikipedia-prominence [n] re-score the stalest n athletes' prominence
//   report                   freshness dashboard; fails on stale sources
// Environment: SUPABASE_URL + SUPABASE_SECRET_KEY (ETL_DRY_RUN=1 to print).
import { appendFileSync } from "node:fs";
import { factsClient, logRun, publicClient, readEnv } from "./lib/db.ts";
import { ingestTeamsAndVenues } from "./sources/wikidata-teams.ts";
import { ingestAthletes } from "./sources/wikidata-athletes.ts";
import { ingestChampionships } from "./sources/wikidata-championships.ts";
import { enrichAthletes } from "./sources/wikidata-enrich.ts";
import { ingestEspnEvents } from "./sources/espn-events.ts";
import { scoreProminence } from "./sources/wikipedia-prominence.ts";
import { seedLahman } from "./seeds/lahman.ts";
import { seedNflverseDraft } from "./seeds/nflverse-draft.ts";

// The nightly set: a source here whose last run failed, or whose last
// success is older than two days, fails the freshness report (and with it
// the workflow, which is the alert).
const NIGHTLY_SOURCES = [
  "wikidata-teams",
  "wikidata-championships",
  "wikidata-athletes",
  "wikidata-enrich",
  "espn-events",
  "wikipedia-prominence",
  "refresh-and-compile",
];

const [job, arg] = process.argv.slice(2);
const env = readEnv();
const client = factsClient(env);

async function main(): Promise<void> {
  switch (job) {
    case "wikidata-teams":
      await logRun(client, "wikidata-teams", env.dryRun, () => ingestTeamsAndVenues(client, env.dryRun));
      return;
    case "wikidata-athletes":
      await logRun(client, "wikidata-athletes", env.dryRun, () => ingestAthletes(client, env.dryRun));
      return;
    case "wikidata-championships":
      await logRun(client, "wikidata-championships", env.dryRun, () => ingestChampionships(client, env.dryRun));
      return;
    case "wikidata-enrich":
      await logRun(client, "wikidata-enrich", env.dryRun, () => enrichAthletes(client, env.dryRun));
      return;
    case "lahman":
      if (!arg) throw new Error("usage: etl/run.ts lahman <dir-with-lahman-csvs>");
      await logRun(client, "lahman", env.dryRun, () => seedLahman(client, arg, env.dryRun));
      return;
    case "nflverse-draft":
      if (!arg) throw new Error("usage: etl/run.ts nflverse-draft <draft_picks.csv>");
      await logRun(client, "nflverse-draft", env.dryRun, () => seedNflverseDraft(client, arg, env.dryRun));
      return;
    case "espn-events":
      await logRun(client, "espn-events", env.dryRun, () => ingestEspnEvents(client, env.dryRun, arg ? Number(arg) : 2));
      return;
    case "wikipedia-prominence":
      await logRun(client, "wikipedia-prominence", env.dryRun, () => scoreProminence(client, env.dryRun, arg ? Number(arg) : 400));
      return;
    case "report": {
      // Freshness dashboard: per-source last run, rows, age. Written to the
      // workflow summary when GitHub provides one; a failed or stale
      // nightly source fails this job, which is the alert.
      const runs = await client
        .from("etl_runs")
        .select("source, started_at, finished_at, rows_upserted, ok, error")
        .order("started_at", { ascending: false })
        .limit(200);
      if (runs.error) throw new Error(`reading etl_runs failed: ${runs.error.message}`);
      const latest = new Map<string, { started_at: string; ok: boolean | null; rows_upserted: number | null; error: string | null }>();
      const latestOk = new Map<string, string>();
      for (const run of (runs.data ?? []) as Array<{ source: string; started_at: string; ok: boolean | null; rows_upserted: number | null; error: string | null }>) {
        if (!latest.has(run.source)) latest.set(run.source, run);
        if (run.ok && !latestOk.has(run.source)) latestOk.set(run.source, run.started_at);
      }
      const lines = ["| source | last run | ok | rows | note |", "|---|---|---|---|---|"];
      const failures: string[] = [];
      for (const source of new Set([...NIGHTLY_SOURCES, ...latest.keys()])) {
        const run = latest.get(source);
        const nightly = NIGHTLY_SOURCES.includes(source);
        if (!run) {
          lines.push(`| ${source} | never | — | — | ${nightly ? "awaiting first nightly run" : "manual seed"} |`);
          continue;
        }
        const ageHours = (Date.now() - new Date(latestOk.get(source) ?? 0).getTime()) / 3_600_000;
        const stale = nightly && (!run.ok || ageHours > 48);
        if (stale) failures.push(`${source}: ${run.ok ? `last success ${Math.round(ageHours)}h ago` : run.error ?? "failed"}`);
        lines.push(`| ${source} | ${run.started_at} | ${run.ok ? "yes" : "NO"} | ${run.rows_upserted ?? ""} | ${stale ? "STALE" : ""} |`);
      }
      const table = lines.join("\n");
      console.log(table);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Facts warehouse freshness\n\n${table}\n`);
      }
      if (failures.length) throw new Error(`stale or failing sources: ${failures.join("; ")}`);
      return;
    }
    case "refresh-and-compile": {
      // The whole nightly pipeline runs in-database (service-role RPCs):
      // rebuild derived links, recompile the catalog, apply the telemetry
      // retirement gate, and cut states over once generated coverage clears
      // the floor. Nothing round-trips row data.
      const rpc = publicClient(env);
      await logRun(client, "refresh-and-compile", env.dryRun, async () => {
        if (env.dryRun) return 0;
        const links = await rpc.rpc("refresh_derived");
        if (links.error) throw new Error(`refresh_derived failed: ${links.error.message}`);
        const verified = await rpc.rpc("cross_verify_facts");
        if (verified.error) throw new Error(`cross_verify_facts failed: ${verified.error.message}`);
        const compiled = await rpc.rpc("compile_questions");
        if (compiled.error) throw new Error(`compile_questions failed: ${compiled.error.message}`);
        const retired = await rpc.rpc("retire_flagged_questions");
        if (retired.error) throw new Error(`retire_flagged_questions failed: ${retired.error.message}`);
        const cutover = await rpc.rpc("starter_bank_cutover");
        if (cutover.error) throw new Error(`starter_bank_cutover failed: ${cutover.error.message}`);
        const summary = compiled.data as { written?: number } | null;
        console.log(
          `derived links: ${JSON.stringify(links.data)}; cross-verify: ${JSON.stringify(verified.data)}; ` +
          `compile: ${JSON.stringify(summary)}; retired: ${JSON.stringify(retired.data)}; ` +
          `cutover: ${JSON.stringify(cutover.data)}`,
        );
        return summary?.written ?? 0;
      });
      return;
    }
    default:
      throw new Error(`unknown ETL job: ${job ?? "(none)"}`);
  }
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : cause);
  process.exit(1);
});
