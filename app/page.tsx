import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect("/app");

  return (
    <main className="landing">
      <section className="hero">
        <div className="eyebrow">A private sports trivia game</div>
        <h1>TERRITORY</h1>
        <p className="hero-copy">
          Answer sports questions. Claim states. Steal them from friends. The map is the scoreboard;
          trivia is the game.
        </p>
        <div className="cta-row">
          <Link className="btn btn-primary" href="/login">Create or join a group</Link>
          <a className="btn btn-ghost" href="#how-it-works">How it works</a>
        </div>
        <div id="how-it-works" className="grid-2" style={{ marginTop: 42, textAlign: "left" }}>
          <div className="panel"><h2>Play in minutes</h2><p className="subtle">Three daily attack actions. Defenses wait for you for 24 hours.</p></div>
          <div className="panel"><h2>Knowledge changes the map</h2><p className="subtle">Correct answers claim territory. Stronger holds require harder streaks.</p></div>
        </div>
      </section>
    </main>
  );
}
