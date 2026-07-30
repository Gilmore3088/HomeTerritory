import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const name = String(body.name ?? "").trim();
  const sports = Array.isArray(body.sports) ? body.sports.map(String) : [];
  const seasonLength = Number(body.seasonLength ?? 30);
  if (name.length < 2 || sports.length === 0 || ![14, 30, 60].includes(seasonLength)) {
    return NextResponse.json({ error: "Invalid group settings" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("create_group", {
    p_name: name,
    p_sports: sports,
    p_season_length: seasonLength,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ groupId: data });
}
