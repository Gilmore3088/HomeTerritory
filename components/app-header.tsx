"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function AppHeader({ detail }: { detail?: string }) {
  const router = useRouter();
  async function signOut() {
    await createClient().auth.signOut();
    router.push("/");
    router.refresh();
  }
  return (
    <header className="topbar">
      <a className="brand" href="/app">HOME<span>TERRITORY</span></a>
      <div className="topbar-meta">
        {detail && <span className="pill">{detail}</span>}
        <button className="btn btn-ghost" style={{ minHeight: 36, padding: "0 12px" }} onClick={signOut}>Sign out</button>
      </div>
    </header>
  );
}
