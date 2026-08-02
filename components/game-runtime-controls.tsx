"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import styles from "./game-runtime-controls.module.css";

const SUPABASE_URL = "https://gduvdnpxgdniogmxxlmg.supabase.co";
const SUPABASE_KEY = "sb_publishable_Xgxcnh4NUlZ7dkYHeC-xiw_mOmxQxGZ";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

type GroupRow = {
  id: string;
  status: "lobby" | "active" | "ended";
};

type Snapshot = {
  group: { id: string; status: string; test_mode?: boolean };
  season: null | {
    status: string;
    current_turn_name?: string | null;
    turn_number?: number;
  };
  attacks?: Array<{ defender_id: string; status: string }>;
  current_user_id: string;
  actions_remaining: number;
  is_my_turn?: boolean;
};

type ActiveSession = {
  question?: { attempt_id?: string };
};

type RuntimeState = {
  groupId: string;
  testMode: boolean;
  isMyTurn: boolean;
  currentTurnName: string;
  turnNumber: number;
  movesRemaining: number;
  hasDefense: boolean;
  activeAttemptId: string | null;
};

type BusyAction = "turn" | "logout" | "report" | "alerts";

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

export default function GameRuntimeControls() {
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<RuntimeState | null>(null);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [alertsSupported, setAlertsSupported] = useState(false);
  const [alertsEnabled, setAlertsEnabled] = useState(false);

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
    const group = groups.find((row) => row.id === saved)
      ?? groups.find((row) => row.status === "active")
      ?? groups[0];

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

    const snapshot = snapshotResponse.data as Snapshot;
    const activeGameSession = (sessionResponse.data ?? null) as ActiveSession | null;
    const hasDefense = Boolean(snapshot.attacks?.some(
      (attack) => attack.defender_id === snapshot.current_user_id && attack.status === "contested",
    ));

    setMessage(null);
    setState({
      groupId: group.id,
      testMode: Boolean(snapshot.group.test_mode),
      isMyTurn: snapshot.is_my_turn !== false,
      currentTurnName: snapshot.season?.current_turn_name ?? "Another player",
      turnNumber: snapshot.season?.turn_number ?? 1,
      movesRemaining: snapshot.actions_remaining ?? 0,
      hasDefense,
      activeAttemptId: activeGameSession?.question?.attempt_id ?? null,
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      void load(data.session);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      void load(nextSession);
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, [load]);

  useEffect(() => {
    const supported = typeof window !== "undefined"
      && "serviceWorker" in navigator
      && "PushManager" in window
      && "Notification" in window;
    setAlertsSupported(supported);
    if (!supported) return;

    navigator.serviceWorker.register("/sw.js")
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setAlertsEnabled(Boolean(subscription)))
      .catch(() => setAlertsEnabled(false));
  }, []);

  useEffect(() => {
    if (!session) return;
    const refresh = () => void load(session);
    const interval = window.setInterval(refresh, 5_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [session, load]);

  const waiting = useMemo(
    () => Boolean(state?.testMode && !state.isMyTurn && !state.hasDefense && !state.activeAttemptId),
    [state],
  );

  useEffect(() => {
    document.body.dataset.territoryWaiting = waiting ? "true" : "false";
    return () => {
      delete document.body.dataset.territoryWaiting;
    };
  }, [waiting]);

  async function endTurn() {
    if (!state || busy || state.activeAttemptId || !state.isMyTurn) return;
    setBusy("turn");
    setMessage(null);
    const { data, error } = await supabase.rpc("end_test_turn", { p_group_id: state.groupId });
    setBusy(null);

    if (error) {
      setMessage(error.message);
      await load(session);
      return;
    }

    const result = data as { next_display_name?: string };
    setMessage(`${result.next_display_name ?? "The next player"} is up.`);
    await load(session);
  }

  async function reportQuestion() {
    if (!state?.activeAttemptId || busy) return;
    const reason = window.prompt(
      "What is wrong with this question?",
      "The question may be inaccurate, ambiguous, duplicated, or mismatched to its difficulty.",
    );
    if (reason === null) return;

    setBusy("report");
    const { error } = await supabase.rpc("report_question", {
      p_attempt_id: state.activeAttemptId,
      p_reason: reason.trim() || "Player reported a possible question problem",
    });
    setBusy(null);

    if (error) {
      window.alert(`Could not report question: ${error.message}`);
      return;
    }

    window.alert("Question quarantined and your move was refunded.");
    window.location.reload();
  }

  async function toggleAlerts() {
    if (!state || !alertsSupported || busy) return;
    setBusy("alerts");

    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      let subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        await supabase.rpc("remove_push_subscription", { p_endpoint: subscription.endpoint });
        await subscription.unsubscribe();
        setAlertsEnabled(false);
        setMessage("Defense alerts are off on this device.");
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMessage("Notification permission was not granted.");
        return;
      }

      const { data: publicKey, error: keyError } = await supabase.rpc("get_push_public_key");
      if (keyError || !publicKey) throw new Error(keyError?.message ?? "Push key unavailable");

      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(String(publicKey)),
      });

      const serialized = subscription.toJSON();
      if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys?.auth) {
        throw new Error("The browser returned an incomplete push subscription");
      }

      const { error: saveError } = await supabase.rpc("upsert_push_subscription", {
        p_group_id: state.groupId,
        p_endpoint: serialized.endpoint,
        p_p256dh: serialized.keys.p256dh,
        p_auth: serialized.keys.auth,
      });
      if (saveError) throw saveError;

      setAlertsEnabled(true);
      setMessage("Defense alerts are enabled on this device.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update alerts");
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    if (busy) return;
    setBusy("logout");
    const { error } = await supabase.auth.signOut();
    if (error) {
      setBusy(null);
      window.alert(`Could not log out: ${error.message}`);
      return;
    }
    window.location.replace("/");
  }

  if (!session) return null;

  return (
    <>
      <div className={styles.accountActions}>
        {alertsSupported && state && (
          <button type="button" className={styles.alerts} onClick={toggleAlerts} disabled={Boolean(busy)}>
            {busy === "alerts" ? "Updating…" : alertsEnabled ? "Alerts on" : "Enable alerts"}
          </button>
        )}
        <button type="button" className={styles.logout} onClick={logout} disabled={Boolean(busy)}>
          {busy === "logout" ? "Signing out…" : "Log out"}
        </button>
      </div>

      {state?.activeAttemptId && (
        <button type="button" className={styles.report} onClick={reportQuestion} disabled={Boolean(busy)}>
          {busy === "report" ? "Reporting…" : "Report question"}
        </button>
      )}

      {state?.testMode && !state.activeAttemptId && (
        <aside className={`${styles.turn} ${state.isMyTurn ? styles.yourTurn : styles.waiting}`} aria-live="polite">
          <div>
            <span>TURN {state.turnNumber}</span>
            <strong>{state.isMyTurn ? "Your turn" : `${state.currentTurnName}’s turn`}</strong>
            <small>
              {message ?? (state.isMyTurn
                ? `${state.movesRemaining} move${state.movesRemaining === 1 ? "" : "s"} remaining`
                : state.hasDefense
                  ? "You may defend while waiting."
                  : "The map is read-only until your turn.")}
            </small>
          </div>
          {state.isMyTurn && (
            <button type="button" onClick={endTurn} disabled={busy === "turn"}>
              {busy === "turn" ? "Ending…" : "End turn"}
            </button>
          )}
        </aside>
      )}
    </>
  );
}
