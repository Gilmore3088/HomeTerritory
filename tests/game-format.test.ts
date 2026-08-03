import assert from "node:assert/strict";
import test from "node:test";
import { dayNumber, edgeErrorMessage, timeLeft } from "../lib/game-format.ts";

const DAY = 86_400_000;

test("dayNumber prefers the server-provided current_day", () => {
  assert.equal(dayNumber({ started_at: new Date(0).toISOString(), current_day: 7 }), 7);
});

test("dayNumber computes from started_at and never returns below one", () => {
  const start = new Date("2026-08-01T00:00:00Z").getTime();
  assert.equal(dayNumber({ started_at: new Date(start).toISOString() }, start + 1000), 1);
  assert.equal(dayNumber({ started_at: new Date(start).toISOString() }, start + 2 * DAY + 1000), 3);
  assert.equal(dayNumber(null), 0);
});

test("timeLeft renders hours, minutes, and expiry", () => {
  const now = new Date("2026-08-01T00:00:00Z").getTime();
  const at = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(timeLeft(at(-1), now), "expired");
  assert.equal(timeLeft(at(5 * 60_000), now), "5m");
  assert.equal(timeLeft(at(3 * 3_600_000 + 20 * 60_000), now), "3h 20m");
});

test("edgeErrorMessage unwraps a function error response body", async () => {
  const error = Object.assign(new Error("non-2xx"), {
    context: new Response(JSON.stringify({ error: "Invite code not found" })),
  });
  assert.equal(await edgeErrorMessage(error), "Invite code not found");
  assert.equal(await edgeErrorMessage(new Error("plain failure")), "plain failure");
  assert.equal(await edgeErrorMessage("not an error"), "The request could not be completed.");
});
