"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createClient } from "@/lib/supabase/client";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { useGameState } from "@/hooks/use-game-state";
import { dayNumber, timeLeft } from "@/lib/game-format";
import { isTerritoryActionBlocked } from "@/lib/game-rules";
import {
  ADJ,
  NEUTRAL,
  STATE_NAMES,
  memberColor,
} from "@/lib/game-constants";
import type {
  ActiveOperation,
  Attack,
  Member,
  ResultState,
  Snapshot,
  Territory,
  View,
} from "@/lib/game-types";
import styles from "./territory-game-v2.module.css";
import TerritoryMap from "./territory-map";
import AuthStage from "./auth-stage";
import LeagueEntry from "./league-entry";
import LobbyStage from "./lobby-stage";
import { FeedOverlay, LeaguePicker, Loading, StandingsOverlay } from "./game-overlays";

const supabase = createClient();

export default function TerritoryGameV2() {
  const { session, authReady } = useSupabaseSession();
  const {
    groups,
    groupId,
    setGroupId,
    snapshot,
    operation,
    setOperation,
    result,
    setResult,
    busy,
    setBusy,
    toast,
    notify,
    loadGroups,
    loadSnapshot,
    beginAction,
  } = useGameState(session);
  const [view, setView] = useState<View>("map");
  const [selected, setSelected] = useState<string | null>(null);
  const [front, setFront] = useState<string | null>(null);
  const [leaguePicker, setLeaguePicker] = useState(false);

  if (!authReady) return <Loading label="Loading the battlefield" />;
  if (!session) return <AuthStage notify={notify} />;
  if (!groupId || groups.length === 0) {
    return <LeagueEntry user={session.user} onCreated={(id) => loadGroups(id)} notify={notify} />;
  }
  if (!snapshot) return <Loading label="Syncing the map" />;
  if (operation || result) {
    return (
      <QuestionArena
        operation={operation}
        result={result}
        setOperation={setOperation}
        setResult={setResult}
        refresh={() => loadSnapshot()}
        notify={notify}
      />
    );
  }

  const me = snapshot.members.find((member) => member.user_id === snapshot.current_user_id);
  if (snapshot.group.status === "lobby" || !snapshot.season) {
    return (
      <LobbyStage
        snapshot={snapshot}
        groups={groups}
        groupId={groupId}
        setGroupId={setGroupId}
        refresh={() => loadSnapshot()}
        reloadGroups={() => loadGroups()}
        notify={notify}
      />
    );
  }

  return (
    <main className={styles.app}>
      {toast && <div className={`${styles.toast} ${toast.error ? styles.toastError : ""}`}>{toast.text}</div>}
      {leaguePicker && (
        <LeaguePicker
          groups={groups}
          active={groupId}
          onPick={(id) => {
            setGroupId(id);
            window.localStorage.setItem("territory_group", id);
            setLeaguePicker(false);
            setSelected(null);
            setFront(null);
            setView("map");
          }}
          onClose={() => setLeaguePicker(false)}
        />
      )}
      <GameShell
        snapshot={snapshot}
        me={me}
        view={view}
        setView={setView}
        selected={selected}
        setSelected={setSelected}
        front={front}
        setFront={setFront}
        busy={busy}
        beginAction={beginAction}
        openLeagues={() => setLeaguePicker(true)}
        refill={async () => {
          setBusy(true);
          const { error } = await supabase.rpc("test_refill_actions", { p_group_id: snapshot.group.id });
          setBusy(false);
          if (error) notify(error.message, true);
          else {
            notify("Three playtest actions restored.");
            loadSnapshot();
          }
        }}
      />
    </main>
  );
}

function GameShell({ snapshot, me, view, setView, selected, setSelected, front, setFront, busy, beginAction, openLeagues, refill }: {
  snapshot: Snapshot;
  me?: Member;
  view: View;
  setView: (view: View) => void;
  selected: string | null;
  setSelected: (state: string | null) => void;
  front: string | null;
  setFront: (userId: string | null) => void;
  busy: boolean;
  beginAction: (kind: string, state: string, attackId?: string) => void;
  openLeagues: () => void;
  refill: () => void;
}) {
  const memberMap = useMemo(() => Object.fromEntries(snapshot.members.map((member) => [member.user_id, member])), [snapshot.members]);
  const territoryMap = useMemo(() => Object.fromEntries(snapshot.territories.map((territory) => [territory.id, territory])), [snapshot.territories]);
  const myStates = snapshot.territories.filter((territory) => territory.owner_id === snapshot.current_user_id);
  const legalTargets = useMemo(() => {
    if (!myStates.length) return new Set(snapshot.territories.map((territory) => territory.id));
    const targets = new Set<string>();
    myStates.forEach((territory) => (territory.adjacent?.length ? territory.adjacent : ADJ[territory.id] ?? []).forEach((neighbor) => targets.add(neighbor)));
    return targets;
  }, [myStates, snapshot.territories]);
  const selectedTerritory = selected ? territoryMap[selected] : null;
  const selectedOwner = selectedTerritory?.owner_id ? memberMap[selectedTerritory.owner_id] : null;
  const pendingDefense = snapshot.attacks.find((attack) => attack.defender_id === snapshot.current_user_id && attack.status === "contested");
  const homePending = me?.home_state && !me.home_completed;
  const myScore = snapshot.scores.find((score) => score.user_id === snapshot.current_user_id)?.cumulative_score ?? 0;
  const rivals = snapshot.members.filter((member) => member.user_id !== snapshot.current_user_id && snapshot.territories.some((territory) => territory.owner_id === member.user_id && (territory.adjacent ?? ADJ[territory.id] ?? []).some((neighbor) => territoryMap[neighbor]?.owner_id === snapshot.current_user_id)));

  let action: null | { kind: string; label: string; danger?: boolean } = null;
  if (selectedTerritory) {
    if (selectedTerritory.owner_id === snapshot.current_user_id && selectedTerritory.hold_level < 3 && !selectedTerritory.contested) action = { kind: "fortify", label: `Fortify to garrison ${selectedTerritory.hold_level + 1}` };
    else if (selectedTerritory.owner_id === null) action = { kind: "claim", label: "Claim · one Tier 1 question" };
    else if (selectedTerritory.owner_id !== snapshot.current_user_id) action = { kind: "attack", label: `Attack · ${selectedTerritory.hold_level === 1 ? 2 : 3} correct in a row`, danger: true };
  }
  const canTarget = Boolean(selectedTerritory && legalTargets.has(selectedTerritory.id) && !selectedTerritory.contested);

  return (
    <>
      <header className={styles.gameHeader}>
        <button className={styles.brandButton} onClick={openLeagues}><span className={styles.logoMarkSmall}>T</span><div><strong>Territory</strong><small>{snapshot.group.name}</small></div></button>
        <div className={styles.profilePill}><span style={{ background: memberColor(me) }}>{me?.display_name.slice(0, 1).toUpperCase()}</span><div><strong>{me?.display_name}</strong><small>Day {dayNumber(snapshot.season)}</small></div></div>
      </header>

      {view === "map" && (
        <section className={styles.board}>
          <div className={styles.mapGlow} />
          <TerritoryMap territories={snapshot.territories} members={snapshot.members} currentUser={snapshot.current_user_id} selected={selected} onSelect={(state) => { setSelected(state); setFront(null); }} front={front} />
          <div className={styles.hud}>
            <HudMetric value={snapshot.actions_remaining} label="Actions" danger={snapshot.actions_remaining === 0} />
            <HudMetric value={myStates.length} label="States" />
            <HudMetric value={myScore} label="Points" />
          </div>
          {rivals.length > 0 && <div className={styles.frontRail}><button className={!front ? styles.frontActive : ""} onClick={() => setFront(null)}>All</button>{rivals.map((rival) => <button key={rival.user_id} className={front === rival.user_id ? styles.frontActive : ""} onClick={() => { setFront(rival.user_id); setSelected(null); }}><span style={{ background: memberColor(rival) }} />{rival.display_name}</button>)}</div>}
          {!selectedTerritory && (
            <MissionDock
              snapshot={snapshot}
              me={me}
              defense={pendingDefense}
              homePending={Boolean(homePending)}
              busy={busy}
              beginAction={beginAction}
              refill={refill}
            />
          )}
          {selectedTerritory && (
            <TerritorySheet
              territory={selectedTerritory}
              owner={selectedOwner}
              currentUser={snapshot.current_user_id}
              homeState={me?.home_state ?? null}
              action={action}
              canTarget={canTarget}
              actionsRemaining={snapshot.actions_remaining}
              busy={busy}
              onClose={() => setSelected(null)}
              onAction={() => action && beginAction(action.kind, selectedTerritory.id)}
            />
          )}
        </section>
      )}
      {view === "standings" && <StandingsOverlay snapshot={snapshot} />}
      {view === "feed" && <FeedOverlay snapshot={snapshot} />}
      <nav className={styles.bottomNav}>
        <button className={view === "map" ? styles.navActive : ""} onClick={() => setView("map")}><span>⌖</span>Map</button>
        <button className={view === "standings" ? styles.navActive : ""} onClick={() => setView("standings")}><span>▥</span>Standings</button>
        <button className={view === "feed" ? styles.navActive : ""} onClick={() => setView("feed")}><span>◌</span>Activity</button>
      </nav>
    </>
  );
}

function HudMetric({ value, label, danger }: { value: number; label: string; danger?: boolean }) {
  return <div className={styles.hudMetric}><strong className={danger ? styles.dangerText : ""}>{value}</strong><span>{label}</span></div>;
}

function MissionDock({ snapshot, me, defense, homePending, busy, beginAction, refill }: {
  snapshot: Snapshot;
  me?: Member;
  defense?: Attack;
  homePending: boolean;
  busy: boolean;
  beginAction: (kind: string, state: string, attackId?: string) => void;
  refill: () => void;
}) {
  if (defense) {
    return <div className={`${styles.missionDock} ${styles.missionDanger}`}><div><span>UNDER ATTACK · {timeLeft(defense.defense_deadline)}</span><h2>Defend {STATE_NAMES[defense.territory_id]}</h2><p>One answer decides who owns it.</p></div><button disabled={busy} onClick={() => beginAction("defend", defense.territory_id, defense.id)}>Defend now</button></div>;
  }
  if (homePending && me?.home_state) {
    return <div className={styles.missionDock}><div><span>OPENING MOVE</span><h2>Secure {STATE_NAMES[me.home_state]}</h2><p>Answer once to raise your starting garrison.</p></div><button disabled={busy} onClick={() => beginAction("home", me.home_state!)}>Play question</button></div>;
  }
  if (snapshot.actions_remaining === 0) {
    return <div className={styles.missionDock}><div><span>ACTIONS SPENT</span><h2>Hold the line</h2><p>Claiming, attacking and fortifying all spend a move. More arrive at the daily refresh.</p></div>{snapshot.group.test_mode && <button disabled={busy} onClick={refill}>Refill test actions</button>}</div>;
  }
  return <div className={styles.missionDock}><div><span>YOUR MOVE</span><h2>Choose a border state</h2><p>Tap a neighboring state to claim or attack.</p></div><div className={styles.actionCount}>{snapshot.actions_remaining}<small>left</small></div></div>;
}

function TerritorySheet({ territory, owner, currentUser, homeState, action, canTarget, actionsRemaining, busy, onClose, onAction }: {
  territory: Territory;
  owner?: Member | null;
  currentUser: string;
  homeState: string | null;
  action: null | { kind: string; label: string; danger?: boolean };
  canTarget: boolean;
  actionsRemaining: number;
  busy: boolean;
  onClose: () => void;
  onAction: () => void;
}) {
  const mine = territory.owner_id === currentUser;
  const disabled = busy || Boolean(action && isTerritoryActionBlocked({
    kind: action.kind,
    contested: territory.contested,
    sharesBorder: canTarget,
    actionsRemaining,
  }));
  return (
    <aside className={styles.territorySheet}>
      <button className={styles.sheetHandle} onClick={onClose} aria-label="Close territory details" />
      <div className={styles.sheetTitle}><div><span>{territory.region}</span><h2>{STATE_NAMES[territory.id]}</h2></div><div className={styles.stateCode}>{territory.id}</div></div>
      <div className={styles.ownerRow}><span style={{ background: owner ? memberColor(owner) : NEUTRAL }} /><strong>{owner ? mine ? "Your territory" : owner.display_name : "Unclaimed"}</strong><small>Garrison {territory.hold_level}{homeState === territory.id ? " · Home" : ""}</small></div>
      <p className={styles.sheetReason}>{territory.contested ? "An attack is already active here." : mine ? "Fortify once per day — it spends a move — to increase the cost of stealing it." : canTarget ? "This state touches your border." : "You do not share a border with this state."}</p>
      {action && <button className={`${styles.sheetAction} ${action.danger ? styles.sheetActionDanger : ""}`} disabled={disabled} onClick={onAction}>{action.label}</button>}
    </aside>
  );
}

function QuestionArena({ operation, result, setOperation, setResult, refresh, notify }: {
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

  useEffect(() => {
    setAnswer("");
    timedOut.current = false;
  }, [question?.attempt_id]);
  useEffect(() => {
    if (!question) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((new Date(question.expires_at).getTime() - Date.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0 && !timedOut.current && !busy) {
        timedOut.current = true;
        void submit("");
      }
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [question?.attempt_id, busy]);

  async function submit(value = answer) {
    if (!operation || busy) return;
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
    const ok = data.status !== "failed";
    setOperation(null);
    setResult({
      ok,
      title: ok ? data.status === "contested" ? "Challenge issued" : "Territory secured" : "Operation failed",
      message: data.message ?? (ok ? "The map changed." : "The map did not move."),
      correctAnswer: data.correct_answer ?? null,
    });
  }

  if (result) {
    return <main className={`${styles.resultPage} ${result.ok ? styles.resultSuccess : styles.resultFailure}`}><div className={styles.resultHalo} /><section><span>{result.ok ? "SUCCESS" : "FAILED"}</span><h1>{result.title}</h1><p>{result.message}</p>{result.correctAnswer && <small>Correct answer: {result.correctAnswer}</small>}<button onClick={() => { setResult(null); refresh(); }}>Return to map</button></section></main>;
  }
  if (!operation || !question) return <Loading label="Restoring question" />;
  const operationLabel = operation.action_type === "home" ? "HOME GROUND" : operation.action_type === "claim" ? "CLAIM" : operation.action_type === "attack" ? "ATTACK" : operation.action_type === "defend" ? "DEFENSE" : "FORTIFY";

  return <main className={styles.questionPage}><div className={styles.questionState}>{operation.territory_id}</div><header><div><span>{operationLabel} · TIER {question.tier}</span><strong>{STATE_NAMES[operation.territory_id]}</strong></div><div className={`${styles.timer} ${seconds <= 8 ? styles.timerDanger : ""}`}>0:{String(seconds).padStart(2, "0")}</div></header><section className={styles.questionCard}><div className={styles.streak}>{Array.from({ length: operation.required_correct }, (_, index) => <span key={index} className={index < operation.correct_count ? styles.streakDone : ""} />)}</div><h1>{question.text}</h1>{question.format === "multiple_choice" ? <div className={styles.answerGrid}>{(question.options ?? []).map((option) => <button key={option} className={answer === option ? styles.answerSelected : ""} onClick={() => setAnswer(option)}>{option}</button>)}</div> : <input className={styles.freeAnswer} autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} placeholder="Type your answer" />}<button className={styles.lockButton} disabled={busy || !answer} onClick={() => submit()}>{busy ? "Checking…" : "Lock answer"}</button></section></main>;
}
