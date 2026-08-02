import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://gduvdnpxgdniogmxxlmg.supabase.co";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_Xgxcnh4NUlZ7dkYHeC-xiw_mOmxQxGZ";
const E2E_TOKEN = process.env.TERRITORY_E2E_TOKEN;

if (!E2E_TOKEN) {
  console.error("TERRITORY_E2E_TOKEN is required.");
  process.exit(2);
}

const functionHeaders = {
  "content-type": "application/json",
  apikey: SUPABASE_KEY,
  authorization: `Bearer ${SUPABASE_KEY}`,
};

function client() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function fixture(action, runId) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/e2e-fixture`, {
    method: "POST",
    headers: { ...functionHeaders, "x-territory-e2e": E2E_TOKEN },
    body: JSON.stringify({ action, run_id: runId }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Fixture ${action} failed: ${payload.error ?? response.status}`);
  return payload;
}

async function playtestSignup(player, password, inviteCode) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/test-signup`, {
    method: "POST",
    headers: functionHeaders,
    body: JSON.stringify({
      displayName: player.display_name,
      email: player.email,
      password,
      inviteCode,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(`Playtest signup failed for ${player.display_name}: ${payload.error ?? response.status}`);
}

async function rpc(supabase, name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function expectRpcError(supabase, name, args, pattern) {
  const { error } = await supabase.rpc(name, args);
  assert(error, `${name} should have failed`);
  assert.match(error.message, pattern, `${name} failed for the wrong reason: ${error.message}`);
}

async function completeAction(supabase, beginPayload) {
  let result = await rpc(supabase, "test_submit_answer", {
    p_session_id: beginPayload.session_id,
    p_correct: true,
  });

  while (result.status === "active") {
    result = await rpc(supabase, "test_submit_answer", {
      p_session_id: beginPayload.session_id,
      p_correct: true,
    });
  }
  return result;
}

async function signIn(supabase, email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Login failed for ${email}: ${error.message}`);
  assert(data.session, `No session returned for ${email}`);
  return data.session;
}

async function run() {
  let setup = null;
  const clients = [client(), client(), client()];

  try {
    setup = await fixture("create");
    assert.equal(setup.players.length, 3);
    console.log("✓ isolated lobby created");

    await Promise.all([
      playtestSignup(setup.players[1], setup.password, setup.invite_code),
      playtestSignup(setup.players[2], setup.password, setup.invite_code),
    ]);
    console.log("✓ two players signed up and joined by invite code");

    const sessions = await Promise.all(setup.players.map((player, index) => signIn(clients[index], player.email, setup.password)));
    assert.equal(new Set(sessions.map((session) => session.user.id)).size, 3);
    console.log("✓ three independent password sessions established");

    await Promise.all([
      rpc(clients[0], "set_home_state", { p_group_id: setup.group_id, p_home_state: "TX" }),
      rpc(clients[1], "set_home_state", { p_group_id: setup.group_id, p_home_state: "AR" }),
      rpc(clients[2], "set_home_state", { p_group_id: setup.group_id, p_home_state: "AL" }),
    ]);
    const seasonId = await rpc(clients[0], "start_season", { p_group_id: setup.group_id });
    assert(seasonId);
    console.log("✓ home states selected and commissioner started season");

    const home = await rpc(clients[0], "game_begin_action", {
      p_season_id: seasonId,
      p_territory_id: "TX",
      p_action_type: "home",
      p_attack_id: null,
    });
    const homeResult = await completeAction(clients[0], home);
    assert.equal(homeResult.status, "completed");
    console.log("✓ home-ground question resolved");

    const claim = await rpc(clients[0], "game_begin_action", {
      p_season_id: seasonId,
      p_territory_id: "OK",
      p_action_type: "claim",
      p_attack_id: null,
    });
    const claimResult = await completeAction(clients[0], claim);
    assert.equal(claimResult.status, "completed");
    console.log("✓ adjacent neutral state claimed");

    const fortify = await rpc(clients[0], "game_begin_action", {
      p_season_id: seasonId,
      p_territory_id: "TX",
      p_action_type: "fortify",
      p_attack_id: null,
    });
    const fortifyResult = await completeAction(clients[0], fortify);
    assert.equal(fortifyResult.status, "completed");
    console.log("✓ owned state fortified and move consumed");

    const attack = await rpc(clients[0], "game_begin_action", {
      p_season_id: seasonId,
      p_territory_id: "AR",
      p_action_type: "attack",
      p_attack_id: null,
    });
    const attackResult = await completeAction(clients[0], attack);
    assert.equal(attackResult.status, "contested");
    assert(attackResult.attack_id);
    console.log("✓ attack streak created a defense window");

    const handoff = await rpc(clients[0], "end_test_turn", { p_group_id: setup.group_id });
    assert.equal(handoff.next_display_name, "E2E Beta");
    await expectRpcError(clients[0], "game_begin_action", {
      p_season_id: seasonId,
      p_territory_id: "NM",
      p_action_type: "claim",
      p_attack_id: null,
    }, /No moves remaining|not your turn/i);
    console.log("✓ end turn handed play to next human and blocked prior player");

    const defense = await rpc(clients[1], "game_begin_action", {
      p_season_id: seasonId,
      p_territory_id: "AR",
      p_action_type: "defend",
      p_attack_id: attackResult.attack_id,
    });
    const defenseResult = await completeAction(clients[1], defense);
    assert.equal(defenseResult.status, "completed");
    console.log("✓ defender repelled attack");

    const secondHome = await rpc(clients[1], "game_begin_action", {
      p_season_id: seasonId,
      p_territory_id: "AR",
      p_action_type: "home",
      p_attack_id: null,
    });
    await completeAction(clients[1], secondHome);

    const reportable = await rpc(clients[1], "game_begin_action", {
      p_season_id: seasonId,
      p_territory_id: "AR",
      p_action_type: "fortify",
      p_attack_id: null,
    });
    const reportResult = await rpc(clients[1], "report_question", {
      p_attempt_id: reportable.question.attempt_id,
      p_reason: "Automated E2E report and refund validation",
    });
    assert.equal(reportResult.status, "void");
    const betaSnapshot = await rpc(clients[1], "group_snapshot", { p_group_id: setup.group_id });
    assert.equal(betaSnapshot.actions_remaining, 3, "Reported fortify should refund the consumed move");
    console.log("✓ question report quarantined and refunded move");

    const secondHandoff = await rpc(clients[1], "end_test_turn", { p_group_id: setup.group_id });
    assert.equal(secondHandoff.next_display_name, "E2E Gamma");
    const gammaHome = await rpc(clients[2], "game_begin_action", {
      p_season_id: seasonId,
      p_territory_id: "AL",
      p_action_type: "home",
      p_attack_id: null,
    });
    await completeAction(clients[2], gammaHome);
    console.log("✓ third player received turn and completed home ground");

    const duelId = await rpc(clients[0], "create_duel", {
      p_group_id: setup.group_id,
      p_opponent_id: sessions[1].user.id,
      p_territory_id: null,
    });
    await rpc(clients[1], "respond_duel", { p_duel_id: duelId, p_accept: true });
    for (const [index, supabase] of [clients[0], clients[1]].entries()) {
      for (let questionNumber = 0; questionNumber < 3; questionNumber += 1) {
        const duelQuestion = await rpc(supabase, "begin_duel_question", { p_duel_id: duelId });
        assert.equal(duelQuestion.status, "question");
        await rpc(supabase, "submit_duel_answer", {
          p_duel_id: duelId,
          p_question_id: duelQuestion.question_id,
          p_answer: "__intentional_duel_miss__",
          p_response_ms: index === 0 ? 1000 + questionNumber : 2000 + questionNumber,
        });
      }
    }
    const duelRows = await rpc(clients[0], "get_my_duels", { p_group_id: setup.group_id });
    const completedDuel = duelRows.find((duel) => duel.id === duelId);
    assert.equal(completedDuel.status, "completed");
    assert.equal(completedDuel.winner_id, sessions[0].user.id);
    console.log("✓ three-question duel completed with speed tiebreak");

    await clients[1].auth.signOut();
    assert.equal((await clients[1].auth.getSession()).data.session, null);
    await signIn(clients[1], setup.players[1].email, setup.password);
    const reloginSnapshot = await rpc(clients[1], "group_snapshot", { p_group_id: setup.group_id });
    assert.equal(reloginSnapshot.group.id, setup.group_id);
    console.log("✓ logout and password re-login restored shared game state");

    console.log("\nTerritory multi-account E2E playtest passed.");
  } finally {
    await Promise.allSettled(clients.map((supabase) => supabase.auth.signOut()));
    if (setup?.run_id) {
      try {
        const cleanup = await fixture("cleanup", setup.run_id);
        console.log(`✓ fixture cleanup removed ${cleanup.deleted_users} temporary users`);
      } catch (error) {
        console.error("Fixture cleanup failed:", error);
      }
    }
  }
}

run().catch((error) => {
  console.error("\nTerritory E2E failed:", error);
  process.exitCode = 1;
});
