// P3d task 3: live duels. Kim (home KS) fights Lee (home NE) over
// Nebraska; KS/NE are used by no other suite. The heart of the file is the
// race test mirroring the concurrent-attack suite: both parties submit a
// correct answer simultaneously and exactly one wins -- the duel row's
// lock is the arbiter. Consent guards, the async-defense block during an
// active duel, and the both-missed void path are covered around it.
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, correctAnswerFor, createTestUser } from "./helpers.ts";

async function makeLeague(kim: SupabaseClient, lee: SupabaseClient) {
  const created = await kim.rpc("create_group_v2", {
    p_name: "Duel League",
    p_sports: ["NFL"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  assert.equal(created.error, null, created.error?.message ?? "");
  const groupId = created.data as string;
  const snap = await kim.rpc("group_snapshot", { p_group_id: groupId });
  const invite = (snap.data as { group: { invite_code: string } }).group.invite_code;
  assert.equal((await lee.rpc("join_group", { p_invite_code: invite })).error, null);
  assert.equal((await kim.rpc("set_home_state", { p_group_id: groupId, p_home_state: "KS" })).error, null);
  assert.equal((await lee.rpc("set_home_state", { p_group_id: groupId, p_home_state: "NE" })).error, null);
  assert.equal((await kim.rpc("start_season", { p_group_id: groupId })).error, null);
  const started = await kim.rpc("group_snapshot", { p_group_id: groupId });
  return { groupId, seasonId: (started.data as { season: { id: string } }).season.id };
}

async function attackToContested(attacker: SupabaseClient, seasonId: string): Promise<string> {
  const begun = await attacker.rpc("game_begin_action", {
    p_season_id: seasonId, p_territory_id: "NE", p_action_type: "attack",
    p_attack_id: null, p_sport: null, p_wager: false,
  });
  assert.equal(begun.error, null, begun.error?.message ?? "");
  const sessionId = (begun.data as { session_id: string }).session_id;
  for (let round = 0; round < 5; round += 1) {
    const { data, error } = await attacker.rpc("game_submit_answer", {
      p_session_id: sessionId,
      p_answer: await correctAnswerFor(sessionId),
    });
    assert.equal(error, null, error?.message ?? "");
    const result = data as { status: string; attack_id?: string };
    if (result.status === "contested") return result.attack_id!;
    assert.equal(result.status, "active", `attack run ended: ${result.status}`);
  }
  throw new Error("attack run did not complete");
}

async function duelAnswerFor(attackId: string): Promise<string> {
  const duel = await admin.from("duels").select("question_id").eq("attack_id", attackId).single();
  const question = await admin.from("questions").select("correct_answer")
    .eq("id", (duel.data as { question_id: string }).question_id).single();
  return (question.data as { correct_answer: string }).correct_answer;
}

test("live duels: consent, shared question, first-correct race, void path", async (t) => {
  const kim = await createTestUser("DuelKim");
  const lee = await createTestUser("DuelLee");
  const kimId = (await kim.auth.getUser()).data.user?.id ?? "";
  const leeId = (await lee.auth.getUser()).data.user?.id ?? "";
  const { groupId, seasonId } = await makeLeague(kim, lee);

  const attackId = await attackToContested(kim, seasonId);

  await t.test("only the defender proposes, only the attacker accepts", async () => {
    const wrongProposer = await kim.rpc("duel_propose", { p_attack_id: attackId });
    assert.match(wrongProposer.error?.message ?? "", /Only the defender/);

    const proposed = await lee.rpc("duel_propose", { p_attack_id: attackId });
    assert.equal(proposed.error, null, proposed.error?.message ?? "");

    const wrongAccepter = await lee.rpc("duel_accept", { p_attack_id: attackId });
    assert.match(wrongAccepter.error?.message ?? "", /Only the attacker/);

    const accepted = await kim.rpc("duel_accept", { p_attack_id: attackId });
    assert.equal(accepted.error, null, accepted.error?.message ?? "");
  });

  await t.test("both parties see the same question; async defense is parked", async () => {
    const kimState = await kim.rpc("duel_state", { p_season_id: seasonId });
    const leeState = await lee.rpc("duel_state", { p_season_id: seasonId });
    const kimDuel = (kimState.data as Array<{ status: string; question: { text: string } }>)[0];
    const leeDuel = (leeState.data as Array<{ status: string; question: { text: string } }>)[0];
    assert.equal(kimDuel.status, "active");
    assert.equal(kimDuel.question.text, leeDuel.question.text, "one shared question for both");

    const blocked = await lee.rpc("game_begin_action", {
      p_season_id: seasonId, p_territory_id: "NE", p_action_type: "defend",
      p_attack_id: attackId, p_sport: null, p_wager: false,
    });
    assert.match(blocked.error?.message ?? "", /live duel is underway/);

    const duel = await admin.from("duels").select("question_id").eq("attack_id", attackId).single();
    const burned = await admin
      .from("user_question_history")
      .select("user_id")
      .in("user_id", [kimId, leeId])
      .eq("question_id", (duel.data as { question_id: string }).question_id);
    assert.equal((burned.data ?? []).length, 2, "the shared family burns for both players");
  });

  await t.test("simultaneous correct answers: exactly one winner", async () => {
    const answer = await duelAnswerFor(attackId);
    const [kimResult, leeResult] = await Promise.all([
      kim.rpc("duel_answer", { p_attack_id: attackId, p_answer: answer }),
      lee.rpc("duel_answer", { p_attack_id: attackId, p_answer: answer }),
    ]);
    assert.equal(kimResult.error, null, kimResult.error?.message ?? "");
    assert.equal(leeResult.error, null, leeResult.error?.message ?? "");
    const statuses = [
      (kimResult.data as { status: string }).status,
      (leeResult.data as { status: string }).status,
    ].sort();
    assert.deepEqual(statuses, ["settled", "won"], "one wins, the other learns it is settled");

    const duel = await admin.from("duels").select("status, winner_id").eq("attack_id", attackId).single();
    const winnerId = (duel.data as { status: string; winner_id: string }).winner_id;
    assert.equal((duel.data as { status: string }).status, "settled");
    assert.ok([kimId, leeId].includes(winnerId));

    const attack = await admin.from("attacks").select("status").eq("id", attackId).single();
    assert.equal((attack.data as { status: string }).status, winnerId === kimId ? "won" : "repelled");

    const territory = await admin.from("season_territories").select("owner_id, contested")
      .eq("season_id", seasonId).eq("territory_id", "NE").single();
    assert.equal((territory.data as { contested: boolean }).contested, false);
    assert.equal(
      (territory.data as { owner_id: string }).owner_id,
      winnerId === kimId ? kimId : leeId,
      "the map follows the duel verdict",
    );

    const ledger = await admin.from("pvp_ledger").select("outcome, reason").eq("season_id", seasonId);
    assert.deepEqual(ledger.data, [
      { outcome: winnerId === kimId ? "attacker_won" : "defender_held", reason: "duel" },
    ]);
  });

  await t.test("both missing voids the duel and the async path resumes", async () => {
    // Whoever lost the race attacks next, so ownership decides the cast.
    const territory = await admin.from("season_territories").select("owner_id")
      .eq("season_id", seasonId).eq("territory_id", "NE").single();
    const ownerIsKim = (territory.data as { owner_id: string }).owner_id === kimId;
    const attacker = ownerIsKim ? lee : kim;
    const defender = ownerIsKim ? kim : lee;
    if (ownerIsKim) {
      // Kim holds the test-mode turn; hand it over so Lee may attack.
      assert.equal((await kim.rpc("end_test_turn", { p_group_id: groupId })).error, null);
    }
    await admin.from("player_actions").update({ actions_remaining: 5 }).eq("season_id", seasonId);

    const attack2 = await attackToContested(attacker, seasonId);
    assert.equal((await defender.rpc("duel_propose", { p_attack_id: attack2 })).error, null);
    assert.equal((await attacker.rpc("duel_accept", { p_attack_id: attack2 })).error, null);

    const first = await defender.rpc("duel_answer", { p_attack_id: attack2, p_answer: "wrong one xyzzy" });
    assert.equal((first.data as { status: string }).status, "waiting");
    const second = await attacker.rpc("duel_answer", { p_attack_id: attack2, p_answer: "wrong two xyzzy" });
    assert.equal((second.data as { status: string }).status, "void");

    const attack = await admin.from("attacks").select("status").eq("id", attack2).single();
    assert.equal((attack.data as { status: string }).status, "contested", "a void duel changes nothing");

    const asyncDefense = await defender.rpc("game_begin_action", {
      p_season_id: seasonId, p_territory_id: "NE", p_action_type: "defend",
      p_attack_id: attack2, p_sport: null, p_wager: false,
    });
    assert.equal(asyncDefense.error, null, "the ordinary defense continues after a void duel");
    const closed = await defender.rpc("game_submit_answer", {
      p_session_id: (asyncDefense.data as { session_id: string }).session_id,
      p_answer: await correctAnswerFor((asyncDefense.data as { session_id: string }).session_id),
    });
    assert.equal((closed.data as { status: string }).status, "completed");
  });
});
