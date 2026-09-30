"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { STATE_NAMES } from "@/lib/game-constants";
import type { Attack } from "@/lib/game-types";

const supabase = createClient();

interface DuelRow {
  attack_id: string;
  territory_id: string;
  status: "proposed" | "active" | "settled";
  attacker_name: string;
  defender_name: string;
  i_am: "attacker" | "defender";
  winner_id: string | null;
  expires_at: string | null;
  question: null | { text: string; format: string; options: string[] };
  answered: boolean;
}

const card: React.CSSProperties = {
  position: "fixed", left: 12, right: 12, bottom: 96, zIndex: 40,
  border: "1px solid #7a3f3f", borderRadius: 12, padding: 14,
  background: "rgba(20,16,16,0.96)", color: "inherit", maxWidth: 560, margin: "0 auto",
};
const button: React.CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid #666", cursor: "pointer", background: "transparent", color: "inherit", marginRight: 8 };

/**
 * Live duels: polls duel_state while a season is open, joins the season's
 * presence channel, and renders whichever side of a duel involves me --
 * the defender's challenge button (on their pending defense), the
 * attacker's accept card, the shared question, and the verdict. Presence
 * only informs the affordance; consent and grading are all server-side.
 */
export default function DuelPanel({ seasonId, currentUserId, pendingDefense }: {
  seasonId: string;
  currentUserId: string;
  pendingDefense?: Attack;
}) {
  const [duels, setDuels] = useState<DuelRow[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [answer, setAnswer] = useState("");
  const [verdict, setVerdict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verdictShownFor = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      const { data, error } = await supabase.rpc("duel_state", { p_season_id: seasonId });
      if (mounted && !error) setDuels((data ?? []) as DuelRow[]);
    }
    void poll();
    const timer = setInterval(() => void poll(), 4000);

    const channel = supabase.channel(`presence:season:${seasonId}`, {
      config: { presence: { key: currentUserId } },
    });
    channel
      .on("presence", { event: "sync" }, () => {
        if (mounted) setOnline(new Set(Object.keys(channel.presenceState())));
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void channel.track({ at: Date.now() });
      });

    return () => {
      mounted = false;
      clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [seasonId, currentUserId]);

  const duel = duels[0];

  useEffect(() => {
    if (!duel || duel.status !== "settled" || verdictShownFor.current === duel.attack_id) return;
    verdictShownFor.current = duel.attack_id;
    const won = duel.winner_id === currentUserId;
    setVerdict(won ? "You won the duel — the state is settled." : "Your opponent answered first. The state is theirs to keep.");
  }, [duel, currentUserId]);

  async function call(fn: string, args: Record<string, unknown>, after?: (data: unknown) => void) {
    setBusy(true);
    const { data, error } = await supabase.rpc(fn, args);
    setBusy(false);
    if (error) {
      setVerdict(error.message);
      return;
    }
    after?.(data);
    const refreshed = await supabase.rpc("duel_state", { p_season_id: seasonId });
    if (!refreshed.error) setDuels((refreshed.data ?? []) as DuelRow[]);
  }

  // Defender-side challenge affordance for a pending async defense with no
  // duel yet. Presence just annotates whether the attacker is here now.
  const canChallenge = pendingDefense && !duels.some((d) => d.attack_id === pendingDefense.id);
  const attackerOnline = pendingDefense ? online.has(pendingDefense.attacker_id) : false;

  if (!duel && !canChallenge && !verdict) return null;

  return (
    <div style={card}>
      {verdict ? (
        <p role="status" style={{ marginBottom: duel || canChallenge ? 10 : 0 }}>
          {verdict} <button style={{ ...button, padding: "2px 8px" }} onClick={() => setVerdict(null)}>✕</button>
        </p>
      ) : null}
      {canChallenge && pendingDefense ? (
        <div>
          <strong>Live duel?</strong>
          <p style={{ opacity: 0.85, margin: "4px 0 8px" }}>
            Challenge the attacker to settle {STATE_NAMES[pendingDefense.territory_id]} right now: one shared
            question, first correct answer wins.{attackerOnline ? " They're online." : " They'll see it if they're around in the next five minutes."}
          </p>
          <button style={button} disabled={busy} onClick={() => void call("duel_propose", { p_attack_id: pendingDefense.id })}>
            Challenge to a live duel
          </button>
        </div>
      ) : null}
      {duel?.status === "proposed" && duel.i_am === "attacker" ? (
        <div>
          <strong>{duel.defender_name} challenges you to a live duel for {STATE_NAMES[duel.territory_id]}.</strong>
          <p style={{ opacity: 0.85, margin: "4px 0 8px" }}>One shared question. First correct answer takes the state, now.</p>
          <button style={button} disabled={busy} onClick={() => void call("duel_accept", { p_attack_id: duel.attack_id })}>
            Accept the duel
          </button>
        </div>
      ) : null}
      {duel?.status === "proposed" && duel.i_am === "defender" ? (
        <p style={{ opacity: 0.85 }}>Duel proposed for {STATE_NAMES[duel.territory_id]} — waiting on {duel.attacker_name}…</p>
      ) : null}
      {duel?.status === "active" && duel.question ? (
        duel.answered ? (
          <p>Answer locked in. Waiting on your opponent…</p>
        ) : (
          <div>
            <strong>DUEL · {STATE_NAMES[duel.territory_id]}</strong>
            <p style={{ fontSize: 16, margin: "6px 0 8px" }}>{duel.question.text}</p>
            {duel.question.format === "multiple_choice" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {duel.question.options.map((option) => (
                  <button key={option} style={button} disabled={busy}
                    onClick={() => void call("duel_answer", { p_attack_id: duel.attack_id, p_answer: option })}>
                    {option}
                  </button>
                ))}
              </div>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (answer.trim()) void call("duel_answer", { p_attack_id: duel.attack_id, p_answer: answer.trim() });
                }}
                style={{ display: "flex", gap: 6 }}
              >
                <input
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder="First correct answer wins"
                  style={{ flex: 1, padding: 8, borderRadius: 6, border: "1px solid #444", background: "transparent", color: "inherit" }}
                />
                <button type="submit" style={button} disabled={busy || !answer.trim()}>Answer</button>
              </form>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}
