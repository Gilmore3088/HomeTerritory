import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(_request: Request, context: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await supabase.rpc("start_season", { p_group_id: groupId });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ seasonId: data });
}
