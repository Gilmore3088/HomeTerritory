// Wikidata-side pure functions, tested on trimmed snapshots of live SPARQL
// responses (retrieved 2026-09-30).
import assert from "node:assert/strict";
import test from "node:test";
import { qid, simplifyBindings, dedupeBy, type SparqlResponse } from "../../etl/lib/sparql.ts";
import { verifyStateRows, EXPECTED_STATE_QIDS } from "../../etl/sources/wikidata-states.ts";
import { toAthleteRows } from "../../etl/sources/wikidata-athletes.ts";
import { toTeamRows, toVenueRows } from "../../etl/sources/wikidata-teams.ts";
import { collectEnrichment, surnameAlias } from "../../etl/sources/wikidata-enrich.ts";

function literal(value: string): { type: string; value: string } {
  return { type: "literal", value };
}
function entity(q: string): { type: string; value: string } {
  return { type: "uri", value: `http://www.wikidata.org/entity/${q}` };
}

test("qid + simplifyBindings flatten the SPARQL shape", () => {
  const response: SparqlResponse = {
    head: { vars: ["p", "pLabel", "links"] },
    results: { bindings: [
      { p: entity("Q82496"), pLabel: literal("Colin Kaepernick"), links: literal("36") },
      { p: entity("Q1097511"), pLabel: literal("J. J. Watt") },
    ] },
  };
  const rows = simplifyBindings(response);
  assert.deepEqual(rows[0], { p: "Q82496", pLabel: "Colin Kaepernick", links: "36" });
  assert.deepEqual(rows[1], { p: "Q1097511", pLabel: "J. J. Watt", links: null });
  assert.equal(qid("http://www.wikidata.org/entity/Q99"), "Q99");
});

test("state mapping accepts the live snapshot and rejects drift", () => {
  const good = Object.entries(EXPECTED_STATE_QIDS).map(([code, q]) => ({
    state: q,
    stateLabel: Object.keys(EXPECTED_STATE_QIDS).length > 0
      ? fullName(code)
      : "",
  }));
  const mapping = verifyStateRows(good);
  assert.equal(mapping.WI, "Q1537");
  assert.equal(Object.keys(mapping).length, 50);

  const drifted = good.map((row) => (row.stateLabel === "Wisconsin" ? { ...row, state: "Q999999" } : row));
  assert.throws(() => verifyStateRows(drifted), /drifted/);
});

function fullName(code: string): string {
  const names: Record<string, string> = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
    CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
    KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
    MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
    NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
    OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
    SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
    VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  };
  return names[code];
}

test("toAthleteRows keeps labeled entities, dates, and prominence from sitelinks", () => {
  // Trimmed from the live Wisconsin/American-football probe.
  const rows = [
    { p: "Q82496", pLabel: "Colin Kaepernick", cityLabel: "Milwaukee", dob: "1987-11-03T00:00:00Z", dod: null, links: "36" },
    { p: "Q1144803", pLabel: "Curly Lambeau", cityLabel: "Green Bay", dob: "1898-04-09T00:00:00Z", dod: "1965-06-01T00:00:00Z", links: "14" },
    { p: "Q99999999", pLabel: "Q99999999", cityLabel: null, dob: null, dod: null, links: "8" },
    { p: "Q82496", pLabel: "Colin Kaepernick", cityLabel: "Milwaukee", dob: "1987-11-03T00:00:00Z", dod: null, links: "36" },
  ];
  const { athletes, prominence } = toAthleteRows(rows, "WI", "NFL");
  assert.equal(athletes.length, 2, "dedup by QID and drop unlabeled entities");
  assert.equal(athletes[0].full_name, "Colin Kaepernick");
  assert.equal(athletes[0].birth_state, "WI");
  assert.equal(athletes[0].birth_date, "1987-11-03");
  assert.equal(athletes[1].death_date, "1965-06-01");
  const kap = prominence.find((p) => p.entity_id === "Q82496");
  const lambeau = prominence.find((p) => p.entity_id === "Q1144803");
  assert.ok(kap && lambeau && kap.score > lambeau.score, "more sitelinks -> higher prominence");
  assert.ok(kap!.score > 0 && kap!.score <= 1);
});

test("toTeamRows + toVenueRows build tenancy-aware venue facts", () => {
  const teamRows = [
    { team: "Q193390", teamLabel: "New England Patriots", venue: "Q167159", venueLabel: "Gillette Stadium", stateLabel: "Massachusetts", founded: "1959-01-01T00:00:00Z", links: "60" },
    { team: "Q193390", teamLabel: "New England Patriots", venue: "Q167159", venueLabel: "Gillette Stadium", stateLabel: "Massachusetts", founded: "1959-01-01T00:00:00Z", links: "60" },
    { team: "Q172435", teamLabel: "New Orleans Saints", venue: null, venueLabel: null, stateLabel: null, founded: null, links: "50" },
  ];
  const { teams, tenancies } = toTeamRows(teamRows, "NFL");
  assert.equal(teams.length, 2);
  assert.equal(teams[0].state, "MA");
  assert.equal(teams[0].founded, 1959);
  assert.deepEqual(tenancies.get("Q167159")?.map((t) => t.team_name), ["New England Patriots"]);

  const venueRows = [
    { v: "Q167159", vLabel: "Gillette Stadium", cityLabel: "Foxborough", stateLabel: "Massachusetts",
      coord: "Point(-71.264 42.091)", elev: "89", capacity: "64628", opened: "2002-01-01T00:00:00Z" },
  ];
  const venues = toVenueRows(venueRows, tenancies);
  assert.equal(venues.length, 1);
  assert.equal(venues[0].state, "MA");
  assert.equal(venues[0].latitude, 42.091);
  assert.equal(venues[0].longitude, -71.264);
  assert.equal(venues[0].elevation_m, 89);
  assert.equal(venues[0].capacity, 64628);
  assert.equal(venues[0].opened, 2002);
  assert.equal((venues[0].tenants as { team_name: string }[])[0].team_name, "New England Patriots");
});

test("collectEnrichment groups careers and aliases; surnameAlias is sane", () => {
  const rows = [
    { p: "Q82496", teamLabel: "San Francisco 49ers", teamLeagueLabel: "National Football League", collegeLabel: "University of Nevada, Reno", alias: "Kaep" },
    { p: "Q82496", teamLabel: "San Francisco 49ers", teamLeagueLabel: "National Football League", collegeLabel: "University of Nevada, Reno", alias: "Colin Rand Kaepernick" },
    { p: "Q82496", teamLabel: "Nevada Wolf Pack football", teamLeagueLabel: null, collegeLabel: "University of Nevada, Reno", alias: "Kaep" },
  ];
  const { proTeams, colleges, aliases } = collectEnrichment(rows);
  assert.deepEqual(proTeams.get("Q82496")?.map((t) => t.team_name),
    ["San Francisco 49ers", "Nevada Wolf Pack football"]);
  assert.equal(colleges.get("Q82496")?.length, 1);
  assert.deepEqual([...(aliases.get("Q82496") ?? [])].sort(), ["Colin Rand Kaepernick", "Kaep"]);

  assert.equal(surnameAlias("Walter Payton"), "Payton");
  assert.equal(surnameAlias("Ken Griffey Jr."), null, "suffixes are not surnames");
  assert.equal(surnameAlias("Pelé"), null);
});

test("dedupeBy keeps first occurrence", () => {
  const rows = [{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "a", n: 3 }];
  assert.deepEqual(dedupeBy(rows, (r) => r.id).map((r) => r.n), [1, 2]);
});
