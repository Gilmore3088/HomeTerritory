// ESPN scoreboard parser, pinned against the live response shape
// (football/nfl/scoreboard?dates=20250928, fetched 2026-09-30). The Dublin
// game is the international-venue case: completed, real winner, but no US
// state -- it must be skipped, not mis-linked.
import assert from "node:assert/strict";
import test from "node:test";
import { toEventRows, type ScoreboardJson } from "../../etl/sources/espn-events.ts";

const scoreboard: ScoreboardJson = {
  events: [
    {
      // Steelers 24-21 Vikings at Croke Park, Dublin -- completed, non-US.
      id: "401772632",
      date: "2025-09-28T13:30Z",
      season: { year: 2025 },
      competitions: [{
        venue: { fullName: "Croke Park", address: { city: "Dublin" } },
        competitors: [
          { homeAway: "home", winner: true, score: "24", team: { displayName: "Pittsburgh Steelers" } },
          { homeAway: "away", winner: false, score: "21", team: { displayName: "Minnesota Vikings" } },
        ],
        status: { type: { completed: true } },
        leaders: [{ leaders: [{ athlete: { fullName: "Carson Wentz" } }] }],
      }],
    },
    {
      // Falcons 34-27 Commanders at Mercedes-Benz Stadium, Atlanta GA.
      id: "401772739",
      date: "2025-09-28T17:00Z",
      season: { year: 2025 },
      competitions: [{
        venue: { fullName: "Mercedes-Benz Stadium", address: { city: "Atlanta", state: "GA" } },
        competitors: [
          { homeAway: "home", winner: true, score: "34", team: { displayName: "Atlanta Falcons" } },
          { homeAway: "away", winner: false, score: "27", team: { displayName: "Washington Commanders" } },
        ],
        status: { type: { completed: true } },
        headlines: [{ shortLinkText: "Penix and Robinson lead Falcons past Commanders" }],
        leaders: [
          { leaders: [{ athlete: { fullName: "Michael Penix Jr." } }] },
          { leaders: [{ athlete: { fullName: "Bijan Robinson" } }] },
          { leaders: [{ athlete: { fullName: "Bijan Robinson" } }] },
        ],
      }],
    },
    {
      // In-progress game: no final, no row.
      id: "401772999",
      date: "2025-09-28T20:00Z",
      season: { year: 2025 },
      competitions: [{
        venue: { fullName: "Lambeau Field", address: { city: "Green Bay", state: "WI" } },
        competitors: [
          { homeAway: "home", score: "7", team: { displayName: "Green Bay Packers" } },
          { homeAway: "away", score: "3", team: { displayName: "Chicago Bears" } },
        ],
        status: { type: { completed: false } },
      }],
    },
  ],
};

test("completed US finals become events; international and live games do not", () => {
  const rows = toEventRows("NFL", scoreboard);
  assert.equal(rows.length, 1, "only the Atlanta final qualifies");
  const row = rows[0];
  assert.equal(row.id, "espn:401772739");
  assert.equal(row.state, "GA");
  assert.equal(row.city, "Atlanta");
  assert.equal(row.year, 2025);
  assert.equal(row.event_date, "2025-09-28");
  assert.equal(row.kind, "game");
  assert.equal(row.confidence, "single_source", "unofficial source stays quarantined from compiling");
  assert.equal(
    row.title,
    "Atlanta Falcons beat the Washington Commanders 34-27 at Mercedes-Benz Stadium",
  );
  assert.equal(row.description, "Penix and Robinson lead Falcons past Commanders");
  assert.deepEqual(row.athletes, [{ name: "Michael Penix Jr." }, { name: "Bijan Robinson" }], "leaders dedupe");
  assert.deepEqual(row.teams, [
    { name: "Atlanta Falcons", score: "34", winner: true },
    { name: "Washington Commanders", score: "27", winner: false },
  ]);
});

test("an empty scoreboard parses to zero rows", () => {
  assert.deepEqual(toEventRows("NHL", {}), []);
  assert.deepEqual(toEventRows("NHL", { events: [] }), []);
});
