"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ComposableMap, Geographies, Geography, ZoomableGroup } from "react-simple-maps";
import states from "us-atlas/states-10m.json";
import { createClient } from "@/lib/supabase/client";
import type { AttackSnapshot, GameSnapshot, QuestionPayload, TerritorySnapshot } from "@/lib/types";

const COLORS = ["#178f89", "#df8d32", "#7357b8", "#377eb8", "#c95858", "#6d9637", "#a65d9d", "#8b6b43"];
const NEUTRAL = "#dfe6eb";

type QuestionState = {
  sessionId: string;
  question: QuestionPayload;
  requiredCorrect: number;
  correctCount: number;
};

type BeginResult = {
  session_id: string;
  question: QuestionPayload;
  required_correct: number;
  correct_count: number;
};

type AnswerResult = {
  status: string;
  message: string;
  question?: QuestionPayload;
  correct_count?: number;
  required_correct?: number;
};

async function jsonRequest<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Request failed");
  return payload as T;
}

function daysRemaining(endsAt: string): number {
  return Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000));
}

function deadlineLabel(value: string): string {
  const ms = new Date(value).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

function HoldDots({ level }: { level: number }) {
  return <span className="hold" aria-label={`Hold level ${level}`}>{[1,2,3].map((value) => <i className={value <= level ? "on" : ""} key={value} />)}</span>;
}

export function GameClient({ initialSnapshot }: { initialSnapshot: GameSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedId, setSelectedId] = useState<string | null>(initialSnapshot.territories.find((t) => t.owner_id === null)?.id ?? "WA");
  const [questionState, setQuestionState] = useState<QuestionState | null>(null);
  const [result, setResult] = useState<{ message: string; error?: boolean; final?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freeFill, setFreeFill] = useState("");
  const [seconds, setSeconds] = useState(30);
  const timedOutRef = useRef(false);

  const supabase = useMemo(() => createClient(), []);
  const memberById = useMemo(() => new Map(snapshot.members.map((member) => [member.user_id, member])), [snapshot.members]);
  const territoryByName = useMemo(() => new Map(snapshot.territories.map((territory) => [territory.name, territory])), [snapshot.territories]);
  const selected = snapshot.territories.find((territory) => territory.id === selectedId) ?? null;
  const ownedIds = snapshot.territories.filter((territory) => territory.owner_id === snapshot.current_user_id).map((territory) => territory.id);
  const selectedAttack = selected ? snapshot.attacks.find((attack) => attack.territory_id === selected.id && attack.status === "contested") ?? null : null;

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/game/snapshot?groupId=${snapshot.group.id}`, { cache: "no-store" });
    if (!response.ok) return;
    setSnapshot(await response.json() as GameSnapshot);
  }, [snapshot.group.id]);

  useEffect(() => {
    if (!snapshot.season) return;
    const seasonId = snapshot.season.id;
    const channel = supabase
      .channel(`territory-${seasonId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "season_territories", filter: `season_id=eq.${seasonId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "attacks", filter: `season_id=eq.${seasonId}` }, refresh)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_events", filter: `season_id=eq.${seasonId}` }, refresh)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "player_actions", filter: `season_id=eq.${seasonId}` }, refresh)
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [refresh, snapshot.season, supabase]);

  const submitAnswer = useCallback(async (answer: string) => {
    if (!questionState || busy) return;
    setBusy(true); setError(null);
    try {
      const payload = await jsonRequest<AnswerResult>("/api/game/answer", { sessionId: questionState.sessionId, answer });
      if (payload.status === "active" && payload.question) {
        setQuestionState({
          sessionId: questionState.sessionId,
          question: payload.question,
          requiredCorrect: payload.required_correct ?? questionState.requiredCorrect,
          correctCount: payload.correct_count ?? questionState.correctCount + 1,
        });
        setFreeFill(""); setResult({ message: payload.message, final: false }); timedOutRef.current = false;
      } else {
        setResult({ message: payload.message, error: payload.status === "failed", final: true });
        timedOutRef.current = true;
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit answer");
    } finally { setBusy(false); }
  }, [busy, questionState, refresh]);

  useEffect(() => {
    if (!questionState || result?.final) return;
    const duration = questionState.question.tier === 3 ? 45 : 30;
    const remaining = Math.max(0, Math.ceil((new Date(questionState.question.expires_at).getTime() - Date.now()) / 1000));
    setSeconds(Math.min(duration, remaining));
    const interval = window.setInterval(() => {
      const next = Math.max(0, Math.ceil((new Date(questionState.question.expires_at).getTime() - Date.now()) / 1000));
      setSeconds(next);
      if (next === 0 && !timedOutRef.current) {
        timedOutRef.current = true;
        void submitAnswer("");
      }
    }, 500);
    return () => window.clearInterval(interval);
  }, [questionState, result?.final, submitAnswer]);

  async function startSeason() {
    setBusy(true); setError(null);
    try { await jsonRequest(`/api/groups/${snapshot.group.id}/start`, {}); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not start season"); }
    finally { setBusy(false); }
  }

  function isAdjacent(target: TerritorySnapshot): boolean {
    if (ownedIds.length === 0) return true;
    return snapshot.territories.some((territory) => territory.owner_id === snapshot.current_user_id && territory.adjacent.includes(target.id));
  }

  function actionFor(target: TerritorySnapshot, attack: AttackSnapshot | null) {
    if (!snapshot.season || snapshot.season.status !== "active") return { type: null, label: "Season ended", enabled: false };
    if (target.contested) {
      if (attack?.defender_id === snapshot.current_user_id) return { type: "defend", label: "Answer defense", enabled: true, attackId: attack.id };
      return { type: null, label: "Defense pending", enabled: false };
    }
    if (target.owner_id === null) return { type: "claim", label: "Play to claim", enabled: snapshot.actions_remaining > 0 && isAdjacent(target) };
    if (target.owner_id === snapshot.current_user_id) return { type: "fortify", label: target.hold_level >= 3 ? "Fully fortified" : "Play to fortify", enabled: target.hold_level < 3 };
    return { type: "attack", label: "Play to steal", enabled: snapshot.actions_remaining > 0 && isAdjacent(target) };
  }

  async function beginSelected() {
    if (!selected || !snapshot.season) return;
    const action = actionFor(selected, selectedAttack);
    if (!action.type || !action.enabled) return;
    setBusy(true); setError(null); setResult(null); timedOutRef.current = false;
    try {
      const payload = await jsonRequest<BeginResult>("/api/game/begin", {
        seasonId: snapshot.season.id,
        territoryId: selected.id,
        actionType: action.type,
        attackId: action.attackId ?? null,
      });
      setQuestionState({ sessionId: payload.session_id, question: payload.question, requiredCorrect: payload.required_correct, correctCount: payload.correct_count });
      setFreeFill("");
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not begin trivia"); }
    finally { setBusy(false); }
  }

  async function reportQuestion() {
    if (!questionState) return;
    setBusy(true);
    try {
      await jsonRequest("/api/game/report", { attemptId: questionState.question.attempt_id, reason: "Question may be inaccurate or ambiguous" });
      setResult({ message: "Question quarantined. Your action was refunded.", final: true });
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not report question"); }
    finally { setBusy(false); }
  }

  function closeQuestion() { setQuestionState(null); setResult(null); setError(null); setFreeFill(""); void refresh(); }

  if (!snapshot.season) {
    const isCommissioner = snapshot.group.commissioner_id === snapshot.current_user_id;
    return (
      <main className="page">
        <div className="page-heading"><div><div className="eyebrow">Lobby</div><h1>{snapshot.group.name}</h1></div></div>
        {error && <div className="feedback">{error}</div>}
        <div className="grid-2">
          <section className="panel"><h2>Invite your group</h2><p className="subtle">Share this code. The season unlocks at three players.</p><div style={{ fontSize: 38, fontWeight: 900, letterSpacing: ".12em" }}>{snapshot.group.invite_code}</div><button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(snapshot.group.invite_code)}>Copy code</button></section>
          <section className="panel"><h2>Players ({snapshot.members.length})</h2>{snapshot.members.map((member) => <div className="leader-row" key={member.user_id}><span className="avatar" style={{ background: COLORS[member.color_index % COLORS.length] }}>{member.display_name.slice(0,1).toUpperCase()}</span><strong>{member.display_name}</strong><span>{member.user_id === snapshot.group.commissioner_id ? "Commissioner" : "Ready"}</span></div>)}{isCommissioner && <button className="btn btn-primary btn-block" style={{ marginTop: 14 }} disabled={busy || snapshot.members.length < 3} onClick={startSeason}>{snapshot.members.length < 3 ? `Need ${3 - snapshot.members.length} more` : "Start season"}</button>}</section>
        </div>
      </main>
    );
  }

  const currentScore = snapshot.scores.find((score) => score.user_id === snapshot.current_user_id);
  const pendingDefenses = snapshot.attacks.filter((attack) => attack.defender_id === snapshot.current_user_id && attack.status === "contested");
  const selectedAction = selected ? actionFor(selected, selectedAttack) : null;

  return (
    <main className="game-page">
      {error && <div className="feedback" style={{ marginBottom: 10 }}>{error}</div>}
      <section className="game-summary">
        <div className="metric"><strong>{snapshot.actions_remaining}</strong><span>attack actions</span></div>
        <div className="metric"><strong>{currentScore?.cumulative_score ?? 0}</strong><span>season points</span></div>
        <div className="metric"><strong>{currentScore?.state_count ?? ownedIds.length}</strong><span>states held</span></div>
        <div className="metric"><strong>{daysRemaining(snapshot.season.ends_at)}</strong><span>days remaining</span></div>
      </section>

      <div className="game-layout">
        <section className="panel map-panel">
          <div className="map-head"><div><div className="eyebrow">Tap a state to play</div><h2>Shared map</h2></div><span className="chip">{snapshot.group.sports.join(" · ")}</span></div>
          <div className="map-wrap">
            <ComposableMap projection="geoAlbersUsa" width={975} height={610}>
              <ZoomableGroup minZoom={1} maxZoom={4}>
                <Geographies geography={states as object}>
                  {({ geographies }) => geographies.map((geo) => {
                    const name = String(geo.properties?.name ?? "");
                    const territory = territoryByName.get(name);
                    if (!territory) return null;
                    const owner = territory.owner_id ? memberById.get(territory.owner_id) : null;
                    const fill = owner ? COLORS[owner.color_index % COLORS.length] : NEUTRAL;
                    return <Geography key={geo.rsmKey} geography={geo} className="map-state" onClick={() => setSelectedId(territory.id)} fill={fill} stroke={territory.contested ? "#d89c29" : selectedId === territory.id ? "#0d1f3c" : "#ffffff"} strokeWidth={territory.contested || selectedId === territory.id ? 2.6 : 1.1} style={{ default: { outline: "none" }, hover: { outline: "none" }, pressed: { outline: "none" } }} />;
                  })}
                </Geographies>
              </ZoomableGroup>
            </ComposableMap>
          </div>
          <div className="legend"><span className="legend-item"><i className="swatch" style={{ background: NEUTRAL }} />Neutral</span>{snapshot.members.map((member) => <span className="legend-item" key={member.user_id}><i className="swatch" style={{ background: COLORS[member.color_index % COLORS.length] }} />{member.display_name}</span>)}</div>
        </section>

        <aside className="sidebar">
          {pendingDefenses.length > 0 && <section className="panel alert"><h3>Defense needed</h3>{pendingDefenses.map((attack) => { const territory = snapshot.territories.find((item) => item.id === attack.territory_id); const attacker = memberById.get(attack.attacker_id); return <button className="btn btn-ghost btn-block" key={attack.id} onClick={() => setSelectedId(attack.territory_id)}>{attacker?.display_name ?? "A player"} attacked {territory?.name} · {deadlineLabel(attack.defense_deadline)}</button>; })}</section>}
          <section className="panel"><h3>Leaderboard</h3>{snapshot.scores.map((score, index) => <div className="leader-row" key={score.user_id}><span className="rank">{index + 1}</span><span><strong>{score.display_name}</strong><small className="subtle" style={{ display: "block" }}>{score.state_count} states</small></span><span className="score">{score.cumulative_score}</span></div>)}</section>
          <section className="panel"><h3>Latest plays</h3>{snapshot.activity.length === 0 && <div className="empty">The first correct answer starts the feed.</div>}{snapshot.activity.slice(0,6).map((item) => <div className="activity-row" key={item.id}><span className="rank">•</span><span>{item.message}</span><small className="subtle">{new Date(item.created_at).toLocaleDateString()}</small></div>)}</section>
        </aside>
      </div>

      {selected && <section className="panel state-panel"><div><div className="state-title"><h2>{selected.name}</h2><HoldDots level={selected.hold_level} />{selected.contested && <span className="chip">Contested</span>}</div><p className="subtle">{selected.owner_id ? `Held by ${memberById.get(selected.owner_id)?.display_name ?? "Unknown"}` : "Neutral territory"} · {selected.region} region</p>{selected.owner_id !== snapshot.current_user_id && ownedIds.length > 0 && !isAdjacent(selected) && <p className="subtle">You need an adjacent state before you can play here.</p>}</div><button className="btn btn-primary" disabled={!selectedAction?.enabled || busy} onClick={beginSelected}>{busy ? "Loading question…" : selectedAction?.label ?? "Unavailable"}</button></section>}

      {questionState && <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="question-modal"><div className="question-meta"><span>{questionState.question.sport} · Tier {questionState.question.tier}</span><span>{questionState.correctCount}/{questionState.requiredCorrect} correct · <b className="timer">{seconds}s</b></span></div>{result && <div className={`result-banner ${result.error ? "error-banner" : ""}`} style={{ marginTop: 14 }}>{result.message}</div>}<h2>{questionState.question.text}</h2>{error && <div className="result-banner error-banner">{error}</div>}{questionState.question.format === "multiple_choice" ? <div className="options">{questionState.question.options.map((option) => <button className="option" disabled={busy || Boolean(result?.final)} key={option} onClick={() => submitAnswer(option)}>{option}</button>)}</div> : <form className="form-stack" onSubmit={(event: FormEvent) => { event.preventDefault(); void submitAnswer(freeFill); }}><input className="input" autoFocus value={freeFill} onChange={(e) => setFreeFill(e.target.value)} placeholder="Type your answer" /><button className="btn btn-primary" disabled={busy || Boolean(result?.final) || freeFill.trim().length === 0}>Submit answer</button></form>}<div className="modal-footer"><button className="btn btn-danger" disabled={busy || Boolean(result?.final)} onClick={reportQuestion}>Report question</button>{result?.final && <button className="btn btn-secondary" onClick={closeQuestion}>Back to map</button>}</div></section></div>}
    </main>
  );
}
