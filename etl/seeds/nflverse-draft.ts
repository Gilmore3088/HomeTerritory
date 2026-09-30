// nflverse draft-picks seed. The workflow downloads
// https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv
// and runs `node --experimental-strip-types etl/run.ts nflverse-draft <file>`.
// Every first-round pick becomes a draft fact; later rounds only for
// players nflverse marks as Hall of Famers (they make great tier-3
// questions: "which round did the Patriots take Tom Brady in?").
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCsv } from "../lib/csv.ts";
import { upsertBatch } from "../lib/db.ts";
import { nflTeamName } from "../lib/nfl-teams.ts";

/** Pure: nflverse draft_picks rows -> facts.drafts rows (fixture-tested). */
export function nflverseDraftToFacts(rows: Record<string, string>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const year = Number(row.season);
    const round = Number(row.round);
    const pick = Number(row.pick);
    const name = row.pfr_player_name?.trim();
    if (!year || !round || !pick || !name) continue;
    const hof = row.hof === "TRUE" || row.hof === "true" || row.hof === "1";
    if (round > 1 && !hof) continue;
    const teamName = nflTeamName(row.team, year);
    out.push({
      id: `nflverse:draft:${year}:${pick}`,
      league: "NFL",
      year,
      round,
      overall_pick: pick,
      player_name: name,
      // An unmapped (code, season) keeps the raw code but ships as
      // single_source, so Gate B keeps it out of questions until mapped.
      team_name: teamName ?? row.team,
      college: row.college || null,
      source: "nflverse",
      source_key: `draft:${year}:${pick}`,
      source_url: "https://github.com/nflverse/nflverse-data/releases/tag/draft_picks",
      confidence: teamName ? "gold" : "single_source",
    });
  }
  return out;
}

export async function seedNflverseDraft(client: SupabaseClient, file: string, dryRun: boolean): Promise<number> {
  const rows = parseCsv(readFileSync(file, "utf8"));
  const drafts = nflverseDraftToFacts(rows);
  const total = await upsertBatch(client, "drafts", drafts, "id", dryRun);
  console.log(`nflverse-draft: ${drafts.length} picks`);
  return total;
}
