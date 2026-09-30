// Championship editions per league. The edition class resolves by label
// ("Super Bowl", "World Series", ...); each edition carries winner (P1346),
// point in time (P585) and often a runner-up via the same participant
// property -- v1 records winner + date and leaves series detail to the
// league-specific seeds. A class that resolves to nothing reports 0 in the
// run summary rather than failing silently.
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSparql, dedupeBy } from "../lib/sparql.ts";
import { upsertBatch } from "../lib/db.ts";

export const CHAMPIONSHIPS: Record<string, { classLabel: string; league: string }> = {
  superbowl: { classLabel: "Super Bowl", league: "NFL" },
  worldseries: { classLabel: "World Series", league: "MLB" },
  nbafinals: { classLabel: "NBA Finals", league: "NBA" },
  stanleycup: { classLabel: "Stanley Cup Finals", league: "NHL" },
};

export function championshipQuery(classQid: string): string {
  return `
    SELECT ?e ?eLabel ?winner ?winnerLabel ?when WHERE {
      ?e wdt:P31 wd:${classQid};
         wdt:P1346 ?winner.
      OPTIONAL { ?e wdt:P585 ?when. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`;
}

/** Pure: SPARQL rows -> facts.championships rows (fixture-tested). */
export function toChampionshipRows(
  rows: Record<string, string | null>[],
  league: string,
): Record<string, unknown>[] {
  const unique = dedupeBy(rows.filter((r) => r.e && r.eLabel && r.winnerLabel), (r) => r.e as string);
  return unique
    .filter((row) => !/^Q\d+$/.test(row.winnerLabel as string) && row.when)
    .map((row) => {
      const year = Number((row.when as string).slice(0, 4));
      return {
        id: row.e as string,
        league,
        season: row.eLabel as string,
        year,
        winner_team_id: row.winner,
        winner_name: row.winnerLabel as string,
        source: "wikidata",
        source_key: row.e as string,
        source_url: `https://www.wikidata.org/wiki/${row.e}`,
        confidence: "gold",
      };
    });
}

export async function ingestChampionships(client: SupabaseClient, dryRun: boolean): Promise<number> {
  const labels = Object.values(CHAMPIONSHIPS).map((c) => `"${c.classLabel}"@en`).join(", ");
  const classes = await runSparql(`
    SELECT ?c ?cLabel WHERE {
      ?c rdfs:label ?cLabel.
      FILTER(?cLabel IN (${labels}))
      FILTER EXISTS { ?edition wdt:P31 ?c. ?edition wdt:P1346 ?w. }
    }`);
  const byLabel: Record<string, string> = {};
  for (const row of classes) {
    if (row.cLabel && row.c) byLabel[row.cLabel] = row.c;
  }
  let total = 0;
  for (const [key, meta] of Object.entries(CHAMPIONSHIPS)) {
    const classQid = byLabel[meta.classLabel];
    if (!classQid) {
      console.warn(`championship class not resolved: ${meta.classLabel} -- skipping`);
      continue;
    }
    const rows = await runSparql(championshipQuery(classQid));
    const editions = toChampionshipRows(rows, meta.league);
    total += await upsertBatch(client, "championships", editions, "id", dryRun);
    console.log(`championships ${key}: ${editions.length}`);
  }
  return total;
}
