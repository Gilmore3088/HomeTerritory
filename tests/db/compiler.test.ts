// P3b golden tests: the question compiler and template catalog, end to end.
// A small real-fact warehouse is seeded through the facts API profile, the
// in-database pipeline runs (refresh_derived -> compile_questions), and the
// compiled public.questions rows are asserted verbatim. Covered behaviors:
//   * a clean compile writes the expected question, options and aliases
//   * shared buildings (two same-league tenants) never compile a
//     "which team plays here" question -- both answers would be true
//   * Gate B: single_source facts are counted and skipped, never compiled
//   * recompiling is idempotent (no duplicate families) and never
//     resurrects a question that telemetry or a reviewer retired
// Seed territories (MA, LA, NJ, MO, IL, IN) are disjoint from the ones the
// engine and audit suites play (WA/OR/TX/NY/OK/OH/GA/FL/ME, MT/NV/WY), so
// the compiled rows never enter a concurrently running game.
import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { admin, stackUrl } from "./helpers.ts";

const factsAdmin = createClient(stackUrl, process.env.SUPABASE_TEST_SERVICE_KEY ?? "", {
  auth: { persistSession: false },
  db: { schema: "facts" },
});

const MARK = "cmptest";
const id = (suffix: string) => `${MARK}:${suffix}`;

async function seedWarehouse(): Promise<void> {
  const src = { source: "test", confidence: "gold" };
  const teams = [
    { id: id("t-ne"), league: "NFL", name: "New England Patriots", city: "Foxborough", state: "MA", founded: 1960, ...src },
    { id: id("t-no"), league: "NFL", name: "New Orleans Saints", city: "New Orleans", state: "LA", founded: 1966, ...src },
    { id: id("t-nyg"), league: "NFL", name: "New York Giants", city: "East Rutherford", state: "NJ", founded: 1925, ...src },
    { id: id("t-nyj"), league: "NFL", name: "New York Jets", city: "East Rutherford", state: "NJ", founded: 1959, ...src },
    { id: id("t-kc"), league: "NFL", name: "Kansas City Chiefs", city: "Kansas City", state: "MO", founded: 1960, ...src },
    { id: id("t-chi"), league: "NFL", name: "Chicago Bears", city: "Chicago", state: "IL", founded: 1920, ...src },
    { id: id("t-ind"), league: "NFL", name: "Indianapolis Colts", city: "Indianapolis", state: "IN", founded: 1953, ...src },
    { id: id("t-az"), league: "NFL", name: "Arizona Cardinals", city: "Glendale", state: "AZ", founded: 1920, ...src },
    // Gate B case: everything about the Cowboys is single_source here, so
    // no template may compile anything from these rows.
    { id: id("t-dal"), league: "NFL", name: "Dallas Cowboys", city: "Arlington", state: "TX", founded: 1960, source: "test", confidence: "single_source" },
  ].map((t) => ({ ...t, source_key: t.id }));

  const venues = [
    { id: id("v-gillette"), name: "Gillette Stadium", city: "Foxborough", state: "MA", capacity: 64628, opened: 2002,
      latitude: 42.09,
      tenants: [{ team_id: id("t-ne"), team_name: "New England Patriots", league: "NFL" }], ...src },
    { id: id("v-superdome"), name: "Caesars Superdome", city: "New Orleans", state: "LA", capacity: 73208, opened: 1975,
      latitude: 29.95,
      tenants: [{ team_id: id("t-no"), team_name: "New Orleans Saints", league: "NFL" }], ...src },
    // Shared-building case: two truthful NFL answers, must not compile.
    { id: id("v-metlife"), name: "MetLife Stadium", city: "East Rutherford", state: "NJ", capacity: 82500, opened: 2010,
      latitude: 40.81,
      tenants: [
        { team_id: id("t-nyg"), team_name: "New York Giants", league: "NFL" },
        { team_id: id("t-nyj"), team_name: "New York Jets", league: "NFL" },
      ], ...src },
    { id: id("v-arrowhead"), name: "Arrowhead Stadium", city: "Kansas City", state: "MO", capacity: 76416, opened: 1972,
      latitude: 39.05,
      tenants: [{ team_id: id("t-kc"), team_name: "Kansas City Chiefs", league: "NFL" }], ...src },
    { id: id("v-soldier"), name: "Soldier Field", city: "Chicago", state: "IL", capacity: 61500, opened: 1924,
      latitude: 41.86,
      tenants: [{ team_id: id("t-chi"), team_name: "Chicago Bears", league: "NFL" }], ...src },
    { id: id("v-statefarm"), name: "State Farm Stadium", city: "Glendale", state: "AZ", capacity: 63400, opened: 2006,
      latitude: 33.53,
      tenants: [{ team_id: id("t-az"), team_name: "Arizona Cardinals", league: "NFL" }], ...src },
    // Gate B case, venue side.
    { id: id("v-att"), name: "AT&T Stadium", city: "Arlington", state: "TX", capacity: 80000, opened: 2009,
      latitude: 32.75,
      tenants: [{ team_id: id("t-dal"), team_name: "Dallas Cowboys", league: "NFL" }],
      source: "test", confidence: "single_source" },
  ].map((v) => ({ ...v, source_key: v.id }));

  const championships = [
    { id: id("ch-sb36"), league: "NFL", season: "Super Bowl XXXVI", year: 2002,
      winner_team_id: id("t-ne"), winner_name: "New England Patriots",
      runner_up_name: "St. Louis Rams", mvp_name: "Tom Brady", ...src, source_key: id("ch-sb36") },
  ];

  const drafts = [
    { id: id("d-1998-1"), league: "NFL", year: 1998, round: 1, overall_pick: 1, player_name: "Peyton Manning", team_name: "Indianapolis Colts", college: "Tennessee", ...src },
    // Pool rows: their team_name has no facts.teams match, so they feed the
    // distractor pool without becoming answer instances themselves.
    { id: id("d-1998-2"), league: "NFL", year: 1998, round: 1, overall_pick: 2, player_name: "Ryan Leaf", team_name: "San Diego Chargers", college: "Washington State", ...src },
    { id: id("d-1998-3"), league: "NFL", year: 1998, round: 1, overall_pick: 3, player_name: "Andre Wadsworth", team_name: "Arizona Cardinals", college: "Florida State", ...src },
    { id: id("d-1998-4"), league: "NFL", year: 1998, round: 1, overall_pick: 4, player_name: "Charles Woodson", team_name: "Oakland Raiders", college: "Michigan", ...src },
  ].map((d) => ({ ...d, source_key: d.id }));

  const seeds: Array<[string, Record<string, unknown>[]]> = [
    ["teams", teams], ["venues", venues], ["drafts", drafts], ["championships", championships],
  ];
  for (const [table, rows] of seeds) {
    const { error } = await factsAdmin.from(table).upsert(rows, { onConflict: "id" });
    assert.equal(error, null, `${table} seed failed: ${error?.message}`);
  }
}

async function cleanUp(): Promise<void> {
  await admin.from("questions").delete().like("family_key", `%${MARK}%`);
  await factsAdmin.from("state_links").delete().like("entity_id", `${MARK}%`);
  for (const table of ["drafts", "championships", "venues", "teams"]) {
    await factsAdmin.from(table).delete().like("id", `${MARK}%`);
  }
}

interface CompileSummary {
  templates: number;
  instances_seen: number;
  written: number;
  skipped_lint: number;
  skipped_unverified: number;
  template_errors: number;
}

test("compiler golden run", async (t) => {
  await seedWarehouse();
  t.after(cleanUp);

  const derived = await admin.rpc("refresh_derived");
  assert.equal(derived.error, null, `refresh_derived failed: ${derived.error?.message}`);
  assert.ok(
    ((derived.data as { state_links: number }).state_links) >= 12,
    "the state-link spine should cover the seeded teams and venues",
  );

  const compiled = await admin.rpc("compile_questions");
  assert.equal(compiled.error, null, `compile_questions failed: ${compiled.error?.message}`);
  const summary = compiled.data as CompileSummary;

  await t.test("no template errored against real data", () => {
    assert.equal(summary.template_errors, 0, JSON.stringify(summary));
    assert.ok(summary.written > 0, "the catalog should compile questions from the seed");
  });

  await t.test("venue-tenant golden: text, options, aliases, tier", async () => {
    const { data, error } = await admin
      .from("questions")
      .select("question_text, correct_answer, options, aliases, tier, format, territory_id, active, validation_status")
      .eq("family_key", `venue-tenant-mc:${id("v-gillette")}:NFL`)
      .single();
    assert.equal(error, null, "the Gillette Stadium question should compile exactly once");
    const q = data as {
      question_text: string; correct_answer: string; options: string[]; aliases: string[];
      tier: number; format: string; territory_id: string; active: boolean; validation_status: string;
    };
    assert.equal(q.question_text, "Which NFL team plays its home games at Gillette Stadium?");
    assert.equal(q.correct_answer, "New England Patriots");
    assert.equal(q.territory_id, "MA");
    assert.equal(q.format, "multiple_choice");
    assert.equal(q.tier, 1);
    assert.equal(q.active, true);
    assert.equal(q.validation_status, "generated_v1");
    assert.equal(q.options.length, 4);
    assert.equal(q.options[0], "New England Patriots");
    assert.equal(new Set(q.options).size, 4, "options must be distinct");
    assert.ok(q.aliases.includes("New England Patriots"), "the answer is always an accepted alias");
  });

  await t.test("a shared building never compiles a tenant question", async () => {
    const { data } = await admin
      .from("questions")
      .select("id, family_key")
      .like("family_key", `%${id("v-metlife")}%`);
    const tenantFamilies = (data ?? []).filter(
      (r: { family_key: string }) => r.family_key.startsWith("venue-tenant-"),
    );
    assert.deepEqual(tenantFamilies, [], "MetLife has two truthful NFL answers; asking is unfair");
  });

  await t.test("Gate B: single_source facts are skipped, not compiled", async () => {
    for (const entity of [id("v-att"), id("t-dal")]) {
      const { data, error } = await admin.from("questions").select("id").like("family_key", `%${entity}%`);
      assert.equal(error, null, error?.message ?? "");
      assert.deepEqual(data, [], `nothing about single_source ${entity} may compile`);
    }
    assert.ok(summary.skipped_unverified >= 2, `unverified skips should be counted: ${JSON.stringify(summary)}`);
  });

  await t.test("draft golden: distractors come from teams that drafted that year", async () => {
    const { data, error } = await admin
      .from("questions")
      .select("question_text, correct_answer, options")
      .eq("family_key", `draft-team-mc:${id("d-1998-1")}`)
      .single();
    assert.equal(error, null);
    const q = data as { question_text: string; correct_answer: string; options: string[] };
    assert.equal(q.question_text, "Which team selected Peyton Manning with the #1 overall pick of the 1998 NFL Draft?");
    assert.equal(q.correct_answer, "Indianapolis Colts");
    assert.deepEqual(
      [...q.options].sort(),
      ["Arizona Cardinals", "Indianapolis Colts", "Oakland Raiders", "San Diego Chargers"],
      "the pool is exactly the four franchises that drafted in 1998",
    );

    const ff = await admin
      .from("questions")
      .select("correct_answer, aliases")
      .eq("family_key", `draft-player-ff:${id("d-1998-1")}`)
      .single();
    assert.equal(ff.error, null);
    const player = ff.data as { correct_answer: string; aliases: string[] };
    assert.equal(player.correct_answer, "Peyton Manning");
    assert.ok(player.aliases.includes("Manning"), "a bare surname must be an accepted answer");
  });

  await t.test("v1.1 goldens: runner-up, MVP with smart article, margin-safe geography", async () => {
    const runnerUp = await admin
      .from("questions")
      .select("question_text, correct_answer, options")
      .eq("family_key", `championship-runnerup-mc:${id("ch-sb36")}`)
      .single();
    assert.equal(runnerUp.error, null, "the runner-up question should compile");
    const ru = runnerUp.data as { question_text: string; correct_answer: string; options: string[] };
    assert.equal(ru.question_text, "Who did the New England Patriots beat in Super Bowl XXXVI?",
      "Super Bowl labels take no article");
    assert.equal(ru.correct_answer, "St. Louis Rams");
    assert.ok(!ru.options.includes("New England Patriots"), "the winner is in the text, never an option");

    const mvp = await admin
      .from("questions")
      .select("question_text, correct_answer, aliases")
      .eq("family_key", `championship-mvp-ff:${id("ch-sb36")}`)
      .single();
    assert.equal(mvp.error, null);
    const m = mvp.data as { question_text: string; correct_answer: string; aliases: string[] };
    assert.equal(m.question_text, "Who was named MVP of Super Bowl XXXVI?");
    assert.equal(m.correct_answer, "Tom Brady");
    assert.ok(m.aliases.includes("Brady"));

    const north = await admin
      .from("questions")
      .select("correct_answer, options")
      .eq("family_key", `venue-northernmost-compare-mc:${id("v-gillette")}`)
      .single();
    assert.equal(north.error, null, "Gillette clears the 1.5-degree margin over three verified venues");
    const n = north.data as { correct_answer: string; options: string[] };
    assert.equal(n.correct_answer, "Gillette Stadium");
    for (const nearTie of ["Soldier Field", "MetLife Stadium", "AT&T Stadium"]) {
      assert.ok(!n.options.includes(nearTie),
        `${nearTie} is inside the margin or unverified and must never be an option`);
    }
  });

  await t.test("recompiling is idempotent and honors retirement", async () => {
    const countRows = async () => {
      const { count } = await admin
        .from("questions")
        .select("id", { count: "exact", head: true })
        .like("family_key", `%${MARK}%`);
      return count ?? 0;
    };
    const before = await countRows();

    const retired = await admin
      .from("questions")
      .update({ active: false })
      .eq("family_key", `venue-tenant-mc:${id("v-gillette")}:NFL`)
      .select("id")
      .single();
    assert.equal(retired.error, null);

    const again = await admin.rpc("compile_questions");
    assert.equal(again.error, null);
    assert.equal((again.data as CompileSummary).template_errors, 0);

    assert.equal(await countRows(), before, "recompiling must not duplicate families");
    const after = await admin
      .from("questions")
      .select("active")
      .eq("family_key", `venue-tenant-mc:${id("v-gillette")}:NFL`)
      .single();
    assert.equal((after.data as { active: boolean }).active, false,
      "a retired question stays retired through recompiles");
  });
});
