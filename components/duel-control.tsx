"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import styles from "./duel-control.module.css";

const supabase = createClient(
  "https://gduvdnpxgdniogmxxlmg.supabase.co",
  "sb_publishable_Xgxcnh4NUlZ7dkYHeC-xiw_mOmxQxGZ",
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

type Group = { id: string; status: string };
type Member = { user_id: string; display_name: string; is_bot?: boolean };
type Duel = {
  id: string;
  status: "pending" | "active" | "declined" | "completed" | "expired";
  territory_id?: string | null;
  challenger_id: string;
  challenger_name: string;
  opponent_id: string;
  opponent_name: string;
  winner_id?: string | null;
  challenger_score?: number | null;
  opponent_score?: number | null;
  challenger_time_ms?: number | null;
  opponent_time_ms?: number | null;
  my_answered: number;
  their_answered: number;
};
type DuelQuestion = {
  status: "question" | "waiting";
  duel_id?: string;
  question_id?: string;
  text?: string;
  format?: "multiple_choice" | "free_fill";
  options?: string[];
  tier?: number;
  sport?: string;
  expires_at?: string;
  number?: number;
};

export default function DuelControl() {
  const [session, setSession] = useState<Session | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [duels, setDuels] = useState<Duel[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<DuelQuestion | null>(null);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(45);
  const startedAt = useRef(0);
  const submitting = useRef(false);

  const load = useCallback(async (activeSession: Session | null) => {
    if (!activeSession) {
      setGroupId(null);
      setMembers([]);
      setDuels([]);
      return;
    }

    const { data: groupRows } = await supabase.rpc("get_my_groups");
    const groups = (groupRows ?? []) as Group[];
    const saved = window.localStorage.getItem("territory_group");
    const group = groups.find((item) => item.id === saved)
      ?? groups.find((item) => item.status === "active")
      ?? groups[0];
    if (!group) return;

    const [snapshotResponse, duelResponse] = await Promise.all([
      supabase.rpc("group_snapshot", { p_group_id: group.id }),
      supabase.rpc("get_my_duels", { p_group_id: group.id }),
    ]);

    if (snapshotResponse.error) {
      setError(snapshotResponse.error.message);
      return;
    }
    if (duelResponse.error) {
      setError(duelResponse.error.message);
      return;
    }

    const snapshot = snapshotResponse.data as { current_user_id: string; members: Member[] };
    setGroupId(group.id);
    setCurrentUserId(snapshot.current_user_id);
    setMembers(snapshot.members ?? []);
    setDuels((duelResponse.data ?? []) as Duel[]);
    setError(null);
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
    if (!open || !session) return;
    const interval = window.setInterval(() => void load(session), 10_000);
    return () => window.clearInterval(interval);
  }, [open, session, load]);

  useEffect(() => {
    if (question?.status !== "question" || !question.expires_at) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((new Date(question.expires_at!).getTime() - Date.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0 && !submitting.current) void submitAnswer("");
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [question?.question_id]);

  const opponents = useMemo(
    () => members.filter((member) => member.user_id !== currentUserId && !member.is_bot),
    [members, currentUserId],
  );

  async function createDuel(opponentId: string) {
    if (!groupId || busy) return;
    setBusy(true);
    setError(null);
    const { error: duelError } = await supabase.rpc("create_duel", {
      p_group_id: groupId,
      p_opponent_id: opponentId,
      p_territory_id: null,
    });
    setBusy(false);
    if (duelError) setError(duelError.message);
    else await load(session);
  }

  async function respond(duelId: string, accept: boolean) {
    setBusy(true);
    const { error: responseError } = await supabase.rpc("respond_duel", {
      p_duel_id: duelId,
      p_accept: accept,
    });
    setBusy(false);
    if (responseError) setError(responseError.message);
    else await load(session);
  }

  async function play(duelId: string) {
    setBusy(true);
    setFeedback(null);
    setAnswer("");
    const { data, error: questionError } = await supabase.rpc("begin_duel_question", { p_duel_id: duelId });
    setBusy(false);
    if (questionError) {
      setError(questionError.message);
      return;
    }
    const next = data as DuelQuestion;
    setQuestion(next);
    if (next.status === "question") {
      startedAt.current = performance.now();
      setSeconds(Math.max(0, Math.ceil((new Date(next.expires_at!).getTime() - Date.now()) / 1000)));
    } else {
      setFeedback("Your answers are locked. Waiting for the other player.");
      await load(session);
    }
  }

  async function submitAnswer(value = answer) {
    if (!question?.duel_id || !question.question_id || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    const responseMs = Math.round(performance.now() - startedAt.current);
    const { data, error: submitError } = await supabase.rpc("submit_duel_answer", {
      p_duel_id: question.duel_id,
      p_question_id: question.question_id,
      p_answer: value,
      p_response_ms: responseMs,
    });
    setBusy(false);
    submitting.current = false;
    if (submitError) {
      setError(submitError.message);
      return;
    }

    const result = data as { correct: boolean; correct_answer: string; status: string };
    setFeedback(`${result.correct ? "Correct" : "Incorrect"}. Answer: ${result.correct_answer}`);
    setQuestion({ status: result.status === "continue" ? "waiting" : "waiting", duel_id: question.duel_id });
    setAnswer("");
    await load(session);
  }

  async function nextQuestion() {
    if (!question?.duel_id) return;
    await play(question.duel_id);
  }

  if (!session || !groupId) return null;

  return (
    <>
      <button type="button" className={styles.launch} onClick={() => { setOpen(true); void load(session); }}>
        Duels
      </button>

      {open && (
        <div className={styles.scrim} onClick={() => setOpen(false)}>
          <section className={styles.modal} onClick={(event) => event.stopPropagation()}>
            <header>
              <div><span>HEAD TO HEAD</span><h2>Duels</h2></div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close duels">×</button>
            </header>

            {error && <div className={styles.error}>{error}</div>}

            {question?.status === "question" && (
              <div className={styles.question}>
                <div className={styles.questionMeta}>QUESTION {question.number} OF 3 · {question.sport} · {seconds}s</div>
                <h3>{question.text}</h3>
                {question.format === "multiple_choice" ? (
                  <div className={styles.answers}>
                    {(question.options ?? []).map((option) => (
                      <button type="button" key={option} onClick={() => setAnswer(option)} className={answer === option ? styles.selected : ""}>{option}</button>
                    ))}
                  </div>
                ) : (
                  <input value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitAnswer(); }} placeholder="Type your answer" autoFocus />
                )}
                <button type="button" className={styles.primary} disabled={!answer || busy} onClick={() => submitAnswer()}>{busy ? "Checking…" : "Lock answer"}</button>
              </div>
            )}

            {feedback && question?.status !== "question" && (
              <div className={styles.feedback}>
                <strong>{feedback}</strong>
                {question?.duel_id && <button type="button" className={styles.primary} onClick={nextQuestion}>Continue duel</button>}
              </div>
            )}

            {!question && (
              <>
                <div className={styles.sectionTitle}>Open duels</div>
                <div className={styles.list}>
                  {duels.filter((duel) => duel.status === "pending" || duel.status === "active").map((duel) => {
                    const incoming = duel.opponent_id === currentUserId && duel.status === "pending";
                    const other = duel.challenger_id === currentUserId ? duel.opponent_name : duel.challenger_name;
                    return (
                      <article key={duel.id}>
                        <div><strong>{other}</strong><small>{duel.status === "pending" ? incoming ? "Challenged you" : "Invitation sent" : `${duel.my_answered}/3 you · ${duel.their_answered}/3 them`}</small></div>
                        <div className={styles.rowActions}>
                          {incoming && <><button type="button" onClick={() => respond(duel.id, true)}>Accept</button><button type="button" onClick={() => respond(duel.id, false)}>Decline</button></>}
                          {duel.status === "active" && duel.my_answered < 3 && <button type="button" onClick={() => play(duel.id)}>Play</button>}
                          {duel.status === "active" && duel.my_answered >= 3 && <span>Waiting</span>}
                        </div>
                      </article>
                    );
                  })}
                  {!duels.some((duel) => duel.status === "pending" || duel.status === "active") && <p>No open duels.</p>}
                </div>

                <div className={styles.sectionTitle}>Challenge a player</div>
                <div className={styles.opponents}>
                  {opponents.map((member) => <button type="button" key={member.user_id} disabled={busy} onClick={() => createDuel(member.user_id)}>{member.display_name}</button>)}
                </div>

                {duels.some((duel) => duel.status === "completed") && <div className={styles.sectionTitle}>Completed</div>}
                <div className={styles.list}>
                  {duels.filter((duel) => duel.status === "completed").slice(0, 5).map((duel) => {
                    const other = duel.challenger_id === currentUserId ? duel.opponent_name : duel.challenger_name;
                    const mine = duel.challenger_id === currentUserId ? duel.challenger_score : duel.opponent_score;
                    const theirs = duel.challenger_id === currentUserId ? duel.opponent_score : duel.challenger_score;
                    return <article key={duel.id}><div><strong>{other}</strong><small>{duel.winner_id === currentUserId ? "You won" : duel.winner_id ? "You lost" : "Tie"}</small></div><b>{mine ?? 0}–{theirs ?? 0}</b></article>;
                  })}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
