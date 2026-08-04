import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedReason, resultCopy } from "../lib/ux-copy.ts";

test("timeout gets its own copy, distinct from a wrong answer", () => {
  const timedOut = resultCopy({ status: "failed", timedOut: true });
  const wrong = resultCopy({ status: "failed", timedOut: false });
  assert.match(timedOut.title, /time/i);
  assert.notEqual(timedOut.title, wrong.title);
  assert.notEqual(timedOut.message, wrong.message);
});

test("a timed-out defense names the loss, not a generic time's up", () => {
  const defense = resultCopy({ status: "failed", timedOut: true, actionType: "defend" });
  const generic = resultCopy({ status: "failed", timedOut: true });
  assert.match(defense.message, /state|territory|attacker/i);
  assert.notEqual(defense.message, generic.message);
});

test("contested and completed statuses keep their non-timeout copy", () => {
  assert.match(resultCopy({ status: "contested", timedOut: false }).title, /challenge/i);
  assert.match(resultCopy({ status: "completed", timedOut: false }).title, /secured|success/i);
});

test("blockedReason precedence: contested beats everything", () => {
  assert.match(
    blockedReason({ hasAction: true, actionsRemaining: 0, contested: true, canTarget: false, isMyTurn: false })!,
    /attack is already active/i,
  );
});

test("blockedReason: off-turn outranks empty action pool and names the holder", () => {
  const reason = blockedReason({
    hasAction: true,
    actionsRemaining: 0,
    contested: false,
    canTarget: true,
    isMyTurn: false,
    turnHolderName: "Riley",
  });
  assert.match(reason!, /Riley/);
  assert.match(reason!, /turn/i);
});

test("blockedReason: no moves left", () => {
  const reason = blockedReason({ hasAction: true, actionsRemaining: 0, contested: false, canTarget: true, isMyTurn: true });
  assert.match(reason!, /no moves left/i);
});

test("blockedReason: cooldown, fortified-today and no-border in order", () => {
  const base = { hasAction: true, actionsRemaining: 2, contested: false, isMyTurn: true };
  assert.match(blockedReason({ ...base, canTarget: true, onCooldown: true })!, /cooling down/i);
  assert.match(blockedReason({ ...base, canTarget: true, alreadyFortifiedToday: true, kind: "fortify" })!, /already fortified/i);
  assert.match(blockedReason({ ...base, canTarget: false, kind: "attack" })!, /border/i);
});

test("blockedReason: an actionable state returns null", () => {
  assert.equal(
    blockedReason({ hasAction: true, actionsRemaining: 2, contested: false, canTarget: true, isMyTurn: true }),
    null,
  );
});
