// Current-season finals from ESPN's keyless site JSON (shape verified live
// 2026-09-30 against /football/nfl/scoreboard?dates=20250928: events[] ->
// competitions[0] with venue.fullName + address.{city,state}, competitors[]
// carrying team.displayName/score/winner, status.type.completed, leaders[]
// with athlete fullNames, headlines[].shortLinkText).
//
// ESPN is unofficial and replaceable (design's source table), so every row
// lands as confidence 'single_source': visible in the warehouse and the
// fresh pool, but Gate B keeps it out of compiled questions until an
// official source (MLB statsapi / NHL api-web, P3e backlog) cross-verifies
// it. Games outside US states (Dublin, London, Mexico City) are skipped --
// no territory to fight for.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchJson } from "../lib/http.ts";
import { isStateCode } from "../lib/states.ts";
import { upsertBatch } from "../lib/db.ts";

export const ESPN_LEAGUES: Array<{ sport: string; path: string }> = [
  { sport: "NFL", path: "football/nfl" },
  { sport: "NBA", path: "basketball/nba" },
  { sport: "MLB", path: "baseball/mlb" },
  { sport: "NHL", path: "hockey/nhl" },
];

interface EspnCompetitor {
  homeAway?: string;
  winner?: boolean;
  score?: string;
  team?: { displayName?: string };
}

interface EspnEvent {
  id?: string;
  date?: string;
  season?: { year?: number };
  competitions?: Array<{
    venue?: { fullName?: string; address?: { city?: string; state?: string } };
    competitors?: EspnCompetitor[];
    status?: { type?: { completed?: boolean } };
    headlines?: Array<{ shortLinkText?: string }>;
    leaders?: Array<{ leaders?: Array<{ athlete?: { fullName?: string } }> }>;
  }>;
  status?: { type?: { completed?: boolean } };
}

export interface ScoreboardJson {
  events?: EspnEvent[];
}

/** Pure: one league's scoreboard -> facts.events rows. */
export function toEventRows(sport: string, json: ScoreboardJson): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const event of json.events ?? []) {
    const comp = event.competitions?.[0];
    const completed = comp?.status?.type?.completed ?? event.status?.type?.completed;
    if (!event.id || !comp || !completed) continue;

    const state = comp.venue?.address?.state;
    if (!isStateCode(state)) continue;

    const winner = comp.competitors?.find((c) => c.winner === true);
    const loser = comp.competitors?.find((c) => c.winner === false);
    if (!winner?.team?.displayName || !loser?.team?.displayName) continue;

    const date = event.date ? event.date.slice(0, 10) : null;
    if (!date) continue;
    const venue = comp.venue?.fullName;
    const title = `${winner.team.displayName} beat the ${loser.team.displayName} ${winner.score}-${loser.score}`
      + (venue ? ` at ${venue}` : "");

    const athletes = (comp.leaders ?? [])
      .flatMap((group) => group.leaders ?? [])
      .map((leader) => leader.athlete?.fullName)
      .filter((name): name is string => Boolean(name));

    rows.push({
      id: `espn:${event.id}`,
      sport,
      league: sport,
      event_date: date,
      year: event.season?.year ?? Number(date.slice(0, 4)),
      title,
      description: comp.headlines?.[0]?.shortLinkText ?? null,
      athletes: [...new Set(athletes)].map((name) => ({ name })),
      teams: [winner, loser].map((c) => ({
        name: c.team?.displayName,
        score: c.score,
        winner: c.winner === true,
      })),
      city: comp.venue?.address?.city ?? null,
      state,
      kind: "game",
      source: "espn",
      source_key: event.id,
      source_url: `https://www.espn.com/${sport.toLowerCase()}/game/_/gameId/${event.id}`,
      confidence: "single_source",
      as_of: date,
    });
  }
  return rows;
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

/** Yesterday's and today's finals for the four majors. */
export async function ingestEspnEvents(client: SupabaseClient, dryRun: boolean, days = 2): Promise<number> {
  const dates: string[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    dates.push(yyyymmdd(new Date(Date.now() - back * 86_400_000)));
  }
  let total = 0;
  for (const { sport, path } of ESPN_LEAGUES) {
    for (const date of dates) {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${date}`;
      const json = await fetchJson<ScoreboardJson>(url, { minIntervalMs: 1500 });
      const rows = toEventRows(sport, json);
      total += await upsertBatch(client, "events", rows, "id", dryRun);
      if (rows.length === 0) console.log(`espn ${sport} ${date}: no completed US games`);
    }
  }
  return total;
}
