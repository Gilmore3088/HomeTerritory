import { test } from "node:test";
import assert from "node:assert/strict";
import { isStaleLoad, shouldShowLoadError, SNAPSHOT_ERROR_THRESHOLD } from "../lib/snapshot-retry.ts";

test("first failure stays a toast; the threshold failure shows the error screen", () => {
  assert.equal(shouldShowLoadError(1, false), false);
  assert.equal(shouldShowLoadError(SNAPSHOT_ERROR_THRESHOLD, false), true);
  assert.equal(shouldShowLoadError(SNAPSHOT_ERROR_THRESHOLD + 3, false), true);
});

test("a rendered board suppresses the error screen even after repeated failures", () => {
  assert.equal(shouldShowLoadError(SNAPSHOT_ERROR_THRESHOLD, true), false);
  assert.equal(shouldShowLoadError(10, true), false);
});

test("a load is stale exactly when the generation moved while it was in flight", () => {
  assert.equal(isStaleLoad(3, 3), false);
  assert.equal(isStaleLoad(3, 4), true);
  assert.equal(isStaleLoad(0, 0), false);
});
