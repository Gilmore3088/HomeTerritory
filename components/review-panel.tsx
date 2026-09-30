"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

interface QueueItem {
  id: string;
  territory_id: string;
  sport: string;
  tier: number;
  format: string;
  question_text: string;
  options: string[];
  correct_answer: string;
  aliases: string[];
  active: boolean;
  retired_reason: string | null;
  attempt_count: number;
  correct_count: number;
  gate_c_issues: string[][];
  report_count: number;
}

const wrap: React.CSSProperties = { maxWidth: 760, margin: "0 auto", padding: "24px 16px", fontFamily: "inherit" };
const card: React.CSSProperties = { border: "1px solid #3a3a3a", borderRadius: 10, padding: 16, marginBottom: 16 };
const tag: React.CSSProperties = { display: "inline-block", padding: "2px 8px", borderRadius: 6, fontSize: 12, marginRight: 8, background: "#2a2a2a" };
const warnTag: React.CSSProperties = { ...tag, background: "#5b2120" };
const button: React.CSSProperties = { padding: "8px 16px", borderRadius: 8, border: "1px solid #555", cursor: "pointer", marginRight: 8, background: "transparent", color: "inherit" };

/**
 * Reviewer-only queue over review_queue / review_decide. The RPCs enforce
 * profiles.is_reviewer server-side; this surface just renders the refusal
 * for everyone else, so there is nothing to hide or gate client-side.
 */
export default function ReviewPanel() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    // State writes stay in the promise continuation (house style: no
    // setState directly in an effect body).
    async function load() {
      const { data, error } = await supabase.rpc("review_queue", { p_limit: 20 });
      if (!mounted) return;
      if (error) {
        setRefusal(error.message.includes("Not a reviewer")
          ? "This page is for question reviewers. Ask the game owner for access."
          : error.message);
        setItems(null);
        return;
      }
      setRefusal(null);
      setItems((data ?? []) as QueueItem[]);
    }
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  async function decide(id: string, verdict: "approve" | "retire") {
    setBusy(id);
    setMessage(null);
    const { error } = await supabase.rpc("review_decide", {
      p_question_id: id,
      p_verdict: verdict,
      p_note: notes[id]?.trim() || null,
    });
    setBusy(null);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage(verdict === "approve" ? "Approved — back in play at full weight." : "Retired.");
    setItems((current) => (current ?? []).filter((item) => item.id !== id));
  }

  if (refusal) {
    return (
      <main style={wrap}>
        <h1>Question review</h1>
        <p>{refusal}</p>
      </main>
    );
  }

  return (
    <main style={wrap}>
      <h1>Question review</h1>
      <p style={{ opacity: 0.8 }}>
        Generated questions with unresolved Gate C flags or player reports come first.
        Approving puts a question back in play and marks it human-reviewed; retiring
        removes it permanently (recompiles never resurrect it).
      </p>
      {message ? <p role="status">{message}</p> : null}
      {items === null ? <p>Loading…</p> : null}
      {items?.length === 0 ? <p>Nothing waiting for review. 🎉</p> : null}
      {items?.map((item) => (
        <section key={item.id} style={card}>
          <div style={{ marginBottom: 8 }}>
            <span style={tag}>{item.territory_id}</span>
            <span style={tag}>{item.sport}</span>
            <span style={tag}>tier {item.tier}</span>
            <span style={tag}>{item.format === "multiple_choice" ? "multiple choice" : "free fill"}</span>
            {item.report_count > 0 ? <span style={warnTag}>{item.report_count} player report{item.report_count > 1 ? "s" : ""}</span> : null}
            {!item.active && item.retired_reason ? <span style={warnTag}>retired: {item.retired_reason}</span> : null}
          </div>
          <p style={{ fontSize: 17, marginBottom: 6 }}>{item.question_text}</p>
          <p style={{ marginBottom: 6 }}>
            <strong>Answer:</strong> {item.correct_answer}
            {item.aliases.length > 1 ? <span style={{ opacity: 0.7 }}> (also accepts {item.aliases.filter((alias) => alias !== item.correct_answer).join(", ")})</span> : null}
          </p>
          {item.format === "multiple_choice" ? (
            <p style={{ marginBottom: 6, opacity: 0.85 }}>Options: {item.options.join(" · ")}</p>
          ) : null}
          {item.attempt_count > 0 ? (
            <p style={{ marginBottom: 6, opacity: 0.85 }}>
              Live: {item.correct_count}/{item.attempt_count} answered correctly
            </p>
          ) : null}
          {item.gate_c_issues.length > 0 ? (
            <ul style={{ margin: "6px 0 6px 18px" }}>
              {item.gate_c_issues.flat().map((issue, index) => (
                <li key={index} style={{ color: "#e8a0a0" }}>{issue}</li>
              ))}
            </ul>
          ) : null}
          <input
            type="text"
            placeholder="Optional note (recorded on the flag)"
            value={notes[item.id] ?? ""}
            onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))}
            style={{ width: "100%", padding: 8, marginBottom: 10, borderRadius: 6, border: "1px solid #444", background: "transparent", color: "inherit" }}
          />
          <div>
            <button style={button} disabled={busy === item.id} onClick={() => void decide(item.id, "approve")}>
              Approve
            </button>
            <button style={{ ...button, borderColor: "#a55" }} disabled={busy === item.id} onClick={() => void decide(item.id, "retire")}>
              Retire
            </button>
          </div>
        </section>
      ))}
    </main>
  );
}
