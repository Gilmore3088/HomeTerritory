"use client";

import { dayNumber } from "@/lib/game-format";
import { memberColor } from "@/lib/game-constants";
import type { GameLoadError, GroupRow, Snapshot } from "@/lib/game-types";
import styles from "./territory-game-v2.module.css";

export function Loading({ label }: { label: string }) {
  return <main className={styles.loading}><div className={styles.loadingOrb} /><span>{label}</span></main>;
}

export function LoadErrorScreen({ error, onRetry }: { error: GameLoadError; onRetry: () => void }) {
  const heading = error.source === "groups" ? "Couldn't load your leagues" : "Couldn't sync the map";
  return (
    <main className={styles.loading}>
      <section className={styles.loadErrorCard}>
        <span className={styles.kicker}>CONNECTION TROUBLE</span>
        <h1>{heading}</h1>
        <p>{error.message}</p>
        <button className={styles.primaryButton} onClick={onRetry}>Retry</button>
      </section>
    </main>
  );
}

export function StandingsOverlay({ snapshot }: { snapshot: Snapshot }) {
  const ranked = [...snapshot.scores].sort((a, b) => b.cumulative_score - a.cumulative_score || b.state_count - a.state_count);
  return <section className={styles.overlayPage}><div className={styles.overlayHeading}><span>DAY {dayNumber(snapshot.season)}</span><h1>Standings</h1><p>Points reward holding ground every day, not a final-hour land grab.</p></div><div className={styles.rankingList}>{ranked.map((player, index) => <div key={player.user_id} className={styles.rankingRow}><div className={styles.rankNumber}>{index + 1}</div><span className={styles.rankingAvatar} style={{ background: memberColor(player) }}>{player.display_name.slice(0, 1)}</span><div><strong>{player.display_name}{player.user_id === snapshot.current_user_id ? " · You" : ""}</strong><small>{player.state_count} states</small></div><b>{player.cumulative_score}</b></div>)}</div></section>;
}

export function FeedOverlay({ snapshot }: { snapshot: Snapshot }) {
  return <section className={styles.overlayPage}><div className={styles.overlayHeading}><span>LIVE LEAGUE</span><h1>Activity</h1><p>Every claim, attack and defense writes the story of the board.</p></div><div className={styles.feedList}>{snapshot.activity.length ? snapshot.activity.map((event) => <div key={event.id} className={styles.feedItem}><span>{event.territory_id ?? "•"}</span><div><strong>{event.message}</strong><small>{new Date(event.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></div></div>) : <p className={styles.empty}>The map is quiet. The first correct answer changes that.</p>}</div></section>;
}

export function SeasonComplete({ snapshot }: { snapshot: Snapshot }) {
  const ranked = [...snapshot.scores].sort((a, b) => b.cumulative_score - a.cumulative_score || b.state_count - a.state_count);
  const winner = ranked[0];
  return (
    <main className={styles.overlayPage}>
      <div className={styles.overlayHeading}>
        <span>FINAL WHISTLE</span>
        <h1>Season complete</h1>
        <p>{winner ? `${winner.display_name} takes the map with ${winner.cumulative_score} points.` : "The season has ended."}</p>
      </div>
      <div className={styles.rankingList}>
        {ranked.map((player, index) => (
          <div key={player.user_id} className={styles.rankingRow}>
            <div className={styles.rankNumber}>{index + 1}</div>
            <span className={styles.rankingAvatar} style={{ background: memberColor(player) }}>{player.display_name.slice(0, 1)}</span>
            <div>
              <strong>{player.display_name}{player.user_id === snapshot.current_user_id ? " · You" : ""}</strong>
              <small>{player.state_count} states</small>
            </div>
            <b>{player.cumulative_score}</b>
          </div>
        ))}
      </div>
    </main>
  );
}

export function LeaguePicker({ groups, active, onPick, onClose }: { groups: GroupRow[]; active: string; onPick: (id: string) => void; onClose: () => void }) {
  return <div className={styles.modalScrim} onClick={onClose}><section className={styles.leagueModal} onClick={(event) => event.stopPropagation()}><div className={styles.modalHeader}><h2>Your leagues</h2><button onClick={onClose}>×</button></div>{groups.map((group) => <button key={group.id} className={`${styles.leagueOption} ${group.id === active ? styles.leagueOptionActive : ""}`} onClick={() => onPick(group.id)}><div><strong>{group.name}</strong><small>{group.member_count} players · {group.status}</small></div><span>{group.invite_code}</span></button>)}</section></div>;
}
