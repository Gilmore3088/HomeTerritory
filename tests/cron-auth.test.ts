import assert from "node:assert/strict";
import test from "node:test";
import { isAuthorizedCronRequest } from "../lib/cron-auth.ts";

const SECRET = "cron-secret-value";

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

test("the configured bearer secret authorizes the tick", () => {
  assert.equal(
    isAuthorizedCronRequest(headers({ authorization: `Bearer ${SECRET}` }), SECRET),
    true,
  );
});

test("a missing or wrong bearer secret is rejected", () => {
  assert.equal(isAuthorizedCronRequest(headers({}), SECRET), false);
  assert.equal(isAuthorizedCronRequest(headers({ authorization: "Bearer nope" }), SECRET), false);
  assert.equal(isAuthorizedCronRequest(headers({ authorization: SECRET }), SECRET), false);
});

// Finding 2: the route used to accept any caller who sent the schedule header
// Vercel Cron happens to add, and that header is fully caller-controlled. Vercel
// Cron also sends `Authorization: Bearer $CRON_SECRET`, so the schedule header
// must never be an authorization signal on its own.
test("a forged x-vercel-cron-schedule header does not authorize the tick", () => {
  assert.equal(
    isAuthorizedCronRequest(headers({ "x-vercel-cron-schedule": "5 8 * * *" }), SECRET),
    false,
  );
  assert.equal(
    isAuthorizedCronRequest(
      headers({ "x-vercel-cron-schedule": "5 8 * * *", authorization: "Bearer nope" }),
      SECRET,
    ),
    false,
  );
});

test("an unset CRON_SECRET rejects every caller instead of opening the route", () => {
  assert.equal(isAuthorizedCronRequest(headers({ authorization: "Bearer " }), undefined), false);
  assert.equal(isAuthorizedCronRequest(headers({ authorization: "Bearer undefined" }), ""), false);
  assert.equal(
    isAuthorizedCronRequest(headers({ "x-vercel-cron-schedule": "5 8 * * *" }), undefined),
    false,
  );
});
