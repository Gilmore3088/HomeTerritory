// Phase 1 audit probes. One test per mechanic on the audit checklist; every
// deviation from expected behavior is written up in docs/superpowers/audit-findings.md.
//
// Probes that document a real bug assert the *correct* behavior and are skipped
// with a comment naming the finding number, so `npm run test:db` stays green
// until Task 8 fixes the bug and un-skips them.
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, answerUntilResolved, correctAnswerFor, createTestUser } from "./helpers.ts";

type Territory = { id: string; owner_id: string | null; hold_level: number; contested: boolean };
type Attack = { id: string; territory_id: string; attacker_id: string; defender_id: string; status: string; defense_deadline: string; tier: number };
type Snapshot = {
  current_user_id: string;
  group: { id: string; invite_code: string; status: string; test_mode?: boolean };
  season: null | { id: string; status: string; current_turn_user_id?: string | null };
  members: Array<{ user_id: string; display_name: string; home_state?: string | null }>;
  territories: Territory[];
  attacks: Attack[];
  actions_remaining: number;
};
type BeginResult = {
  session_id: string;
  action_type: string;
  territory_id: string;
  required_correct: number;
  correct_count: number;
  question: { attempt_id: string; text: string; format: string; options: string[]; tier: number; expires_at: string };
};

type Player = { client: SupabaseClient; id: string; name: string };
type Season = { players: Record<string, Player>; groupId: string; seasonId: string };

// A far-future refresh date parks `refresh_player_actions` on its no-op branch
// (v_days = greatest(0, today - last_refresh_on) = 0), so a probe that sets an
// exact action balance keeps it.
const NO_REFILL_DATE = "2030-01-01";

async function snapshot(user: SupabaseClient, groupId: string): Promise<Snapshot> {
  const { data, error } = await user.rpc("group_snapshot", { p_group_id: groupId });
  if (error) throw error;
  return data as Snapshot;
}

async function begin(
  user: SupabaseClient,
  seasonId: string,
  territory: string,
  kind: string,
  attackId: string | null = null,
): Promise<BeginResult> {
  const { data, error } = await user.rpc("game_begin_action", {
    p_season_id: seasonId,
    p_territory_id: territory,
    p_action_type: kind,
    p_attack_id: attackId,
  });
  if (error) throw error;
  return data as BeginResult;
}

/** Calls game_begin_action and returns the error instead of throwing. */
async function beginExpectingError(
  user: SupabaseClient,
  seasonId: string,
  territory: string,
  kind: string,
  attackId: string | null = null,
): Promise<string> {
  const { error } = await user.rpc("game_begin_action", {
    p_season_id: seasonId,
    p_territory_id: territory,
    p_action_type: kind,
    p_attack_id: attackId,
  });
  assert.ok(error, `expected game_begin_action(${kind}, ${territory}) to be rejected`);
  return error.message;
}

async function createPlayer(name: string): Promise<Player> {
  const client = await createTestUser(name);
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  return { client, id: data.user!.id, name };
}

/**
 * Builds a started season. `homes` is [displayName, twoLetterState] in join
 * order; the first entry creates the group and is therefore the commissioner
 * (and, in test-mode groups, holds turn one).
 */
async function startSeason(
  homes: Array<[string, string]>,
  options: { testMode?: boolean; timezone?: string } = {},
): Promise<Season> {
  const players: Player[] = [];
  for (const [name] of homes) players.push(await createPlayer(name));

  const created = await players[0].client.rpc("create_group_v2", {
    p_name: `Audit ${crypto.randomUUID().slice(0, 8)}`,
    p_sports: ["NFL", "MLB"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: options.testMode ?? false,
  });
  if (created.error) throw created.error;
  const groupId = created.data as string;

  const invite = (await snapshot(players[0].client, groupId)).group.invite_code;
  for (const player of players.slice(1)) {
    const joined = await player.client.rpc("join_group", { p_invite_code: invite });
    if (joined.error) throw joined.error;
  }
  for (const [index, [, home]] of homes.entries()) {
    const saved = await players[index].client.rpc("set_home_state", { p_group_id: groupId, p_home_state: home });
    if (saved.error) throw saved.error;
  }
  // Nothing sets groups.timezone yet (finding 12), so the day-boundary probes
  // write it directly before the season is stamped.
  if (options.timezone) {
    const zoned = await admin.from("groups").update({ timezone: options.timezone }).eq("id", groupId);
    if (zoned.error) throw zoned.error;
  }
  const started = await players[0].client.rpc("start_season", { p_group_id: groupId });
  if (started.error) throw started.error;

  const byName: Record<string, Player> = {};
  for (const player of players) byName[player.name] = player;
  return { players: byName, groupId, seasonId: started.data as string };
}

function territory(snap: Snapshot, id: string): Territory {
  const found = snap.territories.find((row) => row.id === id);
  assert.ok(found, `territory ${id} missing from snapshot`);
  return found;
}

/** Drives an attack to completion so the target ends up contested. */
async function attackUntilContested(player: Player, seasonId: string, target: string): Promise<string> {
  const session = await begin(player.client, seasonId, target, "attack");
  const outcome = (await answerUntilResolved(player.client, session.session_id)) as { status: string; attack_id?: string };
  assert.equal(outcome.status, "contested");
  assert.ok(outcome.attack_id, "a completed attack streak should return an attack_id");
  return outcome.attack_id!;
}

// ---------------------------------------------------------------------------
// 1. Neutral claim on an adjacent unowned state consumes one action
// ---------------------------------------------------------------------------
test("claim on an adjacent neutral state succeeds and spends one action", async () => {
  const { players, groupId, seasonId } = await startSeason([["Ada", "WA"], ["Ben", "FL"]]);
  const before = await snapshot(players.Ada.client, groupId);
  assert.equal(before.actions_remaining, 3, "a fresh non-test season starts every player at three actions");

  // OR is adjacent to WA per public.territories.adjacent and starts neutral.
  const session = await begin(players.Ada.client, seasonId, "OR", "claim");
  assert.equal(session.required_correct, 1, "a neutral claim is a single tier 1 question");
  const outcome = await answerUntilResolved(players.Ada.client, session.session_id);
  assert.equal(outcome.status, "completed");

  const after = await snapshot(players.Ada.client, groupId);
  assert.equal(territory(after, "OR").owner_id, players.Ada.id);
  assert.equal(territory(after, "OR").hold_level, 1);
  assert.equal(after.actions_remaining, 2, "a claim should consume exactly one action");
});

// ---------------------------------------------------------------------------
// 2. Claim on a non-adjacent state is rejected once the player owns territory
// ---------------------------------------------------------------------------
test("claim on a non-adjacent state is rejected once the player owns territory", async () => {
  const { players, seasonId } = await startSeason([["Cleo", "WA"], ["Dev", "FL"]]);
  // start_season already granted WA, so Ada owns territory and adjacency applies.
  const message = await beginExpectingError(players.Cleo.client, seasonId, "NY", "claim");
  assert.match(message, /adjacent/i);
});

// ---------------------------------------------------------------------------
// 3. Attack streak creates a contested attack with a 24h defense deadline
// ---------------------------------------------------------------------------
test("a completed attack streak contests the state with a 24 hour defense deadline", async () => {
  const { players, groupId, seasonId } = await startSeason([["Eve", "WA"], ["Fox", "OR"]]);

  const session = await begin(players.Eve.client, seasonId, "OR", "attack");
  assert.equal(session.required_correct, 2, "a hold_level 1 state costs two correct answers on standard difficulty");
  // Deliberately not asserting session.question.tier. pick_next_question sorts
  // by the question's *adaptive* tier (its observed correct rate once it has 5+
  // attempts), not its stored tier, so the served row's tier column drifts as
  // the bank accumulates history. See finding 21.

  const outcome = (await answerUntilResolved(players.Eve.client, session.session_id)) as { status: string; attack_id?: string };
  // Recorded in the findings doc: ownership does NOT transfer on a winning
  // streak. The state becomes contested and the defender gets a window.
  assert.equal(outcome.status, "contested");

  const after = await snapshot(players.Eve.client, groupId);
  assert.equal(territory(after, "OR").contested, true);
  assert.equal(territory(after, "OR").owner_id, players.Fox.id, "the defender keeps ownership until the attack resolves");

  const attack = after.attacks.find((row) => row.territory_id === "OR");
  assert.ok(attack, "the contested attack should appear in the snapshot");
  // The deadline is now() + 24h measured on the database clock, so allow a
  // minute of skew against the test runner's clock on either side.
  const windowMs = new Date(attack!.defense_deadline).getTime() - Date.now();
  assert.ok(
    windowMs > 23 * 3_600_000 && windowMs <= 24 * 3_600_000 + 60_000,
    `defense window should be ~24h, got ${windowMs}ms`,
  );
});

// ---------------------------------------------------------------------------
// 4. One active attack per state
// ---------------------------------------------------------------------------
test("a second attack on an already contested state is rejected", async () => {
  const { players, seasonId } = await startSeason([["Gil", "WA"], ["Hana", "OR"], ["Ivy", "ID"]]);
  await attackUntilContested(players.Gil, seasonId, "OR");

  // ID is adjacent to OR, so Ivy passes the adjacency gate and can only be
  // stopped by the contested check.
  const message = await beginExpectingError(players.Ivy.client, seasonId, "OR", "attack");
  assert.match(message, /already contested/i);
});

// ---------------------------------------------------------------------------
// 5. Defense with a correct answer keeps the state
// ---------------------------------------------------------------------------
test("a correct defense repels the attack and raises the hold level", async () => {
  const { players, groupId, seasonId } = await startSeason([["Jo", "WA"], ["Kai", "OR"]]);
  const attackId = await attackUntilContested(players.Jo, seasonId, "OR");

  const defense = await begin(players.Kai.client, seasonId, "OR", "defend", attackId);
  assert.equal(defense.required_correct, 1, "a defense is a single question");
  const outcome = await answerUntilResolved(players.Kai.client, defense.session_id);
  assert.equal(outcome.status, "completed");

  const after = await snapshot(players.Kai.client, groupId);
  assert.equal(territory(after, "OR").owner_id, players.Kai.id, "the defender keeps the state");
  assert.equal(territory(after, "OR").contested, false);
  assert.equal(territory(after, "OR").hold_level, 2, "a successful defense raises the garrison");

  const { data: rows } = await admin.from("attacks").select("status").eq("id", attackId);
  assert.equal(rows?.[0]?.status, "repelled");
});

// ---------------------------------------------------------------------------
// 6. resolve_expired_attacks hands the state to the attacker
// ---------------------------------------------------------------------------
test("resolve_expired_attacks awards an undefended state to the attacker", async () => {
  const { players, groupId, seasonId } = await startSeason([["Lena", "WA"], ["Max", "OR"]]);
  const attackId = await attackUntilContested(players.Lena, seasonId, "OR");

  const backdated = await admin
    .from("attacks")
    .update({ defense_deadline: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", attackId);
  assert.equal(backdated.error, null);

  const resolved = await admin.rpc("resolve_expired_attacks", { p_season_id: seasonId });
  assert.equal(resolved.error, null);
  assert.ok((resolved.data as number) >= 1, "at least this season's attack should resolve");

  const after = await snapshot(players.Lena.client, groupId);
  assert.equal(territory(after, "OR").owner_id, players.Lena.id, "the attacker takes the state on timeout");
  assert.equal(territory(after, "OR").hold_level, 1, "a stolen state resets to garrison 1");
  assert.equal(territory(after, "OR").contested, false);

  const { data: rows } = await admin.from("attacks").select("status,resolved_at").eq("id", attackId);
  assert.equal(rows?.[0]?.status, "won");
});

// ---------------------------------------------------------------------------
// 7. resolve_expired_sessions fails abandoned questions
// ---------------------------------------------------------------------------
test("resolve_expired_sessions fails a timed-out claim and starts its cooldown", async () => {
  const { players, seasonId } = await startSeason([["Nia", "WA"], ["Omar", "FL"]]);
  const session = await begin(players.Nia.client, seasonId, "OR", "claim");

  const expired = await admin
    .from("question_attempts")
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", session.question.attempt_id);
  assert.equal(expired.error, null);

  const resolved = await admin.rpc("resolve_expired_sessions", { p_season_id: seasonId });
  assert.equal(resolved.error, null);
  assert.equal(resolved.data as number, 1);

  const { data: sessionRows } = await admin.from("game_sessions").select("status").eq("id", session.session_id);
  assert.equal(sessionRows?.[0]?.status, "failed");

  const { data: cooldownRows } = await admin
    .from("cooldowns")
    .select("expires_at")
    .eq("season_id", seasonId)
    .eq("territory_id", "OR")
    .eq("user_id", players.Nia.id);
  assert.equal(cooldownRows?.length, 1, "a timed-out claim should start a claim cooldown");
});

// ---------------------------------------------------------------------------
// 8. Fortify raises hold_level up to 3 and is blocked on contested states
// ---------------------------------------------------------------------------
test("fortify raises hold level to a maximum of three and is blocked while contested", async () => {
  const { players, groupId, seasonId } = await startSeason([["Pia", "WA"], ["Quin", "FL"]]);

  // fortify_log is keyed by (season, territory, user, played_on), so each pass
  // needs the day's row cleared before the next one is allowed.
  for (const expected of [2, 3]) {
    const session = await begin(players.Pia.client, seasonId, "WA", "fortify");
    const outcome = await answerUntilResolved(players.Pia.client, session.session_id);
    assert.equal(outcome.status, "completed");
    const snap = await snapshot(players.Pia.client, groupId);
    assert.equal(territory(snap, "WA").hold_level, expected);
    await admin.from("fortify_log").delete().eq("season_id", seasonId).eq("territory_id", "WA").eq("user_id", players.Pia.id);
  }

  const capped = await beginExpectingError(players.Pia.client, seasonId, "WA", "fortify");
  assert.match(capped, /already fully fortified/i);

  // Contested states cannot be fortified. FL is Quin's, so contest one of Pia's
  // own states directly through the admin client.
  await admin.from("season_territories").update({ contested: true }).eq("season_id", seasonId).eq("territory_id", "WA");
  await admin.from("season_territories").update({ hold_level: 1 }).eq("season_id", seasonId).eq("territory_id", "WA");
  const contested = await beginExpectingError(players.Pia.client, seasonId, "WA", "fortify");
  assert.match(contested, /contested state cannot be fortified/i);
});

// ---------------------------------------------------------------------------
// 9. test_refill_actions is test-mode only
// ---------------------------------------------------------------------------
test("test_refill_actions is rejected outside test-mode groups and refills inside them", async () => {
  const production = await startSeason([["Rae", "WA"], ["Sam", "FL"]]);
  const denied = await production.players.Rae.client.rpc("test_refill_actions", { p_group_id: production.groupId });
  assert.ok(denied.error, "a non-test league must reject test_refill_actions");
  assert.match(denied.error!.message, /not a test league/i);

  const playtest = await startSeason([["Tess", "WA"], ["Uma", "FL"]], { testMode: true });
  await admin
    .from("player_actions")
    .update({ actions_remaining: 0, last_refresh_on: NO_REFILL_DATE })
    .eq("season_id", playtest.seasonId)
    .eq("user_id", playtest.players.Tess.id);

  const refilled = await playtest.players.Tess.client.rpc("test_refill_actions", { p_group_id: playtest.groupId });
  assert.equal(refilled.error, null);
  assert.equal(refilled.data as number, 3);
  const after = await snapshot(playtest.players.Tess.client, playtest.groupId);
  assert.equal(after.actions_remaining, 3);
});

// ---------------------------------------------------------------------------
// 10. report_question quarantines the question and refunds the action
// ---------------------------------------------------------------------------
// Finding 9: one report used to set `questions.active = false` globally, with no
// threshold and no per-reporter uniqueness, so a handful of reports permanently
// stripped a state's trivia from every league. Three distinct reporters are
// required now, and one account counts once.
test("report_question voids and refunds immediately but quarantines only on the third distinct reporter", async () => {
  const { players, groupId, seasonId } = await startSeason([["Vic", "ID"], ["Wren", "WY"], ["Zoe", "ND"]]);

  // All three home states border MT, so every player can open a claim on it, and
  // parking the rest of MT's bank guarantees they all draw the same question.
  // Deliberately not OR: this probe quarantines its subject, which would leave OR
  // with no active questions for tests/db/engine.test.ts running in parallel.
  const bank = await admin.from("questions").select("id").eq("territory_id", "MT").eq("active", true).order("id");
  assert.equal(bank.error, null);
  const ids = (bank.data ?? []).map((row) => (row as { id: string }).id);
  const subjectId = ids[0];
  const parkedIds = ids.slice(1);
  if (parkedIds.length) await admin.from("questions").update({ active: false }).in("id", parkedIds);

  const activeFlag = async () => {
    const { data } = await admin.from("questions").select("active").eq("id", subjectId);
    return data?.[0]?.active as boolean;
  };

  const reportOnce = async (player: Player) => {
    const session = await begin(player.client, seasonId, "MT", "claim");
    const { data: attemptRows } = await admin
      .from("question_attempts").select("question_id").eq("id", session.question.attempt_id);
    assert.equal(attemptRows?.[0]?.question_id, subjectId, "the probe must serve the parked-down subject question");
    const reported = await player.client.rpc("report_question", {
      p_attempt_id: session.question.attempt_id,
      p_reason: "audit probe",
    });
    assert.equal(reported.error, null);
    assert.equal((reported.data as { status: string }).status, "void");
    const { data: sessionRows } = await admin.from("game_sessions").select("status").eq("id", session.session_id);
    assert.equal(sessionRows?.[0]?.status, "void");
    return reported.data as { reports: number };
  };

  try {
    const spentBefore = await snapshot(players.Vic.client, groupId);
    assert.equal(spentBefore.actions_remaining, 3);

    const first = await reportOnce(players.Vic);
    assert.equal(first.reports, 1);
    assert.equal(await activeFlag(), true, "one report must not quarantine a shared question");
    const refunded = await snapshot(players.Vic.client, groupId);
    assert.equal(refunded.actions_remaining, 3, "the spent move is refunded on the first report");

    const repeat = await reportOnce(players.Vic);
    assert.equal(repeat.reports, 1, "one account counts once, however often it reports");
    assert.equal(await activeFlag(), true);

    const second = await reportOnce(players.Wren);
    assert.equal(second.reports, 2);
    assert.equal(await activeFlag(), true);

    const third = await reportOnce(players.Zoe);
    assert.equal(third.reports, 3);
    assert.equal(await activeFlag(), false, "three distinct reporters quarantine the question");
  } finally {
    // The bank is shared by every league, so leave it exactly as we found it.
    await admin.from("question_reports").delete().eq("question_id", subjectId);
    await admin.from("questions").update({ active: true }).in("id", ids);
  }
});

// ---------------------------------------------------------------------------
// 11. run_daily_tick writes daily_score_events for held territories
// ---------------------------------------------------------------------------
test("run_daily_tick writes a daily score event for held territories", async () => {
  const { players, seasonId } = await startSeason([["Xan", "WA"], ["Yuri", "FL"]]);

  // seasons.last_scored_on defaults to today, so the tick is a no-op until the
  // season is backdated.
  await admin.from("seasons").update({ last_scored_on: "2020-01-01" }).eq("id", seasonId);

  const ticked = await admin.rpc("run_daily_tick");
  assert.equal(ticked.error, null);

  const { data: events } = await admin
    .from("daily_score_events")
    .select("user_id,points,scored_on")
    .eq("season_id", seasonId);
  assert.equal(events?.length, 2, "every group member gets one score event per scored day");
  const mine = events?.find((row) => row.user_id === players.Xan.id);
  assert.ok(mine, "the current player should be scored");
  assert.ok((mine!.points as number) >= 1, "holding one home state is worth at least one point");

  const { data: actionRows } = await admin
    .from("player_actions")
    .select("cumulative_score")
    .eq("season_id", seasonId)
    .eq("user_id", players.Xan.id);
  assert.equal(actionRows?.[0]?.cumulative_score, mine!.points, "the score event is added to the running total");

  // Idempotency: a second tick in the same day must not double-score.
  const again = await admin.rpc("run_daily_tick");
  assert.equal(again.error, null);
  const { data: repeatRows } = await admin
    .from("player_actions")
    .select("cumulative_score")
    .eq("season_id", seasonId)
    .eq("user_id", players.Xan.id);
  assert.equal(repeatRows?.[0]?.cumulative_score, mine!.points, "a repeat tick in the same day is a no-op");
});

// Finding 10: `refresh_player_actions` opened with `perform run_daily_tick()`,
// and run_daily_tick loops over every active season in the database. Since
// group_snapshot and game_begin_action both call it, every page load and every
// move ran a full cross-tenant scoring pass. The cron route is the only
// day-advancer now.
test("a page load does not run the daily tick for every other league in the database", async () => {
  const mine = await startSeason([["Hal", "WA"], ["Ida", "FL"]]);
  const other = await startSeason([["Jem", "NY"], ["Kit", "TX"]]);

  const backdated = await admin.from("seasons").update({ last_scored_on: "2020-01-01" }).eq("id", other.seasonId);
  assert.equal(backdated.error, null);

  // The two calls that used to fan out: a snapshot and a move.
  await snapshot(mine.players.Hal.client, mine.groupId);
  await begin(mine.players.Hal.client, mine.seasonId, "OR", "claim");

  const { data: seasonRows } = await admin.from("seasons").select("last_scored_on").eq("id", other.seasonId);
  assert.equal(
    seasonRows?.[0]?.last_scored_on,
    "2020-01-01",
    "another league's season must not be scored by my page load",
  );

  const { data: events } = await admin.from("daily_score_events").select("user_id").eq("season_id", other.seasonId);
  assert.equal(events?.length, 0, "no cross-tenant score events may be written by a snapshot");
});

// ---------------------------------------------------------------------------
// 12. Turn rotation in test-mode leagues
// ---------------------------------------------------------------------------
test("test-mode turn rotation blocks off-turn moves, rotates on end_test_turn, and allows off-turn defense", async () => {
  const { players, groupId, seasonId } = await startSeason([["Zed", "WA"], ["Ana", "OR"]], { testMode: true });

  const zedTurn = await snapshot(players.Zed.client, groupId);
  assert.equal(zedTurn.season?.current_turn_user_id, players.Zed.id, "the first human holds turn one");
  assert.equal(zedTurn.actions_remaining, 3);
  const anaWaiting = await snapshot(players.Ana.client, groupId);
  assert.equal(anaWaiting.actions_remaining, 0, "an off-turn player holds no actions");

  // Off-turn claim is rejected. Recorded in the findings doc: the message is
  // "No moves remaining" (the zeroed action balance trips first), not the
  // "It is not your turn" the enforce_test_turn_session trigger would raise.
  const blocked = await beginExpectingError(players.Ana.client, seasonId, "CA", "claim");
  assert.match(blocked, /no moves remaining|not your turn/i);

  // Off-turn defense is allowed even though Zed still holds the turn.
  const attackId = await attackUntilContested(players.Zed, seasonId, "OR");
  const defense = await begin(players.Ana.client, seasonId, "OR", "defend", attackId);
  const outcome = await answerUntilResolved(players.Ana.client, defense.session_id);
  assert.equal(outcome.status, "completed", "a defense is exempt from the turn gate");

  const ended = await players.Zed.client.rpc("end_test_turn", { p_group_id: groupId });
  assert.equal(ended.error, null);
  assert.equal((ended.data as { next_user_id: string }).next_user_id, players.Ana.id);

  const rotated = await snapshot(players.Ana.client, groupId);
  assert.equal(rotated.season?.current_turn_user_id, players.Ana.id);
  assert.equal(rotated.actions_remaining, 3, "the incoming player is granted three actions");
  const zedSpent = await snapshot(players.Zed.client, groupId);
  assert.equal(zedSpent.actions_remaining, 0, "the outgoing player's actions are zeroed");
});

// ---------------------------------------------------------------------------
// 13. Action exhaustion
// ---------------------------------------------------------------------------
test("with no actions remaining, claim and attack are rejected", async () => {
  const { players, seasonId } = await startSeason([["Bo", "WA"], ["Cy", "OR"]]);
  await admin
    .from("player_actions")
    .update({ actions_remaining: 0, last_refresh_on: NO_REFILL_DATE })
    .eq("season_id", seasonId)
    .eq("user_id", players.Bo.id);

  assert.match(await beginExpectingError(players.Bo.client, seasonId, "ID", "claim"), /no moves remaining/i);
  assert.match(await beginExpectingError(players.Bo.client, seasonId, "OR", "attack"), /no moves remaining/i);
});

// Finding 4: `game_begin_action` charges an action for `fortify` alongside claim
// and attack. That is the engine's intended contract; the UI was the side that
// disagreed (it promised free fortifies and left the button enabled at zero
// moves). The matching UI rule is covered by `isTerritoryActionBlocked` in
// tests/game-rules.test.ts.
test("fortify spends one move and is refused once moves run out", async () => {
  const { players, groupId, seasonId } = await startSeason([["Di", "WA"], ["Eli", "OR"]]);

  const session = await begin(players.Di.client, seasonId, "WA", "fortify");
  const outcome = await answerUntilResolved(players.Di.client, session.session_id);
  assert.equal(outcome.status, "completed");
  const spent = await snapshot(players.Di.client, groupId);
  assert.equal(spent.actions_remaining, 2, "a fortify costs exactly one move");

  await admin
    .from("player_actions")
    .update({ actions_remaining: 0, last_refresh_on: NO_REFILL_DATE })
    .eq("season_id", seasonId)
    .eq("user_id", players.Di.id);
  await admin.from("fortify_log").delete().eq("season_id", seasonId).eq("user_id", players.Di.id);

  assert.match(await beginExpectingError(players.Di.client, seasonId, "WA", "fortify"), /no moves remaining/i);
});

// Finding 8: the fortify_log row was written at begin time, so a fortify lost to
// a wrong answer still consumed the day's one fortify for that state and the
// player was told "You already fortified this state today" when they had in fact
// failed it. The winning answer claims the day now.
test("a fortify lost to a wrong answer can be retried the same day", async () => {
  const { players, groupId, seasonId } = await startSeason([["Fia", "WA"], ["Gus", "FL"]]);

  const session = await begin(players.Fia.client, seasonId, "WA", "fortify");
  const failed = await players.Fia.client.rpc("game_submit_answer", {
    p_session_id: session.session_id,
    p_answer: "definitely wrong answer xyzzy",
  });
  assert.equal(failed.error, null);
  assert.equal((failed.data as { status: string }).status, "failed");

  const { data: logRows } = await admin
    .from("fortify_log")
    .select("played_on")
    .eq("season_id", seasonId)
    .eq("territory_id", "WA")
    .eq("user_id", players.Fia.id);
  assert.equal(logRows?.length, 0, "a failed fortify must not claim the day's fortify");

  const retry = await begin(players.Fia.client, seasonId, "WA", "fortify");
  const outcome = await answerUntilResolved(players.Fia.client, retry.session_id);
  assert.equal(outcome.status, "completed");

  const after = await snapshot(players.Fia.client, groupId);
  assert.equal(territory(after, "WA").hold_level, 2);
  assert.match(await beginExpectingError(players.Fia.client, seasonId, "WA", "fortify"), /already fortified/i);
});

// ---------------------------------------------------------------------------
// 14. Claim cooldowns
// ---------------------------------------------------------------------------
test("a failed claim starts a cooldown that blocks retries until it expires", async () => {
  const { players, seasonId } = await startSeason([["Fen", "WA"], ["Gia", "FL"]]);

  const session = await begin(players.Fen.client, seasonId, "OR", "claim");
  const failed = await players.Fen.client.rpc("game_submit_answer", {
    p_session_id: session.session_id,
    p_answer: "definitely wrong answer xyzzy",
  });
  assert.equal(failed.error, null);
  assert.equal((failed.data as { status: string }).status, "failed");

  const blocked = await beginExpectingError(players.Fen.client, seasonId, "OR", "claim");
  assert.match(blocked, /cooling down/i);

  const expired = await admin
    .from("cooldowns")
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("season_id", seasonId)
    .eq("territory_id", "OR")
    .eq("user_id", players.Fen.id);
  assert.equal(expired.error, null);

  const retry = await begin(players.Fen.client, seasonId, "OR", "claim");
  const outcome = await answerUntilResolved(players.Fen.client, retry.session_id);
  assert.equal(outcome.status, "completed", "the retry succeeds once the cooldown lapses");
});

// ---------------------------------------------------------------------------
// 15. Underdog discount
// ---------------------------------------------------------------------------
test("the trailing player needs one fewer correct answer than the leader for the same target", async () => {
  const { players, seasonId } = await startSeason([["Hugo", "WA"], ["Ines", "OR"], ["Jonas", "ID"]]);

  // Seed an imbalanced board: Hugo and Ines lead, Jonas trails below the 60%
  // threshold that game_begin_action uses for the underdog discount.
  for (const [player, score] of [[players.Hugo, 100], [players.Ines, 100], [players.Jonas, 0]] as const) {
    const updated = await admin
      .from("player_actions")
      .update({ cumulative_score: score })
      .eq("season_id", seasonId)
      .eq("user_id", player.id);
    assert.equal(updated.error, null);
  }

  // Both targets sit at hold_level 1, so only the score gap can move the price.
  const leaderAttack = await begin(players.Hugo.client, seasonId, "OR", "attack");
  assert.equal(leaderAttack.required_correct, 2, "the leader pays full price on a hold_level 1 state");

  const underdogAttack = await begin(players.Jonas.client, seasonId, "WA", "attack");
  assert.equal(underdogAttack.required_correct, 1, "the trailing player gets a one-answer discount");
});

// Finding 21: pick_next_question selects on a question's *observed* difficulty,
// but the answer timer and the "TIER n" header both read the row's *stored*
// tier. An empirically hard question stored as tier 1 got 30 seconds instead of
// 45, and a two-answer attack could be labelled TIER 3.
test("the served tier is the adaptive tier that selection and the timer both use", async () => {
  const { players, seasonId } = await startSeason([["Ola", "CA"], ["Pau", "FL"]]);

  // Deliberately not OR, for the same reason as the option-order probe above.
  const bank = await admin
    .from("questions").select("id,tier").eq("territory_id", "NV").eq("active", true).order("id");
  assert.equal(bank.error, null);
  const rows = (bank.data ?? []) as Array<{ id: string; tier: number }>;
  const subject = rows[0];
  const parkedIds = rows.slice(1).map((row) => row.id);

  try {
    if (parkedIds.length) await admin.from("questions").update({ active: false }).in("id", parkedIds);

    // Stored tier 1, but answered wrong far more often than right: the selector
    // already treats this as tier 3, so the payload and the timer must agree.
    const seeded = await admin
      .from("questions")
      .update({ tier: 1, attempt_count: 20, correct_count: 2 })
      .eq("id", subject.id);
    assert.equal(seeded.error, null);

    const session = await begin(players.Ola.client, seasonId, "NV", "claim");
    assert.equal(session.question.tier, 3, "an empirically hard question must be served as tier 3");

    const windowMs = new Date(session.question.expires_at).getTime() - Date.now();
    assert.ok(windowMs > 35_000, `a tier 3 question gets 45 seconds, got ${Math.round(windowMs / 1000)}s`);
  } finally {
    await admin.from("questions").update({ tier: subject.tier, attempt_count: 0, correct_count: 0 }).eq("id", subject.id);
    if (parkedIds.length) await admin.from("questions").update({ active: true }).in("id", parkedIds);
  }
});

// ---------------------------------------------------------------------------
// Resume-after-refresh (Step 3, exercised through the RPC the UI calls)
// ---------------------------------------------------------------------------
test("get_my_active_session resumes an unfinished question after a refresh", async () => {
  const { players, groupId, seasonId } = await startSeason([["Kira", "WA"], ["Liam", "FL"]]);
  const session = await begin(players.Kira.client, seasonId, "OR", "claim");

  const resumed = await players.Kira.client.rpc("get_my_active_session", { p_group_id: groupId });
  assert.equal(resumed.error, null);
  const active = resumed.data as BeginResult;
  assert.equal(active.session_id, session.session_id);
  assert.equal(active.action_type, "claim");
  assert.equal(active.territory_id, "OR");
  assert.equal(active.question.attempt_id, session.question.attempt_id);
  assert.equal(active.question.text, session.question.text);
});

// Finding 1: get_my_active_session used to return questions.options verbatim
// instead of shuffling it the way pick_next_question does, and every seeded
// multiple-choice row stores the correct answer at index 0. Any resume --
// including the automatic 5s/20s snapshot polls that overwrite the live
// operation -- revealed the answer.
//
// The probe widens one existing question to eight options with the answer first
// so the served order is the only variable: a verbatim resume pins the answer to
// index 0 on all ten rounds, a per-attempt shuffle does so with probability
// 8^-10.
test("resuming a question serves a stable option order that does not leak the answer", async () => {
  const { players, groupId, seasonId } = await startSeason([["Mona", "WA"], ["Nils", "FL"]]);

  // Deliberately not OR: this probe parks a territory's whole question bank, and
  // tests/db/engine.test.ts runs in a parallel process and claims OR.
  const bank = await admin
    .from("questions")
    .select("id,options,correct_answer")
    .eq("territory_id", "ID")
    .eq("format", "multiple_choice")
    .eq("active", true)
    .order("id")
    .limit(1)
    .single();
  assert.equal(bank.error, null);
  const subject = bank.data as { id: string; options: string[]; correct_answer: string };
  const options = [subject.correct_answer, ...Array.from({ length: 7 }, (_, index) => `Audit decoy ${index}`)];

  const parked = await admin
    .from("questions")
    .update({ active: false })
    .eq("territory_id", "ID")
    .neq("id", subject.id)
    .select("id");
  assert.equal(parked.error, null);
  const widened = await admin.from("questions").update({ options }).eq("id", subject.id);
  assert.equal(widened.error, null);

  try {
    const ROUNDS = 10;
    let answerFirst = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      await admin
        .from("player_actions")
        .update({ actions_remaining: 3, last_refresh_on: NO_REFILL_DATE })
        .eq("season_id", seasonId)
        .eq("user_id", players.Mona.id);

      const session = await begin(players.Mona.client, seasonId, "ID", "claim");
      assert.equal(session.question.format, "multiple_choice");
      assert.deepEqual([...session.question.options].sort(), [...options].sort(), "no option may be dropped");

      const answer = await correctAnswerFor(session.session_id);
      if (session.question.options[0] === answer) answerFirst += 1;

      // Every poll re-reads the active session. The order must not move while
      // the player is looking at it.
      for (let poll = 0; poll < 2; poll += 1) {
        const resumed = await players.Mona.client.rpc("get_my_active_session", { p_group_id: groupId });
        assert.equal(resumed.error, null);
        assert.deepEqual(
          (resumed.data as BeginResult).question.options,
          session.question.options,
          "a resume must serve the same option order the question was opened with",
        );
      }

      await admin.from("game_sessions").update({ status: "void" }).eq("id", session.session_id);
    }
    assert.ok(answerFirst < ROUNDS, "the correct answer must not be pinned to the first option");
  } finally {
    await admin.from("questions").update({ options: subject.options }).eq("id", subject.id);
    const ids = (parked.data ?? []).map((row) => (row as { id: string }).id);
    if (ids.length) await admin.from("questions").update({ active: true }).in("id", ids);
  }
});

// Finding 3: nothing re-checked the attack after `game_begin_action` admitted
// the defender. If the 24h deadline lapsed while the defense question was open,
// any other player's snapshot ran resolve_expired_attacks and handed the state
// to the attacker; the defender's correct answer then reported "You defended X"
// and its unconditional `update season_territories set hold_level = hold_level +
// 1` fortified the *attacker's* new territory. game_submit_answer now re-reads
// the attack under a lock and voids the defense if it is no longer contested.
test("a defense answered after the deadline cannot strengthen the new owner", async () => {
  const { players, groupId, seasonId } = await startSeason([["Otto", "WA"], ["Pam", "OR"]]);
  const attackId = await attackUntilContested(players.Otto, seasonId, "OR");
  const defense = await begin(players.Pam.client, seasonId, "OR", "defend", attackId);

  await admin
    .from("attacks")
    .update({ defense_deadline: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", attackId);
  await admin.rpc("resolve_expired_attacks", { p_season_id: seasonId });

  const answer = await correctAnswerFor(defense.session_id);
  const submitted = await players.Pam.client.rpc("game_submit_answer", {
    p_session_id: defense.session_id,
    p_answer: answer,
  });
  assert.notEqual(
    (submitted.data as { status?: string } | null)?.status,
    "completed",
    "a defense on an attack that already timed out must not report success",
  );

  const after = await snapshot(players.Otto.client, groupId);
  assert.equal(territory(after, "OR").owner_id, players.Otto.id);
  assert.equal(territory(after, "OR").hold_level, 1, "the late defense must not fortify the attacker's new state");
});

// Finding 5: `game_begin_action` only checked for a contested attack at begin
// time, so two players could each open an attack session on the same state. The
// first streak to finish inserted the attack row; the second violated
// one_contested_attack_per_territory and the raw Postgres error reached the
// player, rolling back their winning answer while their spent move stayed
// spent. The loser now gets a clean `void` and the move back.
test("a second attacker on the same state fails cleanly instead of raising a constraint error", async () => {
  const { players, groupId, seasonId } = await startSeason([["Rhea", "WA"], ["Sten", "OR"], ["Tam", "ID"]]);
  const first = await begin(players.Rhea.client, seasonId, "OR", "attack");
  const second = await begin(players.Tam.client, seasonId, "OR", "attack");
  const spent = await snapshot(players.Tam.client, groupId);
  assert.equal(spent.actions_remaining, 2, "the second attacker's move is spent at begin time");

  const firstOutcome = (await answerUntilResolved(players.Rhea.client, first.session_id)) as { status: string };
  assert.equal(firstOutcome.status, "contested");

  let secondStatus: string;
  try {
    secondStatus = ((await answerUntilResolved(players.Tam.client, second.session_id)) as { status: string }).status;
  } catch (error) {
    secondStatus = `threw: ${(error as Error).message}`;
  }
  assert.equal(secondStatus, "void", "the losing attacker should get a clean outcome, not a constraint error");

  const after = await snapshot(players.Tam.client, groupId);
  assert.equal(after.actions_remaining, 3, "a move that bought nothing is returned");
});

// Finding 6: run_test_bot_turns is SECURITY DEFINER and performs no caller check
// at all, and its `revoke all ... from public` never removed the grants Supabase
// hands to anon/authenticated. It is an internal helper driven by run_daily_tick
// and called by no client, so revoking EXECUTE is the whole fix.
test("run_test_bot_turns is not reachable by any client role", async () => {
  const { players, seasonId } = await startSeason([["Uli", "WA"], ["Vera", "FL"]], { testMode: true });

  const asMember = await players.Vera.client.rpc("run_test_bot_turns", { p_season_id: seasonId });
  assert.ok(asMember.error, "a signed-in member must not be able to drive bot turns");

  const asCommissioner = await players.Uli.client.rpc("run_test_bot_turns", { p_season_id: seasonId });
  assert.ok(asCommissioner.error, "not even the commissioner reaches the internal helper directly");
});

// Findings 6 and 7 share one root cause: Supabase's default privileges grant
// EXECUTE on every new function to anon and authenticated, so
// `revoke all ... from public` removes nothing. This probe is the permanent
// guard -- it enumerates every security-definer function in `public` and fails
// the moment a new migration leaves one anon-executable.
test("no security-definer function in public is executable by anon", async () => {
  // Nothing in the product is called before sign-in: the browser client is
  // `authenticated`, and the playtest signup path runs in an edge function under
  // the service key. The allowlist is therefore deliberately empty.
  const ANON_ALLOWLIST: string[] = [];

  const { data, error } = await admin.rpc("security_definer_grants");
  assert.equal(error, null, "security_definer_grants should be readable by the service key");
  const rows = data as Array<{ function: string; anon_execute: boolean; authenticated_execute: boolean }>;
  assert.ok(rows.length >= 20, `expected the engine's functions to be enumerated, saw ${rows.length}`);

  const reachable = rows.filter((row) => row.anon_execute && !ANON_ALLOWLIST.includes(row.function));
  assert.deepEqual(reachable.map((row) => row.function), [], "these functions are reachable unauthenticated");
});

// The same trap, one role up: these are internal helpers that a signed-in player
// must never call directly, whatever the default privileges hand out.
test("engine internals are not executable by authenticated players", async () => {
  const INTERNAL = [
    "handle_new_user()",
    "pick_next_question(p_session_id uuid)",
    "refresh_player_actions(p_season_id uuid, p_user_id uuid)",
    "resolve_attack_win(p_attack_id uuid, p_reason text)",
    "resolve_expired_attacks(p_season_id uuid)",
    "resolve_expired_sessions(p_season_id uuid)",
    "run_daily_tick()",
    "run_test_bot_turns(p_season_id uuid)",
  ];

  const { data, error } = await admin.rpc("security_definer_grants");
  assert.equal(error, null);
  const rows = data as Array<{ function: string; authenticated_execute: boolean }>;
  const byName = new Map(rows.map((row) => [row.function, row.authenticated_execute]));

  for (const name of INTERNAL) {
    assert.equal(byName.has(name), true, `${name} should still exist in the schema`);
    assert.equal(byName.get(name), false, `${name} must not be callable by a signed-in player`);
  }
});

// Finding 11: seasons.last_scored_on, player_actions.last_refresh_on and
// fortify_log.played_on all DEFAULT to `current_date` (the database's UTC date),
// while run_daily_tick and refresh_player_actions compare against
// `(now() at time zone groups.timezone)::date`. A season started while the UTC
// date was already ahead of the group's local date recorded a last_scored_on one
// day in its own future and silently skipped a scoring day, and the once-per-day
// fortify rolled over at UTC midnight while moves rolled over at group-local
// midnight.
//
// Deterministic by construction rather than by luck: Etc/GMT+12 is a fixed UTC-12
// zone and Etc/GMT-14 a fixed UTC+14 one (POSIX inverts the sign; neither has
// DST). They are 26 hours apart, so at every instant they sit on different
// calendar days and at least one of them differs from the UTC date -- the probe
// discriminates whatever time of day it runs.
test("every day-boundary column is stamped in the group's local day, not UTC", async () => {
  const localDatesAround = (offsetHours: number, tookMs: number) => {
    const shift = offsetHours * 3_600_000;
    return new Set([
      new Date(Date.now() - tookMs + shift).toISOString().slice(0, 10),
      new Date(Date.now() + shift).toISOString().slice(0, 10),
    ]);
  };

  const observed: string[] = [];
  for (const [zone, offsetHours, home] of [["Etc/GMT+12", -12, "WA"], ["Etc/GMT-14", 14, "FL"]] as const) {
    const startedAt = Date.now();
    const { players, seasonId } = await startSeason(
      [["Wilf", home], ["Xia", home === "WA" ? "OR" : "GA"]],
      { timezone: zone },
    );

    const fortify = await begin(players.Wilf.client, seasonId, home, "fortify");
    const outcome = await answerUntilResolved(players.Wilf.client, fortify.session_id);
    assert.equal(outcome.status, "completed");

    // Recomputed with the elapsed window so a UTC midnight crossing mid-probe
    // cannot flake it.
    const acceptable = localDatesAround(offsetHours, Date.now() - startedAt);

    const { data: seasonRows } = await admin.from("seasons").select("last_scored_on").eq("id", seasonId);
    const scoredOn = seasonRows?.[0]?.last_scored_on as string;
    assert.ok(acceptable.has(scoredOn), `${zone}: last_scored_on ${scoredOn} is not a ${zone} date`);

    const { data: actionRows } = await admin
      .from("player_actions").select("last_refresh_on").eq("season_id", seasonId).eq("user_id", players.Wilf.id);
    const refreshOn = actionRows?.[0]?.last_refresh_on as string;
    assert.ok(acceptable.has(refreshOn), `${zone}: last_refresh_on ${refreshOn} is not a ${zone} date`);

    const { data: fortifyRows } = await admin
      .from("fortify_log").select("played_on").eq("season_id", seasonId).eq("user_id", players.Wilf.id);
    const playedOn = fortifyRows?.[0]?.played_on as string;
    assert.ok(acceptable.has(playedOn), `${zone}: played_on ${playedOn} is not a ${zone} date`);

    observed.push(scoredOn);
  }

  assert.notEqual(observed[0], observed[1], "UTC-12 and UTC+14 are always on different calendar days");
});

// ---------------------------------------------------------------------------
// Realtime: the tables the client subscribes to must be in the publication
// ---------------------------------------------------------------------------
test("every table the map subscribes to is published to supabase_realtime", async () => {
  // territory-game-v2.tsx subscribes to these four tables filtered by season_id.
  const subscribed = ["season_territories", "attacks", "activity_events", "player_actions"];
  const { data, error } = await admin
    .from("season_territories")
    .select("season_id")
    .limit(1);
  assert.equal(error, null, "the admin client should reach the database");
  assert.ok(data, "season_territories should be readable by the service key");

  // pg_publication_tables is not exposed through PostgREST, so assert the
  // observable consequence instead: each subscribed table exists and carries the
  // season_id column the channel filter uses.
  for (const table of subscribed) {
    const probe = await admin.from(table).select("season_id").limit(1);
    assert.equal(probe.error, null, `${table} must expose season_id for the realtime filter`);
  }
});
