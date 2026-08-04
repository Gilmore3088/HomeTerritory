"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useGameData } from "@/hooks/game-data-context";
import styles from "./game-runtime-controls.module.css";

const supabase = createClient();

export default function GameRuntimeControls() {
  const { session, snapshot, operation, loadSnapshot, advanceGroupDay } = useGameData();
  const [busy, setBusy] = useState<"turn" | "logout" | "report" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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

  async function endTurn() {
    if (!state || busy || state.activeAttemptId || !state.isMyTurn) return;
    setBusy("turn");
    setMessage(null);
    const { data, error } = await supabase.rpc("end_test_turn", { p_group_id: state.groupId });
    setBusy(null);

    if (error) {
      setMessage(error.message);
      await loadSnapshot();
      return;
    }

    const result = data as { next_display_name?: string };
    setMessage(`${result.next_display_name ?? "The next player"} is up.`);
    await loadSnapshot();
  }

  async function reportQuestion() {
    if (!state?.activeAttemptId || busy) return;
    const reason = window.prompt(
      "What is wrong with this question?",
      "The question may be inaccurate, ambiguous, duplicated, or mismatched to its difficulty.",
    );
    if (reason === null) return;

    setBusy("report");
    const { data, error } = await supabase.rpc("report_question", {
      p_attempt_id: state.activeAttemptId,
      p_reason: reason.trim() || "Player reported a possible question problem",
    });
    setBusy(null);

    if (error) {
      window.alert(`Could not report question: ${error.message}`);
      return;
    }

    // A question is only quarantined once three separate players report it, so
    // report_question is the one that knows which outcome the player just got.
    window.alert((data as { message?: string } | null)?.message ?? "Report filed and your move was refunded.");
    await loadSnapshot();
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
      <button type="button" className={styles.logout} onClick={logout} disabled={Boolean(busy)}>
        {busy === "logout" ? "Signing out…" : "Log out"}
      </button>

      {isCommissioner && snapshot?.season && (
        <button type="button" className={styles.logout} onClick={() => advanceGroupDay()} disabled={Boolean(busy)}>
          Advance the day
        </button>
      )}

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
