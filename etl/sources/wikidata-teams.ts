// Teams + venues ingestion. League QIDs resolve at runtime by official
// English label; team home venues (P115) come back in the same pass and a
// second query enriches each venue (coordinates, elevation, capacity,
// opening year) -- the raw material for the comparative geography
// templates. State resolution rides the venue's admin hierarchy (P131*),
// which the live probes showed is the reliable path.
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSparql, dedupeBy } from "../lib/sparql.ts";
import { upsertBatch } from "../lib/db.ts";
import { stateCode } from "../lib/states.ts";

export const LEAGUES: Record<string, { label: string; league: string }> = {
  nfl: { label: "National Football League", league: "NFL" },
  nba: { label: "National Basketball Association", league: "NBA" },
  mlb: { label: "Major League Baseball", league: "MLB" },
  nhl: { label: "National Hockey League", league: "NHL" },
  wnba: { label: "Women's National Basketball Association", league: "WNBA" },
  mls: { label: "Major League Soccer", league: "MLS" },
};

export async function resolveLeagueQids(): Promise<Record<string, string>> {
  const labels = Object.values(LEAGUES).map((l) => `"${l.label}"@en`).join(", ");
  const rows = await runSparql(`
    SELECT ?lg ?lgLabel WHERE {
      ?lg rdfs:label ?lgLabel.
      FILTER(?lgLabel IN (${labels}))
      FILTER EXISTS { ?team wdt:P118 ?lg. }
    }`);
  const byLabel: Record<string, string> = {};
  for (const row of rows) {
    if (row.lgLabel && row.lg) byLabel[row.lgLabel] = row.lg;
  }
  const resolved: Record<string, string> = {};
  for (const [key, meta] of Object.entries(LEAGUES)) {
    if (byLabel[meta.label]) resolved[key] = byLabel[meta.label];
    else console.warn(`league not resolved on Wikidata: ${meta.label} -- skipping`);
  }
  return resolved;
}

export function teamQuery(leagueQid: string): string {
  return `
    SELECT ?team ?teamLabel ?venue ?venueLabel ?stateLabel ?founded ?links WHERE {
      ?team wdt:P118 wd:${leagueQid};
            wikibase:sitelinks ?links.
      OPTIONAL {
        ?team wdt:P115 ?venue.
        OPTIONAL { ?venue wdt:P131* ?st. ?st wdt:P31 wd:Q35657. ?st rdfs:label ?stateLabel. FILTER(lang(?stateLabel) = "en") }
      }
      OPTIONAL { ?team wdt:P571 ?founded. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`;
}

export function venueQuery(venueQids: string[]): string {
  const values = venueQids.map((q) => `wd:${q}`).join(" ");
  return `
    SELECT ?v ?vLabel ?cityLabel ?stateLabel ?coord ?elev ?capacity ?opened WHERE {
      VALUES ?v { ${values} }
      OPTIONAL { ?v wdt:P131* ?st. ?st wdt:P31 wd:Q35657. ?st rdfs:label ?stateLabel. FILTER(lang(?stateLabel) = "en") }
      OPTIONAL { ?v wdt:P131 ?city. }
      OPTIONAL { ?v wdt:P625 ?coord. }
      OPTIONAL { ?v wdt:P2044 ?elev. }
      OPTIONAL { ?v wdt:P1083 ?capacity. }
      OPTIONAL { ?v wdt:P1619 ?opened. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`;
}

export interface TeamRow {
  id: string;
  league: string;
  name: string;
  state: string | null;
  founded: number | null;
  source: string;
  source_key: string;
  source_url: string;
  confidence: string;
}

/** Pure: SPARQL rows -> team rows + the venue tenancy map (fixture-tested). */
export function toTeamRows(rows: Record<string, string | null>[], league: string): {
  teams: TeamRow[];
  tenancies: Map<string, { team_id: string; team_name: string; league: string }[]>;
} {
  const unique = dedupeBy(rows.filter((r) => r.team && r.teamLabel), (r) => `${r.team}|${r.venue ?? ""}`);
  const teams = new Map<string, TeamRow>();
  const tenancies = new Map<string, { team_id: string; team_name: string; league: string }[]>();
  for (const row of unique) {
    const id = row.team as string;
    if (/^Q\d+$/.test(row.teamLabel as string)) continue;
    if (!teams.has(id)) {
      teams.set(id, {
        id,
        league,
        name: row.teamLabel as string,
        state: stateCode(row.stateLabel),
        founded: row.founded ? Number(row.founded.slice(0, 4)) : null,
        source: "wikidata",
        source_key: id,
        source_url: `https://www.wikidata.org/wiki/${id}`,
        confidence: "gold",
      });
    } else if (!teams.get(id)!.state && stateCode(row.stateLabel)) {
      teams.get(id)!.state = stateCode(row.stateLabel);
    }
    if (row.venue) {
      const tenants = tenancies.get(row.venue) ?? [];
      if (!tenants.some((t) => t.team_id === id)) {
        tenants.push({ team_id: id, team_name: row.teamLabel as string, league });
      }
      tenancies.set(row.venue, tenants);
    }
  }
  return { teams: [...teams.values()], tenancies };
}

/** Pure: venue detail rows + tenancy map -> facts.venues rows. */
export function toVenueRows(
  rows: Record<string, string | null>[],
  tenancies: Map<string, { team_id: string; team_name: string; league: string }[]>,
): Record<string, unknown>[] {
  const unique = dedupeBy(rows.filter((r) => r.v && r.vLabel), (r) => r.v as string);
  return unique
    .filter((row) => !/^Q\d+$/.test(row.vLabel as string))
    .map((row) => {
      const coord = row.coord ? /Point\(([-\d.]+) ([-\d.]+)\)/.exec(row.coord) : null;
      return {
        id: row.v as string,
        name: row.vLabel as string,
        city: row.cityLabel && !/^Q\d+$/.test(row.cityLabel) ? row.cityLabel : null,
        state: stateCode(row.stateLabel),
        longitude: coord ? Number(coord[1]) : null,
        latitude: coord ? Number(coord[2]) : null,
        elevation_m: row.elev ? Number(row.elev) : null,
        capacity: row.capacity ? Number(row.capacity) : null,
        opened: row.opened ? Number(row.opened.slice(0, 4)) : null,
        tenants: tenancies.get(row.v as string) ?? [],
        source: "wikidata",
        source_key: row.v as string,
        source_url: `https://www.wikidata.org/wiki/${row.v}`,
        confidence: "gold",
      };
    });
}

export async function ingestTeamsAndVenues(client: SupabaseClient, dryRun: boolean): Promise<number> {
  const leagues = await resolveLeagueQids();
  let total = 0;
  const allTenancies = new Map<string, { team_id: string; team_name: string; league: string }[]>();
  for (const [key, leagueQid] of Object.entries(leagues)) {
    const league = LEAGUES[key].league;
    const rows = await runSparql(teamQuery(leagueQid));
    const { teams, tenancies } = toTeamRows(rows, league);
    for (const [venue, tenants] of tenancies) {
      allTenancies.set(venue, [...(allTenancies.get(venue) ?? []), ...tenants]);
    }
    total += await upsertBatch(client, "teams", teams as unknown as Record<string, unknown>[], "id", dryRun);
    console.log(`teams ${league}: ${teams.length}`);
  }
  const venueQids = [...allTenancies.keys()];
  for (let i = 0; i < venueQids.length; i += 80) {
    const chunk = venueQids.slice(i, i + 80);
    const rows = await runSparql(venueQuery(chunk));
    const venues = toVenueRows(rows, allTenancies);
    total += await upsertBatch(client, "venues", venues, "id", dryRun);
  }
  console.log(`venues: ${venueQids.length}`);
  return total;
}
