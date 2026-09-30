// Gate C reviewer plumbing: prompt shape and verdict parsing. The API call
// itself is owner-run (needs ANTHROPIC_API_KEY); these pin the pure parts.
import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt, parseVerdicts } from "../../etl/gate-c.ts";

const mc = {
  id: "q1", question_text: "Which NFL team plays at Lambeau Field?", format: "multiple_choice",
  options: ["Green Bay Packers", "Chicago Bears", "Minnesota Vikings", "Detroit Lions"],
  correct_answer: "Green Bay Packers", aliases: ["Packers"], territory_id: "WI", sport: "NFL",
};
const ff = { ...mc, id: "q2", format: "free_fill" };

test("the prompt carries options only for multiple choice", () => {
  const prompt = buildPrompt([mc, ff]);
  // The instructions end with a blank line; everything after is the payload.
  const payload = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));
  assert.equal(payload.length, 2);
  assert.deepEqual(payload[0].options, mc.options);
  assert.equal(payload[1].options, undefined);
  assert.ok(prompt.includes("ONLY a JSON array"));
});

test("verdict parsing keeps known ids, coerces ok, and bounds issues", () => {
  const reply = [
    "Here are my verdicts:",
    JSON.stringify([
      { id: "q1", ok: true, issues: [] },
      { id: "q2", ok: "yes", issues: ["a", "b", "c", "d", "e", "f", "g"] },
      { id: "q-unknown", ok: false, issues: ["hallucinated row"] },
    ]),
  ].join("\n");
  const verdicts = parseVerdicts(reply, ["q1", "q2"]);
  assert.equal(verdicts.length, 2);
  assert.deepEqual(verdicts[0], { id: "q1", ok: true, issues: [] });
  assert.equal(verdicts[1].ok, false, "anything but literal true is not a pass");
  assert.equal(verdicts[1].issues.length, 5, "issue lists are capped");
});

test("a reply without a JSON array is rejected loudly", () => {
  assert.throws(() => parseVerdicts("I could not review these.", ["q1"]));
});
