"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

export function useSupabaseSession(): { session: Session | null; authReady: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setAuthReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!mounted) return;
      setSession(next);
      setAuthReady(true);
    });
    // getSession() can stall indefinitely when another tab of the same origin
    // holds auth-js's navigator.locks web lock (the "stuck on Enter the map /
    // endless loading" window states). If neither the initial read nor an
    // auth event has resolved shortly, unblock the UI as signed-out; the auth
    // listener still corrects the state the moment the lock frees up.
    const watchdog = window.setTimeout(() => {
      if (mounted) setAuthReady(true);
    }, 4000);
    return () => {
      mounted = false;
      window.clearTimeout(watchdog);
      data.subscription.unsubscribe();
    };
  }, []);

  return { session, authReady };
}
