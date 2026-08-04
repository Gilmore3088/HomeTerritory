import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// group-storage runs only in the browser; give it a minimal localStorage.
const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
};

const { readSavedGroupId, writeSavedGroupId, clearSavedGroupId } = await import("../lib/group-storage.ts");

beforeEach(() => store.clear());

test("saved groups are scoped per user", () => {
  writeSavedGroupId("user-a", "group-1");
  writeSavedGroupId("user-b", "group-2");
  assert.equal(readSavedGroupId("user-a"), "group-1");
  assert.equal(readSavedGroupId("user-b"), "group-2");
});

test("the legacy unscoped key is deleted, never migrated", () => {
  store.set("territory_group", "stale-group-from-account-a");
  assert.equal(readSavedGroupId("user-b"), null);
  assert.equal(store.has("territory_group"), false);
});

test("clearSavedGroupId removes only that user's selection", () => {
  writeSavedGroupId("user-a", "group-1");
  writeSavedGroupId("user-b", "group-2");
  clearSavedGroupId("user-a");
  assert.equal(readSavedGroupId("user-a"), null);
  assert.equal(readSavedGroupId("user-b"), "group-2");
});
