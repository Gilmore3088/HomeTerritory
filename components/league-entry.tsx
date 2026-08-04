"use client";

import { useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { SPORTS } from "@/lib/game-constants";
import styles from "./territory-game-v2.module.css";

const supabase = createClient();

export default function LeagueEntry({ user, onCreated, notify }: { user: User; onCreated: (id: string) => void; notify: (text: string, error?: boolean) => void }) {
  const [tab, setTab] = useState<"join" | "create">("join");
  const [code, setCode] = useState("");
  const [name, setName] = useState("The Bench Mob");
  const [sports, setSports] = useState<string[]>(SPORTS);
  const [busy, setBusy] = useState(false);

  async function join() {
    setBusy(true);
    const { data, error } = await supabase.rpc("join_group", { p_invite_code: code.trim().toUpperCase() });
    setBusy(false);
    if (error) notify(error.message, true);
    else onCreated(data as string);
  }
  async function create() {
    setBusy(true);
    const { data, error } = await supabase.rpc("create_group_v2", {
      p_name: name,
      p_sports: sports,
      p_season_length: 14,
      p_opening_mode: "open",
      p_board_scope: "fifty",
      p_difficulty: "standard",
      p_test_mode: true,
    });
    setBusy(false);
    if (error) notify(error.message, true);
    else onCreated(data as string);
  }

  return (
    <main className={styles.entryPage}>
      <section className={styles.entryPanel}>
        <div className={styles.logoLine}><div className={styles.logoMarkSmall}>T</div><strong>Territory</strong></div>
        <span className={styles.muted}>{user.email}</span>
        <h1>Choose your battlefield.</h1>
        <p className={styles.entryWelcome}>Welcome to Territory — sports trivia over a map of the fifty states. Join a friend&apos;s league with an invite code, or start your own and send the code around.</p>
        <div className={styles.segmented}>
          <button className={tab === "join" ? styles.segmentActive : ""} onClick={() => setTab("join")}>Join league</button>
          <button className={tab === "create" ? styles.segmentActive : ""} onClick={() => setTab("create")}>Create league</button>
        </div>
        {tab === "join" ? (
          <div className={styles.form}>
            <label><span>Invite code</span><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={8} placeholder="9BCDF13C" /></label>
            <button className={styles.primaryButton} disabled={busy || code.length !== 8} onClick={join}>Join this map</button>
          </div>
        ) : (
          <div className={styles.form}>
            <label><span>League name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <div className={styles.sportGrid}>{SPORTS.map((sport) => <button key={sport} className={sports.includes(sport) ? styles.sportActive : ""} onClick={() => setSports(sports.includes(sport) ? sports.filter((item) => item !== sport) : [...sports, sport])}>{sport}</button>)}</div>
            <button className={styles.primaryButton} disabled={busy || name.trim().length < 2 || !sports.length} onClick={create}>Create league</button>
          </div>
        )}
        <button className={styles.textButton} onClick={() => supabase.auth.signOut()}>Sign out</button>
      </section>
    </main>
  );
}
