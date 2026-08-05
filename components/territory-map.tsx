"use client";

import {
  ADJ,
  CENTROIDS,
  DANGER,
  INK,
  LEADERS,
  MAP_LABELS,
  NEUTRAL,
  PATHS,
  STATE_NAMES,
  memberColor,
} from "@/lib/game-constants";
import type { Member, Territory } from "@/lib/game-types";
import styles from "./territory-game-v2.module.css";

export default function TerritoryMap({ territories, members, currentUser, selected, onSelect, front, previewHome }: {
  territories: Territory[];
  members: Member[];
  currentUser: string;
  selected: string | null;
  onSelect: (state: string) => void;
  front: string | null;
  previewHome?: string;
}) {
  const territoryMap = Object.fromEntries(territories.map((territory) => [territory.id, territory]));
  const memberMap = Object.fromEntries(members.map((member) => [member.user_id, member]));
  const visible = (state: string) => {
    if (!front) return true;
    const ownerId = territoryMap[state]?.owner_id;
    return ownerId === currentUser || ownerId === front;
  };
  const onFront = (state: string) => {
    if (!front) return false;
    const ownerId = territoryMap[state]?.owner_id;
    return (ownerId === currentUser && (ADJ[state] ?? []).some((neighbor) => territoryMap[neighbor]?.owner_id === front)) ||
      (ownerId === front && (ADJ[state] ?? []).some((neighbor) => territoryMap[neighbor]?.owner_id === currentUser));
  };
  const fill = (state: string) => {
    if (previewHome === state) return DANGER;
    const ownerId = territoryMap[state]?.owner_id;
    return ownerId ? memberColor(memberMap[ownerId]) : NEUTRAL;
  };

  return (
    <svg className={styles.mapSvg} viewBox="0 0 1030 620" role="img" aria-label="United States territory map">
      <defs>
        <filter id="state-shadow" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#0d1a2a" floodOpacity=".22" /></filter>
        <pattern id="garrison-hatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="8" stroke="rgba(255,255,255,.7)" strokeWidth="2" /></pattern>
      </defs>
      {Object.keys(PATHS).map((state) => (
        <path
          key={state}
          d={PATHS[state]}
          className={styles.statePath}
          fill={fill(state)}
          stroke="rgba(255,255,255,.92)"
          strokeWidth="1.6"
          opacity={visible(state) ? 1 : 0.16}
          filter={selected === state ? "url(#state-shadow)" : undefined}
          onClick={() => onSelect(state)}
          role="button"
          aria-label={STATE_NAMES[state] ?? state}
        />
      ))}
      {territories.filter((territory) => territory.hold_level === 3 && visible(territory.id)).map((territory) => <path key={`${territory.id}-hatch`} d={PATHS[territory.id]} fill="url(#garrison-hatch)" pointerEvents="none" />)}
      {front && territories.filter((territory) => onFront(territory.id)).map((territory) => <path key={`${territory.id}-front`} d={PATHS[territory.id]} fill="none" stroke={INK} strokeWidth="3.2" pointerEvents="none" />)}
      {selected && <path d={PATHS[selected]} fill="none" stroke={DANGER} strokeWidth="4.5" pointerEvents="none" />}
      {/* Labels double as tap targets: the label itself selects its state, so a
          state too small to hit (RI is 4x6px on a phone) still has a usable
          proxy — its in-map label or its leader-line row on the right edge. */}
      {MAP_LABELS.map((state) => CENTROIDS[state] && <text key={`${state}-label`} x={CENTROIDS[state][0]} y={CENTROIDS[state][1] + 6} textAnchor="middle" className={styles.stateLabel} pointerEvents="auto" cursor="pointer" onClick={() => onSelect(state)} fill={territoryMap[state]?.owner_id || previewHome === state ? "white" : "rgba(20,32,52,.46)"} opacity={visible(state) ? 1 : .16}>{state}</text>)}
      {Object.entries(LEADERS).map(([state, y]) => CENTROIDS[state] && <g key={`${state}-leader`} opacity={visible(state) ? 1 : .16} onClick={() => onSelect(state)} cursor="pointer" role="button" aria-label={`Select ${STATE_NAMES[state] ?? state}`}><rect x="944" y={y - 13} width="86" height="26" fill="transparent" /><line x1={CENTROIDS[state][0]} y1={CENTROIDS[state][1]} x2="966" y2={y} stroke={INK} strokeWidth=".8" opacity=".36" pointerEvents="none" /><text x="974" y={y + 6} className={styles.stateLabel} pointerEvents="auto" fill={INK}>{state}</text></g>)}
    </svg>
  );
}
