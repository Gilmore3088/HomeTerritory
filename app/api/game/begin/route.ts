import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  const { data, error } = await supabase.rpc("game_begin_action", {
    p_season_id: body.seasonId,
    p_territory_id: body.territoryId,
    p_action_type: body.actionType,
    p_attack_id: body.attackId ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
