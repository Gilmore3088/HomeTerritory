import assert from "node:assert/strict";
import test from "node:test";
import { shouldClearOperation, unseenActivityCount } from "../lib/turn-reconcile.ts";

test("shouldClearOperation clears only a resolved session with no newer begin", () => {
  // Server still has the session: never clear.
  assert.equal(shouldClearOperation({ serverHasSession: true, beganAtMs: null, loadStartedAtMs: 100 }), false);
  // Server has none and nothing begun since load started: clear.
  assert.equal(shouldClearOperation({ serverHasSession: false, beganAtMs: null, loadStartedAtMs: 100 }), true);
  assert.equal(shouldClearOperation({ serverHasSession: false, beganAtMs: 50, loadStartedAtMs: 100 }), true);
  // A begin happened at/after this load started: do NOT clear (race guard).
  assert.equal(shouldClearOperation({ serverHasSession: false, beganAtMs: 100, loadStartedAtMs: 100 }), false);
  assert.equal(shouldClearOperation({ serverHasSession: false, beganAtMs: 150, loadStartedAtMs: 100 }), false);
});

test("unseenActivityCount counts rows newer than last seen", () => {
  const activity = [
    { created_at: "2026-08-04T10:00:00Z" },
    { created_at: "2026-08-04T09:00:00Z" },
    { created_at: "2026-08-04T08:00:00Z" },
  ];
  assert.equal(unseenActivityCount(activity, null), 3);
  assert.equal(unseenActivityCount(activity, "2026-08-04T08:30:00Z"), 2);
  assert.equal(unseenActivityCount(activity, "2026-08-04T10:00:00Z"), 0);
  assert.equal(unseenActivityCount([], "2026-08-04T10:00:00Z"), 0);
});
