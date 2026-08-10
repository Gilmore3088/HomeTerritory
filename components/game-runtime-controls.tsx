"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useGameData } from "@/hooks/game-data-context";
import PushAlertsButton from "@/components/push-alerts";
import styles from "./game-runtime-controls.module.css";

const supabase = createClient();
const DEFAULT_REPORT_REASON = "The question may be inaccurate, ambiguous, duplicated, or mismatched to its difficulty.";

export default function GameRuntimeControls() {
  const { session, snapshot, operation, loadSnapshot, advanceGroupDay, notify } = useGameData();
  const [busy, setBusy] = useState<"turn" | "logout" | "report" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState(DEFAULT_REPORT_REASON);
  const messageTimer = useRef<number | null>(null);

  const isCommissioner = Boolean(snapshot && snapshot.group.commissioner_id === snapshot.current_user_id);

  const state = useMemo(() => {
    if (!session || !snapshot) return null;
    const hasDefense = Boolean(
      snapshot.attacks?.some((a) => a.defender_id === snapshot.current_user_id && a.status === "contested"),
    );
    return {
      groupId: snapshot.group.id,
      testMode: Boolean(snapshot.group.test_mode),
      isMyTurn: snapshot.is_my_turn !== false,
      currentTurnName: snapshot.season?.current_turn_name ?? "Another player",
      turnNumber: snapshot.season?.turn_number ?? 1,
      movesRemaining: snapshot.actions_remaining ?? 0,
      hasDefense,
      activeAttemptId: operation?.question?.attempt_id ?? null,
    };
  }, [session, snapshot, operation]);

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

  // The old 5s poll used to reset the banner line; since the P2a data merge
  // nothing did, so "X is up" lingered until the next end-turn.
  function flashMessage(text: string) {
    if (messageTimer.current) window.clearTimeout(messageTimer.current);
    setMessage(text);
    messageTimer.current = window.setTimeout(() => setMessage(null), 6000);
  }
  useEffect(() => () => {
    if (messageTimer.current) window.clearTimeout(messageTimer.current);
  }, []);

  async function endTurn() {
    if (!state || busy || state.activeAttemptId || !state.isMyTurn) return;
    setBusy("turn");
    setMessage(null);
    const { data, error } = await supabase.rpc("end_test_turn", { p_group_id: state.groupId });
    setBusy(null);

    if (error) {
      flashMessage(error.message);
      await loadSnapshot();
      return;
    }

    const result = data as { next_display_name?: string };
    flashMessage(`${result.next_display_name ?? "The next player"} is up.`);
    await loadSnapshot();
  }

  async function submitReport() {
    if (!state?.activeAttemptId || busy) return;
    setBusy("report");
    const { data, error } = await supabase.rpc("report_question", {
      p_attempt_id: state.activeAttemptId,
      p_reason: reportReason.trim() || "Player reported a possible question problem",
    });
    setBusy(null);
    setReportOpen(false);
    setReportReason(DEFAULT_REPORT_REASON);

    if (error) {
      notify(`Could not report question: ${error.message}`, true);
      return;
    }

    // A question is only quarantined once three separate players report it, so
    // report_question is the one that knows which outcome the player just got.
    notify((data as { message?: string } | null)?.message ?? "Report filed and your move was refunded.");
    await loadSnapshot();
  }

  async function logout() {
    if (busy) return;
    setBusy("logout");
    const { error } = await supabase.auth.signOut();
    if (error) {
      setBusy(null);
      notify(`Could not log out: ${error.message}`, true);
      return;
    }
    window.location.replace("/");
  }

  if (!session) return null;

  return (
    <>
      <button type="button" className={styles.logout} onClick={logout} disabled={Boolean(busy)}>
        {busy === "logout" ? "Signing out…" : "Log out"}
      </button>

      <PushAlertsButton userId={session.user.id} notify={notify} />

      {isCommissioner && snapshot?.season && (
        <button type="button" className={styles.advance} onClick={() => advanceGroupDay()} disabled={Boolean(busy)}>
          Advance the day
        </button>
      )}

      {state?.activeAttemptId && (
        <button type="button" className={styles.report} onClick={() => setReportOpen(true)} disabled={Boolean(busy)}>
          {busy === "report" ? "Reporting…" : "Report question"}
        </button>
      )}

      {reportOpen && state?.activeAttemptId && (
        <div className={styles.reportScrim} onClick={() => setReportOpen(false)}>
          <section className={styles.reportDialog} role="dialog" aria-modal="true" aria-label="Report this question" onClick={(event) => event.stopPropagation()}>
            <h2>Report this question</h2>
            <p>Your move is refunded immediately. Three separate reports quarantine the question for every league.</p>
            <textarea
              value={reportReason}
              onChange={(event) => setReportReason(event.target.value)}
              rows={4}
              maxLength={500}
              autoFocus
            />
            <div className={styles.reportActions}>
              <button type="button" onClick={() => setReportOpen(false)} disabled={busy === "report"}>Keep playing</button>
              <button type="button" className={styles.reportSubmit} onClick={submitReport} disabled={busy === "report"}>
                {busy === "report" ? "Reporting…" : "File report"}
              </button>
            </div>
          </section>
        </div>
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
                  ? "You may defend while waiting — defending never spends a move."
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
