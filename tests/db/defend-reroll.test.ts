import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, answerUntilResolved, createTestUser } from "./helpers.ts";

// 20260804230000_defend_reroll_cap_and_grant_hygiene.sql: a defender can
// report a defense question (voiding the session) at most twice per attack;
// the third open is rejected. Reporting is otherwise free for defense (no
// move, turn-exempt), which let a defender walk the state's question bank.

interface Player { client: SupabaseClient; id: string; name: string }

async function createPlayer(name: string): Promise<Player> {
  const client = await createTestUser(name);
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  return { client, id: data.user!.id, name };
}

async function begin(user: SupabaseClient, seasonId: string, territory: string, kind: string, attackId: string | null = null) {
  const { data, error } = await user.rpc("game_begin_action", {
    p_season_id: seasonId,
    p_territory_id: territory,
    p_action_type: kind,
    p_attack_id: attackId,
  });
  if (error) throw error;
  return data as { session_id: string; question: { attempt_id: string } };
}

async function startTwoPlayerSeason(): Promise<{ players: Record<string, Player>; groupId: string; seasonId: string }> {
  const ada = await createPlayer("Ada");
  const ben = await createPlayer("Ben");
  const created = await ada.client.rpc("create_group_v2", {
    p_name: `Reroll ${crypto.randomUUID().slice(0, 8)}`,
    p_sports: ["NFL", "MLB"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: false,
  });
  if (created.error) throw created.error;
  const groupId = created.data as string;
  const invite = await admin.from("groups").select("invite_code").eq("id", groupId).single();
  const joined = await ben.client.rpc("join_group", { p_invite_code: invite.data!.invite_code });
  if (joined.error) throw joined.error;
  for (const [player, home] of [[ada, "WA"], [ben, "OR"]] as const) {
    const saved = await player.client.rpc("set_home_state", { p_group_id: groupId, p_home_state: home });
    if (saved.error) throw saved.error;
  }
  const started = await ada.client.rpc("start_season", { p_group_id: groupId });
  if (started.error) throw started.error;
  return { players: { Ada: ada, Ben: ben }, groupId, seasonId: started.data as string };
}

async function reportServedQuestion(user: SupabaseClient, attemptId: string): Promise<void> {
  const { error } = await user.rpc("report_question", {
    p_attempt_id: attemptId,
    p_reason: "Reroll-cap probe report",
  });
  if (error) throw error;
}

test("a defense can be rerolled twice by reporting, never a third time", async () => {
  const { players, seasonId } = await startTwoPlayerSeason();

  // Ada contests Ben's home state (WA and OR are adjacent; hold 1 needs 2 correct).
  const attackSession = await begin(players.Ada.client, seasonId, "OR", "attack");
  const outcome = (await answerUntilResolved(players.Ada.client, attackSession.session_id)) as { status: string; attack_id?: string };
  assert.equal(outcome.status, "contested");
  const attackId = outcome.attack_id!;

  // Reroll 1: open the defense, report the question -> session voided.
  const firstDefense = await begin(players.Ben.client, seasonId, "OR", "defend", attackId);
  await reportServedQuestion(players.Ben.client, firstDefense.question.attempt_id);

  // A second defense is legitimate after one void.
  const secondDefense = await begin(players.Ben.client, seasonId, "OR", "defend", attackId);
  assert.ok(secondDefense.session_id, "one voided session must not lock the defense out");
  await reportServedQuestion(players.Ben.client, secondDefense.question.attempt_id);

  // Two voids is the ceiling: the third open is rejected.
  const third = await players.Ben.client.rpc("game_begin_action", {
    p_season_id: seasonId,
    p_territory_id: "OR",
    p_action_type: "defend",
    p_attack_id: attackId,
  });
  assert.ok(third.error, "a third reroll must be rejected");
  assert.match(third.error!.message, /rerolled twice/i);
});

test("create_group (v1) is no longer authenticated-executable", async () => {
  const player = await createPlayer("Vex");
  const probe = await player.client.rpc("create_group", {
    p_name: "Legacy probe",
    p_sports: ["NFL"],
    p_season_length: 14,
  });
  assert.ok(probe.error, "the superseded v1 RPC must be revoked from signed-in players");
  assert.match(probe.error!.message, /permission denied|not find|does not exist/i);
});
