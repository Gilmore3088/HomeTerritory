import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// CORS: browsers only ever call this from the app's own origins. Requests
// with a foreign Origin are refused outright (stops other pages crowdsourcing
// their visitors' browsers at this endpoint); requests with no Origin (curl,
// server-side) pass through and are governed by the platform gate instead.
//
// Two deliberate rules:
//  - The localhost defaults apply ONLY when this function is running against a
//    local stack. In production an unset ALLOWED_ORIGINS fails closed rather
//    than quietly trusting anything a victim happens to run on port 3000.
//  - Preview matching is opt-in via ALLOW_VERCEL_PREVIEWS, never on by
//    default: *.vercel.app subdomains are first-come-first-served, so anyone
//    can deploy "hometerritory-<x>" and claim an allowlisted origin.
const DEFAULT_DEV_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];
const PREVIEW_ORIGIN = /^https:\/\/hometerritory-[a-z0-9-]+\.vercel\.app$/;

function isLocalStack(): boolean {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  return url.includes("localhost") || url.includes("127.0.0.1") || url.includes("kong:");
}

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const allowlist = configured.length ? configured : (isLocalStack() ? DEFAULT_DEV_ORIGINS : []);
  if (allowlist.includes(origin)) return origin;
  if (Deno.env.get("ALLOW_VERCEL_PREVIEWS") === "true" && PREVIEW_ORIGIN.test(origin)) return origin;
  return null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
  const allowed = allowedOrigin(origin);
  if (allowed) headers["Access-Control-Allow-Origin"] = allowed;
  return headers;
}

const MAX_BODY_BYTES = 4096;
const MAX_DISPLAY_NAME = 40;
const MAX_PASSWORD = 128;

// Internal failures never leak Postgres/GoTrue internals to an
// unauthenticated caller; the real error goes to the function log with a
// correlation id the player can quote.
function internalError(respond: (body: unknown, status?: number) => Response, error: unknown): Response {
  const correlationId = crypto.randomUUID().slice(0, 8);
  console.error(`[signup ${correlationId}]`, error);
  return respond({ error: `Signup hit a server problem (ref ${correlationId}). Try again shortly.` }, 500);
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);
  if (origin && !allowedOrigin(origin)) return respond({ error: "Origin not allowed." }, 403);

  const admin = (() => {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return null;
    return createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  })();
  if (!admin) return respond({ error: "Signup service is not configured." }, 500);

  // Tracked across the whole handler so even an unexpected throw cannot leave
  // a confirmed account behind (a stranded account soft-bricks the address:
  // signup says "already exists" and sign-in yields a user with no league).
  let createdUserId: string | null = null;

  try {
    // Measure the body we actually received: a missing, non-numeric, or
    // chunked content-length would sail past a header-only check.
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return respond({ error: "Request too large." }, 413);
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return respond({ error: "Send a JSON object." }, 400);
    }
    const displayName = String(body.displayName ?? "").replace(/\p{Cc}/gu, "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const inviteCode = String(body.inviteCode ?? "").trim().toUpperCase();

    if (displayName.length < 2) return respond({ error: "Enter a display name." }, 400);
    if (displayName.length > MAX_DISPLAY_NAME) return respond({ error: "Display name is too long." }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return respond({ error: "Enter a valid email." }, 400);
    if (password.length < 8) return respond({ error: "Password must be at least 8 characters." }, 400);
    if (password.length > MAX_PASSWORD) return respond({ error: "Password is too long." }, 400);
    if (!/^[A-Z0-9]{8}$/.test(inviteCode)) return respond({ error: "Enter a valid 8-character playtest invite code." }, 400);

    const { data: group, error: groupError } = await admin
      .from("groups")
      .select("id,name,status,test_mode,board_scope")
      .eq("invite_code", inviteCode)
      .eq("test_mode", true)
      .maybeSingle();

    if (groupError) return internalError(respond, groupError);
    if (!group) return respond({ error: "That code is not an active playtest invite." }, 403);

    // Capacity and color are settled BEFORE any account exists: a signup
    // against a full league must create nothing it has to clean up.
    const { data: memberships, error: membersError } = await admin
      .from("group_members")
      .select("color_index")
      .eq("group_id", group.id);
    if (membersError) return internalError(respond, membersError);
    if ((memberships ?? []).length >= 8) return respond({ error: "This playtest league is full." }, 409);
    const used = new Set((memberships ?? []).map((row: { color_index: number }) => row.color_index));
    const colorIndex = Array.from({ length: 8 }, (_, index) => index).find((index) => !used.has(index));
    if (colorIndex === undefined) return respond({ error: "No player color is available." }, 409);

    // An invite code proves the holder may join *this league*. It proves nothing
    // about who owns a given email address, so signup never touches an account
    // that already exists: createUser rejects the duplicate.
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });

    if (createError) {
      const alreadyRegistered = createError.status === 422
        || /already (been )?registered|already exists|duplicate/i.test(createError.message);
      // The distinct duplicate-email message is a deliberate UX choice for a
      // closed playtest; the invite gate bounds who can probe it.
      if (alreadyRegistered) return respond({ error: "An account with that email already exists. Sign in instead." }, 409);
      return respond({ error: "Account creation failed. Check the details and try again." }, 400);
    }

    const user = created.user;
    if (!user) return internalError(respond, new Error("createUser returned no user"));
    createdUserId = user.id;

    // Every failure past this point deletes the just-created account —
    // GoTrue and Postgres share no transaction, so the rollback is manual.
    // profiles_id_fkey cascades the profile row with it.
    const rollback = async (cause: unknown): Promise<Response> => {
      const removal = await admin.auth.admin.deleteUser(user.id);
      if (removal.error) console.error("[signup rollback failed]", removal.error);
      else createdUserId = null;
      // A membership or home-state race (23505) is retriable, not a server
      // fault: the league filled up between the capacity read and the insert.
      const code = (cause as { code?: string } | null)?.code;
      if (code === "23505") {
        return respond({ error: "That league filled up while you were signing up. Try again." }, 409);
      }
      return internalError(respond, cause);
    };

    const { error: profileError } = await admin
      .from("profiles")
      .upsert({ id: user.id, display_name: displayName }, { onConflict: "id" });
    if (profileError) return rollback(profileError);

    const { error: memberError } = await admin.from("group_members").insert({
      group_id: group.id,
      user_id: user.id,
      color_index: colorIndex,
    });
    if (memberError) return rollback(memberError);

    let homeState: string | null = null;

    if (group.status === "active") {
      const { data: season, error: seasonError } = await admin
        .from("seasons")
        .select("id,current_turn_user_id")
        .eq("group_id", group.id)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (seasonError) return rollback(seasonError);

      if (season) {
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
        if (territoryError) return rollback(territoryError);
        homeState = available?.territory_id ?? null;

        if (homeState) {
          const { error: ownershipError } = await admin
            .from("season_territories")
            .update({ owner_id: user.id, hold_level: 1, updated_at: new Date().toISOString() })
            .eq("season_id", season.id)
            .eq("territory_id", homeState)
            .is("owner_id", null);
          if (ownershipError) return rollback(ownershipError);

          const { error: homeError } = await admin
            .from("group_members")
            .update({ home_state: homeState, home_completed: false })
            .eq("group_id", group.id)
            .eq("user_id", user.id);
          if (homeError) return rollback(homeError);
        }

        const { error: actionError } = await admin.from("player_actions").upsert({
          season_id: season.id,
          user_id: user.id,
          actions_remaining: season.current_turn_user_id === user.id ? 3 : 0,
          last_refresh_on: new Date().toISOString().slice(0, 10),
        }, { onConflict: "season_id,user_id" });
        if (actionError) return rollback(actionError);
      }
    }

    createdUserId = null;
    return respond({
      ok: true,
      league: group.name,
      homeState,
      message: homeState
        ? `You joined ${group.name} and start from ${homeState}.`
        : `You joined ${group.name}.`,
    });
  } catch (error) {
    if (createdUserId) {
      const removal = await admin.auth.admin.deleteUser(createdUserId);
      if (removal.error) console.error("[signup rollback failed]", removal.error);
    }
    return internalError(respond, error);
  }
});
