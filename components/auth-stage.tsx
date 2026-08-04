"use client";

import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { edgeErrorMessage } from "@/lib/game-format";
import { PATHS } from "@/lib/game-constants";
import styles from "./territory-game-v2.module.css";

const supabase = createClient();

export default function AuthStage({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    if (mode === "signin") {
      // supabase-js queues auth calls behind a shared Web Lock; if another
      // window is starving it the promise can hang. The watchdog frees the
      // button so the player can retry instead of staring at "Working".
      const watchdog = window.setTimeout(() => {
        setBusy(false);
        notify("Sign-in is taking longer than expected. Check your connection and try again.", true);
      }, 12_000);
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      window.clearTimeout(watchdog);
      setBusy(false);
      if (error) notify(error.message, true);
      return;
    }

    const { data, error } = await supabase.functions.invoke("test-signup", {
      body: { displayName, email, password, inviteCode },
    });
    if (error) {
      setBusy(false);
      notify(await edgeErrorMessage(error), true);
      return;
    }
    const payload = data as { ok?: boolean; error?: string; message?: string };
    if (!payload.ok) {
      setBusy(false);
      notify(payload.error ?? "Account creation failed.", true);
      return;
    }
    const signIn = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signIn.error) {
      notify(`Account created, but sign-in failed: ${signIn.error.message}`, true);
      return;
    }
    notify(payload.message ?? "Account created and joined.");
  }

  return (
    <main className={styles.authPage}>
      <div className={styles.authBackdrop} aria-hidden="true">
        <svg viewBox="0 0 1030 620">
          {Object.entries(PATHS).map(([code, path]) => (
            <path key={code} d={path} fill={code === "TX" ? "#E34A34" : "rgba(255,255,255,.08)"} stroke="rgba(255,255,255,.13)" strokeWidth="1" />
          ))}
        </svg>
      </div>
      <section className={styles.authHero}>
        <div className={styles.logoMark}>T</div>
        <div className={styles.kicker}>SPORTS TRIVIA · TERRITORY WAR</div>
        <h1>Know the game.<br />Own the map.</h1>
        <p>Claim states, defend borders and settle which friend actually knows sports.</p>
      </section>
      <section className={styles.authPanel}>
        <div className={styles.segmented}>
          <button className={mode === "signin" ? styles.segmentActive : ""} onClick={() => setMode("signin")}>Sign in</button>
          <button className={mode === "signup" ? styles.segmentActive : ""} onClick={() => setMode("signup")}>Join playtest</button>
        </div>
        <form onSubmit={submit} className={styles.form}>
          {mode === "signup" && (
            <>
              <label><span>Display name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="nickname" required /></label>
              <label><span>League invite code</span><input value={inviteCode} onChange={(event) => setInviteCode(event.target.value.toUpperCase())} maxLength={8} placeholder="9BCDF13C" required /></label>
            </>
          )}
          <label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
          <label><span>Password</span><input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} required /></label>
          {mode === "signup" && <div className={styles.confirmNote}><strong>No confirmation email.</strong> A valid playtest code creates a confirmed account and joins the league immediately.</div>}
          <button className={styles.primaryButton} disabled={busy}>{busy ? "Working…" : mode === "signin" ? "Enter the map" : "Create account and join"}</button>
        </form>
      </section>
    </main>
  );
}
