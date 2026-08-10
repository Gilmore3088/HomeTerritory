"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./game-runtime-controls.module.css";

const supabase = createClient();
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function applicationServerKey(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/**
 * Opt-in web-push for defense alerts. Renders nothing when push is not
 * configured (no VAPID key) or the browser cannot do it; otherwise a small
 * toggle that subscribes this browser and stores the subscription under RLS.
 */
export default function PushAlertsButton({ userId, notify }: { userId: string; notify: (text: string, error?: boolean) => void }) {
  const [status, setStatus] = useState<"unsupported" | "off" | "on" | "denied" | "busy">("unsupported");

  useEffect(() => {
    if (!VAPID_PUBLIC_KEY || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
    let mounted = true;
    // State writes stay in the promise continuation (house style: no
    // setState directly in an effect body).
    async function detect() {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!mounted) return;
      if (Notification.permission === "denied") {
        setStatus("denied");
        return;
      }
      const subscription = await registration?.pushManager.getSubscription();
      if (mounted) setStatus(subscription ? "on" : "off");
    }
    void detect();
    return () => {
      mounted = false;
    };
  }, []);

  async function enable() {
    if (!VAPID_PUBLIC_KEY) return;
    setStatus("busy");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "off");
        return;
      }
      const registration = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(VAPID_PUBLIC_KEY) as unknown as BufferSource,
      });
      const json = subscription.toJSON();
      const { error } = await supabase.from("push_subscriptions").upsert({
        user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
      }, { onConflict: "endpoint" });
      if (error) throw new Error(error.message);
      setStatus("on");
      notify("Defense alerts are on for this device.");
    } catch (cause) {
      setStatus("off");
      notify(`Could not enable alerts: ${cause instanceof Error ? cause.message : "unknown error"}`, true);
    }
  }

  async function disable() {
    setStatus("busy");
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", subscription.endpoint);
        await subscription.unsubscribe();
      }
      setStatus("off");
      notify("Defense alerts are off for this device.");
    } catch (cause) {
      setStatus("on");
      notify(`Could not disable alerts: ${cause instanceof Error ? cause.message : "unknown error"}`, true);
    }
  }

  if (status === "unsupported" || status === "denied") return null;

  return (
    <button
      type="button"
      className={styles.alerts}
      onClick={status === "on" ? disable : enable}
      disabled={status === "busy"}
    >
      {status === "busy" ? "Alerts…" : status === "on" ? "Alerts on" : "Enable alerts"}
    </button>
  );
}
