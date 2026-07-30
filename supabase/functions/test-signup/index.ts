import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  try {
    const body = await request.json();
    const displayName = String(body.displayName ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const inviteCode = String(body.inviteCode ?? "").trim().toUpperCase();

    if (displayName.length < 2) return respond({ error: "Enter a display name." }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return respond({ error: "Enter a valid email." }, 400);
    if (password.length < 8) return respond({ error: "Password must be at least 8 characters." }, 400);
    if (!/^[A-Z0-9]{8}$/.test(inviteCode)) return respond({ error: "Enter a valid 8-character playtest invite code." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return respond({ error: "Signup service is not configured." }, 500);

    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const { data: group, error: groupError } = await admin
      .from("groups")
      .select("id,name,status,test_mode")
      .eq("invite_code", inviteCode)
      .eq("test_mode", true)
      .maybeSingle();
    if (groupError) return respond({ error: groupError.message }, 500);
    if (!group) return respond({ error: "That code is not an active playtest invite." }, 403);

    const { data: listed, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) return respond({ error: listError.message }, 500);
    const existing = listed.users.find((candidate) => candidate.email?.toLowerCase() === email) ?? null;
    let user = existing;

    if (user) {
      if (user.email_confirmed_at) {
        return respond({ error: "An account with that email already exists. Sign in instead." }, 409);
      }
      const { data: recovered, error: recoverError } = await admin.auth.admin.updateUserById(user.id, {
        password,
        email_confirm: true,
        user_metadata: { ...user.user_metadata, display_name: displayName },
      });
      if (recoverError) return respond({ error: recoverError.message }, 400);
      user = recovered.user;
    } else {
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName },
      });
      if (createError) return respond({ error: createError.message }, 400);
      user = created.user;
    }

    await admin.from("profiles").upsert({ id: user.id, display_name: displayName }, { onConflict: "id" });

    const { data: existingMembership } = await admin
      .from("group_members")
      .select("group_id,color_index")
      .eq("group_id", group.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!existingMembership) {
      const { count } = await admin.from("group_members").select("user_id", { count: "exact", head: true }).eq("group_id", group.id);
      if ((count ?? 0) >= 8) return respond({ error: "This playtest league is full." }, 409);
      const { data: memberships } = await admin.from("group_members").select("color_index").eq("group_id", group.id);
      const used = new Set((memberships ?? []).map((row: { color_index: number }) => row.color_index));
      const colorIndex = Array.from({ length: 8 }, (_, index) => index).find((index) => !used.has(index));
      if (colorIndex === undefined) return respond({ error: "No player color is available." }, 409);
      const { error: memberError } = await admin.from("group_members").insert({ group_id: group.id, user_id: user.id, color_index: colorIndex });
      if (memberError) return respond({ error: memberError.message }, 500);
    }

    let homeState: string | null = null;
    if (group.status === "active") {
      const { data: season } = await admin.from("seasons").select("id").eq("group_id", group.id).eq("status", "active").maybeSingle();
      if (season) {
        const { data: existingHome } = await admin.from("profiles").select("home_state").eq("id", user.id).maybeSingle();
        homeState = existingHome?.home_state ?? null;
        if (!homeState) {
          const { data: available } = await admin
            .from("season_territories")
            .select("territory_id")
            .eq("season_id", season.id)
            .is("owner_id", null)
            .eq("contested", false)
            .order("territory_id")
            .limit(1)
            .maybeSingle();
          homeState = available?.territory_id ?? null;
        }
        if (homeState) {
          await admin.from("season_territories")
            .update({ owner_id: user.id, hold_level: 1, updated_at: new Date().toISOString() })
            .eq("season_id", season.id)
            .eq("territory_id", homeState)
            .is("owner_id", null);
          await admin.from("player_actions").upsert({ season_id: season.id, user_id: user.id, actions_remaining: 3 });
          await admin.from("profiles").update({ home_state: homeState, home_completed: false }).eq("id", user.id);
        }
      }
    }

    return respond({
      ok: true,
      recovered: Boolean(existing),
      league: group.name,
      homeState,
      message: homeState
        ? `Account ready. You joined ${group.name}, and ${homeState} is your home ground.`
        : `Account ready. You joined ${group.name}.`,
    });
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : "Signup failed." }, 500);
  }
});
