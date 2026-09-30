// ETL harness: the one place that writes to the facts warehouse.
// Every ingester goes through logRun() (so facts.etl_runs is the audit
// trail) and upsertBatch() (chunked, idempotent by the table's conflict
// target). The client speaks the `facts` PostgREST profile with the
// service key; anon/authenticated hold zero privileges there
// (tests/db/facts.test.ts).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface EtlEnv {
  url: string;
  serviceKey: string;
  dryRun: boolean;
}

export function readEnv(): EtlEnv {
  const url = process.env.SUPABASE_URL ?? process.env.SUPABASE_TEST_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY
    ?? process.env.SUPABASE_SERVICE_ROLE_KEY
    ?? process.env.SUPABASE_TEST_SERVICE_KEY
    ?? "";
  if (!url || !serviceKey) {
    throw new Error("ETL needs SUPABASE_URL and SUPABASE_SECRET_KEY (or the SUPABASE_TEST_* pair).");
  }
  return { url, serviceKey, dryRun: process.env.ETL_DRY_RUN === "1" };
}

export function factsClient(env: EtlEnv): SupabaseClient {
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false },
    db: { schema: "facts" },
  });
}

const BATCH = 400;

export async function upsertBatch(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  dryRun = false,
): Promise<number> {
  if (rows.length === 0) return 0;
  if (dryRun) {
    console.log(`[dry-run] ${table}: would upsert ${rows.length} rows (conflict: ${onConflict})`);
    return rows.length;
  }
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await client.from(table).upsert(chunk, { onConflict, ignoreDuplicates: false });
    if (error) throw new Error(`${table} upsert failed at offset ${i}: ${error.message}`);
    written += chunk.length;
  }
  return written;
}

/** Wraps an ingester so every run lands in facts.etl_runs, success or not. */
export async function logRun(
  client: SupabaseClient,
  source: string,
  dryRun: boolean,
  work: () => Promise<number>,
): Promise<number> {
  if (dryRun) {
    const rows = await work();
    console.log(`[dry-run] ${source}: ${rows} rows`);
    return rows;
  }
  const started = await client
    .from("etl_runs")
    .insert({ source })
    .select("id")
    .single();
  if (started.error) throw new Error(`could not open etl_run for ${source}: ${started.error.message}`);
  const runId = (started.data as { id: string }).id;
  try {
    const rows = await work();
    await client.from("etl_runs").update({
      finished_at: new Date().toISOString(),
      rows_upserted: rows,
      ok: true,
    }).eq("id", runId);
    console.log(`${source}: upserted ${rows} rows`);
    return rows;
  } catch (cause) {
    await client.from("etl_runs").update({
      finished_at: new Date().toISOString(),
      ok: false,
      error: cause instanceof Error ? cause.message.slice(0, 2000) : String(cause),
    }).eq("id", runId);
    throw cause;
  }
}
