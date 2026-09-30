// Enrichment pass: for athletes already in the warehouse, batch-fetch
// career stops (P54), colleges (P69) and aliases (skos:altLabel), 60
// athletes per SPARQL call. Aliases are what make free-fill answers
// forgiving, so this pass is what replaces the hand-written alias lists.
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSparql } from "../lib/sparql.ts";
import { upsertBatch } from "../lib/db.ts";

export function enrichQuery(athleteQids: string[]): string {
  const values = athleteQids.map((q) => `wd:${q}`).join(" ");
  return `
    SELECT ?p ?teamLabel ?teamLeagueLabel ?collegeLabel ?alias WHERE {
      VALUES ?p { ${values} }
      OPTIONAL { ?p wdt:P54 ?team. ?team rdfs:label ?teamLabel. FILTER(lang(?teamLabel) = "en")
                 OPTIONAL { ?team wdt:P118 ?lg. ?lg rdfs:label ?teamLeagueLabel. FILTER(lang(?teamLeagueLabel) = "en") } }
      OPTIONAL { ?p wdt:P69 ?college. ?college rdfs:label ?collegeLabel. FILTER(lang(?collegeLabel) = "en") }
      OPTIONAL { ?p skos:altLabel ?alias. FILTER(lang(?alias) = "en") }
    }`;
}

export interface EnrichResult {
  proTeams: Map<string, { team_name: string; league: string | null }[]>;
  colleges: Map<string, { name: string }[]>;
  aliases: Map<string, Set<string>>;
}

/** Pure: SPARQL fanout rows -> per-athlete career/alias structures. */
export function collectEnrichment(rows: Record<string, string | null>[]): EnrichResult {
  const proTeams = new Map<string, { team_name: string; league: string | null }[]>();
  const colleges = new Map<string, { name: string }[]>();
  const aliases = new Map<string, Set<string>>();
  for (const row of rows) {
    const id = row.p;
    if (!id) continue;
    if (row.teamLabel && !/^Q\d+$/.test(row.teamLabel)) {
      const teams = proTeams.get(id) ?? [];
      if (!teams.some((t) => t.team_name === row.teamLabel)) {
        teams.push({ team_name: row.teamLabel, league: row.teamLeagueLabel ?? null });
        proTeams.set(id, teams);
      }
    }
    if (row.collegeLabel && !/^Q\d+$/.test(row.collegeLabel)) {
      const schools = colleges.get(id) ?? [];
      if (!schools.some((c) => c.name === row.collegeLabel)) {
        schools.push({ name: row.collegeLabel });
        colleges.set(id, schools);
      }
    }
    if (row.alias && row.alias.length >= 2 && row.alias.length <= 60) {
      const set = aliases.get(id) ?? new Set<string>();
      set.add(row.alias);
      aliases.set(id, set);
    }
  }
  return { proTeams, colleges, aliases };
}

/** A surname alias makes "Payton" acceptable for "Walter Payton". */
export function surnameAlias(fullName: string): string | null {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  return /^[A-Z][\w'.-]+$/.test(last) && !/^(Jr|Sr|II|III|IV)\.?$/.test(last) ? last : null;
}

export async function enrichAthletes(client: SupabaseClient, dryRun: boolean): Promise<number> {
  let total = 0;
  let from = 0;
  const page = 600;
  for (;;) {
    const { data, error } = await client
      .from("athletes")
      .select("id, full_name")
      .eq("source", "wikidata")
      .order("id")
      .range(from, from + page - 1);
    if (error) throw new Error(`athlete page read failed: ${error.message}`);
    const athletes = (data ?? []) as { id: string; full_name: string }[];
    if (athletes.length === 0) break;

    for (let i = 0; i < athletes.length; i += 60) {
      const chunk = athletes.slice(i, i + 60);
      const rows = await runSparql(enrichQuery(chunk.map((a) => a.id)));
      const { proTeams, colleges, aliases } = collectEnrichment(rows);

      const updates = chunk
        .filter((a) => proTeams.has(a.id) || colleges.has(a.id))
        .map((a) => ({
          id: a.id,
          pro_teams: (proTeams.get(a.id) ?? []),
          colleges: (colleges.get(a.id) ?? []),
        }));
      for (const update of updates) {
        if (dryRun) continue;
        const { error: upErr } = await client
          .from("athletes")
          .update({ pro_teams: update.pro_teams, colleges: update.colleges })
          .eq("id", update.id);
        if (upErr) throw new Error(`athlete enrich update failed: ${upErr.message}`);
      }

      const aliasRows: Record<string, unknown>[] = [];
      for (const athlete of chunk) {
        const set = aliases.get(athlete.id) ?? new Set<string>();
        const surname = surnameAlias(athlete.full_name);
        if (surname) set.add(surname);
        for (const alias of set) {
          if (alias === athlete.full_name) continue;
          aliasRows.push({ entity_type: "athlete", entity_id: athlete.id, alias, alias_kind: "alt_label" });
        }
      }
      total += await upsertBatch(client, "aliases", aliasRows, "entity_type,entity_id,alias", dryRun);
    }
    from += page;
    console.log(`enriched through ${from}`);
  }
  return total;
}
