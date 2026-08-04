"use client";

import { useMemo } from "react";
import { dayNumber, timeLeft } from "@/lib/game-format";
import { isTerritoryActionBlocked } from "@/lib/game-rules";
import { blockedReason } from "@/lib/ux-copy";
import { ADJ, NEUTRAL, STATE_NAMES, memberColor } from "@/lib/game-constants";
import type { Attack, Member, Snapshot, Territory, View } from "@/lib/game-types";
import styles from "./territory-game-v2.module.css";
import TerritoryMap from "./territory-map";
import { FeedOverlay, StandingsOverlay } from "./game-overlays";

export default function GameShell({ snapshot, me, view, setView, selected, setSelected, front, setFront, busy, beginAction, openLeagues, refill }: {
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

  // Costs are stated up-front in base terms ("2+"): difficulty and catch-up
  // modifiers shift the exact requirement per player, so the copy promises a
  // floor rather than lying about the number.
  let action: null | { kind: string; label: string; danger?: boolean } = null;
  if (selectedTerritory) {
    if (selectedTerritory.owner_id === snapshot.current_user_id && selectedTerritory.hold_level < 3 && !selectedTerritory.contested) action = { kind: "fortify", label: `Fortify to garrison ${selectedTerritory.hold_level + 1} — 1 move, 1 question` };
    else if (selectedTerritory.owner_id === null) action = { kind: "claim", label: "Claim — 1 move, 1 question" };
    else if (selectedTerritory.owner_id !== snapshot.current_user_id) action = { kind: "attack", label: `Attack — 1 move, needs ${selectedTerritory.hold_level === 1 ? 2 : 3}+ correct`, danger: true };
  }
  const canTarget = Boolean(selectedTerritory && legalTargets.has(selectedTerritory.id) && !selectedTerritory.contested);
  const isMyTurn = snapshot.is_my_turn !== false;
  const turnHolderName = snapshot.season?.current_turn_name ?? null;

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
            <HudMetric value={snapshot.actions_remaining} label="Actions" danger={snapshot.actions_remaining === 0 && isMyTurn} pips={5} />
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
              isMyTurn={isMyTurn}
              turnHolderName={turnHolderName}
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
              isMyTurn={isMyTurn}
              turnHolderName={turnHolderName}
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

function HudMetric({ value, label, danger, pips }: { value: number; label: string; danger?: boolean; pips?: number }) {
  return (
    <div className={styles.hudMetric}>
      <strong className={danger ? styles.dangerText : ""}>{value}</strong>
      <span>{label}</span>
      {pips !== undefined && (
        <span className={styles.hudPips} aria-hidden="true">
          {Array.from({ length: pips }, (_, index) => (
            <i key={index} className={index < value ? styles.hudPipFilled : ""} />
          ))}
        </span>
      )}
    </div>
  );
}

function MissionDock({ snapshot, me, defense, homePending, isMyTurn, turnHolderName, busy, beginAction, refill }: {
  snapshot: Snapshot;
  me?: Member;
  defense?: Attack;
  homePending: boolean;
  isMyTurn: boolean;
  turnHolderName: string | null;
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
  // Off-turn players never had moves this rotation — saying "spent" would be
  // a lie. Name the turn holder and the one thing they CAN do.
  if (!isMyTurn) {
    return <div className={styles.missionDock}><div><span>WAITING</span><h2>{turnHolderName ? `It's ${turnHolderName}'s turn` : "Another player is up"}</h2><p>You can defend if attacked. Your moves arrive when your turn starts.</p></div></div>;
  }
  if (snapshot.actions_remaining === 0) {
    return <div className={styles.missionDock}><div><span>ACTIONS SPENT</span><h2>Hold the line</h2><p>Claiming, attacking and fortifying all spend a move. More arrive at the daily refresh.</p></div>{snapshot.group.test_mode && <button disabled={busy} onClick={refill}>Refill test actions</button>}</div>;
  }
  return <div className={styles.missionDock}><div><span>YOUR MOVE</span><h2>Choose a border state</h2><p>Tap a neighboring state to claim or attack.</p></div><div className={styles.actionCount}>{snapshot.actions_remaining}<small>left</small></div></div>;
}

function TerritorySheet({ territory, owner, currentUser, homeState, action, canTarget, actionsRemaining, isMyTurn, turnHolderName, busy, onClose, onAction }: {
  territory: Territory;
  owner?: Member | null;
  currentUser: string;
  homeState: string | null;
  action: null | { kind: string; label: string; danger?: boolean };
  canTarget: boolean;
  actionsRemaining: number;
  isMyTurn: boolean;
  turnHolderName: string | null;
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
    isMyTurn,
  }));
  // The disabled button always explains itself; when nothing blocks, fall back
  // to the situational hint.
  const reason = blockedReason({
    hasAction: Boolean(action),
    actionsRemaining,
    contested: territory.contested,
    canTarget,
    isMyTurn,
    turnHolderName,
    kind: action?.kind,
  }) ?? (mine
    ? "Fortify once per day — it spends a move — to increase the cost of stealing it."
    : canTarget
      ? "This state touches your border."
      : "You do not share a border with this state.");
  return (
    <aside className={styles.territorySheet}>
      <button className={styles.sheetHandle} onClick={onClose} aria-label="Close territory details" />
      <div className={styles.sheetTitle}><div><span>{territory.region}</span><h2>{STATE_NAMES[territory.id]}</h2></div><div className={styles.stateCode}>{territory.id}</div></div>
      <div className={styles.ownerRow}><span style={{ background: owner ? memberColor(owner) : NEUTRAL }} /><strong>{owner ? mine ? "Your territory" : owner.display_name : "Unclaimed"}</strong><small>Garrison {territory.hold_level}{homeState === territory.id ? " · Home" : ""}</small></div>
      <p className={styles.sheetReason}>{reason}</p>
      {action && <button className={`${styles.sheetAction} ${action.danger ? styles.sheetActionDanger : ""}`} disabled={disabled} onClick={onAction}>{action.label}</button>}
    </aside>
  );
}
