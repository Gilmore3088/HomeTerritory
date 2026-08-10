// lib/ux-copy.ts reuses lib/game-rules.ts through the project's "@/*" path
// alias, which node's resolver does not understand -- bridged with the same
// test-only loader hook tests/cron-tick-route.test.ts uses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const projectRoot = pathToFileURL(`${process.cwd()}/`).href;
const loaderSource = `
  const ROOT = ${JSON.stringify(projectRoot)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      const withExt = /\\.[a-zA-Z0-9]+$/.test(rel) ? rel : rel + ".ts";
      return nextResolve(new URL(withExt, ROOT).href, context);
    }
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);

const { blockedReason, resultCopy } = await import("../lib/ux-copy.ts");

test("a timed-out failure reads as time running out, not a wrong answer", () => {
  const timedOut = resultCopy({ status: "failed", timedOut: true });
  const wrong = resultCopy({ status: "failed", timedOut: false });
  assert.match(timedOut.title, /Time/);
  assert.notEqual(timedOut.title, wrong.title);
  assert.notEqual(timedOut.message, wrong.message);
});

test("non-timeout statuses keep their own copy", () => {
  assert.equal(resultCopy({ status: "contested", timedOut: false }).title, "Challenge issued");
  assert.equal(resultCopy({ status: "completed", timedOut: false }).title, "Territory secured");
  assert.equal(resultCopy({ status: "failed", timedOut: false }).title, "Operation failed");
  assert.equal(resultCopy({ status: "void", timedOut: false }).title, "No harm done");
});

test("blockedReason explains zero actions for move-spending kinds", () => {
  const reason = blockedReason({ hasAction: true, actionsRemaining: 0, contested: false, canTarget: true, kind: "claim" });
  assert.match(reason ?? "", /No moves left/);
});

test("blockedReason precedence: contested wins over everything", () => {
  const reason = blockedReason({ hasAction: true, actionsRemaining: 0, contested: true, canTarget: false, kind: "attack" });
  assert.match(reason ?? "", /attack is already active/);
});

test("blockedReason explains a missing border on claim and attack", () => {
  const claim = blockedReason({ hasAction: true, actionsRemaining: 2, contested: false, canTarget: false, kind: "claim" });
  const attack = blockedReason({ hasAction: true, actionsRemaining: 2, contested: false, canTarget: false, kind: "attack" });
  assert.match(claim ?? "", /border/);
  assert.match(attack ?? "", /border/);
});

test("blockedReason covers cooldown and the daily fortify", () => {
  const cooldown = blockedReason({ hasAction: true, actionsRemaining: 2, contested: false, canTarget: true, onCooldown: true, kind: "claim" });
  const fortified = blockedReason({ hasAction: true, actionsRemaining: 2, contested: false, canTarget: true, alreadyFortifiedToday: true, kind: "fortify" });
  assert.match(cooldown ?? "", /cooling down/);
  assert.match(fortified ?? "", /already fortified/);
});

test("blockedReason is null when the action is playable, and fortify ignores borders", () => {
  assert.equal(blockedReason({ hasAction: true, actionsRemaining: 2, contested: false, canTarget: true, kind: "attack" }), null);
  assert.equal(blockedReason({ hasAction: true, actionsRemaining: 1, contested: false, canTarget: false, kind: "fortify" }), null);
  assert.equal(blockedReason({ hasAction: false, actionsRemaining: 0, contested: true, canTarget: false }), null);
});
