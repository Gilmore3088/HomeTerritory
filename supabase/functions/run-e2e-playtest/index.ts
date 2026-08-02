import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return respond({ error: "E2E runner is not configured" }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: configuration, error: configurationError } = await admin
    .from("e2e_configuration")
    .select("fixture_token")
    .eq("id", true)
    .maybeSingle();
  if (configurationError || !configuration) return respond({ error: configurationError?.message ?? "E2E configuration unavailable" }, 500);

  const token = request.headers.get("x-territory-e2e");
  if (token !== configuration.fixture_token) return respond({ error: "Unauthorized" }, 401);

  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!publishableKey) return respond({ error: "Public Supabase key unavailable" }, 500);

  const functionHeaders = {
    "content-type": "application/json",
    apikey: publishableKey,
    authorization: `Bearer ${publishableKey}`,
  };

  const logs: string[] = [];
  let setup: null | {
    run_id: string;
    group_id: string;
    invite_code: string;
    password: string;
    players: Array<{ email: string; display_name: string }>;
  } = null;

  const clients = [0, 1, 2].map(() => createClient(SUPABASE_URL, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }));

  async function fixture(action: "create" | "cleanup", runId?: string) {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/e2e-fixture`, {
      method: "POST",
      headers: { ...functionHeaders, "x-territory-e2e": token! },
      body: JSON.stringify({ action, run_id: runId }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Fixture ${action}: ${payload.error ?? response.status}`);
    return payload;
  }

  async function signup(player: { email: string; display_name: string }, password: string, inviteCode: string) {
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
    if (!response.ok || !payload.ok) throw new Error(`Signup ${player.display_name}: ${payload.error ?? response.status}`);
  }

  async function rpc(client: ReturnType<typeof createClient>, name: string, args: Record<string, unknown> = {}) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data;
  }

  async function completeAction(client: ReturnType<typeof createClient>, begin: { session_id: string }) {
    let result = await rpc(client, "test_submit_answer", { p_session_id: begin.session_id, p_correct: true });
    while (result.status === "active") {
      result = await rpc(client, "test_submit_answer", { p_session_id: begin.session_id, p_correct: true });
    }
    return result;
  }

  try {
    setup = await fixture("create");
    logs.push("isolated lobby created");

    await signup(setup.players[1], setup.password, setup.invite_code);
    await signup(setup.players[2], setup.password, setup.invite_code);
    logs.push("playtest signup and invite joining passed");

    const sessions = [];
    for (let index = 0; index < clients.length; index += 1) {
      const { data, error } = await clients[index].auth.signInWithPassword({
        email: setup.players[index].email,
        password: setup.password,
      });
      if (error || !data.session) throw new Error(`Login ${index + 1}: ${error?.message ?? "no session"}`);
      sessions.push(data.session);
    }
    assert(new Set(sessions.map((session) => session.user.id)).size === 3, "Three distinct auth sessions were not created");
    logs.push("three independent password logins passed");

    await Promise.all([
      rpc(clients[0], "set_home_state", { p_group_id: setup.group_id, p_home_state: "TX" }),
      rpc(clients[1], "set_home_state", { p_group_id: setup.group_id, p_home_state: "AR" }),
      rpc(clients[2], "set_home_state", { p_group_id: setup.group_id, p_home_state: "AL" }),
    ]);
    const seasonId = await rpc(clients[0], "start_season", { p_group_id: setup.group_id });
    assert(seasonId, "Season did not start");
    logs.push("home selection and commissioner season start passed");

    const home = await rpc(clients[0], "game_begin_action", {
      p_season_id: seasonId, p_territory_id: "TX", p_action_type: "home", p_attack_id: null,
    });
    assert((await completeAction(clients[0], home)).status === "completed", "Home action failed");
    logs.push("home-ground action passed");

    const claim = await rpc(clients[0], "game_begin_action", {
      p_season_id: seasonId, p_territory_id: "OK", p_action_type: "claim", p_attack_id: null,
    });
    assert((await completeAction(clients[0], claim)).status === "completed", "Claim failed");
    logs.push("claim action passed");

    const fortify = await rpc(clients[0], "game_begin_action", {
      p_season_id: seasonId, p_territory_id: "TX", p_action_type: "fortify", p_attack_id: null,
    });
    assert((await completeAction(clients[0], fortify)).status === "completed", "Fortify failed");
    logs.push("fortify action passed");

    const attack = await rpc(clients[0], "game_begin_action", {
      p_season_id: seasonId, p_territory_id: "AR", p_action_type: "attack", p_attack_id: null,
    });
    const attackResult = await completeAction(clients[0], attack);
    assert(attackResult.status === "contested" && attackResult.attack_id, "Attack did not create a defense window");
    logs.push("attack action and streak passed");

    const handoff = await rpc(clients[0], "end_test_turn", { p_group_id: setup.group_id });
    assert(handoff.next_display_name === "E2E Beta", "First turn did not pass to Beta");
    const { error: outOfTurnError } = await clients[0].rpc("game_begin_action", {
      p_season_id: seasonId, p_territory_id: "NM", p_action_type: "claim", p_attack_id: null,
    });
    assert(outOfTurnError, "Prior player was able to play after ending turn");
    logs.push("end-turn and waiting-player enforcement passed");

    const defense = await rpc(clients[1], "game_begin_action", {
      p_season_id: seasonId, p_territory_id: "AR", p_action_type: "defend", p_attack_id: attackResult.attack_id,
    });
    assert((await completeAction(clients[1], defense)).status === "completed", "Defense failed");
    logs.push("defense action passed");

    const betaHome = await rpc(clients[1], "game_begin_action", {
      p_season_id: seasonId, p_territory_id: "AR", p_action_type: "home", p_attack_id: null,
    });
    await completeAction(clients[1], betaHome);

    const reportable = await rpc(clients[1], "game_begin_action", {
      p_season_id: seasonId, p_territory_id: "AR", p_action_type: "fortify", p_attack_id: null,
    });
    const report = await rpc(clients[1], "report_question", {
      p_attempt_id: reportable.question.attempt_id,
      p_reason: "Automated E2E report and refund validation",
    });
    assert(report.status === "void", "Question report did not void the session");
    const betaSnapshot = await rpc(clients[1], "group_snapshot", { p_group_id: setup.group_id });
    assert(betaSnapshot.actions_remaining === 3, "Reported move was not refunded");
    logs.push("question report, quarantine and refund passed");

    const secondHandoff = await rpc(clients[1], "end_test_turn", { p_group_id: setup.group_id });
    assert(secondHandoff.next_display_name === "E2E Gamma", "Second turn did not pass to Gamma");
    const gammaHome = await rpc(clients[2], "game_begin_action", {
      p_season_id: seasonId, p_territory_id: "AL", p_action_type: "home", p_attack_id: null,
    });
    await completeAction(clients[2], gammaHome);
    logs.push("third-player turn passed");

    const duelId = await rpc(clients[0], "create_duel", {
      p_group_id: setup.group_id,
      p_opponent_id: sessions[1].user.id,
      p_territory_id: null,
    });
    await rpc(clients[1], "respond_duel", { p_duel_id: duelId, p_accept: true });
    for (let playerIndex = 0; playerIndex < 2; playerIndex += 1) {
      for (let questionIndex = 0; questionIndex < 3; questionIndex += 1) {
        const duelQuestion = await rpc(clients[playerIndex], "begin_duel_question", { p_duel_id: duelId });
        assert(duelQuestion.status === "question", "Duel question was not served");
        await rpc(clients[playerIndex], "submit_duel_answer", {
          p_duel_id: duelId,
          p_question_id: duelQuestion.question_id,
          p_answer: "__intentional_duel_miss__",
          p_response_ms: playerIndex === 0 ? 1000 + questionIndex : 2000 + questionIndex,
        });
      }
    }
    const duelRows = await rpc(clients[0], "get_my_duels", { p_group_id: setup.group_id });
    const completedDuel = duelRows.find((duel: { id: string }) => duel.id === duelId);
    assert(completedDuel?.status === "completed", "Duel did not complete");
    assert(completedDuel.winner_id === sessions[0].user.id, "Duel speed tiebreak selected wrong winner");
    logs.push("three-question duel and speed tiebreak passed");

    await clients[1].auth.signOut();
    assert((await clients[1].auth.getSession()).data.session === null, "Logout did not clear local session");
    const { data: relogin, error: reloginError } = await clients[1].auth.signInWithPassword({
      email: setup.players[1].email,
      password: setup.password,
    });
    assert(!reloginError && relogin.session, `Re-login failed: ${reloginError?.message ?? "no session"}`);
    const restored = await rpc(clients[1], "group_snapshot", { p_group_id: setup.group_id });
    assert(restored.group.id === setup.group_id, "Re-login did not restore league state");
    logs.push("logout and re-login passed");

    return respond({ ok: true, logs });
  } catch (error) {
    return respond({ ok: false, error: error instanceof Error ? error.message : "E2E failed", logs }, 500);
  } finally {
    await Promise.allSettled(clients.map((client) => client.auth.signOut()));
    if (setup?.run_id) {
      try {
        await fixture("cleanup", setup.run_id);
        logs.push("fixture cleanup passed");
      } catch (cleanupError) {
        console.error("E2E cleanup failed", cleanupError);
      }
    }
  }
});
