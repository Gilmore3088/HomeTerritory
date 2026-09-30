// Parser tests for the bulk seeds -- pure functions, no network, no DB.
// The draft fixture is a slice of the REAL nflverse draft_picks.csv
// (retrieved 2026-09-30) chosen to exercise every franchise-era boundary
// the code mapping has to get right.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseCsv } from "../../etl/lib/csv.ts";
import { nflverseDraftToFacts } from "../../etl/seeds/nflverse-draft.ts";
import { nflTeamName } from "../../etl/lib/nfl-teams.ts";
import { lahmanToFacts } from "../../etl/seeds/lahman.ts";

test("parseCsv handles quotes, escaped quotes and CRLF", () => {
  const rows = parseCsv('a,b,c\r\n1,"two, two","say ""hi"""\n4,5,6\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { a: "1", b: "two, two", c: 'say "hi"' });
  assert.deepEqual(rows[1], { a: "4", b: "5", c: "6" });
});

test("nfl team codes resolve era-correct franchise names", () => {
  assert.equal(nflTeamName("STL", 1981), "St. Louis Cardinals");
  assert.equal(nflTeamName("STL", 2001), "St. Louis Rams");
  assert.equal(nflTeamName("STL", 1990), null, "STL had no NFL team between the Cardinals leaving and the Rams arriving");
  assert.equal(nflTeamName("HOU", 1995), "Houston Oilers");
  assert.equal(nflTeamName("HOU", 2002), "Houston Texans");
  assert.equal(nflTeamName("PHO", 1988), "Phoenix Cardinals");
  assert.equal(nflTeamName("LVR", 2020), "Las Vegas Raiders");
  assert.equal(nflTeamName("TEN", 1997), "Tennessee Oilers");
  assert.equal(nflTeamName("TEN", 2005), "Tennessee Titans");
  assert.equal(nflTeamName("XXX", 2000), null);
});

test("nflverse draft fixture compiles to era-correct draft facts", () => {
  const rows = parseCsv(readFileSync("etl/fixtures/draft_picks.sample.csv", "utf8"));
  const facts = nflverseDraftToFacts(rows);
  const byKey = new Map(facts.map((f) => [`${f.year}:${f.overall_pick}`, f]));

  assert.equal(byKey.get("1998:1")?.player_name, "Peyton Manning");
  assert.equal(byKey.get("1998:1")?.team_name, "Indianapolis Colts");
  assert.equal(byKey.get("1981:5")?.team_name, "St. Louis Cardinals");
  assert.equal(byKey.get("2001:20")?.team_name, "St. Louis Rams");
  assert.equal(byKey.get("1995:3")?.team_name, "Houston Oilers");
  assert.equal(byKey.get("2002:1")?.team_name, "Houston Texans");
  assert.equal(byKey.get("1988:12")?.team_name, "Phoenix Cardinals");
  assert.equal(byKey.get("2020:12")?.team_name, "Las Vegas Raiders");

  // Round-2+ picks survive only as Hall of Famers.
  assert.equal(byKey.get("1980:48")?.player_name, "Dwight Stephenson");
  assert.ok(facts.every((f) => (f.round as number) === 1 || f.confidence === "gold"));
  // Every mapped fact is gold; nothing in the fixture should be unmapped.
  assert.ok(facts.every((f) => f.confidence === "gold"), "fixture rows all map to era-correct names");
});

test("lahman fixture keeps notable players and emits awards + seasons", () => {
  const files = {
    people: parseCsv([
      "playerID,birthYear,birthMonth,birthDay,birthCountry,birthState,birthCity,nameFirst,nameLast,debut,finalGame",
      "ruthba01,1895,2,6,USA,MD,Baltimore,Babe,Ruth,1914-07-11,1935-05-30",
      "nobodx01,1970,1,1,USA,OH,Akron,Joe,Nobody,1995-04-01,1996-09-20",
      "aaronha01,1934,2,5,USA,AL,Mobile,Hank,Aaron,1954-04-13,1976-10-03",
    ].join("\n")),
    hallOfFame: parseCsv([
      "playerID,yearid,votedBy,inducted,category",
      "ruthba01,1936,BBWAA,Y,Player",
      "aaronha01,1982,BBWAA,Y,Player",
    ].join("\n")),
    awards: parseCsv([
      "playerID,awardID,yearID,lgID",
      "aaronha01,Most Valuable Player,1957,NL",
      "nobodx01,Silver Slugger,1995,AL",
    ].join("\n")),
    teams: parseCsv([
      "yearID,lgID,teamID,divID,Rank,W,L,name,WSWin,LgWin",
      "1927,AL,NYA,,1,110,44,New York Yankees,Y,Y",
      "1899,NL,CLV,,12,20,134,Cleveland Spiders,N,N",
    ].join("\n")),
  };
  const { athletes, awards, seasonResults } = lahmanToFacts(files);

  const names = athletes.map((a) => a.full_name);
  assert.ok(names.includes("Babe Ruth"));
  assert.ok(names.includes("Hank Aaron"));
  assert.ok(!names.includes("Joe Nobody"), "short career + non-notable award stays out");

  const aaron = athletes.find((a) => a.full_name === "Hank Aaron") as Record<string, unknown>;
  assert.equal(aaron.birth_state, "AL");
  assert.equal(aaron.birth_city, "Mobile");
  assert.equal((aaron.hall_of_fame as unknown[]).length, 1);

  assert.equal(awards.length, 1, "only notable awards ship");
  assert.equal(awards[0].winner_name, "Hank Aaron");
  assert.equal(awards[0].year, 1957);

  assert.equal(seasonResults.length, 1, "pre-1901 seasons stay out");
  assert.equal(seasonResults[0].playoff_result, "won World Series");
});
