# Local Supabase stack

How to run Territory against a local Supabase instance instead of production.

## Prerequisites

- Docker running (Docker Desktop, Colima, or equivalent).
- Supabase CLI installed (`brew install supabase/tap/supabase`, or use the
  project-local binary at `/opt/homebrew/bin/supabase`).

## Port note

This repo's `supabase/config.toml` shifts every local port up by 1000 from the
CLI's defaults (API `55321`, DB `55322`, shadow DB `55320`, Studio `55323`,
Inbucket/Mailpit `55324`, pooler `55329`, analytics `55327`) to avoid colliding
with any other Supabase project already running on the same machine. If you
don't have another stack running locally, you can leave these as-is — the
commands below always read the actual values back out of `supabase status`
rather than hardcoding the defaults.

If `supabase start` fails with something like
`failed to start docker container ... mkdir .../docker.sock: operation not
supported`, that's a known Colima limitation: the `vector`/`logflare` log
aggregator container tries to bind-mount the host Docker socket, which
Colima's virtiofs mount doesn't support. Work around it by excluding those
two containers:

```bash
supabase start -x vector -x logflare
```

Everything else (Postgres, PostgREST, GoTrue, Storage, Edge Functions, Studio,
Mailpit) starts normally; you only lose the Studio "Logs" panel.

## The three stack commands

```bash
npm run stack:start   # supabase start  — boots the local Postgres + API containers
npm run stack:reset   # supabase db reset — replays every file in supabase/migrations/ in order, then seeds
npm run stack:stop    # supabase stop   — tears the containers down
```

If you hit the Colima docker-socket issue above, run
`supabase start -x vector -x logflare` directly instead of `npm run stack:start`
the first time; subsequent `supabase start` calls reuse the running containers.

## Reading keys from `supabase status`

```bash
supabase status
```

prints the local API URL, DB URL, and both the anon/publishable and
service_role/secret keys. Machine-readable form:

```bash
supabase status -o json
```

Key fields: `API_URL`, `DB_URL`, `ANON_KEY` / `PUBLISHABLE_KEY`,
`SERVICE_ROLE_KEY` / `SECRET_KEY`. This CLI version emits both the legacy JWT
keys (`ANON_KEY`, `SERVICE_ROLE_KEY`) and the newer `sb_publishable_...` /
`sb_secret_...` keys (`PUBLISHABLE_KEY`, `SECRET_KEY`); the app
(`lib/supabase/client.ts`, `lib/supabase/server.ts`, `lib/supabase/admin.ts`)
reads the newer `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY`
format, so use `PUBLISHABLE_KEY` / `SECRET_KEY` when pointing the app at the
local stack.

The local keys are fixed, well-known defaults baked into the Supabase CLI —
they carry no production power and are safe to keep in local shell history or
gitignored files, but never commit them.

## Running the app against the local stack

`.env.local` points at production. Shell environment variables override
`.env.local` in Next.js, so you can point a single `npm run dev` invocation at
the local stack without touching `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321 \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<PUBLISHABLE_KEY from supabase status> \
npm run dev
```

Then open `http://localhost:3000`. The landing page should render, and
signing in as a nonexistent user should fail cleanly — that failure is the
signal you're talking to the empty local database, not production.

## Serving the signup edge function

```bash
supabase functions serve test-signup
```

Serves `supabase/functions/test-signup` against the local stack (reads env
vars from `supabase/functions/.env` if present, otherwise inherits the
running stack's local Postgres/API connection).

## Exporting test env vars

Tasks 6, 7, and 10 (DB test harness, audit scripts, E2E smoke test) read
these three variables:

```bash
export SUPABASE_TEST_URL=http://127.0.0.1:55321
export SUPABASE_TEST_ANON_KEY=<ANON_KEY or PUBLISHABLE_KEY from supabase status>
export SUPABASE_TEST_SERVICE_KEY=<SERVICE_ROLE_KEY or SECRET_KEY from supabase status>
```

Adjust the port numbers if you're running with the CLI's stock config
(no port shift) instead of this repo's shifted `supabase/config.toml`.
