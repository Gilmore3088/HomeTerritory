import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, answerUntilResolved, createTestUser } from "./helpers.ts";

async function startedSeason(commish: SupabaseClient, mate: SupabaseClient, home1: string, home2: string) {
  const created = await commish.rpc("create_group_v2", {
    p_name: "Advance League", p_sports: ["NFL"], p_season_length: 14,
    p_opening_mode: "open", p_board_scope: "fifty", p_difficulty: "standard", p_test_mode: true,
  });
  assert.equal(created.error, null);
  const groupId = created.data as string;
  const snap = await commish.rpc("group_snapshot", { p_group_id: groupId });
  const invite = (snap.data as { group: { invite_code: string } }).group.invite_code;
  await mate.rpc("join_group", { p_invite_code: invite });
  await commish.rpc("set_home_state", { p_group_id: groupId, p_home_state: home1 });
  await mate.rpc("set_home_state", { p_group_id: groupId, p_home_state: home2 });
  await commish.rpc("start_season", { p_group_id: groupId });
  const after = await commish.rpc("group_snapshot", { p_group_id: groupId });
  return { groupId, seasonId: (after.data as { season: { id: string } }).season.id };
}

test("advance_season scores a season's held territories once per local day", async () => {
  const a = await createTestUser("AdvA");
  const b = await createTestUser("AdvB");
  const { seasonId } = await startedSeason(a, b, "TX", "NY");

  // Backdate last_scored_on so scoring is due (mirrors tests/db/audit.test.ts).
  await admin.from("seasons").update({ last_scored_on: "2000-01-01" }).eq("id", seasonId);
  const first = await admin.rpc("advance_season", { p_season_id: seasonId });
  assert.equal(first.error, null);
  const { data: events, error } = await admin
    .from("daily_score_events").select("scored_on").eq("season_id", seasonId);
  assert.equal(error, null);
  assert.ok((events ?? []).length > 0, "advance_season recorded score events");

  // Second call same local day: resolves but does not double-score.
  const before = (events ?? []).length;
  await admin.rpc("advance_season", { p_season_id: seasonId });
  const { data: events2 } = await admin
    .from("daily_score_events").select("scored_on").eq("season_id", seasonId);
  assert.equal((events2 ?? []).length, before, "no double-scoring within one local day");
});

test("run_daily_tick still scores active seasons via advance_season", async () => {
  const a = await createTestUser("TickA");
  const b = await createTestUser("TickB");
  const { seasonId } = await startedSeason(a, b, "CA", "FL");
  await admin.from("seasons").update({ last_scored_on: "2000-01-01" }).eq("id", seasonId);
  const tick = await admin.rpc("run_daily_tick");
  assert.equal(tick.error, null);
  const { data: events } = await admin
    .from("daily_score_events").select("scored_on").eq("season_id", seasonId);
  assert.ok((events ?? []).length > 0, "run_daily_tick scored via advance_season");
});
