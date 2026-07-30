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

    // Never modify an existing account here: a playtest invite code is not
    // proof of email ownership, so recovering/confirming an existing user
    // would let any code holder take over unconfirmed accounts.
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });
    if (createError) {
      if (createError.code === "email_exists" || /already.*registered|already.*exists/i.test(createError.message ?? "")) {
        return respond({ error: "An account with that email already exists. Sign in instead." }, 409);
      }
      return respond({ error: createError.message }, 400);
    }
    const user = created.user;

    const { error: profileError } = await admin.from("profiles").upsert({ id: user.id, display_name: displayName }, { onConflict: "id" });
    if (profileError) return respond({ error: profileError.message }, 500);

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
      const { data: season, error: seasonError } = await admin.from("seasons").select("id").eq("group_id", group.id).eq("status", "active").maybeSingle();
      if (seasonError) return respond({ error: seasonError.message }, 500);
      if (season) {
        // home_state lives on group_members, not profiles.
        const { data: myMembership, error: myMembershipError } = await admin
          .from("group_members").select("home_state").eq("group_id", group.id).eq("user_id", user.id).maybeSingle();
        if (myMembershipError) return respond({ error: myMembershipError.message }, 500);
        homeState = myMembership?.home_state ?? null;
        if (!homeState) {
          // Skip states another member already calls home; group_members has a
          // unique (group_id, home_state) index even when the owner lost the state.
          const { data: takenHomes, error: takenError } = await admin
            .from("group_members").select("home_state").eq("group_id", group.id).not("home_state", "is", null);
          if (takenError) return respond({ error: takenError.message }, 500);
          let query = admin
            .from("season_territories")
            .select("territory_id")
            .eq("season_id", season.id)
            .is("owner_id", null)
            .eq("contested", false);
          const taken = (takenHomes ?? []).map((row: { home_state: string | null }) => row.home_state).filter(Boolean) as string[];
          if (taken.length > 0) query = query.not("territory_id", "in", `(${taken.join(",")})`);
          const { data: available, error: availableError } = await query.order("territory_id").limit(1).maybeSingle();
          if (availableError) return respond({ error: availableError.message }, 500);
          homeState = available?.territory_id ?? null;
          if (homeState) {
            const { error: claimError } = await admin.from("season_territories")
              .update({ owner_id: user.id, hold_level: 1, updated_at: new Date().toISOString() })
              .eq("season_id", season.id)
              .eq("territory_id", homeState)
              .is("owner_id", null);
            if (claimError) return respond({ error: claimError.message }, 500);
            const { error: actionsError } = await admin.from("player_actions").upsert({ season_id: season.id, user_id: user.id, actions_remaining: 3 });
            if (actionsError) return respond({ error: actionsError.message }, 500);
            const { error: homeError } = await admin.from("group_members")
              .update({ home_state: homeState, home_completed: false })
              .eq("group_id", group.id)
              .eq("user_id", user.id);
            if (homeError) return respond({ error: homeError.message }, 500);
          }
        }
      }
    }

    return respond({
      ok: true,
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
