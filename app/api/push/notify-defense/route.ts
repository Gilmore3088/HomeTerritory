import { NextResponse } from "next/server";
import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";

// Best-effort defender alert, fired by the attacker's client the moment an
// attack lands. The client is untrusted: this route re-reads the attack under
// the secret key, only ever notifies the defender the database names, and
// claims the attack atomically so repeated calls send nothing twice.
export async function POST(request: Request) {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    return NextResponse.json({ error: "Push is not configured" }, { status: 503 });
  }

  let attackId: string | null = null;
  try {
    const body = await request.json();
    attackId = typeof body?.attack_id === "string" ? body.attack_id : null;
  } catch {
    attackId = null;
  }
  if (!attackId) return NextResponse.json({ error: "attack_id is required" }, { status: 400 });

  const supabase = createAdminClient();

  // Claim the attack: only a live, recent, unclaimed attack sends. The
  // filtered update is the dedupe -- a second caller matches zero rows.
  const { data: attack, error: claimError } = await supabase
    .from("attacks")
    .update({ defender_notified_at: new Date().toISOString() })
    .eq("id", attackId)
    .eq("status", "contested")
    .is("defender_notified_at", null)
    .gt("created_at", new Date(Date.now() - 10 * 60_000).toISOString())
    .select("id,territory_id,attacker_id,defender_id")
    .maybeSingle();

  if (claimError) return NextResponse.json({ error: claimError.message }, { status: 500 });
  if (!attack) return NextResponse.json({ ok: true, sent: 0 });

  const [{ data: territory }, { data: attacker }, { data: subscriptions, error: subsError }] = await Promise.all([
    supabase.from("territories").select("name").eq("id", attack.territory_id).maybeSingle(),
    supabase.from("profiles").select("display_name").eq("id", attack.attacker_id).maybeSingle(),
    supabase.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id", attack.defender_id),
  ]);
  if (subsError) return NextResponse.json({ error: subsError.message }, { status: 500 });
  if (!subscriptions?.length) return NextResponse.json({ ok: true, sent: 0 });

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
    publicKey,
    privateKey,
  );

  const payload = JSON.stringify({
    title: `${territory?.name ?? "Your state"} is under attack`,
    body: `${attacker?.display_name ?? "A rival"} put ${territory?.name ?? "your state"} under attack. One correct answer defends it — you have 24 hours.`,
    tag: `attack-${attack.id}`,
    url: "/",
  });

  let sent = 0;
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        payload,
      );
      sent += 1;
    } catch (cause) {
      const status = (cause as { statusCode?: number }).statusCode;
      // 404/410 means the browser dropped the subscription; clean it up.
      if (status === 404 || status === 410) {
        await supabase.from("push_subscriptions").delete().eq("id", subscription.id);
      }
    }
  }));

  return NextResponse.json({ ok: true, sent });
}
