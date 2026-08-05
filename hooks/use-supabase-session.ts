"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { clearSavedGroupId } from "@/lib/group-storage";

export function useSupabaseSession(): { session: Session | null; authReady: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const lastUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      lastUserIdRef.current = data.session?.user.id ?? lastUserIdRef.current;
      setSession(data.session);
      setAuthReady(true);
    });
    // This callback MUST stay synchronous: supabase-js serializes auth work
    // behind a navigator.locks Web Lock, and awaiting another Supabase call in
    // here deadlocks every subsequent request (supabase-js#1594). setState
    // only; anything async belongs in an effect reacting to the state.
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!mounted) return;
      const previousUserId = lastUserIdRef.current;
      const nextUserId = next?.user.id ?? null;
      if (nextUserId === null && previousUserId !== null) {
        clearSavedGroupId(previousUserId);
      }
      lastUserIdRef.current = nextUserId ?? previousUserId;
      setSession(next);
      setAuthReady(true);
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return { session, authReady };
}
