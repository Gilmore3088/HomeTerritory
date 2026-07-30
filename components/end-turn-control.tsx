"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import styles from "./end-turn-control.module.css";

const SUPABASE_URL = "https://gduvdnpxgdniogmxxlmg.supabase.co";
const SUPABASE_KEY = "sb_publishable_Xgxcnh4NUlZ7dkYHeC-xiw_mOmxQxGZ";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

type GroupRow = {
  id: string;
  status: "lobby" | "active" | "ended";
};

type TurnSnapshot = {
  group: {
    id: string;
    status: string;
    test_mode?: boolean;
  };
  season: null | {
    status: string;
    current_turn_user_id?: string | null;
    current_turn_name?: string | null;
    turn_number?: number;
  };
  actions_remaining: number;
  is_my_turn?: boolean;
};

type ControlState = {
  groupId: string;
  isMyTurn: boolean;
  currentTurnName: string;
  turnNumber: number;
  actionsRemaining: number;
  hasActiveSession: boolean;
};

export default function EndTurnControl() {
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<ControlState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (activeSession: Session | null) => {
    if (!activeSession) {
      setState(null);
      return;
    }

    const { data: groupData, error: groupError } = await supabase.rpc("get_my_groups");
    if (groupError) {
      setMessage(groupError.message);
      return;
    }

    const groups = (groupData ?? []) as GroupRow[];
    const saved = window.localStorage.getItem("territory_group");
    const group = groups.find((row) => row.id === saved) ?? groups.find((row) => row.status === "active") ?? groups[0];
    if (!group) {
      setState(null);
      return;
    }

    const [snapshotResponse, sessionResponse] = await Promise.all([
      supabase.rpc("group_snapshot", { p_group_id: group.id }),
      supabase.rpc("get_my_active_session", { p_group_id: group.id }),
    ]);

    if (snapshotResponse.error) {
      setMessage(snapshotResponse.error.message);
      return;
    }

    const snapshot = snapshotResponse.data as TurnSnapshot;
    if (!snapshot.group.test_mode || snapshot.group.status !== "active" || snapshot.season?.status !== "active") {
      setState(null);
      return;
    }

    setMessage(null);
    setState({
      groupId: group.id,
      isMyTurn: Boolean(snapshot.is_my_turn),
      currentTurnName: snapshot.season.current_turn_name ?? "Another player",
      turnNumber: snapshot.season.turn_number ?? 1,
      actionsRemaining: snapshot.actions_remaining ?? 0,
      hasActiveSession: Boolean(sessionResponse.data),
    });
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      void load(data.session);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      void load(nextSession);
    });

    return () => data.subscription.unsubscribe();
  }, [load]);

  useEffect(() => {
    if (!session) return;
    const refresh = () => void load(session);
    const interval = window.setInterval(refresh, 8_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [session, load]);

  async function endTurn() {
    if (!state || busy || state.hasActiveSession) return;
    setBusy(true);
    setMessage(null);
    const { data, error } = await supabase.rpc("end_test_turn", { p_group_id: state.groupId });
    setBusy(false);

    if (error) {
      setMessage(error.message);
      await load(session);
      return;
    }

    const result = data as { next_display_name?: string };
    setMessage(`${result.next_display_name ?? "The next player"} is up.`);
    await load(session);
  }

  if (!state) return null;

  return (
    <aside className={`${styles.control} ${state.isMyTurn ? styles.yourTurn : styles.waiting}`} aria-live="polite">
      <div className={styles.copy}>
        <span className={styles.eyebrow}>TURN {state.turnNumber}</span>
        <strong>
          {state.isMyTurn
            ? state.hasActiveSession
              ? "Finish the active question"
              : "Your turn"
            : `${state.currentTurnName}’s turn`}
        </strong>
        <small>
          {message ?? (state.isMyTurn
            ? `${state.actionsRemaining} action${state.actionsRemaining === 1 ? "" : "s"} remaining`
            : "You can still answer a defense while waiting.")}
        </small>
      </div>
      {state.isMyTurn && (
        <button type="button" disabled={busy || state.hasActiveSession} onClick={endTurn}>
          {busy ? "Ending…" : "End turn"}
        </button>
      )}
    </aside>
  );
}
