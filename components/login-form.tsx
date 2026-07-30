"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const router = useRouter();
  const supabase = createClient();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    const result = mode === "signup"
      ? await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName.trim() || email.split("@")[0] } },
        })
      : await supabase.auth.signInWithPassword({ email, password });

    setBusy(false);
    if (result.error) {
      setMessage(result.error.message);
      return;
    }

    if (mode === "signup" && !result.data.session) {
      setMessage("Account created. Check your email to confirm, then sign in.");
      setMode("signin");
      return;
    }

    router.push("/app");
    router.refresh();
  }

  return (
    <section className="auth-card">
      <div className="eyebrow">Territory</div>
      <h1>{mode === "signin" ? "Welcome back" : "Join the game"}</h1>
      <p className="subtle">Use an email and password. Your game state is shared through Supabase—not stored only on this phone.</p>
      <form className="form-stack" onSubmit={submit}>
        {mode === "signup" && (
          <label className="label">Display name<input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required /></label>
        )}
        <label className="label">Email<input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="label">Password<input className="input" type="password" minLength={8} autoComplete={mode === "signin" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {message && <div className="feedback">{message}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}</button>
      </form>
      <button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setMessage(null); }}>
        {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
      </button>
    </section>
  );
}
