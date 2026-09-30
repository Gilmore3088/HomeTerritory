// P3b-3: operating gates for the generated bank -- telemetry retirement,
// the coverage map, and the starter-bank cutover. Probes live in RI, which
// no other suite plays. starter_bank_cutover acts globally, so everything
// it retires during the test is restored before the file finishes (rows it
// touches are identifiable by retired_reason = 'starter_cutover').
import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { admin } from "./helpers.ts";
import { stackUrl } from "./helpers.ts";

const factsAdmin = createClient(stackUrl, process.env.SUPABASE_TEST_SERVICE_KEY ?? "", {
  auth: { persistSession: false },
  db: { schema: "facts" },
});

test("telemetry retirement, coverage and cutover", async (t) => {
  const template = await factsAdmin.from("question_templates").select("id").limit(1).single();
  assert.equal(template.error, null, "the catalog migration should have seeded templates");
  const templateId = (template.data as { id: string }).id;

  const mk = (n: number, attempts: number, correct: number) => ({
    territory_id: "RI", sport: "NFL", link_type: "player", tier: 1, format: "free_fill",
    question_text: `Ops probe ${n}?`, options: [], correct_answer: "x", aliases: ["x"],
    validation_status: "generated_v1", active: true, family_key: `ops:fam${n}`,
    template_id: templateId, attempt_count: attempts, correct_count: correct,
  });
  const seeded = await admin
    .from("questions")
    .insert([mk(1, 30, 30), mk(2, 30, 0), mk(3, 5, 5)])
    .select("id, question_text");
  assert.equal(seeded.error, null, `probe seed failed: ${seeded.error?.message}`);
  const probeIds = (seeded.data ?? []).map((row: { id: string }) => row.id);

  t.after(async () => {
    await admin.from("questions").delete().in("id", probeIds);
  });

  await t.test("suspicious pass rates retire generated questions with a reason", async () => {
    const retired = await admin.rpc("retire_flagged_questions");
    assert.equal(retired.error, null, `retire rpc failed: ${retired.error?.message}`);
    const summary = retired.data as { retired_too_easy: number; retired_too_hard: number };
    assert.ok(summary.retired_too_easy >= 1, JSON.stringify(summary));
    assert.ok(summary.retired_too_hard >= 1, JSON.stringify(summary));

    const after = await admin
      .from("questions")
      .select("question_text, active, retired_reason")
      .in("id", probeIds)
      .order("question_text");
    const rows = (after.data ?? []) as Array<{ question_text: string; active: boolean; retired_reason: string | null }>;
    assert.deepEqual(rows, [
      { question_text: "Ops probe 1?", active: false, retired_reason: "telemetry_too_easy" },
      { question_text: "Ops probe 2?", active: false, retired_reason: "telemetry_too_hard" },
      { question_text: "Ops probe 3?", active: true, retired_reason: null },
    ], "only questions with enough attempts and an extreme rate retire");
  });

  await t.test("the coverage map counts generated and handwritten separately", async () => {
    const coverage = await admin.rpc("question_coverage");
    assert.equal(coverage.error, null, `coverage rpc failed: ${coverage.error?.message}`);
    const ri = (coverage.data as Array<{ territory_id: string; generated_active: number }>)
      .filter((row) => row.territory_id === "RI");
    const generated = ri.reduce((sum, row) => sum + Number(row.generated_active), 0);
    assert.ok(generated >= 1, "the surviving RI probe should appear as generated coverage");
  });

  await t.test("cutover retires a state's starter bank once generated coverage clears the floor", async () => {
    const cut = await admin.rpc("starter_bank_cutover", { p_floor: 1 });
    assert.equal(cut.error, null, `cutover rpc failed: ${cut.error?.message}`);
    try {
      const summary = cut.data as { states_cut_over: string[]; starter_questions_retired: number };
      assert.ok(summary.states_cut_over.includes("RI"), JSON.stringify(summary));

      const handwritten = await admin
        .from("questions")
        .select("id", { count: "exact", head: true })
        .eq("territory_id", "RI")
        .is("template_id", null)
        .eq("active", true);
      assert.equal(handwritten.count, 0, "no handwritten RI question stays active after cutover");
    } finally {
      // The rpc is global: put back every starter row it retired, across all
      // states, so parallel suites and the smoke run see the full bank.
      const restored = await admin
        .from("questions")
        .update({ active: true, retired_reason: null })
        .eq("retired_reason", "starter_cutover")
        .select("id");
      assert.equal(restored.error, null, `cutover restore failed: ${restored.error?.message}`);
    }
  });
});
