import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin, createTestUser } from "./helpers.ts";

// 20260805120000_allow_home_opening_off_turn.sql (audit F4): securing home
// ground is turn-exempt like defend — a mid-season joiner (or slow starter)
// must not be locked out of their opening move while another player holds the
// turn. Claims and attacks stay turn-gated.

interface Player { client: SupabaseClient; id: string; name: string }

async function createPlayer(name: string): Promise<Player> {
  const client = await createTestUser(name);
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  return { client, id: data.user!.id, name };
}

test("the home opening move is allowed off-turn in a test league; claims stay gated", async () => {
  const ada = await createPlayer("Ada");
  const ben = await createPlayer("Ben");
  const created = await ada.client.rpc("create_group_v2", {
    p_name: `HomeGate ${crypto.randomUUID().slice(0, 8)}`,
    p_sports: ["NFL", "MLB"],
    p_season_length: 14,
    p_opening_mode: "open",
    p_board_scope: "fifty",
    p_difficulty: "standard",
    p_test_mode: true,
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
  const seasonId = started.data as string;

  const season = await admin.from("seasons").select("current_turn_user_id").eq("id", seasonId).single();
  const offTurn = season.data!.current_turn_user_id === ada.id
    ? { player: ben, home: "OR" }
    : { player: ada, home: "WA" };

  // Off-turn home opening: allowed since 20260805120000.
  const home = await offTurn.player.client.rpc("game_begin_action", {
    p_season_id: seasonId,
    p_territory_id: offTurn.home,
    p_action_type: "home",
    p_attack_id: null,
  });
  assert.equal(home.error, null, `off-turn home opening must be allowed: ${home.error?.message}`);
  assert.ok((home.data as { session_id: string }).session_id);

  // Claims are still turn-gated for the same player.
  const claim = await offTurn.player.client.rpc("game_begin_action", {
    p_season_id: seasonId,
    p_territory_id: "NV",
    p_action_type: "claim",
    p_attack_id: null,
  });
  assert.match(claim.error?.message ?? "", /not your turn/i, "off-turn claim must stay rejected");
});
