# HomeTerritory

HomeTerritory is the working MVP for **Territory**: an asynchronous, private-group sports trivia game where correct answers claim and steal U.S. states.

This repository is not a static mockup. The application is designed around shared Supabase state, server-authoritative PostgreSQL functions, authenticated users, realtime map updates, and a scheduled daily scoring job.

## What works in this branch

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

## Connect Supabase

1. Create a new Supabase project.
2. Open the SQL editor and run `supabase/migrations/202607300001_initial_schema.sql`.
3. In **Authentication → URL Configuration**, set the production site URL and add `http://localhost:3000` as a redirect URL while developing.
4. Copy `.env.example` to `.env.local` and fill in:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
CRON_SECRET=
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

The service-role key is only imported by the protected Vercel Cron route. It is never exposed to client components.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

To test the real multiplayer flow, create three accounts using three email addresses, join the same invite code, and start the season from the commissioner account.

## Deploy to Vercel

1. Import this GitHub repository into Vercel.
2. Add all variables from `.env.example` in Vercel project settings.
3. Set `CRON_SECRET` to a long random value. Vercel automatically sends it to the cron route as a bearer token.
4. Deploy.
5. Update Supabase's site URL to the Vercel domain.

`vercel.json` runs the daily tick at 08:05 UTC. The MVP uses one UTC scoring tick; per-group local-midnight scoring is a post-MVP refinement.

## Starter question bank

The migration creates 550 starter questions—11 per state—so claims, attacks, and defenses can be tested without runtime AI generation. They prove the game pipeline but are deliberately marked `starter_seed`, not production-validated. A production rollout should replace or augment them with the structured generation and external validation pipeline described in the PRD.

## Security notes

- Row Level Security limits shared game reads to group members.
- All gameplay writes happen through authenticated PostgreSQL RPC functions.
- Question answers, attempts, cooldowns, and reports are not directly readable by clients.
- Internal attack-resolution functions have public execution revoked.
- The daily tick requires the service role and a separate cron secret.

## Current intentional MVP limits

- No web-push notifications yet; the in-app defense alert and realtime update are implemented first.
- No AI generation worker or external sports-reference validation worker yet.
- No coast-to-coast or sport-diversity bonus yet.
- Daily scoring is UTC rather than group-local time.
- The starter bank uses repeated factual subjects in different question forms to guarantee enough test inventory.

## Verification

The pure game-rule tests run with Node 22 without third-party packages:

```bash
npm test
```

The GitHub Actions workflow also runs type checking and a production Next.js build after dependencies are installed.
