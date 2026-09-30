// P3b task 4: cross-verification. Agreement between Wikidata and Lahman
// promotes both rows to cross_verified with both sources recorded;
// disagreement files a value_conflict instead; an ambiguous name (two
// plausible Lahman people) files unresolved_entity; and a second run
// changes nothing. Probe names are distinctive so no real row can match.
import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { admin, stackUrl } from "./helpers.ts";

const factsAdmin = createClient(stackUrl, process.env.SUPABASE_TEST_SERVICE_KEY ?? "", {
  auth: { persistSession: false },
  db: { schema: "facts" },
});

const IDS = ["xv:Q1", "xv:l1", "xv:Q2", "xv:l2", "xv:Q3", "xv:l3a", "xv:l3b"];

test("cross-verification promotes agreement and files disagreement", async (t) => {
  const athlete = (id: string, source: string, name: string, extra: Record<string, unknown>) => ({
    id, full_name: name, sports: ["MLB"], source, source_key: id, confidence: "gold", ...extra,
  });
  const seeded = await factsAdmin.from("athletes").upsert([
    athlete("xv:Q1", "wikidata", "Crossver Agreeson", { birth_city: "Spavinaw", birth_state: "OK", birth_date: "1931-10-20", career_start: 1951 }),
    athlete("xv:l1", "lahman", "Crossver Agreeson", { birth_city: "Spavinaw", birth_state: "OK", birth_date: "1931-10-20", career_start: 1951 }),
    athlete("xv:Q2", "wikidata", "Crossver Disputa", { birth_state: "OK", career_start: 1967 }),
    athlete("xv:l2", "lahman", "Crossver Disputa", { birth_state: "TX", career_start: 1968 }),
    athlete("xv:Q3", "wikidata", "Crossver Manyface", { birth_state: "GA", career_start: 1990 }),
    athlete("xv:l3a", "lahman", "Crossver Manyface", { birth_state: "GA", career_start: 1990 }),
    athlete("xv:l3b", "lahman", "Crossver Manyface", { birth_state: "GA", career_start: 1991 }),
  ], { onConflict: "id" });
  assert.equal(seeded.error, null, seeded.error?.message ?? "");

  const champs = await factsAdmin.from("championships").upsert([
    { id: "xv:ws1", league: "MLB", season: "1903 World Series", year: 1903,
      winner_name: "Boston Americans", source: "wikidata", source_key: "xv:ws1", confidence: "gold" },
    { id: "xv:ws2", league: "MLB", season: "1904 World Series", year: 1904,
      winner_name: "Crossver Nine", source: "wikidata", source_key: "xv:ws2", confidence: "gold" },
  ], { onConflict: "id" });
  assert.equal(champs.error, null, champs.error?.message ?? "");
  const seasons = await factsAdmin.from("season_results").upsert([
    { id: "xv:sr1", league: "MLB", team_name: "Boston Americans", season: "1903", year: 1903,
      playoff_result: "won World Series", source: "lahman", source_key: "xv:sr1", confidence: "gold" },
    { id: "xv:sr2", league: "MLB", team_name: "Different Nine", season: "1904", year: 1904,
      playoff_result: "won World Series", source: "lahman", source_key: "xv:sr2", confidence: "gold" },
  ], { onConflict: "id" });
  assert.equal(seasons.error, null, seasons.error?.message ?? "");

  t.after(async () => {
    await factsAdmin.from("fact_conflicts").delete().like("entity_id", "xv:%");
    await factsAdmin.from("athletes").delete().in("id", IDS);
    await factsAdmin.from("championships").delete().in("id", ["xv:ws1", "xv:ws2"]);
    await factsAdmin.from("season_results").delete().in("id", ["xv:sr1", "xv:sr2"]);
  });

  const first = await admin.rpc("cross_verify_facts");
  assert.equal(first.error, null, first.error?.message ?? "");
  const summary = first.data as Record<string, number>;
  assert.ok(summary.athletes_promoted >= 2, JSON.stringify(summary));
  assert.ok(summary.athletes_conflicted >= 1, JSON.stringify(summary));
  assert.ok(summary.athletes_ambiguous >= 1, JSON.stringify(summary));
  assert.ok(summary.championships_promoted >= 1, JSON.stringify(summary));
  assert.ok(summary.championships_conflicted >= 1, JSON.stringify(summary));

  await t.test("agreement carries both sources; disputes and ambiguity stay gold", async () => {
    const rows = await factsAdmin.from("athletes").select("id, confidence, verified_sources").in("id", IDS).order("id");
    const byId = new Map((rows.data as Array<{ id: string; confidence: string; verified_sources: string[] }>).map((r) => [r.id, r]));
    assert.equal(byId.get("xv:Q1")?.confidence, "cross_verified");
    assert.equal(byId.get("xv:l1")?.confidence, "cross_verified");
    assert.deepEqual(byId.get("xv:Q1")?.verified_sources, ["lahman", "wikidata"]);
    for (const id of ["xv:Q2", "xv:l2", "xv:Q3", "xv:l3a", "xv:l3b"]) {
      assert.equal(byId.get(id)?.confidence, "gold", `${id} must not be promoted`);
    }

    const conflicts = await factsAdmin.from("fact_conflicts")
      .select("entity_id, field, kind, value_a, value_b")
      .like("entity_id", "xv:%")
      .order("entity_id");
    const rowsOut = conflicts.data as Array<{ entity_id: string; field: string; kind: string; value_a: string | null; value_b: string | null }>;
    const dispute = rowsOut.find((r) => r.entity_id === "xv:Q2");
    assert.deepEqual(dispute, { entity_id: "xv:Q2", field: "birth_state", kind: "value_conflict", value_a: "OK", value_b: "TX" });
    assert.equal(rowsOut.find((r) => r.entity_id === "xv:Q3")?.kind, "unresolved_entity");
    assert.equal(rowsOut.find((r) => r.entity_id === "xv:ws2")?.kind, "value_conflict");
  });

  await t.test("world series titles cross-verify by year", async () => {
    const champ = await factsAdmin.from("championships").select("confidence").eq("id", "xv:ws1").single();
    assert.equal((champ.data as { confidence: string }).confidence, "cross_verified");
    const season = await factsAdmin.from("season_results").select("confidence").eq("id", "xv:sr1").single();
    assert.equal((season.data as { confidence: string }).confidence, "cross_verified");
  });

  await t.test("a second run is a no-op", async () => {
    const again = await admin.rpc("cross_verify_facts");
    assert.equal(again.error, null);
    const rerun = again.data as Record<string, number>;
    assert.equal(rerun.athletes_promoted, 0, JSON.stringify(rerun));
    const conflictCount = await factsAdmin.from("fact_conflicts")
      .select("id", { count: "exact", head: true })
      .like("entity_id", "xv:%");
    assert.equal(conflictCount.count, 3, "no duplicate conflicts on re-run");
  });
});
