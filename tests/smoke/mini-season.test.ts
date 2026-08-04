// Task 10: end-to-end smoke test. One linear playthrough that proves the whole
// pipe still works after the stabilization fixes -- lobby, home ground, a
// claim, and the daily scoring tick -- against a real (freshly reset) local
// stack. This is intentionally not exhaustive: tests/db/engine.test.ts and
// tests/db/audit.test.ts already cover the individual mechanics in depth.
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, answerUntilResolved, createTestUser } from "../db/helpers.ts";

type Snapshot = {
  current_user_id: string;
  group: { invite_code: string };
  season: null | { id: string };
  territories: Array<{ id: string; owner_id: string | null; hold_level: number }>;
};

type Player = { name: string; client: SupabaseClient; home: string };

test("a three-player mini-season plays end to end", async () => {
  // 1. Three users, one group, everyone joined.
  const players: Player[] = [
    { name: "Smoke-A", client: await createTestUser("Smoke-A"), home: "WA" },
    { name: "Smoke-B", client: await createTestUser("Smoke-B"), home: "OR" },
    { name: "Smoke-C", client: await createTestUser("Smoke-C"), home: "CA" },
  ];
  const [a, b, c] = players;

  const created = await a.client.rpc("create_group_v2", {
    p_name: "Smoke Season",
    p_sports: ["NFL"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  assert.equal(created.error, null);
  const groupId = created.data as string;

  const snap = async (u: SupabaseClient): Promise<Snapshot> => {
    const { data, error } = await u.rpc("group_snapshot", { p_group_id: groupId });
    assert.equal(error, null);
    return data as Snapshot;
  };

  const invite = (await snap(a.client)).group.invite_code;
  for (const p of [b, c]) {
    assert.equal((await p.client.rpc("join_group", { p_invite_code: invite })).error, null);
  }

  // 2. Homes locked, season started.
  for (const p of players) {
    assert.equal(
      (await p.client.rpc("set_home_state", { p_group_id: groupId, p_home_state: p.home })).error,
      null,
    );
  }
  assert.equal((await a.client.rpc("start_season", { p_group_id: groupId })).error, null);
  const seasonId = (await snap(a.client)).season!.id;

  // 3. Each player secures home ground, one at a time.
  //
  // Turn choreography confirmed by tests/db/audit.test.ts ("test-mode turn
  // rotation..." and the start_season comment in
  // 20260730220000_add_playtest_turn_handoff.sql): a test-mode season assigns
  // turn one to the human with the lowest color_index -- the group creator, so
  // Smoke-A goes first. create_group_v2 gives the creator color_index 0 and
  // join_group assigns 1, 2, ... in join order, so join order here (A, B, C)
  // is also turn order. enforce_test_turn_session (and, since finding 19, the
  // friendlier check inside game_begin_action itself) blocks every action type
  // except 'defend' from a non-turn player -- 'home' is not exempt -- so each
  // player must hold the turn before beginning their own home action, and
  // end_test_turn (called by the player who currently holds the turn) is what
  // hands it to the next one. With three players this is exactly three
  // rotations: A's end_test_turn hands to B, B's hands to C, and C's wraps
  // back to A -- which conveniently leaves A holding the turn again for the
  // claim in step 4 below.
  for (const p of players) {
    const begun = await p.client.rpc("game_begin_action", {
      p_season_id: seasonId,
      p_territory_id: p.home,
      p_action_type: "home",
      p_attack_id: null,
    });
    assert.equal(begun.error, null, `${p.name} begins home action`);
    const outcome = await answerUntilResolved(p.client, (begun.data as { session_id: string }).session_id);
    assert.notEqual(outcome.status, "failed", `${p.name} secures home`);
    const ended = await p.client.rpc("end_test_turn", { p_group_id: groupId });
    assert.equal(ended.error, null, `${p.name} ends their turn`);
  }
  const afterHomes = await snap(a.client);
  for (const p of players) {
    const territory = afterHomes.territories.find((t) => t.id === p.home);
    assert.ok(territory?.owner_id, `${p.home} is owned after home round`);
    assert.equal(territory?.hold_level, 2, `${p.home} was garrisoned by the home action`);
  }

  // 4. Player A claims an adjacent neutral state (ID borders WA and OR per
  // public.territories.adjacent). The three rotations above left the turn
  // back on A, so this is a legal in-turn action.
  const claim = await a.client.rpc("game_begin_action", {
    p_season_id: seasonId,
    p_territory_id: "ID",
    p_action_type: "claim",
    p_attack_id: null,
  });
  assert.equal(claim.error, null);
  const claimOutcome = await answerUntilResolved(a.client, (claim.data as { session_id: string }).session_id);
  assert.notEqual(claimOutcome.status, "failed");

  // 5. Daily tick produces score events. run_daily_tick only scores a season
  // whose last_scored_on is strictly before today (see tests/db/audit.test.ts,
  // "run_daily_tick writes a daily score event..."), and a season started
  // moments ago already has last_scored_on set to today -- so, same as that
  // probe, the season is backdated first to force this tick to actually score
  // it rather than silently no-op.
  const backdated = await admin.from("seasons").update({ last_scored_on: "2020-01-01" }).eq("id", seasonId);
  assert.equal(backdated.error, null);

  const tick = await admin.rpc("run_daily_tick");
  assert.equal(tick.error, null);
  // daily_score_events has no surrogate id column -- its primary key is the
  // composite (season_id, user_id, scored_on) (202607300001_initial_schema.sql).
  const { data: events, error: eventsError } = await admin
    .from("daily_score_events")
    .select("user_id")
    .eq("season_id", seasonId);
  assert.equal(eventsError, null);
  assert.ok((events ?? []).length > 0, "daily tick recorded score events for this season");
});
