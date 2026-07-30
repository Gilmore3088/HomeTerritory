# HomeTerritory

HomeTerritory is the working MVP for **Territory**: an asynchronous, private-group sports trivia game where correct answers claim and steal U.S. states.

This repository is not a static mockup. The application uses shared Supabase state, server-authoritative PostgreSQL functions, authenticated users, realtime map updates, and scheduled scoring.

## What works

- Email/password signup and sign-in through Supabase Auth
- Create a private group and select sports and season length
- Join a group with an eight-character invite code
- Three-player minimum and commissioner-controlled season start
- Interactive, zoomable 50-state map
- Neutral claims, adjacency-restricted attacks, hold levels, fortification, and 24-hour defenses
- Tiered questions, multi-answer attack streaks, timers, action consumption, cooldowns, and underdog discounts
- Server-side answer checking; correct answers are not sent to the browser
- One active attack per state and automatic timeout resolution
- Shared cumulative scoring, region bonuses, leaderboard, and activity feed
- Supabase Realtime subscriptions so multiple phones update from the same database
- One-tap question quarantine and action refund
- Installable PWA shell
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

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

To test the real multiplayer flow, create three accounts using three email addresses, join the same invite code, and start the season from the commissioner account.

## Deploy to Vercel

1. Import `Gilmore3088/HomeTerritory` into Vercel.
2. Add every variable from `.env.example` in Vercel project settings.
3. Set `CRON_SECRET` to a long random value.
4. Deploy.
5. Update `NEXT_PUBLIC_SITE_URL` to the Vercel production domain.
6. In Supabase **Authentication → URL Configuration**, set the production site URL and add the Vercel authentication callback URLs.

`vercel.json` runs the daily tick at 08:05 UTC. The MVP uses one UTC scoring tick; per-group local-midnight scoring is a later refinement.

## Starter question bank

The migration creates 550 starter questions—11 per state—so claims, attacks, and defenses can be tested without runtime AI generation. They prove the game pipeline but are marked `starter_seed`, not production-validated. A production rollout should replace or augment them with the structured generation and external validation pipeline described in the PRD.

## Security notes

- Row Level Security limits shared game reads to group members.
- All gameplay writes happen through authenticated PostgreSQL RPC functions.
- Question answers, attempts, cooldowns, and reports are not directly readable by clients.
- Internal attack-resolution functions have public execution revoked.
- The daily tick requires the server secret key and a separate cron secret.
- `SUPABASE_SECRET_KEY` is accepted by the server. `SUPABASE_SERVICE_ROLE_KEY` remains a temporary compatibility fallback only.

## Current intentional MVP limits

- No web-push notifications yet; the in-app defense alert and realtime update are implemented first.
- No AI generation worker or external sports-reference validation worker yet.
- No coast-to-coast or sport-diversity bonus yet.
- Daily scoring is UTC rather than group-local time.
- The starter bank uses repeated factual subjects in different question forms to guarantee enough test inventory.

## Verification

```bash
npm test
npm run typecheck
npm run build
```

The GitHub Actions CI workflow runs all three checks on pull requests.
