// ETL entrypoint:  node --experimental-strip-types etl/run.ts <job> [arg]
// Jobs:
//   wikidata-teams           teams + venues for the pro leagues
//   wikidata-athletes        per-state notable athletes (long; nightly)
//   wikidata-championships   title editions per league
//   wikidata-enrich          careers + aliases for ingested athletes
//   lahman <dir>             seed from an unzipped Lahman CSV directory
//   nflverse-draft <file>    seed from nflverse draft_picks.csv
// Environment: SUPABASE_URL + SUPABASE_SECRET_KEY (ETL_DRY_RUN=1 to print).
import { factsClient, logRun, publicClient, readEnv } from "./lib/db.ts";
import { ingestTeamsAndVenues } from "./sources/wikidata-teams.ts";
import { ingestAthletes } from "./sources/wikidata-athletes.ts";
import { ingestChampionships } from "./sources/wikidata-championships.ts";
import { enrichAthletes } from "./sources/wikidata-enrich.ts";
import { seedLahman } from "./seeds/lahman.ts";
import { seedNflverseDraft } from "./seeds/nflverse-draft.ts";

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
        const compiled = await rpc.rpc("compile_questions");
        if (compiled.error) throw new Error(`compile_questions failed: ${compiled.error.message}`);
        const retired = await rpc.rpc("retire_flagged_questions");
        if (retired.error) throw new Error(`retire_flagged_questions failed: ${retired.error.message}`);
        const cutover = await rpc.rpc("starter_bank_cutover");
        if (cutover.error) throw new Error(`starter_bank_cutover failed: ${cutover.error.message}`);
        const summary = compiled.data as { written?: number } | null;
        console.log(
          `derived links: ${JSON.stringify(links.data)}; compile: ${JSON.stringify(summary)}; ` +
          `retired: ${JSON.stringify(retired.data)}; cutover: ${JSON.stringify(cutover.data)}`,
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
