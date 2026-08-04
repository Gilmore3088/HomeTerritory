"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ALL_STATES, STATE_NAMES, memberColor } from "@/lib/game-constants";
import type { GroupRow, Snapshot } from "@/lib/game-types";
import styles from "./territory-game-v2.module.css";
import TerritoryMap from "./territory-map";

const supabase = createClient();

export default function LobbyStage({ snapshot, groups, groupId, setGroupId, refresh, reloadGroups, notify }: {
  snapshot: Snapshot;
  groups: GroupRow[];
  groupId: string;
  setGroupId: (id: string) => void;
  refresh: () => void;
  reloadGroups: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const me = snapshot.members.find((member) => member.user_id === snapshot.current_user_id);
  const commissioner = snapshot.group.commissioner_id === snapshot.current_user_id;
  const [homeState, setHomeState] = useState(me?.home_state ?? "");
  const [busy, setBusy] = useState(false);
  const used = new Set(snapshot.members.map((member) => member.home_state).filter(Boolean) as string[]);
  const humans = snapshot.members.filter((member) => !member.is_bot);
  const homesReady = humans.every((member) => member.home_state);

  async function saveHome() {
    setBusy(true);
    const { error } = await supabase.rpc("set_home_state", { p_group_id: snapshot.group.id, p_home_state: homeState });
    setBusy(false);
    if (error) notify(error.message, true);
    else {
      notify(`${STATE_NAMES[homeState]} is your home ground.`);
      refresh();
    }
  }
  async function start() {
    setBusy(true);
    const { error } = await supabase.rpc("start_season", { p_group_id: snapshot.group.id });
    setBusy(false);
    if (error) notify(error.message, true);
    else {
      notify("Season started.");
      refresh();
      reloadGroups();
    }
  }

  return (
    <main className={styles.lobbyPage}>
      <div className={styles.lobbyMap}>
        <TerritoryMap territories={[]} members={snapshot.members} currentUser={snapshot.current_user_id} selected={homeState || null} onSelect={(code) => { if (!used.has(code) || me?.home_state === code) setHomeState(code); }} front={null} previewHome={homeState} />
      </div>
      <section className={styles.lobbySheet}>
        <div className={styles.lobbyHeader}>
          <div><span className={styles.kicker}>LEAGUE LOBBY</span><h1>{snapshot.group.name}</h1></div>
          <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
        </div>
        <div className={styles.inviteStrip}><span>Invite code</span><strong>{snapshot.group.invite_code}</strong><button onClick={async () => { await navigator.clipboard.writeText(snapshot.group.invite_code); notify("Invite code copied."); }}>Copy</button></div>
        <div className={styles.lobbyBody}>
          <div className={styles.homeChoice}>
            <div><span className={styles.kicker}>YOUR HOME GROUND</span><h2>{homeState ? STATE_NAMES[homeState] : "Choose a state"}</h2><p>Tap the map or use the list. Your opening question determines its first garrison.</p></div>
            <select value={homeState} onChange={(event) => setHomeState(event.target.value)}><option value="">Choose state</option>{ALL_STATES.map((code) => <option key={code} value={code} disabled={used.has(code) && me?.home_state !== code}>{STATE_NAMES[code]}</option>)}</select>
            <button className={styles.primaryButton} disabled={!homeState || busy} onClick={saveHome}>{me?.home_state ? "Update home state" : "Lock home state"}</button>
          </div>
          <div className={styles.playerRail}>{snapshot.members.map((member) => <div key={member.user_id} className={styles.playerAvatar}><span style={{ background: memberColor(member) }}>{member.display_name.slice(0, 1).toUpperCase()}</span><strong>{member.display_name}</strong><small>{member.is_bot ? "Bot" : member.home_state ?? "Choosing"}</small></div>)}</div>
          {commissioner && <button className={styles.startButton} disabled={busy || humans.length < 2 || !homesReady} onClick={start}>{!homesReady ? "Waiting for home states" : humans.length < 2 ? "Two people required" : "Start the season"}</button>}
          <button className={styles.textButton} onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </section>
    </main>
  );
}
