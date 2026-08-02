"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import styles from "./recap.module.css";

const supabase = createClient(
  "https://gduvdnpxgdniogmxxlmg.supabase.co",
  "sb_publishable_Xgxcnh4NUlZ7dkYHeC-xiw_mOmxQxGZ",
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
);

type Standing = { name: string; score: number; states: number };
type RecapData = {
  league: string;
  period_start: string;
  period_end: string;
  recap: {
    day?: number;
    standings?: Standing[];
    best_defender?: { name: string; defenses: number } | null;
    most_fought_state?: { state: string; attacks: number } | null;
    biggest_steal?: { message: string; state: string } | null;
    map?: Record<string, string>;
  };
};

export default function RecapPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState<string | null>(null);
  const [data, setData] = useState<RecapData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    params.then(({ token: resolved }) => setToken(resolved));
  }, [params]);

  useEffect(() => {
    if (!token) return;
    supabase.rpc("get_public_recap", { p_share_token: token }).then(({ data: payload, error: recapError }) => {
      if (recapError) setError(recapError.message);
      else if (!payload) setError("This recap could not be found.");
      else setData(payload as RecapData);
    });
  }, [token]);

  const ownership = useMemo(() => {
    const groups = new Map<string, string[]>();
    Object.entries(data?.recap.map ?? {}).forEach(([state, owner]) => {
      const current = groups.get(owner) ?? [];
      current.push(state);
      groups.set(owner, current);
    });
    return [...groups.entries()]
      .map(([owner, states]) => ({ owner, states: states.sort() }))
      .sort((a, b) => b.states.length - a.states.length);
  }, [data]);

  if (error) return <main className={styles.page}><section className={styles.empty}><h1>Recap unavailable</h1><p>{error}</p><a href="/">Open Territory</a></section></main>;
  if (!data) return <main className={styles.page}><section className={styles.empty}><p>Loading the recap…</p></section></main>;

  const standings = data.recap.standings ?? [];

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.logo}>T</div>
        <div>
          <span>WEEKLY FIELD REPORT · DAY {data.recap.day ?? "—"}</span>
          <h1>{data.league}</h1>
          <p>{new Date(data.period_start).toLocaleDateString()}–{new Date(data.period_end).toLocaleDateString()}</p>
        </div>
        <button type="button" onClick={() => navigator.clipboard.writeText(window.location.href)}>Copy share link</button>
      </section>

      <section className={styles.leader}>
        <span>LEAGUE LEADER</span>
        <h2>{standings[0]?.name ?? "No leader yet"}</h2>
        <p>{standings[0] ? `${standings[0].score} points · ${standings[0].states} states` : "The map is still open."}</p>
      </section>

      <section className={styles.grid}>
        <article>
          <span>BEST DEFENSE</span>
          <strong>{data.recap.best_defender?.name ?? "No defenses yet"}</strong>
          <small>{data.recap.best_defender ? `${data.recap.best_defender.defenses} successful defenses` : "No attack was repelled this week."}</small>
        </article>
        <article>
          <span>MOST FOUGHT</span>
          <strong>{data.recap.most_fought_state?.state ?? "No contested state"}</strong>
          <small>{data.recap.most_fought_state ? `${data.recap.most_fought_state.attacks} attacks` : "The borders stayed quiet."}</small>
        </article>
        <article>
          <span>BIGGEST STEAL</span>
          <strong>{data.recap.biggest_steal?.state ?? "No completed steal"}</strong>
          <small>{data.recap.biggest_steal?.message ?? "No territory changed hands through an expired or missed defense."}</small>
        </article>
      </section>

      <section className={styles.standings}>
        <div className={styles.heading}><span>STANDINGS</span><h2>Who controls the week</h2></div>
        {standings.map((standing, index) => (
          <div className={styles.standing} key={standing.name}>
            <b>{index + 1}</b>
            <strong>{standing.name}</strong>
            <span>{standing.states} states</span>
            <em>{standing.score}</em>
          </div>
        ))}
      </section>

      <section className={styles.ownership}>
        <div className={styles.heading}><span>MAP CONTROL</span><h2>Territories by owner</h2></div>
        {ownership.map((row) => (
          <div key={row.owner}><strong>{row.owner}</strong><span>{row.states.join(" · ")}</span></div>
        ))}
      </section>

      <footer><a href="/">Open the live map</a><span>Sports trivia that changes the map.</span></footer>
    </main>
  );
}
