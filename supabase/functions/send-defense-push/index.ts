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
  if (!supabaseUrl || !serviceKey) return json({ error: "Push service is not configured" }, 500);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: config, error: configError } = await admin
    .from("push_configuration")
    .select("public_key,private_key,webhook_token,subject")
    .eq("id", true)
    .maybeSingle();

  if (configError || !config) return json({ error: configError?.message ?? "Push keys are unavailable" }, 500);
  if (request.headers.get("x-territory-webhook") !== config.webhook_token) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await request.json().catch(() => ({})) as { attack_id?: string };
  if (!body.attack_id) return json({ error: "attack_id is required" }, 400);

  const { data: attack, error: attackError } = await admin
    .from("attacks")
    .select("id,season_id,territory_id,attacker_id,defender_id,defense_deadline,status")
    .eq("id", body.attack_id)
    .maybeSingle();

  if (attackError || !attack) return json({ error: attackError?.message ?? "Attack not found" }, 404);

  const [{ data: season }, { data: territory }, { data: attacker }] = await Promise.all([
    admin.from("seasons").select("group_id").eq("id", attack.season_id).maybeSingle(),
    admin.from("territories").select("name").eq("id", attack.territory_id).maybeSingle(),
    admin.from("profiles").select("display_name").eq("id", attack.attacker_id).maybeSingle(),
  ]);

  if (!season) return json({ error: "Season not found" }, 404);

  const { data: subscriptions, error: subscriptionsError } = await admin
    .from("push_subscriptions")
    .select("id,endpoint,p256dh,auth")
    .eq("user_id", attack.defender_id)
    .eq("group_id", season.group_id);

  if (subscriptionsError) return json({ error: subscriptionsError.message }, 500);
  if (!subscriptions?.length) return json({ ok: true, sent: 0, reason: "No subscriptions" });

  webpush.setVapidDetails(config.subject, config.public_key, config.private_key);

  const stateName = territory?.name ?? attack.territory_id;
  const attackerName = attacker?.display_name ?? "A rival";
  const deadline = new Date(attack.defense_deadline);
  const payload = JSON.stringify({
    title: `${attackerName} attacked ${stateName}`,
    body: `Defend ${stateName} before ${deadline.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC.`,
    tag: `attack-${attack.id}`,
    data: { url: "/", attackId: attack.id, territoryId: attack.territory_id },
  });

  let sent = 0;
  let removed = 0;

  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, payload, { TTL: 60 * 60 * 24, urgency: "high" });
      sent += 1;
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 0;
      if (statusCode === 404 || statusCode === 410) {
        await admin.from("push_subscriptions").delete().eq("id", subscription.id);
        removed += 1;
        return;
      }
      console.error("Push send failed", error);
    }
  }));

  return json({ ok: true, sent, removed });
});
