// Wikidata SPARQL helper: builds the query URL, fetches with etiquette
// headers, and flattens the verbose binding shape into plain records.
// Pure parsing lives in simplifyBindings so fixtures can test it offline.
import { fetchJson } from "./http.ts";

export const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";

export interface SparqlBinding {
  [variable: string]: { type: string; value: string; "xml:lang"?: string } | undefined;
}

export interface SparqlResponse {
  head: { vars: string[] };
  results: { bindings: SparqlBinding[] };
}

/** http://www.wikidata.org/entity/Q193390 -> Q193390 (non-entities pass through). */
export function qid(uri: string): string {
  const match = /entity\/(Q\d+)$/.exec(uri);
  return match ? match[1] : uri;
}

/** Flattens bindings to {var: string|null}, mapping entity URIs to QIDs. */
export function simplifyBindings(response: SparqlResponse): Record<string, string | null>[] {
  return response.results.bindings.map((binding) => {
    const row: Record<string, string | null> = {};
    for (const variable of response.head.vars) {
      const cell = binding[variable];
      row[variable] = cell ? (cell.type === "uri" ? qid(cell.value) : cell.value) : null;
    }
    return row;
  });
}

/** Dedupe rows that differ only through SPARQL property-path fanout. */
export function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

export async function runSparql(query: string): Promise<Record<string, string | null>[]> {
  const url = `${WIKIDATA_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const response = await fetchJson<SparqlResponse>(url, {
    minIntervalMs: 2000,
    headers: { Accept: "application/sparql-results+json" },
  });
  return simplifyBindings(response);
}
