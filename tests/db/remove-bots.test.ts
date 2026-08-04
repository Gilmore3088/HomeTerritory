import { test } from "node:test";
import assert from "node:assert/strict";
import { admin, createTestUser } from "./helpers.ts";

// The engine after bot removal (20260804210000_remove_bot_players.sql): no
// is_bot column, no bot_action_log, no run_test_bot_turns, profiles_id_fkey
// restored, and snapshot/start/rotate all reasoning about members only.

test("profiles.is_bot column is gone", async () => {
  const probe = await admin.from("profiles").select("is_bot").limit(1);
  assert.ok(probe.error, "selecting is_bot should fail once the column is dropped");
});

test("bot_action_log table is gone", async () => {
  const probe = await admin.from("bot_action_log").select("*").limit(1);
  assert.ok(probe.error, "bot_action_log should no longer exist");
});

test("run_test_bot_turns no longer exists for any role", async () => {
  const probe = await admin.rpc("run_test_bot_turns", {
    p_season_id: "00000000-0000-0000-0000-000000000000",
  });
  assert.ok(probe.error, "the function should be dropped");
  assert.match(probe.error!.message, /could not find|does not exist|schema cache/i);
});

test("profiles_id_fkey is restored against auth.users", async () => {
  const ghost = crypto.randomUUID();
  const ins = await admin.from("profiles").insert({ id: ghost, display_name: "Ghost" });
  assert.ok(ins.error, "profiles without an auth.users row must be rejected");
  assert.match(ins.error!.message, /foreign key|violates/i);
});

// No "bots were deleted" probe by display name: is_bot is gone, so the only
// durable evidence the data pass ran is that the restored FK VALIDATED every
// existing row (Postgres refuses to add it over orphans) -- covered above.
// Display names are user data, not schema, and one local seed run left a
// bot-named account that was never flagged is_bot.

test("start_season requires two members and seeds all homes at hold 1", async () => {
  const solo = await createTestUser("Sol");
  const create = await solo.rpc("create_group_v2", {
    p_name: "No Bots Solo",
    p_sports: ["NFL"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
  });
  assert.equal(create.error, null, create.error?.message ?? "");
  const groupId = create.data as string;
  const home = await solo.rpc("set_home_state", { p_group_id: groupId, p_home_state: "MT" });
  assert.equal(home.error, null, home.error?.message ?? "");

  const aloneStart = await solo.rpc("start_season", { p_group_id: groupId });
  assert.ok(aloneStart.error, "a single member cannot start a season");
  assert.match(aloneStart.error!.message, /at least two players/i);

  const rival = await createTestUser("Riv");
  const invite = await admin.from("groups").select("invite_code").eq("id", groupId).single();
  assert.equal(invite.error, null);
  const join = await rival.rpc("join_group", { p_invite_code: invite.data!.invite_code });
  assert.equal(join.error, null, join.error?.message ?? "");
  const rivalHome = await rival.rpc("set_home_state", { p_group_id: groupId, p_home_state: "WY" });
  assert.equal(rivalHome.error, null, rivalHome.error?.message ?? "");

  const start = await solo.rpc("start_season", { p_group_id: groupId });
  assert.equal(start.error, null, start.error?.message ?? "");

  const holds = await admin
    .from("season_territories")
    .select("territory_id, hold_level, owner_id")
    .eq("season_id", start.data as string)
    .not("owner_id", "is", null);
  assert.equal(holds.error, null);
  assert.ok(holds.data!.length >= 2, "both home states should be seeded");
  for (const row of holds.data!) {
    assert.equal(row.hold_level, 1, "every seeded home starts at hold 1 (the bot=2 branch is gone)");
  }

  const snap = await solo.rpc("group_snapshot", { p_group_id: groupId });
  assert.equal(snap.error, null, snap.error?.message ?? "");
  const members = (snap.data as { members: Array<Record<string, unknown>> }).members;
  assert.equal(members.length, 2);
  for (const member of members) {
    assert.equal("is_bot" in member, false, "snapshot members no longer carry is_bot");
  }

  const rotate = await solo.rpc("end_test_turn", { p_group_id: groupId });
  assert.equal(rotate.error, null, rotate.error?.message ?? "");
  const next = rotate.data as { next_user_id: string | null };
  assert.ok(next.next_user_id, "the turn should rotate to the other member");
});
