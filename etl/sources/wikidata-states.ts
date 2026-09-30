// Canonical US-state QID mapping, fetched live from Wikidata (P31 = Q35657,
// "U.S. state") and verified against the expected 50 postal codes. The
// EXPECTED map below is itself a live snapshot (2026-09-30) -- the fetch
// must agree with it exactly or the run aborts, so a vandalized or drifted
// Wikidata state list can never silently re-map the whole warehouse.
import { runSparql } from "../lib/sparql.ts";
import { stateCode } from "../lib/states.ts";

export const EXPECTED_STATE_QIDS: Record<string, string> = {
  AL: "Q173", AK: "Q797", AZ: "Q816", AR: "Q1612", CA: "Q99",
  CO: "Q1261", CT: "Q779", DE: "Q1393", FL: "Q812", GA: "Q1428",
  HI: "Q782", ID: "Q1221", IL: "Q1204", IN: "Q1415", IA: "Q1546",
  KS: "Q1558", KY: "Q1603", LA: "Q1588", ME: "Q724", MD: "Q1391",
  MA: "Q771", MI: "Q1166", MN: "Q1527", MS: "Q1494", MO: "Q1581",
  MT: "Q1212", NE: "Q1553", NV: "Q1227", NH: "Q759", NJ: "Q1408",
  NM: "Q1522", NY: "Q1384", NC: "Q1454", ND: "Q1207", OH: "Q1397",
  OK: "Q1649", OR: "Q824", PA: "Q1400", RI: "Q1387", SC: "Q1456",
  SD: "Q1211", TN: "Q1509", TX: "Q1439", UT: "Q829", VT: "Q16551",
  VA: "Q1370", WA: "Q1223", WV: "Q1371", WI: "Q1537", WY: "Q1214",
};

export function verifyStateRows(rows: Record<string, string | null>[]): Record<string, string> {
  const fetched: Record<string, string> = {};
  for (const row of rows) {
    const code = stateCode(row.stateLabel);
    if (code && row.state) fetched[code] = row.state;
  }
  const mismatches: string[] = [];
  for (const [code, expectedQid] of Object.entries(EXPECTED_STATE_QIDS)) {
    if (fetched[code] !== expectedQid) {
      mismatches.push(`${code}: expected ${expectedQid}, got ${fetched[code] ?? "missing"}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Wikidata state mapping drifted -- refusing to ingest: ${mismatches.join("; ")}`);
  }
  return fetched;
}

export async function fetchStateQids(): Promise<Record<string, string>> {
  const rows = await runSparql(`
    SELECT ?state ?stateLabel WHERE {
      ?state wdt:P31 wd:Q35657.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`);
  return verifyStateRows(rows);
}
