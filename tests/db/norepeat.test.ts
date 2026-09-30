// P3c-1: the lifetime no-repeat guarantee, exercised through real play.
// One player plays a home action on the same state in three different
// groups (three seasons). With exactly two question families in the state:
//   season 1 serves one family, season 2 must serve the other (the lifetime
//   ledger crosses seasons and groups), and season 3 -- every family seen --
//   must still serve something, via the season-fresh fallback, and leave a
//   pool_thin serving_event for the coverage dashboards.
// VT/NH are used by no other suite, and the state's regular bank is parked
// for the duration so the two seeded families are the whole pool.
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser } from "./helpers.ts";

const FAMILIES = ["norepeat:famA", "norepeat:famB"];

async function playHomeAction(
  alice: SupabaseClient,
  leagueName: string,
): Promise<{ familyServed: string; sessionId: string }> {
  const created = await alice.rpc("create_group_v2", {
    p_name: leagueName,
    p_sports: ["NFL"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  assert.equal(created.error, null, `create_group_v2: ${created.error?.message}`);
  const groupId = created.data as string;

  const snap = await alice.rpc("group_snapshot", { p_group_id: groupId });
  assert.equal(snap.error, null);
  const invite = (snap.data as { group: { invite_code: string } }).group.invite_code;

  const partner = await createTestUser(`NoRepeatPartner-${leagueName}`);
  assert.equal((await partner.rpc("join_group", { p_invite_code: invite })).error, null);
  assert.equal((await alice.rpc("set_home_state", { p_group_id: groupId, p_home_state: "VT" })).error, null);
  assert.equal((await partner.rpc("set_home_state", { p_group_id: groupId, p_home_state: "NH" })).error, null);
  assert.equal((await alice.rpc("start_season", { p_group_id: groupId })).error, null);

  const started = await alice.rpc("group_snapshot", { p_group_id: groupId });
  const seasonId = (started.data as { season: { id: string } }).season.id;

  const begun = await alice.rpc("game_begin_action", {
    p_season_id: seasonId,
    p_territory_id: "VT",
    p_action_type: "home",
    p_attack_id: null,
  });
  assert.equal(begun.error, null, `game_begin_action: ${begun.error?.message}`);
  const sessionId = (begun.data as { session_id: string }).session_id;

  const attempt = await admin
    .from("question_attempts")
    .select("questions(correct_answer, family_key)")
    .eq("session_id", sessionId)
    .is("answered_at", null)
    .order("served_at", { ascending: false })
    .limit(1)
    .single();
  assert.equal(attempt.error, null);
  const q = (attempt.data as unknown as { questions: { correct_answer: string; family_key: string } }).questions;

  const submitted = await alice.rpc("game_submit_answer", {
    p_session_id: sessionId,
    p_answer: q.correct_answer,
  });
  assert.equal(submitted.error, null);
  assert.equal((submitted.data as { status: string }).status, "completed", "home actions always complete");

  return { familyServed: q.family_key, sessionId };
}

test("a question family is never re-served across seasons until the pool runs dry", async (t) => {
  // Park the real VT bank so the two seeded families are the whole pool.
  const bank = await admin.from("questions").select("id").eq("territory_id", "VT").eq("active", true);
  assert.equal(bank.error, null);
  const parkedIds = (bank.data ?? []).map((row: { id: string }) => row.id);
  if (parkedIds.length) {
    await admin.from("questions").update({ active: false }).in("id", parkedIds);
  }

  const seeded = await admin
    .from("questions")
    .insert([
      { territory_id: "VT", sport: "NFL", link_type: "player", tier: 1, format: "free_fill",
        question_text: "No-repeat probe alpha?", options: [], correct_answer: "alpha",
        aliases: ["alpha"], validation_status: "approved", active: true, family_key: FAMILIES[0] },
      { territory_id: "VT", sport: "NFL", link_type: "player", tier: 1, format: "free_fill",
        question_text: "No-repeat probe beta?", options: [], correct_answer: "beta",
        aliases: ["beta"], validation_status: "approved", active: true, family_key: FAMILIES[1] },
    ])
    .select("id");
  assert.equal(seeded.error, null, `probe seed failed: ${seeded.error?.message}`);
  const probeIds = (seeded.data ?? []).map((row: { id: string }) => row.id);

  t.after(async () => {
    // Attempts reference the probes, so retire rather than delete them.
    await admin.from("questions").update({ active: false }).in("id", probeIds);
    if (parkedIds.length) {
      await admin.from("questions").update({ active: true }).in("id", parkedIds);
    }
  });

  const alice = await createTestUser("NoRepeatAlice");
  const aliceId = (await alice.auth.getUser()).data.user?.id ?? "";
  assert.ok(aliceId);

  const first = await playHomeAction(alice, "NoRepeat One");
  assert.ok(FAMILIES.includes(first.familyServed), `unexpected family: ${first.familyServed}`);

  const ledger1 = await admin
    .from("user_question_history")
    .select("family_key, times_served")
    .eq("user_id", aliceId);
  assert.equal(ledger1.error, null, "the ledger should be service-role readable");
  assert.deepEqual(
    ledger1.data,
    [{ family_key: first.familyServed, times_served: 1 }],
    "every serve lands in the lifetime ledger",
  );

  const second = await playHomeAction(alice, "NoRepeat Two");
  assert.ok(FAMILIES.includes(second.familyServed));
  assert.notEqual(
    second.familyServed,
    first.familyServed,
    "a new season in a new group must not repeat a family this player has seen",
  );

  const eventsSoFar = await admin
    .from("serving_events")
    .select("id")
    .eq("user_id", aliceId);
  assert.deepEqual(eventsSoFar.data, [], "no fallback fires while unseen families remain");

  const third = await playHomeAction(alice, "NoRepeat Three");
  assert.ok(FAMILIES.includes(third.familyServed), "an exhausted pool still serves rather than stranding play");

  const events = await admin
    .from("serving_events")
    .select("event, territory_id, detail")
    .eq("user_id", aliceId);
  assert.equal(events.error, null);
  assert.equal(events.data?.length, 1, "exactly one fallback event for the exhausted serve");
  const event = (events.data ?? [])[0] as { event: string; territory_id: string; detail: { stage: string } };
  assert.equal(event.event, "pool_thin");
  assert.equal(event.territory_id, "VT");
  assert.equal(event.detail.stage, "season_fresh");

  const ledger3 = await admin
    .from("user_question_history")
    .select("family_key, times_served")
    .eq("user_id", aliceId)
    .order("family_key");
  const counts = (ledger3.data ?? []).map((row: { family_key: string; times_served: number }) => row.times_served);
  assert.deepEqual((ledger3.data ?? []).map((r: { family_key: string }) => r.family_key).sort(), [...FAMILIES].sort());
  assert.deepEqual([...counts].sort(), [1, 2], "the re-served family increments, the other stays at one");
});

test("players cannot read the ledger or the serving trail", async () => {
  const snoop = await createTestUser("LedgerSnoop");
  for (const table of ["user_question_history", "serving_events"]) {
    const { data, error } = await snoop.from(table).select("*").limit(1);
    assert.ok(
      error !== null || (data ?? []).length === 0,
      `a signed-in player must not read ${table}`,
    );
  }
});
