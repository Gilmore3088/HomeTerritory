import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Recap push is not configured" }, 500);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: config, error: configError } = await admin
    .from("push_configuration")
    .select("public_key,private_key,webhook_token,subject")
    .eq("id", true)
    .maybeSingle();
  if (configError || !config) return json({ error: configError?.message ?? "Push configuration unavailable" }, 500);
  if (request.headers.get("x-territory-webhook") !== config.webhook_token) return json({ error: "Unauthorized" }, 401);

  const body = await request.json().catch(() => ({})) as { recap_id?: string };
  if (!body.recap_id) return json({ error: "recap_id is required" }, 400);

  const { data: recap, error: recapError } = await admin
    .from("league_recaps")
    .select("id,group_id,share_token,period_end,recap")
    .eq("id", body.recap_id)
    .maybeSingle();
  if (recapError || !recap) return json({ error: recapError?.message ?? "Recap not found" }, 404);

  const { data: subscriptions, error: subscriptionError } = await admin
    .from("push_subscriptions")
    .select("id,endpoint,p256dh,auth")
    .eq("group_id", recap.group_id);
  if (subscriptionError) return json({ error: subscriptionError.message }, 500);
  if (!subscriptions?.length) return json({ ok: true, sent: 0, reason: "No subscriptions" });

  const standings = Array.isArray(recap.recap?.standings) ? recap.recap.standings : [];
  const leader = standings[0];
  const payload = JSON.stringify({
    title: `${recap.recap?.league ?? "Territory"} weekly recap`,
    body: leader
      ? `${leader.name} leads with ${leader.score} points and ${leader.states} states.`
      : "This week's map, standings and rivalry moments are ready.",
    tag: `recap-${recap.id}`,
    data: { url: `/recap/${recap.share_token}` },
  });

  webpush.setVapidDetails(config.subject, config.public_key, config.private_key);

  let sent = 0;
  let removed = 0;
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, payload, { TTL: 60 * 60 * 24 * 7 });
      sent += 1;
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 0;
      if (statusCode === 404 || statusCode === 410) {
        await admin.from("push_subscriptions").delete().eq("id", subscription.id);
        removed += 1;
      } else {
        console.error("Recap push failed", error);
      }
    }
  }));

  return json({ ok: true, sent, removed });
});
