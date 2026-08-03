import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, answerUntilResolved, correctAnswerFor, createTestUser } from "./helpers.ts";

type Snapshot = {
  current_user_id: string;
  group: { id: string; invite_code: string; status: string };
  season: null | { id: string; status: string };
  members: Array<{ user_id: string; display_name: string; home_state?: string | null }>;
  territories: Array<{ id: string; owner_id: string | null; hold_level: number; contested: boolean }>;
  actions_remaining: number;
};

async function snapshot(user: SupabaseClient, groupId: string): Promise<Snapshot> {
  const { data, error } = await user.rpc("group_snapshot", { p_group_id: groupId });
  if (error) throw error;
  return data as Snapshot;
}

async function begin(user: SupabaseClient, seasonId: string, territory: string, kind: string) {
  const { data, error } = await user.rpc("game_begin_action", {
    p_season_id: seasonId,
    p_territory_id: territory,
    p_action_type: kind,
    p_attack_id: null,
  });
  if (error) throw error;
  return data as { session_id: string };
}

test("full lobby-to-claim flow works for three players", async () => {
  const alice = await createTestUser("Alice");
  const bob = await createTestUser("Bob");
  const cara = await createTestUser("Cara");

  const createdGroup = await alice.rpc("create_group_v2", {
    p_name: "Engine Test League",
    p_sports: ["NFL", "MLB"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  assert.equal(createdGroup.error, null);
  const groupId = createdGroup.data as string;

  const invite = (await snapshot(alice, groupId)).group.invite_code;
  assert.equal((await bob.rpc("join_group", { p_invite_code: invite })).error, null);
  assert.equal((await cara.rpc("join_group", { p_invite_code: invite })).error, null);

  for (const [user, home] of [[alice, "WA"], [bob, "FL"], [cara, "ME"]] as const) {
    const saved = await user.rpc("set_home_state", { p_group_id: groupId, p_home_state: home });
    assert.equal(saved.error, null);
  }

  assert.equal((await alice.rpc("start_season", { p_group_id: groupId })).error, null);
  const started = await snapshot(alice, groupId);
  assert.ok(started.season, "season should exist after start_season");
  const seasonId = started.season!.id;

  // Turn semantics (confirmed by reading 20260730220000_add_playtest_turn_handoff.sql and
  // 20260802173000_stabilize_turn_scoring_questions_and_bots.sql): start_season assigns the
  // first turn to the human with the lowest color_index in test-mode groups. Members are
  // assigned color_index in join order (create_group_v2 gives the creator 0, join_group
  // increments from there), so Alice -- who created the group -- holds turn 1. The
  // enforce_test_turn_session_trigger on game_sessions blocks any non-turn-holder from
  // starting a claim/attack/home/fortify action (defenses are exempt), so only Alice may
  // call game_begin_action here; Bob and Cara never need to act in this flow.
  const home = await begin(alice, seasonId, "WA", "home");
  const result = await answerUntilResolved(alice, home.session_id);
  assert.notEqual(result.status, "failed");

  const after = await snapshot(alice, groupId);
  const wa = after.territories.find((territory) => territory.id === "WA");
  assert.equal(wa?.owner_id, after.current_user_id);
});

test("wrong answers fail a session and the correct answer is disclosed", async () => {
  const dana = await createTestUser("Dana");
  const erin = await createTestUser("Erin");
  const createdGroup = await dana.rpc("create_group_v2", {
    p_name: "Failure League",
    p_sports: ["NFL"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  const groupId = createdGroup.data as string;
  const invite = (await snapshot(dana, groupId)).group.invite_code;
  await erin.rpc("join_group", { p_invite_code: invite });
  await dana.rpc("set_home_state", { p_group_id: groupId, p_home_state: "TX" });
  await erin.rpc("set_home_state", { p_group_id: groupId, p_home_state: "NY" });
  await dana.rpc("start_season", { p_group_id: groupId });
  const seasonId = (await snapshot(dana, groupId)).season!.id;

  // Deviation from the brief: the brief's draft used a "home" action here to test the
  // failure path, but game_submit_answer (20260730082200_handoff_answer_resolution.sql)
  // special-cases action_type='home' to *always* return status 'completed' -- home ground
  // can never be lost, a wrong answer only leaves it at hold_level 1 instead of 2. That
  // action type can never produce 'failed', so it can't exercise this test's own premise.
  // Adapted to use a 'claim' action instead (on OK, adjacent to Dana's TX home per
  // territories.adjacent), which does route through the real success/fail branch.
  const session = await begin(dana, seasonId, "OK", "claim");
  const submitted = await dana.rpc("game_submit_answer", {
    p_session_id: session.session_id,
    p_answer: "definitely wrong answer xyzzy",
  });
  assert.equal(submitted.error, null);
  const outcome = submitted.data as { status: string; correct_answer?: string };
  assert.equal(outcome.status, "failed");
  assert.ok(outcome.correct_answer && outcome.correct_answer.length > 0);
});

test("a non-member cannot read another group's snapshot", async () => {
  const frank = await createTestUser("Frank");
  const grace = await createTestUser("Grace");
  const createdGroup = await frank.rpc("create_group_v2", {
    p_name: "Private League",
    p_sports: ["NBA"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  const groupId = createdGroup.data as string;
  const denied = await grace.rpc("group_snapshot", { p_group_id: groupId });
  assert.ok(denied.error, "outsider snapshot should be rejected");
});

test("correctAnswerFor helper reads the served question", async () => {
  const henry = await createTestUser("Henry");
  const iris = await createTestUser("Iris");
  const createdGroup = await henry.rpc("create_group_v2", {
    p_name: "Helper League",
    p_sports: ["NFL"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  const groupId = createdGroup.data as string;
  const invite = (await snapshot(henry, groupId)).group.invite_code;
  await iris.rpc("join_group", { p_invite_code: invite });
  await henry.rpc("set_home_state", { p_group_id: groupId, p_home_state: "OH" });
  await iris.rpc("set_home_state", { p_group_id: groupId, p_home_state: "GA" });
  await henry.rpc("start_season", { p_group_id: groupId });
  const seasonId = (await snapshot(henry, groupId)).season!.id;
  const session = await begin(henry, seasonId, "OH", "home");
  const answer = await correctAnswerFor(session.session_id);
  assert.ok(answer.length > 0);
});
