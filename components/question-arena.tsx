"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { STATE_NAMES } from "@/lib/game-constants";
import { resultCopy } from "@/lib/ux-copy";
import type { ActiveOperation, ResultState } from "@/lib/game-types";
import styles from "./territory-game-v2.module.css";
import { Loading } from "./game-overlays";

const supabase = createClient();

export default function QuestionArena({ operation, result, setOperation, setResult, refresh, notify }: {
  operation: ActiveOperation | null;
  result: ResultState | null;
  setOperation: (operation: ActiveOperation | null) => void;
  setResult: (result: ResultState | null) => void;
  refresh: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const timedOut = useRef(false);
  const question = operation?.question;
  const attemptId = question?.attempt_id ?? null;
  const expiresAt = question?.expires_at ?? null;
  const [servedAttemptId, setServedAttemptId] = useState(attemptId);

  // A new question means a blank answer box. Clearing it as the attempt id
  // changes keeps the reset in the same render that first shows the new
  // question, so the previous answer is never briefly visible under it.
  if (attemptId !== servedAttemptId) {
    setServedAttemptId(attemptId);
    setAnswer("");
  }

  useEffect(() => {
    timedOut.current = false;
  }, [attemptId]);

  // The timer has to reach the newest submit without restarting on every
  // keystroke, so it reads the latest one through a ref instead of listing an
  // identity that changes with the answer box.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });

  useEffect(() => {
    if (!expiresAt) return;
    const deadline = new Date(expiresAt).getTime();
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0 && !timedOut.current && !busy) {
        timedOut.current = true;
        void submitRef.current("");
      }
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [expiresAt, busy]);

  async function submit(value = answer) {
    if (!operation || busy) return;
    const viaTimeout = timedOut.current;
    setBusy(true);
    const { data, error } = await supabase.rpc("game_submit_answer", { p_session_id: operation.session_id, p_answer: value });
    setBusy(false);
    if (error) {
      notify(error.message, true);
      return;
    }
    if (data.status === "active" && data.question) {
      setOperation({ ...operation, question: data.question, correct_count: data.correct_count });
      setAnswer("");
      return;
    }
    if (data.status === "contested" && data.attack_id) {
      // Best-effort defender alert; the server route re-verifies the attack.
      void fetch("/api/push/notify-defense", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attack_id: data.attack_id }),
      }).catch(() => undefined);
    }
    const ok = data.status !== "failed";
    const copy = resultCopy({ status: data.status, timedOut: viaTimeout });
    setOperation(null);
    setResult({
      ok,
      title: copy.title,
      // A timed-out answer keeps the consequence but drops the misleading
      // "Incorrect." prefix -- running out of clock is not a wrong answer.
      message: viaTimeout
        ? (data.message ? `The clock ran out. ${String(data.message).replace(/^Incorrect\.\s*/, "")}` : copy.message)
        : data.message ?? copy.message,
      correctAnswer: data.correct_answer ?? null,
    });
  }

  if (result) {
    return <main className={`${styles.resultPage} ${result.ok ? styles.resultSuccess : styles.resultFailure}`}><div className={styles.resultHalo} /><section><span>{result.ok ? "SUCCESS" : "FAILED"}</span><h1>{result.title}</h1><p>{result.message}</p>{result.correctAnswer && <small>Correct answer: {result.correctAnswer}</small>}<button onClick={() => { setResult(null); refresh(); }}>Return to map</button></section></main>;
  }
  if (!operation || !question) return <Loading label="Restoring question" />;
  const operationLabel = operation.action_type === "home" ? "HOME GROUND" : operation.action_type === "claim" ? "CLAIM" : operation.action_type === "attack" ? "ATTACK" : operation.action_type === "defend" ? "DEFENSE" : "FORTIFY";

  const totalSeconds = question.tier === 3 ? 45 : 30;
  return <main className={styles.questionPage}><div className={styles.questionState}>{operation.territory_id}</div><header><div><span>{operationLabel} · TIER {question.tier}</span><strong>{STATE_NAMES[operation.territory_id]}</strong></div><div className={`${styles.timer} ${seconds <= 8 ? styles.timerDanger : ""}`}>0:{String(seconds).padStart(2, "0")}</div></header><div className={styles.timerTrack} role="presentation"><div className={`${styles.timerFill} ${seconds <= 8 ? styles.timerFillDanger : ""}`} style={{ width: `${Math.max(0, Math.min(100, (seconds / totalSeconds) * 100))}%` }} /></div><section className={styles.questionCard}><div className={styles.streak}>{Array.from({ length: operation.required_correct }, (_, index) => <span key={index} className={index < operation.correct_count ? styles.streakDone : ""} />)}</div><h1>{question.text}</h1>{question.format === "multiple_choice" ? <div className={styles.answerGrid}>{(question.options ?? []).map((option) => <button key={option} className={answer === option ? styles.answerSelected : ""} onClick={() => setAnswer(option)}>{option}</button>)}</div> : <input className={styles.freeAnswer} autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} placeholder="Type your answer" />}<button className={styles.lockButton} disabled={busy || !answer} onClick={() => submit()}>{busy ? "Checking…" : "Lock answer"}</button></section></main>;
}
