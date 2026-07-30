import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const groupId = url.searchParams.get("groupId");
  if (!groupId) return NextResponse.json({ error: "groupId is required" }, { status: 400 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await supabase.rpc("group_snapshot", { p_group_id: groupId });
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  return NextResponse.json(data);
}
