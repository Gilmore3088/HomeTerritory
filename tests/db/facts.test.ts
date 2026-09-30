// P3a leak guard: the facts warehouse (schema `facts`) feeds the question
// compiler and must never be readable by a client role. Two layers are
// asserted here, so a leak fails CI by default:
//   1. public.facts_privilege_audit() enumerates every privilege anon,
//      authenticated or PUBLIC holds on anything in the schema -- must be
//      empty. This catches a stray GRANT in any future migration.
//   2. Live probes: an anon client and a signed-in client both attempt to
//      read facts tables through the API profile; both must be refused.
//      This catches a stack whose defaults differ from the audit's model.
import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { admin, anonClient, createTestUser, stackAnonKey, stackUrl } from "./helpers.ts";

test("no client-side role holds any privilege in the facts schema", async () => {
  const { data, error } = await admin.rpc("facts_privilege_audit");
  assert.equal(error, null, "the audit helper should be callable under the service key");
  const rows = (data ?? []) as Array<{ object_kind: string; object_name: string; grantee: string; privilege: string }>;
  assert.deepEqual(
    rows,
    [],
    "these facts-schema privileges are reachable by client roles: " + JSON.stringify(rows),
  );
});

test("anon and authenticated clients cannot read facts tables through the API", async () => {
  const probes = ["athletes", "teams", "question_templates", "state_links"];

  const anon = createClient(stackUrl, stackAnonKey, {
    auth: { persistSession: false },
    db: { schema: "facts" },
  });
  for (const table of probes) {
    const { error } = await anon.from(table).select("*").limit(1);
    assert.ok(error, `anon must be refused reading facts.${table}`);
  }

  const user = await createTestUser("FactsProbe");
  const signedInSession = await user.auth.getSession();
  const token = signedInSession.data.session?.access_token ?? "";
  const authed = createClient(stackUrl, stackAnonKey, {
    auth: { persistSession: false },
    db: { schema: "facts" },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  for (const table of probes) {
    const { error } = await authed.from(table).select("*").limit(1);
    assert.ok(error, `a signed-in player must be refused reading facts.${table}`);
  }
});

test("the service role can write and read the warehouse through the facts profile", async () => {
  const factsAdmin = createClient(stackUrl, process.env.SUPABASE_TEST_SERVICE_KEY ?? "", {
    auth: { persistSession: false },
    db: { schema: "facts" },
  });
  const probeId = `test:${crypto.randomUUID()}`;
  const inserted = await factsAdmin.from("athletes").upsert({
    id: probeId,
    full_name: "Probe Athlete",
    birth_state: "WI",
    sports: ["NFL"],
    source: "test",
    source_key: probeId,
  }, { onConflict: "id" });
  assert.equal(inserted.error, null, `service-role upsert failed: ${inserted.error?.message}`);

  const read = await factsAdmin.from("athletes").select("full_name").eq("id", probeId).single();
  assert.equal(read.error, null);
  assert.equal((read.data as { full_name: string }).full_name, "Probe Athlete");

  await factsAdmin.from("athletes").delete().eq("id", probeId);
});
