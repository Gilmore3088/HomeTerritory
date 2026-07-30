"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

const SPORTS = ["NFL", "NCAA Football", "MLB", "NBA", "NCAA Basketball", "NHL"];

type GroupRow = {
  id: string;
  name: string;
  status: string;
  invite_code: string;
  sports: string[];
  member_count: number;
  is_commissioner: boolean;
};

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Request failed");
  return payload;
}

export function DashboardClient({ initialGroups }: { initialGroups: GroupRow[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [sports, setSports] = useState<string[]>(["NFL", "NCAA Football", "MLB", "NBA"]);
  const [seasonLength, setSeasonLength] = useState(30);
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleSport(sport: string) {
    setSports((current) => current.includes(sport) ? current.filter((item) => item !== sport) : [...current, sport]);
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const payload = await postJson("/api/groups", { name, sports, seasonLength });
      router.push(`/g/${payload.groupId}`);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create group"); }
    finally { setBusy(false); }
  }

  async function joinGroup(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const payload = await postJson("/api/groups/join", { inviteCode });
      router.push(`/g/${payload.groupId}`);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not join group"); }
    finally { setBusy(false); }
  }

  return (
    <>
      {error && <div className="feedback" style={{ marginBottom: 14 }}>{error}</div>}
      <div className="grid-2">
        <section className="panel">
          <h2>Create a group</h2>
          <form className="form-stack" onSubmit={createGroup}>
            <label className="label">Group name<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sunday Group Chat" required /></label>
            <div className="label">Sports</div>
            <div className="checkbox-grid">
              {SPORTS.map((sport) => <label className="check" key={sport}><input type="checkbox" checked={sports.includes(sport)} onChange={() => toggleSport(sport)} />{sport}</label>)}
            </div>
            <label className="label">Season length<select className="input" value={seasonLength} onChange={(e) => setSeasonLength(Number(e.target.value))}><option value={14}>14 days</option><option value={30}>30 days</option><option value={60}>60 days</option></select></label>
            <button className="btn btn-primary" disabled={busy || sports.length === 0}>Create group</button>
          </form>
        </section>
        <section className="panel">
          <h2>Join with an invite code</h2>
          <form className="form-stack" onSubmit={joinGroup}>
            <label className="label">Invite code<input className="input" value={inviteCode} onChange={(e) => setInviteCode(e.target.value.toUpperCase())} maxLength={8} placeholder="AB12CD34" required /></label>
            <button className="btn btn-secondary" disabled={busy}>Join group</button>
          </form>
          <h3 style={{ marginTop: 28 }}>Your groups</h3>
          <div className="group-list">
            {initialGroups.length === 0 && <div className="empty">No groups yet.</div>}
            {initialGroups.map((group) => (
              <div className="group-row" key={group.id}>
                <div><strong>{group.name}</strong><div className="subtle">{group.member_count} players · {group.status}</div><div className="chips">{group.sports.slice(0,3).map((sport) => <span className="chip" key={sport}>{sport}</span>)}</div></div>
                <a className="btn btn-ghost" href={`/g/${group.id}`}>Open</a>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
