"use client";

import { useEffect, useState } from "react";
import { dayNumber } from "@/lib/game-format";
import { memberColor } from "@/lib/game-constants";
import { createClient } from "@/lib/supabase/client";
import type { GroupRow, Snapshot } from "@/lib/game-types";
import GauntletStrip from "./gauntlet-strip";
import styles from "./territory-game-v2.module.css";

interface RivalryRow {
  attacker_id: string;
  attacker_name: string;
  defender_id: string;
  defender_name: string;
  states_taken: number;
  defenses_held: number;
  wager_fights: number;
}

export function Loading({ label }: { label: string }) {
  return <main className={styles.loading}><div className={styles.loadingOrb} /><span>{label}</span></main>;
}

export function StandingsOverlay({ snapshot }: { snapshot: Snapshot }) {
  const ranked = [...snapshot.scores].sort((a, b) => b.cumulative_score - a.cumulative_score || b.state_count - a.state_count);
  const [rivalries, setRivalries] = useState<RivalryRow[]>([]);

  useEffect(() => {
    let mounted = true;
    // State writes stay in the promise continuation (house style).
    async function load() {
      const { data, error } = await createClient().rpc("pvp_rivalries", { p_group_id: snapshot.group.id });
      if (mounted && !error) setRivalries((data ?? []) as RivalryRow[]);
    }
    void load();
    return () => {
      mounted = false;
    };
  }, [snapshot.group.id]);

  return <section className={styles.overlayPage}><div className={styles.overlayHeading}><span>DAY {dayNumber(snapshot.season)}</span><h1>Standings</h1><p>Points reward holding ground every day, not a final-hour land grab.</p></div><div className={styles.rankingList}>{ranked.map((player, index) => <div key={player.user_id} className={styles.rankingRow}><div className={styles.rankNumber}>{index + 1}</div><span className={styles.rankingAvatar} style={{ background: memberColor(player) }}>{player.display_name.slice(0, 1)}</span><div><strong>{player.display_name}{player.user_id === snapshot.current_user_id ? " · You" : ""}</strong><small>{player.state_count} states</small></div><b>{player.cumulative_score}</b></div>)}</div>{snapshot.season && <GauntletStrip seasonId={snapshot.season.id} />}{rivalries.length > 0 && <div className={styles.overlayHeading} style={{ marginTop: 24 }}><span>LIFETIME</span><h1 style={{ fontSize: 22 }}>Rivalries</h1><p>Every attack ever resolved between this league&apos;s players, across all your seasons.</p></div>}{rivalries.map((rivalry) => <div key={`${rivalry.attacker_id}:${rivalry.defender_id}`} className={styles.rankingRow}><div><strong>{rivalry.attacker_name} → {rivalry.defender_name}</strong><small>{rivalry.states_taken} taken · {rivalry.defenses_held} held{rivalry.wager_fights > 0 ? ` · ${rivalry.wager_fights} wagers` : ""}</small></div></div>)}</section>;
}

export function FeedOverlay({ snapshot }: { snapshot: Snapshot }) {
  return <section className={styles.overlayPage}><div className={styles.overlayHeading}><span>LIVE LEAGUE</span><h1>Activity</h1><p>Every claim, attack and defense writes the story of the board.</p></div><div className={styles.feedList}>{snapshot.activity.length ? snapshot.activity.map((event) => <div key={event.id} className={styles.feedItem}><span>{event.territory_id ?? "•"}</span><div><strong>{event.message}</strong><small>{new Date(event.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></div></div>) : <p className={styles.empty}>The map is quiet. The first correct answer changes that.</p>}</div></section>;
}

export function LeaguePicker({ groups, active, onPick, onClose }: { groups: GroupRow[]; active: string; onPick: (id: string) => void; onClose: () => void }) {
  return <div className={styles.modalScrim} onClick={onClose}><section className={styles.leagueModal} onClick={(event) => event.stopPropagation()}><div className={styles.modalHeader}><h2>Your leagues</h2><button onClick={onClose}>×</button></div>{groups.map((group) => <button key={group.id} className={`${styles.leagueOption} ${group.id === active ? styles.leagueOptionActive : ""}`} onClick={() => onPick(group.id)}><div><strong>{group.name}</strong><small>{group.member_count} players · {group.status}</small></div><span>{group.invite_code}</span></button>)}</section></div>;
}
