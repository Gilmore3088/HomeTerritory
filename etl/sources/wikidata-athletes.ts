// Athlete ingestion: per state x occupation, notability-gated by Wikidata
// sitelink count (>= MIN_SITELINKS), which doubles as the raw prominence
// signal. Occupation QIDs are resolved at RUNTIME by English label -- never
// memorized -- and an occupation that resolves to nothing (or to an item no
// athletes carry) simply reports 0 rows in the run summary, where the
// coverage monitoring makes it visible instead of silently wrong.
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSparql, dedupeBy } from "../lib/sparql.ts";
import { upsertBatch } from "../lib/db.ts";
import { fetchStateQids } from "./wikidata-states.ts";

export const MIN_SITELINKS = 5;

export const OCCUPATIONS: Record<string, { label: string; sport: string }> = {
  football: { label: "American football player", sport: "NFL" },
  basketball: { label: "basketball player", sport: "NBA" },
  baseball: { label: "baseball player", sport: "MLB" },
  hockey: { label: "ice hockey player", sport: "NHL" },
  golf: { label: "golfer", sport: "OTH" },
  boxing: { label: "boxer", sport: "OTH" },
  tennis: { label: "tennis player", sport: "OTH" },
  racing: { label: "racing automobile driver", sport: "OTH" },
};

export async function resolveOccupationQids(): Promise<Record<string, string>> {
  const labels = Object.values(OCCUPATIONS).map((o) => `"${o.label}"@en`).join(", ");
  const rows = await runSparql(`
    SELECT ?occ ?occLabel WHERE {
      ?occ rdfs:label ?occLabel.
      FILTER(?occLabel IN (${labels}))
      FILTER EXISTS { ?somebody wdt:P106 ?occ. }
    }`);
  const byLabel: Record<string, string> = {};
  for (const row of rows) {
    if (row.occLabel && row.occ) byLabel[row.occLabel] = row.occ;
  }
  const resolved: Record<string, string> = {};
  for (const [key, occupation] of Object.entries(OCCUPATIONS)) {
    if (byLabel[occupation.label]) resolved[key] = byLabel[occupation.label];
    else console.warn(`occupation not resolved on Wikidata: ${occupation.label} -- skipping`);
  }
  return resolved;
}

export interface AthleteRow {
  id: string;
  full_name: string;
  birth_city: string | null;
  birth_state: string;
  birth_date: string | null;
  death_date: string | null;
  sports: string[];
  source: string;
  source_key: string;
  source_url: string;
  confidence: string;
}

/** Pure: SPARQL rows -> facts.athletes rows (fixture-tested offline). */
export function toAthleteRows(
  rows: Record<string, string | null>[],
  state: string,
  sport: string,
): { athletes: AthleteRow[]; prominence: { entity_type: string; entity_id: string; score: number; signals: object }[] } {
  const unique = dedupeBy(rows.filter((r) => r.p && r.pLabel), (r) => r.p as string);
  const athletes: AthleteRow[] = [];
  const prominence = [];
  for (const row of unique) {
    const id = row.p as string;
    // Wikidata labels that are still the bare QID mean "no English label" --
    // useless as an answer, so those entities are skipped outright.
    if (/^Q\d+$/.test(row.pLabel as string)) continue;
    athletes.push({
      id,
      full_name: row.pLabel as string,
      birth_city: row.cityLabel ?? null,
      birth_state: state,
      birth_date: row.dob ? row.dob.slice(0, 10) : null,
      death_date: row.dod ? row.dod.slice(0, 10) : null,
      sports: [sport],
      source: "wikidata",
      source_key: id,
      source_url: `https://www.wikidata.org/wiki/${id}`,
      confidence: "gold",
    });
    const links = Number(row.links ?? 0);
    prominence.push({
      entity_type: "athlete",
      entity_id: id,
      // sitelinks -> [0,1]: 5 links ~ 0.1, 30 ~ 0.55, 100+ ~ saturating.
      score: Math.min(1, Math.round(1000 * Math.log10(1 + links) / 2.2) / 1000),
      signals: { wikidata_sitelinks: links },
    });
  }
  return { athletes, prominence };
}

export function athleteQuery(occupationQid: string, stateQid: string): string {
  return `
    SELECT ?p ?pLabel ?cityLabel ?dob ?dod ?links WHERE {
      ?p wdt:P106 wd:${occupationQid};
         wdt:P19 ?city;
         wikibase:sitelinks ?links.
      ?city wdt:P131* wd:${stateQid}.
      OPTIONAL { ?p wdt:P569 ?dob. }
      OPTIONAL { ?p wdt:P570 ?dod. }
      FILTER(?links >= ${MIN_SITELINKS})
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`;
}

export async function ingestAthletes(client: SupabaseClient, dryRun: boolean): Promise<number> {
  const [states, occupations] = [await fetchStateQids(), await resolveOccupationQids()];
  let total = 0;
  for (const [stateCode, stateQid] of Object.entries(states)) {
    // Merge across occupations BEFORE upserting: a two-sport athlete (Bo
    // Jackson matches both football and baseball) must end up with both
    // sports on one row, not whichever batch wrote last.
    const merged = new Map<string, AthleteRow>();
    const prominenceRows: Record<string, unknown>[] = [];
    for (const [key, occupationQid] of Object.entries(occupations)) {
      const sport = OCCUPATIONS[key].sport;
      const rows = await runSparql(athleteQuery(occupationQid, stateQid));
      const { athletes, prominence } = toAthleteRows(rows, stateCode, sport);
      for (const athlete of athletes) {
        const existing = merged.get(athlete.id);
        if (existing) {
          existing.sports = [...new Set([...existing.sports, ...athlete.sports])];
        } else {
          merged.set(athlete.id, athlete);
          prominenceRows.push(prominence.find((p) => p.entity_id === athlete.id) as unknown as Record<string, unknown>);
        }
      }
      console.log(`athletes ${stateCode}/${key}: ${athletes.length}`);
    }
    const stateRows = [...merged.values()] as unknown as Record<string, unknown>[];
    total += await upsertBatch(client, "athletes", stateRows, "id", dryRun);
    await upsertBatch(client, "prominence", prominenceRows, "entity_type,entity_id", dryRun);
  }
  return total;
}
