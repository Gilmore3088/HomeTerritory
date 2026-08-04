import assert from "node:assert/strict";
import test from "node:test";
import { pickActiveGroup } from "../lib/game-selection.ts";

const rows = [
  { id: "lobby-1", status: "lobby" },
  { id: "active-1", status: "active" },
  { id: "ended-1", status: "ended" },
];

test("preferred wins when it is present in rows", () => {
  assert.equal(pickActiveGroup(rows, "lobby-1", "ended-1"), "ended-1");
});

test("preferred is ignored when it is not in rows, falling through to saved/active/first", () => {
  assert.equal(pickActiveGroup(rows, "lobby-1", "not-a-member"), "lobby-1");
});

test("saved wins over active and first when it is present in rows", () => {
  assert.equal(pickActiveGroup(rows, "lobby-1", null), "lobby-1");
});

// Finding 22: a stale localStorage id for a group the user no longer belongs
// to must never be trusted, or the snapshot RPC raises "Group access denied"
// and the app wedges on the loading spinner forever.
test("saved is ignored when it is not in rows, falling back instead of wedging the app", () => {
  assert.equal(pickActiveGroup(rows, "not-a-member", null), "active-1");
});

test("the first active row wins over the first row when there is no valid saved or preferred", () => {
  assert.equal(pickActiveGroup(rows, null, null), "active-1");
});

test("the first row wins when no row is active", () => {
  const noneActive = [
    { id: "lobby-1", status: "lobby" },
    { id: "ended-1", status: "ended" },
  ];
  assert.equal(pickActiveGroup(noneActive, null, null), "lobby-1");
});

test("returns null when rows is empty", () => {
  assert.equal(pickActiveGroup([], "anything", "anything"), null);
});

test("rows without a status are treated as not active but still eligible as saved/first", () => {
  const noStatus = [{ id: "a" }, { id: "b" }];
  assert.equal(pickActiveGroup(noStatus, "b", null), "b");
  assert.equal(pickActiveGroup(noStatus, null, null), "a");
});
