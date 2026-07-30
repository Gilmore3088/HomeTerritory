"use client";

import { useEffect, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import styles from "./logout-control.module.css";

const SUPABASE_URL = "https://gduvdnpxgdniogmxxlmg.supabase.co";
const SUPABASE_KEY = "sb_publishable_Xgxcnh4NUlZ7dkYHeC-xiw_mOmxQxGZ";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export default function LogoutControl() {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (active) setSession(nextSession);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  if (!session) return null;

  async function signOut() {
    setBusy(true);
    const { error } = await supabase.auth.signOut();

    if (error) {
      setBusy(false);
      window.alert(`Could not log out: ${error.message}`);
      return;
    }

    window.location.replace("/");
  }

  return (
    <button
      type="button"
      className={styles.button}
      onClick={signOut}
      disabled={busy}
      aria-label="Log out of Territory"
    >
      <span className={styles.icon} aria-hidden="true">↪</span>
      <span>{busy ? "Signing out…" : "Log out"}</span>
    </button>
  );
}
