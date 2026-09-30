export const metadata = { title: "Data Sources — Home Territory" };

const wrap: React.CSSProperties = { maxWidth: 720, margin: "0 auto", padding: "32px 16px", lineHeight: 1.6 };

/**
 * The attribution page the design requires (Retrosheet's notice is a
 * condition of use; the others deserve the credit). Static on purpose:
 * this list changes only when an ingester does.
 */
export default function SourcesPage() {
  return (
    <main style={wrap}>
      <h1>Data sources</h1>
      <p>
        Home Territory&apos;s trivia is compiled from public sports data. Every question
        carries provenance back to the rows it was built from. Our thanks to:
      </p>
      <ul>
        <li>
          <strong>Wikidata</strong> (CC0) — the backbone: athletes, teams, venues,
          championships, and the alias lists that make free-fill answers forgiving.
        </li>
        <li>
          <strong>Lahman Baseball Database</strong> — baseball history to 1871:
          players, awards, Hall of Fame voting, season results. Created and
          maintained by Sean Lahman and volunteers.
        </li>
        <li>
          <strong>nflverse</strong> — open NFL data including the draft history
          our NFL draft questions are built from.
        </li>
        <li>
          <strong>ESPN</strong> — unofficial public JSON for current-season
          scores; used for fresh-event context, never as a sole source of a
          compiled fact.
        </li>
        <li>
          <strong>Retrosheet</strong> — where game-log detail appears, the
          information used was obtained free of charge from and is copyrighted
          by Retrosheet. Interested parties may contact Retrosheet at
          www.retrosheet.org. (This notice is a condition of Retrosheet&apos;s
          generous license.)
        </li>
      </ul>
      <p>
        Facts are cross-verified between sources where possible; anything that
        rests on a single source is quarantined from play until confirmed.
        Sports Reference sites are never scraped — their terms prohibit it — and
        are used only for occasional manual verification by a human reviewer.
      </p>
    </main>
  );
}
