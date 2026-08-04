// S3: a wiring test for the cron auth guard as the route actually uses it, not
// just the pure predicate. tests/cron-auth.test.ts only exercises
// isAuthorizedCronRequest() in isolation -- if app/api/cron/tick/route.ts ever
// stopped calling it (or called it wrong), that suite would stay green while
// the route itself opened up. This file imports the real GET handler and
// drives it directly.
//
// The route module cannot be imported by node's native ESM loader unmodified:
// Next.js ships no package.json "exports" map for the "next/server" subpath,
// so a bare `import "next/server"` fails outside Next's own build/dev
// pipeline (it only resolves inside Next's bundler); and this project's "@/*"
// tsconfig path alias has no meaning to node's resolver, which only Next's
// bundler and tsc understand. Both are bridged here with a small, test-only
// node:module loader hook -- no package.json, tsconfig, or app source change
// -- so the real handler runs in-process with no dev server.
//
// createAdminClient() is called only *after* the auth check (never at module
// load), so the 401 cases below never reach it. The "correct bearer" case
// does reach it; NEXT_PUBLIC_SUPABASE_URL is pointed at a loopback address
// nothing listens on so that request fails fast and locally instead of
// touching the network or requiring the Supabase stack -- this file runs
// under `npm test`, which is documented as needing no stack.
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const CRON_SECRET = "s3-wiring-test-secret";
process.env.CRON_SECRET = CRON_SECRET;
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "s3-wiring-test-key";

const projectRoot = pathToFileURL(`${process.cwd()}/`).href;
const loaderSource = `
  const ROOT = ${JSON.stringify(projectRoot)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
      const rel = specifier.slice(2);
      const withExt = /\\.[a-zA-Z0-9]+$/.test(rel) ? rel : rel + ".ts";
      return nextResolve(new URL(withExt, ROOT).href, context);
    }
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);

const routeModule = (await import("../app/api/cron/tick/route.ts")) as {
  GET: (request: Request) => Promise<Response>;
};

function tickRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/cron/tick", { headers });
}

test("the tick route rejects a request with no Authorization header", async () => {
  const response = await routeModule.GET(tickRequest());
  assert.equal(response.status, 401);
});

test("the tick route rejects a request with the wrong bearer", async () => {
  const response = await routeModule.GET(tickRequest({ authorization: "Bearer wrong-secret" }));
  assert.equal(response.status, 401);
});

test("the tick route does not reject the correct bearer at the auth layer", async () => {
  const response = await routeModule.GET(tickRequest({ authorization: `Bearer ${CRON_SECRET}` }));
  assert.notEqual(
    response.status,
    401,
    "the correct CRON_SECRET bearer must clear the route's own auth guard",
  );
});
