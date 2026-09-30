// P3c-2: the human review surface. A non-reviewer is refused; a reviewer
// sees flagged questions first, and their verdicts stick: retire removes a
// question from play and the queue permanently, approve reinstates it as
// human-reviewed and resolves the Gate C flags either way. Probes live in
// CT, which no other suite touches.
import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { admin, createTestUser, stackUrl } from "./helpers.ts";

const factsAdmin = createClient(stackUrl, process.env.SUPABASE_TEST_SERVICE_KEY ?? "", {
  auth: { persistSession: false },
  db: { schema: "facts" },
});

test("review queue and verdicts", async (t) => {
  const template = await factsAdmin.from("question_templates").select("id").limit(1).single();
  assert.equal(template.error, null);
  const templateId = (template.data as { id: string }).id;

  const seeded = await admin
    .from("questions")
    .insert({
      territory_id: "CT", sport: "NFL", link_type: "player", tier: 1, format: "free_fill",
      question_text: "Review probe question?", options: [], correct_answer: "x", aliases: ["x"],
      validation_status: "generated_v1", active: true, family_key: "review:fam1", template_id: templateId,
    })
    .select("id")
    .single();
  assert.equal(seeded.error, null, `probe seed failed: ${seeded.error?.message}`);
  const questionId = (seeded.data as { id: string }).id;

  const flagged = await factsAdmin.from("fact_conflicts").insert({
    entity_type: "question", entity_id: questionId, field: "gate_c",
    kind: "gate_c_flag", detail: { issues: ["ambiguous phrasing"] },
  });
  assert.equal(flagged.error, null, `flag seed failed: ${flagged.error?.message}`);

  t.after(async () => {
    await factsAdmin.from("fact_conflicts").delete().eq("entity_id", questionId);
    await admin.from("questions").delete().eq("id", questionId);
  });

  const reviewer = await createTestUser("ReviewerRhea");
  const reviewerId = (await reviewer.auth.getUser()).data.user?.id ?? "";
  assert.ok(reviewerId);

  await t.test("a non-reviewer is refused", async () => {
    const { error } = await reviewer.rpc("review_queue", { p_limit: 5 });
    assert.ok(error, "review_queue must refuse a regular player");
    assert.match(error?.message ?? "", /Not a reviewer/);

    const decide = await reviewer.rpc("review_decide", { p_question_id: questionId, p_verdict: "retire" });
    assert.match(decide.error?.message ?? "", /Not a reviewer/);
  });

  const promoted = await admin.from("profiles").update({ is_reviewer: true }).eq("id", reviewerId).select("id");
  assert.equal(promoted.error, null);
  assert.equal(promoted.data?.length, 1, "the test user's profile row should exist");

  await t.test("flagged questions surface first with their issues", async () => {
    const { data, error } = await reviewer.rpc("review_queue", { p_limit: 20 });
    assert.equal(error, null, `queue failed: ${error?.message}`);
    const items = data as Array<{ id: string; gate_c_issues: string[][]; report_count: number }>;
    assert.ok(items.length >= 1);
    assert.equal(items[0].id, questionId, "the Gate C flagged probe outranks unflagged compiles");
    assert.deepEqual(items[0].gate_c_issues.flat(), ["ambiguous phrasing"]);
  });

  await t.test("retire removes the question from play and the queue, and resolves the flag", async () => {
    const { data, error } = await reviewer.rpc("review_decide", {
      p_question_id: questionId, p_verdict: "retire", p_note: "two defensible answers",
    });
    assert.equal(error, null, `decide failed: ${error?.message}`);
    assert.equal((data as { flags_resolved: number }).flags_resolved, 1);

    const question = await admin.from("questions").select("active, retired_reason").eq("id", questionId).single();
    assert.deepEqual(question.data, { active: false, retired_reason: "reviewer" });

    const conflict = await factsAdmin.from("fact_conflicts").select("resolution").eq("entity_id", questionId).single();
    assert.match((conflict.data as { resolution: string }).resolution, /retire by reviewer: two defensible answers/);

    const queue = await reviewer.rpc("review_queue", { p_limit: 20 });
    const ids = (queue.data as Array<{ id: string }>).map((item) => item.id);
    assert.ok(!ids.includes(questionId), "a reviewer-retired question never cycles back into the queue");
  });

  await t.test("approve reinstates as human-reviewed", async () => {
    const { error } = await reviewer.rpc("review_decide", { p_question_id: questionId, p_verdict: "approve" });
    assert.equal(error, null);
    const question = await admin
      .from("questions")
      .select("active, retired_reason, validation_status")
      .eq("id", questionId)
      .single();
    assert.deepEqual(question.data, { active: true, retired_reason: null, validation_status: "reviewed_v1" });
  });
});
