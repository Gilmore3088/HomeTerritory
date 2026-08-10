"use client";

import { useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { SPORTS } from "@/lib/game-constants";
import styles from "./territory-game-v2.module.css";

const supabase = createClient();

const SEASON_LENGTHS = [7, 10, 14, 30, 60];
const US_TIMEZONES = [
  { id: "America/New_York", label: "Eastern" },
  { id: "America/Chicago", label: "Central" },
  { id: "America/Denver", label: "Mountain" },
  { id: "America/Phoenix", label: "Arizona" },
  { id: "America/Los_Angeles", label: "Pacific" },
  { id: "America/Anchorage", label: "Alaska" },
  { id: "Pacific/Honolulu", label: "Hawaii" },
];

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
  } catch {
    return "America/Los_Angeles";
  }
}

export default function LeagueEntry({ user, onCreated, notify }: { user: User; onCreated: (id: string) => void; notify: (text: string, error?: boolean) => void }) {
  const [tab, setTab] = useState<"join" | "create">("join");
  const [code, setCode] = useState("");
  const [name, setName] = useState("The Bench Mob");
  const [sports, setSports] = useState<string[]>(SPORTS);
  const [seasonLength, setSeasonLength] = useState(14);
  const [openingMode, setOpeningMode] = useState<"open" | "dealt">("open");
  const [boardScope, setBoardScope] = useState<"fifty" | "lower48">("fifty");
  const [difficulty, setDifficulty] = useState<"casual" | "standard" | "hardcore">("standard");
  const [timezone, setTimezone] = useState(detectTimezone());
  const [busy, setBusy] = useState(false);

  const timezones = US_TIMEZONES.some((zone) => zone.id === timezone)
    ? US_TIMEZONES
    : [{ id: timezone, label: timezone.split("/").pop()?.replace(/_/g, " ") ?? timezone }, ...US_TIMEZONES];

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
      p_season_length: seasonLength,
      p_opening_mode: openingMode,
      p_board_scope: boardScope,
      p_difficulty: difficulty,
      p_test_mode: true,
      p_timezone: timezone,
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
        <p className={styles.entryLede}>Claim states, defend borders and settle which friend actually knows sports. Join a league with an invite code, or commission your own.</p>
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
            <div className={styles.optionRow}>
              <label><span>Season length</span>
                <select value={seasonLength} onChange={(event) => setSeasonLength(Number(event.target.value))}>
                  {SEASON_LENGTHS.map((days) => <option key={days} value={days}>{days} days</option>)}
                </select>
              </label>
              <label><span>Timezone</span>
                <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
                  {timezones.map((zone) => <option key={zone.id} value={zone.id}>{zone.label}</option>)}
                </select>
              </label>
            </div>
            <div className={styles.optionRow}>
              <label><span>Opening</span>
                <select value={openingMode} onChange={(event) => setOpeningMode(event.target.value as "open" | "dealt")}>
                  <option value="open">Open map — claim from neutral</option>
                  <option value="dealt">Dealt — the whole map is split</option>
                </select>
              </label>
              <label><span>Board</span>
                <select value={boardScope} onChange={(event) => setBoardScope(event.target.value as "fifty" | "lower48")}>
                  <option value="fifty">All 50 states</option>
                  <option value="lower48">Lower 48</option>
                </select>
              </label>
            </div>
            <label><span>Difficulty</span>
              <select value={difficulty} onChange={(event) => setDifficulty(event.target.value as "casual" | "standard" | "hardcore")}>
                <option value="casual">Casual — steals need one less answer</option>
                <option value="standard">Standard</option>
                <option value="hardcore">Hardcore — steals need one more answer</option>
              </select>
            </label>
            <button className={styles.primaryButton} disabled={busy || name.trim().length < 2 || !sports.length} onClick={create}>Create league</button>
          </div>
        )}
        <button className={styles.textButton} onClick={() => supabase.auth.signOut()}>Sign out</button>
      </section>
    </main>
  );
}
