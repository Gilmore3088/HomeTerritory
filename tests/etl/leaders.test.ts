// Season stat leaders from Lahman Batting.csv, pinned against a fixture
// cut from the real 2021 release (etl/fixtures/batting.sample.csv):
// Maris's 61 in the 1961 AL, Cepeda leading the 1961 NL, the 2021 AL
// HR TIE (Guerrero Jr. and Perez, 48 each) that must produce nothing,
// and 1898 rows outside the modern era.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseCsv } from "../../etl/lib/csv.ts";
import { lahmanLeaders } from "../../etl/seeds/lahman.ts";

const batting = parseCsv(readFileSync("etl/fixtures/batting.sample.csv", "utf8"));
const names = new Map([
  ["marisro01", "Roger Maris"],
  ["cepedor01", "Orlando Cepeda"],
  ["perezsa02", "Salvador Perez"],
  ["tatisfe02", "Fernando Tatis Jr."],
]);

test("undisputed leaders only, modern era only, ties produce nothing", () => {
  const leaders = lahmanLeaders(batting, names);
  const byId = new Map(leaders.map((row) => [row.id as string, row]));

  const maris = byId.get("lahman:leader:HR:AL:1961");
  assert.ok(maris, "the 1961 AL HR lead is undisputed");
  assert.equal(maris?.holder_name, "Roger Maris");
  assert.equal(maris?.value, "61");
  assert.equal(maris?.notes, "AL");
  assert.equal(maris?.confidence, "gold");

  assert.equal(byId.get("lahman:leader:HR:NL:1961")?.holder_name, "Orlando Cepeda");

  assert.equal(byId.get("lahman:leader:HR:AL:2021"), undefined,
    "Guerrero and Perez shared the 2021 AL lead -- a tie compiles nothing");
  assert.equal(byId.get("lahman:leader:RBI:AL:2021")?.holder_name, "Salvador Perez",
    "the RBI lead that same season was undisputed");

  assert.ok(![...byId.keys()].some((id) => id.includes("1898")),
    "pre-1901 seasons stay out of the modern-era families");

  const tatis = byId.get("lahman:leader:HR:NL:2021");
  assert.equal(tatis?.holder_name, "Fernando Tatis Jr.");
});
