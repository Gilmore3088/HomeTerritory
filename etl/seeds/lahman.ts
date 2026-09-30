// Lahman database seed (MLB history to 1871). The nightly workflow (or a
// human) downloads and unzips the Lahman CSV release, then runs
//   node --experimental-strip-types etl/run.ts lahman <dir-with-csvs>
// Parsing is pure and fixture-tested; only rows that clear the notability
// bar (HOF, an award, or a 10+ season career) become athlete facts -- the
// full People.csv is ~21k rows and most would never make a fair question.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCsv } from "../lib/csv.ts";
import { upsertBatch } from "../lib/db.ts";
import { isStateCode } from "../lib/states.ts";

export interface LahmanFiles {
  people: Record<string, string>[];
  hallOfFame: Record<string, string>[];
  awards: Record<string, string>[];
  teams: Record<string, string>[];
  batting?: Record<string, string>[];
}

export function readLahmanDir(dir: string): LahmanFiles {
  const read = (name: string) => parseCsv(readFileSync(join(dir, name), "utf8"));
  return {
    people: read("People.csv"),
    hallOfFame: read("HallOfFame.csv"),
    awards: read("AwardsPlayers.csv"),
    teams: read("Teams.csv"),
    // Optional: leaders derive from it when present (visible zero if not).
    batting: existsSync(join(dir, "Batting.csv")) ? read("Batting.csv") : [],
  };
}

const NOTABLE_AWARDS = new Set([
  "Most Valuable Player", "Cy Young Award", "Rookie of the Year",
  "Triple Crown", "World Series MVP", "All-Star Game MVP",
]);

/** Pure: Lahman tables -> warehouse rows. */
/** Pure: Batting.csv -> undisputed season HR/RBI leaders per league.
 * Stints sum (a traded player's halves combine), only the modern era
 * (1901+) and only AL/NL count, and a TIED season produces nothing:
 * validated against the full 2021 release, 34 of 267 HR seasons are
 * shared leads, and a shared lead has no single defensible answer. */
export function lahmanLeaders(
  batting: Record<string, string>[],
  names: Map<string, string>,
): Record<string, unknown>[] {
  const stats = ["HR", "RBI"] as const;
  const totals = new Map<string, Map<string, number>>();
  for (const row of batting) {
    const year = Number(row.yearID);
    if (year < 1901 || (row.lgID !== "AL" && row.lgID !== "NL")) continue;
    for (const stat of stats) {
      const key = `${stat}:${row.lgID}:${year}`;
      const perPlayer = totals.get(key) ?? new Map<string, number>();
      perPlayer.set(row.playerID, (perPlayer.get(row.playerID) ?? 0) + Number(row[stat] || 0));
      totals.set(key, perPlayer);
    }
  }
  const leaders: Record<string, unknown>[] = [];
  for (const [key, perPlayer] of totals) {
    const [stat, league, yearText] = key.split(":");
    const best = Math.max(...perPlayer.values());
    const holders = [...perPlayer.entries()].filter(([, value]) => value === best);
    if (holders.length !== 1 || best === 0) continue;
    const [playerID] = holders[0];
    leaders.push({
      id: `lahman:leader:${stat}:${league}:${yearText}`,
      scope: "season",
      league: "MLB",
      stat,
      holder_athlete_id: `lahman:${playerID}`,
      holder_name: names.get(playerID) ?? playerID,
      value: String(best),
      year_from: Number(yearText),
      year_to: Number(yearText),
      notes: league,
      source: "lahman",
      source_key: `leader:${stat}:${league}:${yearText}`,
      confidence: "gold",
    });
  }
  return leaders;
}

export function lahmanToFacts(files: LahmanFiles): {
  athletes: Record<string, unknown>[];
  awards: Record<string, unknown>[];
  seasonResults: Record<string, unknown>[];
  leaders: Record<string, unknown>[];
} {
  const inducted = new Set(
    files.hallOfFame.filter((r) => r.inducted === "Y" && r.category === "Player").map((r) => r.playerID),
  );
  const awardsByPlayer = new Map<string, Record<string, string>[]>();
  for (const row of files.awards) {
    if (!NOTABLE_AWARDS.has(row.awardID)) continue;
    const list = awardsByPlayer.get(row.playerID) ?? [];
    list.push(row);
    awardsByPlayer.set(row.playerID, list);
  }

  const names = new Map<string, string>();
  const athletes: Record<string, unknown>[] = [];
  for (const person of files.people) {
    const debutYear = person.debut ? Number(person.debut.slice(0, 4)) : null;
    const finalYear = person.finalGame ? Number(person.finalGame.slice(0, 4)) : null;
    const careerSeasons = debutYear && finalYear ? finalYear - debutYear + 1 : 0;
    const notable = inducted.has(person.playerID)
      || awardsByPlayer.has(person.playerID)
      || careerSeasons >= 10;
    const fullName = `${person.nameFirst} ${person.nameLast}`.trim();
    names.set(person.playerID, fullName);
    if (!notable || !person.nameLast) continue;
    const birthState = person.birthCountry === "USA" && isStateCode(person.birthState)
      ? person.birthState
      : null;
    athletes.push({
      id: `lahman:${person.playerID}`,
      full_name: fullName,
      birth_city: person.birthCity || null,
      birth_state: birthState,
      birth_date: person.birthYear && person.birthMonth && person.birthDay
        ? `${person.birthYear}-${person.birthMonth.padStart(2, "0")}-${person.birthDay.padStart(2, "0")}`
        : null,
      sports: ["MLB"],
      career_start: debutYear,
      career_end: finalYear,
      hall_of_fame: inducted.has(person.playerID) ? [{ hof: "National Baseball Hall of Fame" }] : [],
      source: "lahman",
      source_key: person.playerID,
      confidence: "gold",
    });
  }

  const awards: Record<string, unknown>[] = [];
  for (const [playerID, rows] of awardsByPlayer) {
    for (const row of rows) {
      const winner = names.get(playerID) ?? playerID;
      awards.push({
        id: `lahman:award:${row.awardID}:${row.yearID}:${playerID}:${row.lgID}`,
        award: row.awardID,
        league: "MLB",
        year: Number(row.yearID),
        winner_athlete_id: `lahman:${playerID}`,
        winner_name: winner,
        notes: row.lgID || null,
        source: "lahman",
        source_key: `award:${row.awardID}:${row.yearID}:${playerID}:${row.lgID}`,
        confidence: "gold",
      });
    }
  }

  const seasonResults: Record<string, unknown>[] = [];
  for (const team of files.teams) {
    const year = Number(team.yearID);
    if (!year || year < 1901) continue;
    seasonResults.push({
      id: `lahman:season:${team.yearID}:${team.teamID}`,
      league: "MLB",
      team_name: team.name,
      season: `${team.yearID}`,
      year,
      wins: Number(team.W) || null,
      losses: Number(team.L) || null,
      finish: team.Rank ? `#${team.Rank} ${team.divID || team.lgID}` : null,
      playoff_result: team.WSWin === "Y" ? "won World Series" : team.LgWin === "Y" ? "won pennant" : null,
      source: "lahman",
      source_key: `season:${team.yearID}:${team.teamID}`,
      confidence: "gold",
    });
  }

  return { athletes, awards, seasonResults, leaders: lahmanLeaders(files.batting ?? [], names) };
}

export async function seedLahman(client: SupabaseClient, dir: string, dryRun: boolean): Promise<number> {
  const files = readLahmanDir(dir);
  const { athletes, awards, seasonResults, leaders } = lahmanToFacts(files);
  let total = 0;
  total += await upsertBatch(client, "athletes", athletes, "id", dryRun);
  total += await upsertBatch(client, "awards", awards, "id", dryRun);
  total += await upsertBatch(client, "season_results", seasonResults, "id", dryRun);
  total += await upsertBatch(client, "leaders", leaders, "id", dryRun);
  console.log(`lahman: ${athletes.length} athletes, ${awards.length} awards, ${seasonResults.length} seasons, ${leaders.length} leaders`);
  return total;
}
