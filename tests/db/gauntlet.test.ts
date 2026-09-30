// P3d task 5: the daily gauntlet. One shared 5-pack per league per day,
// graded and timed server-side, bonus paid into the season score exactly
// once. The pack draws from the global bank (newest per sport), so this
// test never asserts WHICH questions were picked -- it reads the pack and
// answers by lookup, which also keeps it immune to suites that add or
// remove questions in parallel.
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser } from "./helpers.ts";

async function makeLeague(a: SupabaseClient, b: SupabaseClient) {
  const created = await a.rpc("create_group_v2", {
    p_name: "Gauntlet League",
    p_sports: ["NFL", "MLB"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  assert.equal(created.error, null, created.error?.message ?? "");
  const groupId = created.data as string;
  const snap = await a.rpc("group_snapshot", { p_group_id: groupId });
  const invite = (snap.data as { group: { invite_code: string } }).group.invite_code;
  assert.equal((await b.rpc("join_group", { p_invite_code: invite })).error, null);
  assert.equal((await a.rpc("set_home_state", { p_group_id: groupId, p_home_state: "UT" })).error, null);
  assert.equal((await b.rpc("set_home_state", { p_group_id: groupId, p_home_state: "CO" })).error, null);
  assert.equal((await a.rpc("start_season", { p_group_id: groupId })).error, null);
  const started = await a.rpc("group_snapshot", { p_group_id: groupId });
  return { groupId, seasonId: (started.data as { season: { id: string } }).season.id };
}

async function packAnswer(seasonId: string, index: number): Promise<string> {
  const pack = await admin.from("gauntlet_packs").select("question_ids").eq("season_id", seasonId).single();
  const ids = (pack.data as { question_ids: string[] }).question_ids;
  const question = await admin.from("questions").select("correct_answer").eq("id", ids[index]).single();
  return (question.data as { correct_answer: string }).correct_answer;
}

/** Runs the gauntlet to completion; wrongIndexes answer garbage instead. */
async function runGauntlet(user: SupabaseClient, seasonId: string, wrongIndexes: number[]) {
  for (let round = 0; round < 8; round += 1) {
    const next = await user.rpc("gauntlet_next", { p_season_id: seasonId });
    assert.equal(next.error, null, next.error?.message ?? "");
    const q = next.data as { index: number };
    const answer = wrongIndexes.includes(q.index)
      ? "definitely wrong xyzzy"
      : await packAnswer(seasonId, q.index);
    const graded = await user.rpc("gauntlet_answer", { p_season_id: seasonId, p_answer: answer });
    assert.equal(graded.error, null, graded.error?.message ?? "");
    const result = graded.data as { status: string; correct_count: number; of: number; bonus?: number; total_seconds?: number };
    if (result.status === "finished") return result;
  }
  throw new Error("gauntlet did not finish");
}

test("the daily gauntlet: shared pack, server grading, one-shot bonus", async (t) => {
  // The pack is the newest question per sport, so five future-dated probes
  // in five sports ARE the pack -- deterministic, and immune to suites that
  // insert or delete questions in parallel.
  const future = new Date(Date.now() + 3600_000).toISOString();
  const probes = ["NFL", "MLB", "NBA", "NHL", "CFB"].map((sport, index) => ({
    territory_id: "UT", sport, link_type: "player", tier: 1, format: "free_fill",
    question_text: `Gauntlet probe ${sport}?`, options: [], correct_answer: `answer${index}`,
    aliases: [`answer${index}`], validation_status: "approved", active: true,
    family_key: `gauntlet:${sport}`, created_at: future,
  }));
  const seeded = await admin.from("questions").insert(probes).select("id");
  assert.equal(seeded.error, null, seeded.error?.message ?? "");
  const probeIds = (seeded.data ?? []).map((row: { id: string }) => row.id);

  t.after(async () => {
    await admin.from("questions").update({ active: false }).in("id", probeIds);
  });

  const alice = await createTestUser("GauntletAlice");
  const bob = await createTestUser("GauntletBob");
  const aliceId = (await alice.auth.getUser()).data.user?.id ?? "";
  const { groupId, seasonId } = await makeLeague(alice, bob);

  await t.test("the pack materializes once, five questions, no run yet", async () => {
    const { data, error } = await alice.rpc("gauntlet_today", { p_season_id: seasonId });
    assert.equal(error, null, error?.message ?? "");
    const state = data as { size: number; my_run: unknown; leaderboard: unknown[] };
    assert.equal(state.size, 5, "the daily pack holds five questions");
    assert.equal(state.my_run, null);
    assert.deepEqual(state.leaderboard, []);

    const again = await bob.rpc("gauntlet_today", { p_season_id: seasonId });
    assert.equal((again.data as { size: number }).size, 5, "the pack is shared, not per player");
    const packs = await admin.from("gauntlet_packs").select("question_ids").eq("season_id", seasonId);
    assert.equal(packs.data?.length, 1, "exactly one pack per league per day");
    assert.deepEqual(
      [...(packs.data?.[0] as { question_ids: string[] }).question_ids].sort(),
      [...probeIds].sort(),
      "the future-dated probes are the newest per sport, so they are the pack",
    );
  });

  await t.test("a perfect run pays the bonus into the season score once", async () => {
    const before = await admin.from("player_actions").select("cumulative_score")
      .eq("season_id", seasonId).eq("user_id", aliceId).single();

    const result = await runGauntlet(alice, seasonId, []);
    assert.equal(result.of, 5);
    assert.equal(result.correct_count, 5);
    assert.equal(result.bonus, 7, "five correct plus the perfect-run bonus");

    const after = await admin.from("player_actions").select("cumulative_score")
      .eq("season_id", seasonId).eq("user_id", aliceId).single();
    assert.equal(
      (after.data as { cumulative_score: number }).cumulative_score,
      (before.data as { cumulative_score: number }).cumulative_score + 7,
    );

    const replay = await alice.rpc("gauntlet_next", { p_season_id: seasonId });
    assert.match(replay.error?.message ?? "", /already ran/);
  });

  await t.test("misses count and the leaderboard orders by score then time", async () => {
    const result = await runGauntlet(bob, seasonId, [0]);
    assert.equal(result.correct_count, 4);
    assert.equal(result.bonus, 4, "no perfect-run bonus with a miss");

    const { data } = await alice.rpc("gauntlet_today", { p_season_id: seasonId });
    const board = (data as { leaderboard: Array<{ display_name: string; correct_count: number }> }).leaderboard;
    assert.equal(board.length, 2);
    assert.equal(board[0].display_name, "GauntletAlice");
    assert.equal(board[0].correct_count, 5);
    assert.equal(board[1].display_name, "GauntletBob");
    assert.equal(board[1].correct_count, 4);
  });

  await t.test("gauntlet serves burn lifetime families; outsiders are refused", async () => {
    const history = await admin.from("user_question_history").select("family_key").eq("user_id", aliceId);
    assert.ok((history.data ?? []).length >= 5, "every gauntlet serve lands in the lifetime ledger");

    const outsider = await createTestUser("GauntletOutsider");
    const denied = await outsider.rpc("gauntlet_today", { p_season_id: seasonId });
    assert.match(denied.error?.message ?? "", /not in this group/);
    void groupId;
  });
});
