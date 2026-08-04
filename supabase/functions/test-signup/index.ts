import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

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

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: group, error: groupError } = await admin
      .from("groups")
      .select("id,name,status,test_mode,board_scope")
      .eq("invite_code", inviteCode)
      .eq("test_mode", true)
      .maybeSingle();

    if (groupError) return respond({ error: groupError.message }, 500);
    if (!group) return respond({ error: "That code is not an active playtest invite." }, 403);

    // An invite code proves the holder may join *this league*. It proves nothing
    // about who owns a given email address, so signup never touches an account
    // that already exists: the old "recover an unconfirmed account" branch reset
    // the password of any address an invite holder cared to type. Letting
    // createUser reject the duplicate also removes the paged listUsers scan,
    // which only ever saw the first 1000 accounts.
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });

    if (createError) {
      const alreadyRegistered = createError.status === 422
        || /already (been )?registered|already exists|duplicate/i.test(createError.message);
      return respond(
        { error: alreadyRegistered ? "An account with that email already exists. Sign in instead." : createError.message },
        alreadyRegistered ? 409 : 400,
      );
    }

    const user = created.user;
    if (!user) return respond({ error: "Account creation did not return a user." }, 500);

    const { error: profileError } = await admin
      .from("profiles")
      .upsert({ id: user.id, display_name: displayName, is_bot: false }, { onConflict: "id" });
    if (profileError) return respond({ error: profileError.message }, 500);

    const { data: existingMembership, error: membershipLookupError } = await admin
      .from("group_members")
      .select("group_id,color_index,home_state,home_completed")
      .eq("group_id", group.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (membershipLookupError) return respond({ error: membershipLookupError.message }, 500);

    if (!existingMembership) {
      const { count, error: countError } = await admin
        .from("group_members")
        .select("user_id", { count: "exact", head: true })
        .eq("group_id", group.id);
      if (countError) return respond({ error: countError.message }, 500);
      if ((count ?? 0) >= 8) return respond({ error: "This playtest league is full." }, 409);

      const { data: memberships, error: colorsError } = await admin
        .from("group_members")
        .select("color_index")
        .eq("group_id", group.id);
      if (colorsError) return respond({ error: colorsError.message }, 500);

      const used = new Set((memberships ?? []).map((row: { color_index: number }) => row.color_index));
      const colorIndex = Array.from({ length: 8 }, (_, index) => index).find((index) => !used.has(index));
      if (colorIndex === undefined) return respond({ error: "No player color is available." }, 409);

      const { error: memberError } = await admin.from("group_members").insert({
        group_id: group.id,
        user_id: user.id,
        color_index: colorIndex,
      });
      if (memberError) return respond({ error: memberError.message }, 500);
    }

    let homeState = existingMembership?.home_state ?? null;

    if (group.status === "active") {
      const { data: season, error: seasonError } = await admin
        .from("seasons")
        .select("id,current_turn_user_id")
        .eq("group_id", group.id)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (seasonError) return respond({ error: seasonError.message }, 500);

      if (season) {
        if (!homeState) {
          const territoryQuery = admin
            .from("season_territories")
            .select("territory_id")
            .eq("season_id", season.id)
            .is("owner_id", null)
            .eq("contested", false)
            .order("territory_id")
            .limit(1);

          if (group.board_scope !== "fifty") territoryQuery.not("territory_id", "in", "(AK,HI)");

          const { data: available, error: territoryError } = await territoryQuery.maybeSingle();
          if (territoryError) return respond({ error: territoryError.message }, 500);
          homeState = available?.territory_id ?? null;
        }

        if (homeState) {
          const { error: ownershipError } = await admin
            .from("season_territories")
            .update({ owner_id: user.id, hold_level: 1, updated_at: new Date().toISOString() })
            .eq("season_id", season.id)
            .eq("territory_id", homeState)
            .is("owner_id", null);
          if (ownershipError) return respond({ error: ownershipError.message }, 500);

          const { error: homeError } = await admin
            .from("group_members")
            .update({ home_state: homeState, home_completed: false })
            .eq("group_id", group.id)
            .eq("user_id", user.id);
          if (homeError) return respond({ error: homeError.message }, 500);
        }

        const { error: actionError } = await admin.from("player_actions").upsert({
          season_id: season.id,
          user_id: user.id,
          actions_remaining: season.current_turn_user_id === user.id ? 3 : 0,
          last_refresh_on: new Date().toISOString().slice(0, 10),
        }, { onConflict: "season_id,user_id" });
        if (actionError) return respond({ error: actionError.message }, 500);
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
