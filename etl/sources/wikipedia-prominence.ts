// The difficulty engine's prominence signal, per the design: a weighted
// blend of Wikipedia pageviews (12-month median), Wikidata sitelinks, and
// accolades (HOF > awards > career length). Pageviews shape verified live
// 2026-09-30 (wikimedia.org/api/rest_v1/metrics/pageviews/per-article,
// monthly items[] with a PARTIAL current month that must be dropped).
// Titles resolve from QIDs at runtime via SPARQL sitelinks -- never from a
// guessed "First_Last" (disambiguation pages would poison the signal).
// Athletes with no English article simply score without the pageview
// component; the blend renormalizes.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchJson } from "../lib/http.ts";
import { runSparql } from "../lib/sparql.ts";
import { upsertBatch } from "../lib/db.ts";

export interface PageviewItem {
  timestamp: string; // YYYYMMDDHH
  views: number;
}

/** Median monthly views over up to 12 FULL months (current month dropped). */
export function medianMonthlyViews(items: PageviewItem[], now = new Date()): number | null {
  const currentMonth = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const full = items
    .filter((item) => item.timestamp.slice(0, 6) !== currentMonth)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 12)
    .map((item) => item.views)
    .sort((a, b) => a - b);
  if (full.length === 0) return null;
  const mid = Math.floor(full.length / 2);
  return full.length % 2 === 1 ? full[mid] : Math.round((full[mid - 1] + full[mid]) / 2);
}

export interface ProminenceInputs {
  pvMedian: number | null;
  sitelinks: number;
  hof: boolean;
  awardCount: number;
  careerYears: number | null;
}

/** 0..1 blend. Pageviews dominate when known; accolades anchor the floor. */
export function blendScore(inputs: ProminenceInputs): number {
  const sl = Math.min(1, Math.log10(1 + inputs.sitelinks) / 2.2);
  const acc = inputs.hof ? 1
    : inputs.awardCount > 0 ? 0.6
    : (inputs.careerYears ?? 0) >= 15 ? 0.4
    : 0.2;
  const pv = inputs.pvMedian == null ? null : Math.min(1, Math.log10(1 + inputs.pvMedian) / 5.5);
  const score = pv == null
    ? 0.6 * sl + 0.4 * acc
    : 0.5 * pv + 0.3 * sl + 0.2 * acc;
  return Math.round(score * 1000) / 1000;
}

export function titleQuery(qids: string[]): string {
  const values = qids.map((qid) => `wd:${qid}`).join(" ");
  return `SELECT ?p ?title WHERE {
  VALUES ?p { ${values} }
  ?article schema:about ?p ;
           schema:isPartOf <https://en.wikipedia.org/> ;
           schema:name ?title .
}`;
}

function monthStamp(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}0100`;
}

async function fetchMedian(title: string): Promise<number | null> {
  const end = new Date();
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 13, 1));
  const url = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/"
    + `all-access/user/${encodeURIComponent(title.replaceAll(" ", "_"))}/monthly/${monthStamp(start)}/${monthStamp(end)}`;
  try {
    const body = await fetchJson<{ items?: PageviewItem[] }>(url, { minIntervalMs: 300, retries: 2 });
    return medianMonthlyViews(body.items ?? []);
  } catch {
    // 404 = article exists but has no pageview rows in range (or vanished);
    // the athlete scores without the component.
    return null;
  }
}

interface AthleteRow {
  id: string;
  hall_of_fame: unknown[] | null;
  career_start: number | null;
  career_end: number | null;
}

/** Re-scores the stalest batch of athlete prominence rows. */
export async function scoreProminence(client: SupabaseClient, dryRun: boolean, batch = 400): Promise<number> {
  const stale = await client
    .from("prominence")
    .select("entity_id, score, signals")
    .eq("entity_type", "athlete")
    .like("entity_id", "Q%")
    .order("updated_at", { ascending: true })
    .limit(batch);
  if (stale.error) throw new Error(`reading prominence failed: ${stale.error.message}`);
  const rows = (stale.data ?? []) as Array<{ entity_id: string; signals: Record<string, unknown> | null }>;
  if (rows.length === 0) return 0;
  const ids = rows.map((row) => row.entity_id);

  const athletes = await client
    .from("athletes")
    .select("id, hall_of_fame, career_start, career_end")
    .in("id", ids);
  if (athletes.error) throw new Error(`reading athletes failed: ${athletes.error.message}`);
  const byId = new Map((athletes.data as AthleteRow[]).map((a) => [a.id, a]));

  const awardRows = await client.from("awards").select("winner_athlete_id").in("winner_athlete_id", ids);
  if (awardRows.error) throw new Error(`reading awards failed: ${awardRows.error.message}`);
  const awardCounts = new Map<string, number>();
  for (const row of (awardRows.data ?? []) as Array<{ winner_athlete_id: string }>) {
    awardCounts.set(row.winner_athlete_id, (awardCounts.get(row.winner_athlete_id) ?? 0) + 1);
  }

  const titles = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    for (const row of await runSparql(titleQuery(chunk))) {
      if (row.p && row.title) titles.set(row.p, row.title);
    }
  }

  const updates: Record<string, unknown>[] = [];
  const asOf = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    const athlete = byId.get(row.entity_id);
    if (!athlete) continue;
    const title = titles.get(row.entity_id);
    const pvMedian = title && !dryRun ? await fetchMedian(title) : null;
    const sitelinks = Number(row.signals?.wikidata_sitelinks ?? 0);
    const careerYears = athlete.career_start != null && athlete.career_end != null
      ? athlete.career_end - athlete.career_start
      : null;
    const score = blendScore({
      pvMedian,
      sitelinks,
      hof: Array.isArray(athlete.hall_of_fame) && athlete.hall_of_fame.length > 0,
      awardCount: awardCounts.get(row.entity_id) ?? 0,
      careerYears,
    });
    updates.push({
      entity_type: "athlete",
      entity_id: row.entity_id,
      score,
      signals: {
        ...(row.signals ?? {}),
        ...(pvMedian != null ? { pv_median: pvMedian, pv_as_of: asOf } : {}),
      },
      updated_at: new Date().toISOString(),
    });
  }
  return upsertBatch(client, "prominence", updates, "entity_type,entity_id", dryRun);
}
