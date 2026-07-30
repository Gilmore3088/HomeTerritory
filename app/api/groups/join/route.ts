import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  const inviteCode = String(body.inviteCode ?? "").trim().toUpperCase();
  const { data, error } = await supabase.rpc("join_group", { p_invite_code: inviteCode });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ groupId: data });
}
