# HomeTerritory

HomeTerritory is the working MVP for **Territory**: an asynchronous, private-group sports trivia game where correct answers claim and steal U.S. states.

This repository is not a static mockup. The application uses shared Supabase state, server-authoritative PostgreSQL functions, authenticated users, realtime map updates, and scheduled scoring.

## What works

- Email/password signup and sign-in through Supabase Auth
- Create a private group and choose sports, season length (7–60 days),
  opening mode (open map or fully dealt), board scope (50 states or lower 48),
  difficulty, and the league's timezone
- Join a group with an eight-character invite code
- Two-player minimum and commissioner-controlled season start
- Interactive 50-state map
- Neutral claims, adjacency-restricted attacks, hold levels, fortification, and 24-hour defenses
- Tiered questions, multi-answer attack streaks, timers, action consumption, cooldowns, and underdog discounts
- Server-side answer checking; the browser never sees an answer before it is
  submitted, and `game_submit_answer` returns `correct_answer` only in its
  reply to an attempt that has already been graded
- One active attack per state and automatic timeout resolution
- Shared cumulative scoring with region, coast-to-coast and sport-diversity
  bonuses, leaderboard, and activity feed
- Supabase Realtime subscriptions so multiple phones update from the same database
- One-tap question reporting through an in-app dialog with an immediate
  action refund; a question is quarantined once three separate players report
  it, and a service-role `reactivate_question` RPC can undo a quarantine
- Commissioner "Advance the day" fast-forward: each tap settles or advances a
  full game day (scoring, action refresh, fortify windows, season end all
  follow the shifted calendar)
- Installable PWA (registered service worker + manifest) with opt-in web-push
  defense alerts when VAPID keys are configured
- Vercel Cron endpoint for scoring and expired-session cleanup

## Architecture

- **Frontend:** Next.js 16 App Router, React 19, TypeScript, mobile-first CSS
- **Authentication and database:** Supabase Auth + PostgreSQL + Row Level Security
- **Authoritative game engine:** PostgreSQL security-definer functions in the migration
- **Realtime:** Supabase Postgres Changes on map, attacks, activity, and scores
- **Hosting:** Vercel

The browser never decides whether an answer is correct, whether a state is adjacent, whether an action exists, or whether ownership changes.

## Connected Supabase project

- Project ref: `gduvdnpxgdniogmxxlmg`
- Project URL: `https://gduvdnpxgdniogmxxlmg.supabase.co`

Never commit or paste the database password, a Supabase secret key, a legacy service-role key, or a personal access token.

## Deploy the database migration securely

The repository includes `.github/workflows/deploy-supabase.yml`. It applies migrations through the Supabase CLI while keeping credentials in encrypted GitHub Actions secrets.

1. Create a Supabase personal access token from your Supabase account settings.
2. In GitHub, open **HomeTerritory → Settings → Secrets and variables → Actions**.
3. Add these repository secrets:

   - `SUPABASE_ACCESS_TOKEN`: your Supabase personal access token
   - `SUPABASE_DB_PASSWORD`: the current database password

4. Open **Actions → Deploy Supabase database → Run workflow**.
5. Confirm the workflow passes. It performs a dry run, applies pending migrations, and prints migration status.

After the first deployment, future commits that change `supabase/migrations/**` automatically deploy the new migrations from `main`.

## Configure application keys

Supabase now recommends publishable keys for browser clients and secret keys for trusted server components.

In **Supabase → Settings → API Keys**, copy:

- the publishable key into `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- the secret key into `SUPABASE_SECRET_KEY`

The secret key bypasses Row Level Security and must exist only in Vercel or a local `.env.local` file. It must never be exposed to client components or committed to Git.

Copy `.env.example` to `.env.local` and fill in:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://gduvdnpxgdniogmxxlmg.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
CRON_SECRET=
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

Web-push defense alerts are optional: generate a key pair with
`npx web-push generate-vapid-keys` and set `NEXT_PUBLIC_VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`. Leave them blank to ship without
push — the in-app alerts button hides itself.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

Point `.env.local` at the hosted project, or run the whole stack on your own
machine — Postgres, Auth, Storage and the edge functions — with the Supabase
CLI. `docs/superpowers/local-stack.md` has the ports this repository uses, the
`supabase start` flags Colima needs, and the environment variables the database
test suite reads.

To test the real multiplayer flow, create two accounts using two email addresses, join the same invite code, and start the season from the commissioner account.

## Deploy to Vercel

1. Import `Gilmore3088/HomeTerritory` into Vercel.
2. Add every variable from `.env.example` in Vercel project settings.
3. Set `CRON_SECRET` to a long random value.
4. Deploy.
5. Update `NEXT_PUBLIC_SITE_URL` to the Vercel production domain.
6. In Supabase **Authentication → URL Configuration**, set the production site URL and add the Vercel authentication callback URLs.

`vercel.json` runs the daily tick at 08:05 UTC. Each league's day boundary
comes from its own `groups.timezone`, chosen at league creation (the form
detects the browser's zone), so the tick scores whichever leagues have
crossed local midnight by then.

## Starter question bank

The migrations seed 550 starter questions—11 per state—so claims, attacks, and defenses can be tested without runtime AI generation. The original single-subject-per-state bank (`starter_seed`) is deactivated in favor of a diversified bank (`starter_seed_v2`): every state mixes teams, players, venues and events with distinct answers, so seeing one question no longer reveals a state's whole bank. It is still starter content, not production-validated; a production rollout should replace or augment it with the structured generation and external validation pipeline described in the PRD.

## Security notes

- Row Level Security limits shared game reads to group members.
- All gameplay writes happen through authenticated PostgreSQL RPC functions.
- Question answers, attempts, cooldowns, and reports are not directly readable by clients.
- Internal attack-resolution functions have public execution revoked.
- The daily tick requires the server secret key and a separate cron secret.
- `SUPABASE_SECRET_KEY` is accepted by the server. `SUPABASE_SERVICE_ROLE_KEY` remains a temporary compatibility fallback only.
- The `test-signup` edge function scopes its CORS to the `ALLOWED_ORIGINS`
  secret (comma-separated, `https://*.host` preview wildcards); unset keeps
  the permissive default for local stacks.
- The push notify route re-verifies every attack server-side and claims it
  atomically, so a spoofed client call cannot notify anyone or double-send.

## Current intentional MVP limits

- No AI generation worker or external sports-reference validation worker yet;
  the diversified starter bank is hand-written, not externally validated.
- Web-push covers the defense alert only (sent when an attack lands); there
  are no turn or daily-recap notifications yet.
- Question moderation has quarantine and a service-role reactivation RPC, but
  no reviewer UI or queue.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run lint
```

The GitHub Actions CI workflow runs the first three on pull requests, and a
second `engine` job boots the Supabase CLI stack to run `npm run test:db` and
`npm run test:smoke` on every push and pull request.

Locally, `npm run test:db` drives the real engine functions and needs a
running local stack plus `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY` and
`SUPABASE_TEST_SERVICE_KEY`; see `docs/superpowers/local-stack.md`.
