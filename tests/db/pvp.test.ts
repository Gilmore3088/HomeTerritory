// P3d: wager attacks, defender's choice, the rivalry ledger, and season
// awards, exercised through real play. Eve (home AZ) fights Finn (home NM)
// over New Mexico; AZ/NM and this file's probes are used by no other suite.
// The scenario mirrors the SQL simulation the migration was verified with.
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, correctAnswerFor, createTestUser } from "./helpers.ts";

async function makeLeague(eve: SupabaseClient, finn: SupabaseClient) {
  const created = await eve.rpc("create_group_v2", {
    p_name: "Wager League",
    p_sports: ["NFL", "MLB"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  assert.equal(created.error, null, created.error?.message ?? "");
  const groupId = created.data as string;
  const snap = await eve.rpc("group_snapshot", { p_group_id: groupId });
  const invite = (snap.data as { group: { invite_code: string } }).group.invite_code;
  assert.equal((await finn.rpc("join_group", { p_invite_code: invite })).error, null);
  assert.equal((await eve.rpc("set_home_state", { p_group_id: groupId, p_home_state: "AZ" })).error, null);
  assert.equal((await finn.rpc("set_home_state", { p_group_id: groupId, p_home_state: "NM" })).error, null);
  assert.equal((await eve.rpc("start_season", { p_group_id: groupId })).error, null);
  const started = await eve.rpc("group_snapshot", { p_group_id: groupId });
  const seasonId = (started.data as { season: { id: string } }).season.id;
  return { groupId, seasonId };
}

async function runToContested(eve: SupabaseClient, sessionId: string): Promise<string> {
  for (let round = 0; round < 5; round += 1) {
    const answer = await correctAnswerFor(sessionId);
    const { data, error } = await eve.rpc("game_submit_answer", { p_session_id: sessionId, p_answer: answer });
    assert.equal(error, null, error?.message ?? "");
    const result = data as { status: string; attack_id?: string };
    if (result.status === "contested") return result.attack_id!;
    assert.equal(result.status, "active", `attack run ended early: ${result.status}`);
  }
  throw new Error("attack run did not complete");
}

test("wager attacks, defender's choice, ledger and awards", async (t) => {
  const bank = await admin.from("questions").select("id").eq("territory_id", "NM").eq("active", true);
  const parkedIds = (bank.data ?? []).map((row: { id: string }) => row.id);
  if (parkedIds.length) await admin.from("questions").update({ active: false }).in("id", parkedIds);

  const seeded = await admin
    .from("questions")
    .insert([
      { territory_id: "NM", sport: "NFL", link_type: "player", tier: 3, format: "free_fill",
        question_text: "Wager probe gamma?", options: [], correct_answer: "gamma", aliases: ["gamma"],
        validation_status: "approved", active: true, family_key: "wager:famG" },
      { territory_id: "NM", sport: "MLB", link_type: "player", tier: 3, format: "free_fill",
        question_text: "Wager probe delta?", options: [], correct_answer: "delta", aliases: ["delta"],
        validation_status: "approved", active: true, family_key: "wager:famD" },
      { territory_id: "NM", sport: "NFL", link_type: "player", tier: 3, format: "multiple_choice",
        question_text: "Wager probe epsilon?", options: ["a", "b", "c", "d"], correct_answer: "a", aliases: ["a"],
        validation_status: "approved", active: true, family_key: "wager:famE" },
    ])
    .select("id");
  assert.equal(seeded.error, null, seeded.error?.message ?? "");
  const probeIds = (seeded.data ?? []).map((row: { id: string }) => row.id);

  t.after(async () => {
    // Attempts reference the probes, so retire rather than delete them.
    await admin.from("questions").update({ active: false }).in("id", probeIds);
    if (parkedIds.length) await admin.from("questions").update({ active: true }).in("id", parkedIds);
  });

  const eve = await createTestUser("WagerEve");
  const finn = await createTestUser("WagerFinn");
  const eveId = (await eve.auth.getUser()).data.user?.id ?? "";
  const finnId = (await finn.auth.getUser()).data.user?.id ?? "";
  const { groupId, seasonId } = await makeLeague(eve, finn);

  let wagerAttackId = "";

  await t.test("a wager spends two moves and runs tier-3 free-fill only", async () => {
    const before = await admin.from("player_actions").select("actions_remaining")
      .eq("season_id", seasonId).eq("user_id", eveId).single();
    const begun = await eve.rpc("game_begin_action", {
      p_season_id: seasonId, p_territory_id: "NM", p_action_type: "attack",
      p_attack_id: null, p_sport: null, p_wager: true,
    });
    assert.equal(begun.error, null, begun.error?.message ?? "");
    const opened = begun.data as { session_id: string; question: { format: string; tier: number } };
    assert.equal(opened.question.format, "free_fill", "a wager never serves multiple choice");

    const after = await admin.from("player_actions").select("actions_remaining")
      .eq("season_id", seasonId).eq("user_id", eveId).single();
    assert.equal(
      (after.data as { actions_remaining: number }).actions_remaining,
      (before.data as { actions_remaining: number }).actions_remaining - 2,
      "a wager costs two moves",
    );

    wagerAttackId = await runToContested(eve, opened.session_id);
    const attack = await admin.from("attacks").select("wager, tier").eq("id", wagerAttackId).single();
    assert.deepEqual(attack.data, { wager: true, tier: 3 });

    const formats = await admin
      .from("question_attempts")
      .select("questions(format)")
      .eq("session_id", opened.session_id);
    for (const row of (formats.data ?? []) as unknown as Array<{ questions: { format: string } }>) {
      assert.equal(row.questions.format, "free_fill");
    }
  });

  await t.test("defender's choice serves the chosen sport; holding a wager earns no garrison", async () => {
    const badSport = await finn.rpc("game_begin_action", {
      p_season_id: seasonId, p_territory_id: "NM", p_action_type: "defend",
      p_attack_id: wagerAttackId, p_sport: "CRICKET", p_wager: false,
    });
    assert.match(badSport.error?.message ?? "", /not in this league/);

    const begun = await finn.rpc("game_begin_action", {
      p_season_id: seasonId, p_territory_id: "NM", p_action_type: "defend",
      p_attack_id: wagerAttackId, p_sport: "MLB", p_wager: false,
    });
    assert.equal(begun.error, null, begun.error?.message ?? "");
    const opened = begun.data as { session_id: string; question: { sport: string; format: string } };
    assert.equal(opened.question.sport, "MLB", "the defender's chosen sport is served first");
    assert.equal(opened.question.format, "free_fill", "a wager defense is free-fill too");

    const submitted = await finn.rpc("game_submit_answer", {
      p_session_id: opened.session_id,
      p_answer: await correctAnswerFor(opened.session_id),
    });
    assert.equal(submitted.error, null);
    assert.equal((submitted.data as { status: string }).status, "completed");

    const territory = await admin.from("season_territories").select("hold_level, contested, owner_id")
      .eq("season_id", seasonId).eq("territory_id", "NM").single();
    assert.deepEqual(territory.data, { hold_level: 1, contested: false, owner_id: finnId },
      "holding against a wager keeps the state but earns no garrison");

    const ledger = await admin.from("pvp_ledger").select("outcome, reason, wager").eq("season_id", seasonId);
    assert.deepEqual(ledger.data, [{ outcome: "defender_held", reason: "repelled", wager: true }]);
  });

  await t.test("a lost defense writes attacker_won and flips the state", async () => {
    await admin.from("player_actions").update({ actions_remaining: 5 }).eq("season_id", seasonId);
    const begun = await eve.rpc("game_begin_action", {
      p_season_id: seasonId, p_territory_id: "NM", p_action_type: "attack",
      p_attack_id: null, p_sport: null, p_wager: false,
    });
    assert.equal(begun.error, null, begun.error?.message ?? "");
    const attackId = await runToContested(eve, (begun.data as { session_id: string }).session_id);

    const defense = await finn.rpc("game_begin_action", {
      p_season_id: seasonId, p_territory_id: "NM", p_action_type: "defend",
      p_attack_id: attackId, p_sport: null, p_wager: false,
    });
    assert.equal(defense.error, null, defense.error?.message ?? "");
    const failed = await finn.rpc("game_submit_answer", {
      p_session_id: (defense.data as { session_id: string }).session_id,
      p_answer: "definitely wrong xyzzy",
    });
    assert.equal((failed.data as { status: string }).status, "failed");

    const territory = await admin.from("season_territories").select("owner_id")
      .eq("season_id", seasonId).eq("territory_id", "NM").single();
    assert.equal((territory.data as { owner_id: string }).owner_id, eveId);

    const ledger = await admin.from("pvp_ledger").select("outcome, reason, wager")
      .eq("season_id", seasonId).order("id");
    assert.deepEqual(ledger.data, [
      { outcome: "defender_held", reason: "repelled", wager: true },
      { outcome: "attacker_won", reason: "incorrect", wager: false },
    ]);
  });

  await t.test("rivalries aggregate lifetime head-to-head for the group", async () => {
    const { data, error } = await eve.rpc("pvp_rivalries", { p_group_id: groupId });
    assert.equal(error, null, error?.message ?? "");
    const rows = data as Array<{ attacker_id: string; defender_id: string; states_taken: number; defenses_held: number; wager_fights: number }>;
    const pair = rows.find((row) => row.attacker_id === eveId && row.defender_id === finnId);
    assert.ok(pair, "the Eve→Finn rivalry should exist");
    assert.equal(pair?.states_taken, 1);
    assert.equal(pair?.defenses_held, 1);
    assert.equal(pair?.wager_fights, 1);

    const outsider = await createTestUser("WagerOutsider");
    const denied = await outsider.rpc("pvp_rivalries", { p_group_id: groupId });
    assert.match(denied.error?.message ?? "", /not in this group/);
  });

  await t.test("the season recap carries the awards block", async () => {
    await admin.from("seasons").update({ ends_at: new Date(Date.now() - 3600_000).toISOString() }).eq("id", seasonId);
    const advanced = await admin.rpc("advance_season", { p_season_id: seasonId });
    assert.equal(advanced.error, null, advanced.error?.message ?? "");

    const recap = await admin.from("season_recaps").select("recap").eq("season_id", seasonId).single();
    assert.equal(recap.error, null, "the recap should exist once the season ends");
    const awards = (recap.data as { recap: { awards: Record<string, unknown> } }).recap.awards;
    assert.deepEqual(
      awards.best_defender,
      { user_id: finnId, display_name: "WagerFinn", defenses_held: 1 },
    );
    const rivalry = awards.rivalry as { clashes: number };
    assert.equal(rivalry.clashes, 2, "both resolutions count toward the season rivalry");
  });
});
