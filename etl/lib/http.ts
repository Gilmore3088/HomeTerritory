// Polite HTTP for ingesters: per-host minimum interval, retry with
// exponential backoff on 429/5xx/network, JSON parsing, and a common
// User-Agent that identifies the project (Wikidata etiquette requires one).
const lastHitByHost = new Map<string, number>();

const USER_AGENT = "HomeTerritoryETL/1.0 (https://github.com/Gilmore3088/HomeTerritory; trivia facts ingestion)";

export interface FetchOptions {
  minIntervalMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const { minIntervalMs = 1100, retries = 4 } = options;
  const host = new URL(url).host;
  const waitUntil = (lastHitByHost.get(host) ?? 0) + minIntervalMs;
  const delay = waitUntil - Date.now();
  if (delay > 0) await sleep(delay);

  let attempt = 0;
  for (;;) {
    lastHitByHost.set(host, Date.now());
    let response: Response | null = null;
    let networkError: unknown = null;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...options.headers },
      });
    } catch (cause) {
      networkError = cause;
    }
    if (response?.ok) {
      return (await response.json()) as T;
    }
    const retryable = networkError !== null
      || response?.status === 429
      || (response !== null && response.status >= 500);
    if (!retryable || attempt >= retries) {
      const detail = networkError instanceof Error
        ? networkError.message
        : `HTTP ${response?.status ?? "?"}`;
      throw new Error(`fetch failed for ${host}: ${detail}`);
    }
    attempt += 1;
    await sleep(2 ** attempt * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
