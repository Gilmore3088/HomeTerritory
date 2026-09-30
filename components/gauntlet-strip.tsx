"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

interface GauntletState {
  played_on: string;
  size: number;
  my_run: null | { current_index: number; correct_count: number; total_seconds: number; finished: boolean; bonus: number | null };
  leaderboard: Array<{ user_id: string; display_name: string; correct_count: number; total_seconds: number }>;
}

interface GauntletQuestion {
  index: number;
  of: number;
  text: string;
  format: string;
  options: string[];
  sport: string;
  expires_at: string;
}

const box: React.CSSProperties = { border: "1px solid #3a3a3a", borderRadius: 10, padding: 14, margin: "16px 0" };
const button: React.CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid #555", cursor: "pointer", background: "transparent", color: "inherit" };

/**
 * The daily gauntlet: one shared 5-pack per league per day, graded and
 * timed server-side (gauntlet_today / gauntlet_next / gauntlet_answer).
 * Rendered inside the standings overlay.
 */
export default function GauntletStrip({ seasonId }: { seasonId: string }) {
  const [state, setState] = useState<GauntletState | null>(null);
  const [question, setQuestion] = useState<GauntletQuestion | null>(null);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    // State writes stay in the promise continuation (house style).
    async function load() {
      const { data, error } = await supabase.rpc("gauntlet_today", { p_season_id: seasonId });
      if (mounted && !error) setState(data as GauntletState);
    }
    void load();
    return () => {
      mounted = false;
    };
  }, [seasonId]);

  async function reload() {
    const { data, error } = await supabase.rpc("gauntlet_today", { p_season_id: seasonId });
    if (!error) setState(data as GauntletState);
  }

  async function next() {
    setBusy(true);
    setFeedback(null);
    const { data, error } = await supabase.rpc("gauntlet_next", { p_season_id: seasonId });
    setBusy(false);
    if (error) {
      setFeedback(error.message);
      return;
    }
    setAnswer("");
    setQuestion(data as GauntletQuestion);
  }

  async function submit(value: string) {
    setBusy(true);
    const { data, error } = await supabase.rpc("gauntlet_answer", { p_season_id: seasonId, p_answer: value });
    setBusy(false);
    if (error) {
      setFeedback(error.message);
      return;
    }
    const result = data as { status: string; correct: boolean; correct_answer: string; correct_count: number; of: number; bonus?: number };
    if (result.status === "finished") {
      setQuestion(null);
      setFeedback(`Gauntlet done: ${result.correct_count}/${result.of} — +${result.bonus} points.`);
      void reload();
      return;
    }
    setFeedback(result.correct ? "Correct." : `Missed — it was ${result.correct_answer}.`);
    void next();
  }

  if (!state || state.size === 0) return null;

  return (
    <div style={box}>
      <strong>Daily gauntlet</strong>
      <p style={{ opacity: 0.8, margin: "4px 0 10px" }}>
        The same five questions for the whole league. Correct answers pay points; a perfect run pays two extra.
      </p>
      {feedback ? <p role="status">{feedback}</p> : null}
      {question ? (
        <div>
          <p style={{ margin: "6px 0" }}>
            <small style={{ opacity: 0.7 }}>{question.index + 1} of {question.of} · {question.sport}</small>
          </p>
          <p style={{ fontSize: 16, marginBottom: 8 }}>{question.text}</p>
          {question.format === "multiple_choice" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {question.options.map((option) => (
                <button key={option} style={button} disabled={busy} onClick={() => void submit(option)}>{option}</button>
              ))}
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (answer.trim()) void submit(answer.trim());
              }}
              style={{ display: "flex", gap: 6 }}
            >
              <input
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="Your answer"
                style={{ flex: 1, padding: 8, borderRadius: 6, border: "1px solid #444", background: "transparent", color: "inherit" }}
              />
              <button type="submit" style={button} disabled={busy || !answer.trim()}>Answer</button>
            </form>
          )}
        </div>
      ) : state.my_run?.finished ? (
        <p>
          Your run: {state.my_run.correct_count}/{state.size} in {state.my_run.total_seconds}s
          {state.my_run.bonus != null ? ` · +${state.my_run.bonus} points` : ""}
        </p>
      ) : (
        <button style={button} disabled={busy} onClick={() => void next()}>
          {state.my_run ? "Resume today's gauntlet" : "Run today's gauntlet"}
        </button>
      )}
      {state.leaderboard.length > 0 && (
        <ol style={{ margin: "10px 0 0 18px" }}>
          {state.leaderboard.map((row) => (
            <li key={row.user_id}>
              {row.display_name}: {row.correct_count}/{state.size} · {row.total_seconds}s
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
