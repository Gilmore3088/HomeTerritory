# Territory (HomeTerritory) — Session Handoff

Date: 2026-08-04. Repo: `/Users/jgmbp/Desktop/HomeTerritory`, GitHub `Gilmore3088/HomeTerritory`.
This doc is the single source of truth to resume in a fresh session. Read it first.

## TL;DR

Territory is an async, private-group **sports-trivia + territory-war** game (Next.js 16 + Supabase). Over this session it went from "code-complete MVP that couldn't be run" to **two shipped phases on `main`** and a third in progress. First real playtest verdict: **"this seems like a decent game"** — the core loop works and is fun. The remaining work is making that core *accessible* (login/session cleanup, balance; bots were removed 2026-08-04, so play is multiplayer-only) and *live* (deploy).

## What's shipped (merged to `main`, pushed, CI green)

- **Phase 1 — Stabilize.** Audited the whole game engine; fixed **22 findings** incl. two security blockers (an answer-leak via unshuffled options; a cron-auth forged-header bypass) and a stale-localStorage app-wedge. Split the 859-line monolith into focused components. Stood up a local Supabase stack + a 3-layer test suite (unit / DB / smoke). Spec: `docs/superpowers/specs/2026-08-03-stabilize-phase-design.md`.
- **Phase 2a — Foundation.** Merged the dual-polling data layer into one `GameDataProvider` context; fixed the stale-question bug (race-guarded); extracted `advance_season` from `run_daily_tick`; added a commissioner-gated `advance_group_day` ("Advance the day" control). Spec: `docs/superpowers/specs/2026-08-04-p2a-foundation-design.md`.
- Test suite at `main` HEAD: **32 unit / 41 DB / 1 smoke**, typecheck / build / lint all green.

## In progress — Phase 2b (Broadcast visual redesign)

Branch: **`feat/p2b-broadcast`** (NOT merged, NOT pushed).
- Locked visual direction: **Broadcast** — light, editorial, poster-bold, saturated team colors, real US map as hero (chosen from 3 mockups; reference `.superpowers/brainstorm/*/content/three-real.html` option 3 "arena").
- **Done: Task 1** (commit `2dca50e`) — Broadcast design tokens + hero game screen + map recolor. Controller-verified in browser: matches the mockup (bone-white page, blue/red states, white HUD pills, black dock w/ gold label + red CTA). The hero screen looks right.
- **Also done: logout-overlap fix** (commit `9f0dbd8`) — "Advance the day" no longer covers "Log out".
- **Remaining: Tasks 2-13** — pure UX helpers, restyle question/result/auth/lobby/overlays, visual timer + timeout copy, blocked-action reasons, in-app report dialog (kill native prompt/alert), focus refresh, onboarding/empty states, dead-CSS cleanup, touch targets, closeout. Full plan: `docs/superpowers/plans/2026-08-04-p2b-broadcast-restyle.md`. Resume ledger: `.superpowers/sdd/2026-08-04-p2b-broadcast-restyle/progress.md`.
- Branch is in a **coherent transitional state**: hero = Broadcast; other screens still old dark style via back-compat token aliases (functional, not yet restyled).

## Playtest verdict + the two issues found (2026-08-04)

Played two-window (commish@ + member@). Verdict: **decent game.** Two balance/turn issues:
1. **Action asymmetry** — one player seemed to get ~3 turns/actions, the other ~2 questions. The action-vs-question economy (claim = 1 Q, attack = 2-3 in a row, defense = 1 Q) reads as unequal/confusing.
2. **Defense consumes offense** — after defending two attacks in a turn, the defender "cannot claim more territory or attack back." Defense and offense share the turn/action pool.

## NEXT-BUILD PRIORITIES (agreed order)

> **DECISION 2026-08-04 (supersedes the old #1):** Bots are REMOVED from the game
> entirely — they were test scaffolding, and a trivia game has no honest bot
> opponent (a bot either knows every answer or is a dice roll). Solo-vs-bots is
> dead; Territory is multiplayer-only, and solo evaluation stays two-window.
> Done on branch `worktree-remove-bots` (plan
> `docs/superpowers/plans/2026-08-04-remove-bots.md`): migration
> `20260804210000_remove_bot_players.sql` drops `is_bot` / `bot_action_log` /
> `run_test_bot_turns`, strips bot branches from `start_season` /
> `end_test_turn` / `group_snapshot` / `advance_season`, cleans bot rows, and
> RESTORES `profiles_id_fkey` (closes the P5 orphaned-profiles backlog item).

1. **Login / session cleanup.** "Enter the map" gets stuck in some window states (accounts + browser auth verified working; it's a client/session-state bug). Sessions persist confusingly across windows.
2. **Balance pass** on the two playtest issues above (action economy symmetry; separate defense from offense, or make the split intentional and legible).
3. **Deploy live** (owner action — see below; the staged migration count now includes the bot-removal migration).
4. Finish **P2b** (visual), then **P2c** (motion/juice + animated map), **P2d** (PWA install).

## How to resume

- Local stack: `npm run stack:start` (started with `-x vector -x logflare`; `npm run stack:reset` for a clean board). API `http://127.0.0.1:55321` (ports +1000). Details: `docs/superpowers/local-stack.md`.
- Legacy JWT keys are required for `test:db` and dev-vs-local (the `sb_*` keys 401). Get them from `supabase status`.
- Run the app vs local stack: `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<anon> npm run dev`.
- Seed accounts (local, password `playtest-password-1`): `commish@` / `member@` (group "Advance Demo League", 2 real humans — best for two-window play), plus `solo@`/`rival@` (group "Solo vs Bot" — name is historical; bots no longer exist). The old `seed-vs-bots*.mjs` scripts were deleted with the bot removal.
- Playtest = **two browser windows** (one incognito), two real logins, drive both sides, "End turn" to pass. That is the intended mode: bots were removed 2026-08-04, so there is no solo mode.
- Process: this repo uses the superpowers brainstorm → spec → plan → subagent-driven-development flow. Specs in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`, deferred items in `docs/superpowers/backlog.md`.

## Deployment (owner action — needs YOUR credentials)

Nothing is deployed; production DB is still on the pre-Phase-1 schema. To go live:
1. In GitHub → Settings → Secrets and variables → Actions, add `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`.
2. Re-run the **Deploy Supabase database** workflow (it auto-triggers on pushes to `supabase/migrations/**` but currently fails at auth because the secrets are unset). This applies the **14 staged migrations** (12 Phase-1 + 2 P2a).
3. Deploy the app to Vercel (import the repo, set env vars from `.env.example`, set `NEXT_PUBLIC_SITE_URL`), and configure Supabase Auth URLs.

## Git state

- `main`: Phase 1 + Phase 2a, merged + pushed to `origin/main`, CI green.
- `worktree-remove-bots` (worktree at `.claude/worktrees/remove-bots`): the bot removal — 5 commits, full suite green (32 unit / 46 db / 1 smoke). Merge to `main` first.
- `feat/p2b-broadcast`: P2b spec + plan + Task 1 + logout fix. Local only — not merged, not pushed. After the bot-removal merge, bring `main` into this branch (the `test-signup` edge-function fix exists identically on both sides), then resume at P2b Task 2 — or do login/balance first (recommended).
