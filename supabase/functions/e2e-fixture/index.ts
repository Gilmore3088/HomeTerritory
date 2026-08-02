import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
  try { return JSON.stringify(error); } catch { return "Fixture operation failed"; }
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const token = Array.from(bytes, (value) => value.toString(36)).join("").slice(0, 24);
  return `Tt!${token}9`;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return respond({ error: "Fixture service is not configured" }, 500);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: config, error: configError } = await admin
    .from("e2e_configuration")
    .select("fixture_token")
    .eq("id", true)
    .maybeSingle();
  if (configError || !config) return respond({ error: configError?.message ?? "E2E configuration unavailable" }, 500);
  if (request.headers.get("x-territory-e2e") !== config.fixture_token) return respond({ error: "Unauthorized" }, 401);

  const body = await request.json().catch(() => ({})) as { action?: string; run_id?: string };

  if (body.action === "cleanup") {
    if (!body.run_id) return respond({ error: "run_id is required" }, 400);

    const { data: run, error: runError } = await admin
      .from("e2e_runs")
      .select("id,group_id")
      .eq("id", body.run_id)
      .maybeSingle();
    if (runError || !run) return respond({ error: runError?.message ?? "E2E run not found" }, 404);

    const { data: memberships } = await admin
      .from("group_members")
      .select("user_id")
      .eq("group_id", run.group_id);
    const userIds = (memberships ?? []).map((row: { user_id: string }) => row.user_id);

    if (userIds.length) {
      const { data: reports } = await admin
        .from("question_reports")
        .select("id,question_id")
        .in("reported_by", userIds);
      const questionIds = [...new Set((reports ?? []).map((row: { question_id: string }) => row.question_id))];
      if (questionIds.length) await admin.from("questions").update({ active: true }).in("id", questionIds);
      if (reports?.length) await admin.from("question_reports").delete().in("id", reports.map((row: { id: string }) => row.id));
    }

    await admin.from("groups").delete().eq("id", run.group_id);
    if (userIds.length) await admin.from("profiles").delete().in("id", userIds);
    await Promise.all(userIds.map((userId) => admin.auth.admin.deleteUser(userId)));

    return respond({ ok: true, deleted_users: userIds.length });
  }

  if (body.action !== "create") return respond({ error: "Use action=create or action=cleanup" }, 400);

  const runId = crypto.randomUUID();
  const short = runId.replaceAll("-", "").slice(0, 10);
  const password = randomPassword();
  const inviteCode = short.slice(0, 8).toUpperCase();
  const emails = [1, 2, 3].map((index) => `territory-e2e-${short}-${index}@example.test`);
  let commissionerId: string | null = null;
  let groupId: string | null = null;

  try {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: emails[0],
      password,
      email_confirm: true,
      user_metadata: { display_name: "E2E Alpha" },
    });
    if (createError || !created.user) throw new Error(createError?.message ?? "Could not create commissioner");
    commissionerId = created.user.id;

    const { error: profileError } = await admin.from("profiles").insert({
      id: commissionerId,
      display_name: "E2E Alpha",
      is_bot: false,
    });
    if (profileError) throw profileError;

    const { data: group, error: groupError } = await admin.from("groups").insert({
      name: `Territory E2E ${short}`,
      commissioner_id: commissionerId,
      invite_code: inviteCode,
      sports: ["NFL", "NCAA Football", "MLB", "NBA", "NCAA Basketball", "NHL"],
      season_length: 14,
      status: "lobby",
      board_scope: "fifty",
      opening_mode: "open",
      difficulty: "standard",
      timezone: "America/Los_Angeles",
      test_mode: true,
    }).select("id").single();
    if (groupError || !group) throw new Error(groupError?.message ?? "Could not create E2E group");
    groupId = group.id;

    const { error: memberError } = await admin.from("group_members").insert({
      group_id: groupId,
      user_id: commissionerId,
      color_index: 0,
    });
    if (memberError) throw memberError;

    const { error: runError } = await admin.from("e2e_runs").insert({
      id: runId,
      group_id: groupId,
      user_ids: [commissionerId],
    });
    if (runError) throw runError;

    return respond({
      ok: true,
      run_id: runId,
      group_id: groupId,
      invite_code: inviteCode,
      password,
      players: [
        { email: emails[0], display_name: "E2E Alpha" },
        { email: emails[1], display_name: "E2E Beta" },
        { email: emails[2], display_name: "E2E Gamma" },
      ],
    });
  } catch (error) {
    if (groupId) await admin.from("groups").delete().eq("id", groupId);
    if (commissionerId) {
      await admin.from("profiles").delete().eq("id", commissionerId);
      await admin.auth.admin.deleteUser(commissionerId);
    }
    return respond({ error: errorMessage(error) }, 500);
  }
});
