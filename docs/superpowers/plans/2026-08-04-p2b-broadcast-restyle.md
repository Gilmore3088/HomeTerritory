# Phase 2b Broadcast Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the locked "Broadcast" visual language (light, editorial, poster-bold, saturated team colors, real map as hero) across every screen, fold in the backlog UX papercut fixes, and add onboarding/empty states — without changing game logic.

**Architecture:** Retheme in place. The live stylesheet `components/territory-game-v2.module.css` holds the working design tokens (CSS vars on its shared selector) and every component's classes; Broadcast is delivered by changing token VALUES + specific screen treatments there, recoloring the map constants in `lib/game-constants.ts`, updating the two global mobile-override sheets in lockstep, and removing the dead `globals.css` classes. Motion (P2c) and PWA (P2d) are out of scope.

**Tech Stack:** TypeScript 5.9 (strict), React 19, Next.js 16, CSS Modules + two global CSS sheets, node built-in test runner. Fonts already loaded: Fraunces (serif display), Public Sans (body), IBM Plex Mono.

## Global Constraints

- Branch `feat/p2b-broadcast` (created; spec committed there).
- Conventional commits ending with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- After every task: `npm test`, `npm run typecheck`, `npm run build`, `npm run lint` all pass/exit 0. No game-logic/RPC changes (only the small UX-fix helpers); the existing 32 unit / 41 db / 1 smoke tests stay green (DB/smoke unaffected by CSS).
- No new npm dependencies. No `console.log`. No emojis in code. App source files under 300 lines (the minified module CSS is an existing exception; do not expand its line count needlessly).
- **Do NOT rename `territory-game-v2.module.css`** — `organized-mobile.css` / `mobile-overrides.css` couple to its generated class names via `[class*="territory-game-v2-module"]`. Update those override sheets in lockstep when a token value or a dark→light treatment changes.
- Implementers: **use the frontend-design skill** for taste, and verify each restyled screen against the locked Broadcast mockup at `.superpowers/brainstorm/*/content/three-real.html` (option 3 "arena").
- Broadcast is a LIGHT system. The current question/result screens are dark — converting them is a deliberate, in-scope departure.

## Broadcast tokens (authoritative values)

Surfaces: `--paper:#faf7ef`, `--paper-2:#f0ece0`, `--card:#ffffff`, `--ink:#111111`, `--line:#ddd6c6`, `--muted:rgba(17,17,17,.55)`, `--dock:#111111` (black dock/nav/CTA, white text).
Team/state: `--mine:#1d6fe0`, `--mine-ink:#0a4fb0`, `--rival:#e0332f`, `--rival-ink:#a81f1c`, `--neutral:#e7e3d8`, `--neutral-line:#c8c2b2`, `--gold:#f5d020`.
Type: Fraunces serif for poster headlines (heavy), Public Sans bold for HUD numbers/labels/buttons. Keep the `2px solid var(--ink)` focus ring.

## Codebase facts (verified 2026-08-04, on branch)

- `app/page.tsx` → `GameDataProvider` wrapping `TerritoryGame` + `GameRuntimeControls` (P2a).
- Live styles: `components/territory-game-v2.module.css` (minified; token block on the shared `.app,.authPage,...` selector; all component classes). `app/globals.css` (font imports, body noise, focus styles + DEAD `.shell`/`.card`/`.brand-lockup`/`.eyebrow` classes + unused `:root` vars). `app/mobile-overrides.css` + `app/organized-mobile.css` (global, attribute-selector overrides, imported in `app/layout.tsx`).
- Map colors: `lib/game-constants.ts` — `PLAYER_COLORS[]`, `NEUTRAL`, `INK`, `PAPER`, `DANGER`; consumed by `components/territory-map.tsx` (`memberColor`, `fill`).
- Components: `auth-stage.tsx`, `league-entry.tsx`, `lobby-stage.tsx`, `game-shell.tsx` (HudMetric/MissionDock/TerritorySheet), `territory-map.tsx`, `game-overlays.tsx` (StandingsOverlay/FeedOverlay/LeaguePicker/Loading), `question-arena.tsx`, `game-runtime-controls.tsx`, `territory-game.tsx` coordinator.
- `lib/game-rules.ts` exports `isTerritoryActionBlocked` (informs blocked reasons). `hooks/use-game-state.ts` owns the single poll loop (Task 10 restores focus refresh). `lib/turn-reconcile.ts` has `unseenActivityCount` (built P2a, wire in empty/onboarding if useful).
- Local stack running at `http://127.0.0.1:55321`; seeded commissioner demo: `commish@playtest.local` / `playtest-password-1` (group "Advance Demo League", season started). For fresh data, re-seed via a script like P2a's or `npm run stack:reset` + a seed.

## Verification note (applies to every restyle task)

CSS restyle cannot be fully pre-written as verbatim code. Each restyle task: apply the Broadcast tokens + the stated treatment using the frontend-design skill, keep structure/behavior identical, run the four checks, and confirm in the browser (dev server against the local stack, PORT 3000) that the screen renders in Broadcast with no horizontal overflow at 390px. The CONTROLLER independently browser-verifies (Task 1 first, then the full click-through in Task 13).

---

### Task 1: Broadcast tokens + hero game screen + map colors

**Files:**
- Modify: `components/territory-game-v2.module.css` (token block + `.board`/`.mapSvg`/`.gameHeader`/`.hud`/`.hudMetric`/`.missionDock`/`.bottomNav`/`.territorySheet` treatments)
- Modify: `lib/game-constants.ts` (map palette)
- Modify: `app/organized-mobile.css`, `app/mobile-overrides.css` (lockstep values for the hero screen)

**Interfaces:**
- Consumes: nothing.
- Produces: the Broadcast token vars (names above) on the module's shared selector — every later task consumes them. `lib/game-constants.ts` exports the same symbol names (`PLAYER_COLORS`, `NEUTRAL`, `INK`, `PAPER`, `DANGER`) with Broadcast values.

- [ ] **Step 1: Retheme the token block** — replace the module's shared-selector var block (`--ink/--navy/--blue/--red/--paper/--muted/--line`) with the Broadcast tokens (add `--mine/--rival/--neutral/--gold/--dock/--card`; keep back-compat aliases `--blue:var(--mine)`, `--red:var(--rival)` so unrelated rules still resolve while you migrate them).
- [ ] **Step 2: Recolor the map** — in `lib/game-constants.ts` set `NEUTRAL="#e7e3d8"`, `PAPER="#faf7ef"`, `INK="#111111"`, `DANGER="#e0332f"`, and `PLAYER_COLORS` to a saturated poster set led by `#1d6fe0` (blue), `#e0332f` (red), then distinct bold hues (green `#1f9d57`, amber `#e8a020`, violet `#7a4bd0`, teal `#138a95`, orange `#e2622f`, slate `#41506a`). Keep the array length ≥ 8.
- [ ] **Step 3: Restyle the hero** — the game board (`.board` light Broadcast base), `.mapSvg` drop-shadow, white HUD stat pills (`.hudMetric`), the black mission dock (`.missionDock` → `--dock` bg, white text, gold `--gold` label, red `--rival` primary CTA), the black bottom nav (`.bottomNav`), and the territory sheet as a white card. Match the locked mockup (option 3). Update `organized-mobile.css`/`mobile-overrides.css` values that reference the old palette for these classes.
- [ ] **Step 4: Checks** — `npm test && npm run typecheck && npm run build && npm run lint` all pass. Start the dev server against the local stack and confirm the game screen renders in Broadcast (light page, blue/red states, black dock).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(design): Broadcast tokens + hero game screen restyle"`

> **CONTROLLER GATE:** the controller browser-verifies this hero screen against the locked mockup before Task 2 is dispatched. If it drifts, iterate Task 1 before spreading the treatment.

---

### Task 2: Pure UX helpers (resultCopy, blockedReason)

**Files:**
- Create: `lib/ux-copy.ts`
- Test: `tests/ux-copy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resultCopy(input: { status: string; timedOut: boolean }): { title: string; message: string }` — for `timedOut` true returns a distinct "Time's up" title/message; for `status` failed vs contested vs completed returns the matching non-timeout copy.
  - `blockedReason(input: { hasAction: boolean; actionsRemaining: number; contested: boolean; canTarget: boolean; onCooldown?: boolean; alreadyFortifiedToday?: boolean; kind?: string }): string | null` — returns the human reason a claim/attack/fortify button is disabled, or null when it is actionable. Task 3 uses `resultCopy`; Task 8 uses `blockedReason`.

- [ ] **Step 1: Write the failing tests** (`tests/ux-copy.test.ts`): assert `resultCopy({status:"failed",timedOut:true})` title contains "Time" and differs from `resultCopy({status:"failed",timedOut:false})`; `resultCopy({status:"contested",timedOut:false})` is the challenge-issued copy; `resultCopy({status:"completed",timedOut:false})` is the success copy. For `blockedReason`: zero actions → "No moves left today"; contested → "An attack is already active"; `!canTarget` on a claim/attack → "You don't share a border"; onCooldown → cooldown copy; alreadyFortifiedToday on fortify → already-fortified copy; actionable → null. Cover the precedence order.
- [ ] **Step 2: Run to verify fail** — `npm test` → cannot find module.
- [ ] **Step 3: Implement `lib/ux-copy.ts`** with the two pure functions and a clear precedence order (contested > no-actions > cooldown > already-fortified > no-border > actionable).
- [ ] **Step 4: Run to verify pass** — `npm test`.
- [ ] **Step 5: Commit** — `test(ux): add resultCopy and blockedReason helpers`.

---

### Task 3: Question screen → Broadcast focus mode + visual timer + timeout copy

**Files:**
- Modify: `components/question-arena.tsx`, `components/territory-game-v2.module.css` (`.questionPage` and children)

**Interfaces:**
- Consumes: Task 1 tokens, Task 2 `resultCopy`.
- Produces: a light Broadcast question screen; the timeout path now yields distinct copy.

- [ ] **Step 1: Restyle `.questionPage`** dark→Broadcast light focus mode: bone `--paper` background, heavy black poster question type (`.questionCard h1`), a large faint state watermark, answer buttons as white cards with black text (selected = filled `--ink`), streak pips in `--mine`.
- [ ] **Step 2: Add a VISUAL countdown** — render a ring or bar that depletes with `seconds` (the component already computes `seconds`); keep the numeric readout. Use `--gold`→`--rival` as time runs low (reuse the existing danger threshold).
- [ ] **Step 3: Distinct timeout copy** — where the arena builds the result state, pass `timedOut` (true when the auto-submit fired on expiry — the component already tracks `timedOut` via a ref) into `resultCopy(...)` so an expired question shows "Time's up", not the generic incorrect message.
- [ ] **Step 4: Checks + browser** — four checks pass; confirm the question screen renders light Broadcast with a depleting timer; let one expire to see the timeout copy.
- [ ] **Step 5: Commit** — `feat(design): Broadcast question screen with visual timer and timeout copy`.

---

### Task 4: Result screen → Broadcast poster

**Files:**
- Modify: `components/question-arena.tsx` (result branch), `components/territory-game-v2.module.css` (`.resultPage` and children)

**Interfaces:**
- Consumes: Task 1 tokens, Task 2 `resultCopy` (title/message already threaded in Task 3).
- Produces: a saturated Broadcast result poster.

- [ ] **Step 1: Restyle `.resultPage`** — success = `--mine` blue field, failure = `--rival` red field, big black/white editorial verdict, the correct-answer line legible, a black/white "Return to map" CTA. Keep the reduced-motion guard.
- [ ] **Step 2: Checks + browser** — four checks; confirm success (blue) and failure (red) posters render; the timeout result shows the Task 3 copy on the poster.
- [ ] **Step 3: Commit** — `feat(design): Broadcast result poster`.

---

### Task 5: Auth / landing restyle

**Files:**
- Modify: `components/auth-stage.tsx`, `components/territory-game-v2.module.css` (`.authPage` and children)

**Interfaces:** consumes Task 1 tokens.

- [ ] **Step 1: Restyle `.authPage`** dark-navy→Broadcast: bone-white hero, heavy black editorial headline ("Know the game. Own the map."), the light US map watermark with Texas in `--rival`, a white sign-in card with a black primary CTA and the segmented toggle in Broadcast. Update the mobile override values for `.authPage`/`.authHero`/`.authPanel`.
- [ ] **Step 2: Checks + browser** — four checks; the landing page renders light Broadcast, sign-in still works against the local stack.
- [ ] **Step 3: Commit** — `feat(design): Broadcast auth/landing screen`.

---

### Task 6: League entry + lobby + league picker + onboarding

**Files:**
- Modify: `components/league-entry.tsx`, `components/lobby-stage.tsx`, `components/game-overlays.tsx` (LeaguePicker), `components/territory-game-v2.module.css` (`.entryPage`/`.lobbyPage`/`.leagueModal` and children)

**Interfaces:** consumes Task 1 tokens.

- [ ] **Step 1: Restyle** entry, lobby (invite strip in `--dock` black with gold code; player rail; home-state chooser), and the league-picker modal to Broadcast light cards + black CTAs.
- [ ] **Step 2: Onboarding / empty states** — first-run when the user has no groups: `LeagueEntry` gets a welcoming Broadcast "create or join" hero rather than a bare form; the lobby shows a clear "waiting for players / home states" state and a "season not started" commissioner prompt (these are presentation over existing data — do not change the gating logic).
- [ ] **Step 3: Checks + browser** — four checks; walk create-league, join, lobby, and the picker.
- [ ] **Step 4: Commit** — `feat(design): Broadcast league entry, lobby, picker, and onboarding`.

---

### Task 7: Standings + feed overlays + empty states

**Files:**
- Modify: `components/game-overlays.tsx` (StandingsOverlay, FeedOverlay, Loading), `components/territory-game-v2.module.css` (`.overlayPage`/`.rankingRow`/`.feedItem`/`.loading`)

**Interfaces:** consumes Task 1 tokens.

- [ ] **Step 1: Restyle** standings (bold rank numerals, team-color avatars, light rows) and feed (light editorial rows) to Broadcast; restyle the `Loading` splash to Broadcast light.
- [ ] **Step 2: Empty states** — feed empty already has copy ("The map is quiet…") — style it Broadcast; add an empty/standings-at-zero treatment if the list is empty.
- [ ] **Step 3: Checks + browser** — four checks; view standings and feed.
- [ ] **Step 4: Commit** — `feat(design): Broadcast standings, feed, empty states`.

---

### Task 8: Blocked-action reasons in TerritorySheet

**Files:**
- Modify: `components/game-shell.tsx` (TerritorySheet), `components/territory-game-v2.module.css` (a reason line style if needed)

**Interfaces:** consumes Task 2 `blockedReason`, Task 1 tokens.

- [ ] **Step 1: Surface the reason** — in `TerritorySheet`, when the action button is disabled, render `blockedReason(...)` output (no moves / cooling down / already fortified / no border / contested) in place of / alongside the existing generic reason line, wired from the props the sheet already has (`action`, `canTarget`, `actionsRemaining`, `territory.contested`). Pass any cooldown/fortified flags already present on the territory; if a flag is not available, omit that branch (do not fabricate data).
- [ ] **Step 2: Checks + browser** — four checks; at zero actions confirm the button shows "No moves left today" rather than a silent grey button.
- [ ] **Step 3: Commit** — `feat(ux): explain why a territory action is blocked`.

---

### Task 9: Custom in-app report dialog

**Files:**
- Modify: `components/game-runtime-controls.tsx`, `components/game-runtime-controls.module.css` (or the shared module) for the dialog style

**Interfaces:** consumes Task 1 tokens; uses the shared context `notify`/`loadSnapshot` (from `useGameData`).

- [ ] **Step 1: Replace native dialogs** — swap the `window.prompt`/`window.alert`/`window.location.reload()` report flow for a small in-app Broadcast modal that collects the reason, calls `report_question`, then confirms via the shared `notify` toast and `loadSnapshot()` (no full-page reload). Keep the report action gating (only when there is an active attempt).
- [ ] **Step 2: Checks + browser** — four checks; trigger a report and confirm the in-app modal + toast (no native popups).
- [ ] **Step 3: Commit** — `feat(ux): in-app report dialog replacing native prompts`.

---

### Task 10: P2a-deferred fixes + commissioner button style

**Files:**
- Modify: `hooks/use-game-state.ts` (focus refresh), `components/game-runtime-controls.tsx` (message auto-clear + commissioner button style), `components/game-runtime-controls.module.css`

**Interfaces:** consumes Task 1 tokens.

- [ ] **Step 1: Restore focus refresh** — add a `focus`/`visibilitychange` listener in the shared data hook that calls `loadSnapshot()` (debounced/guarded), so the merged data layer refreshes on tab refocus like the old dual-poll did.
- [ ] **Step 2: Auto-clear the turn-banner message** — clear the `message` state after a short timeout (or on the next successful snapshot) so "X is up" does not linger indefinitely.
- [ ] **Step 3: Commissioner button** — give the "Advance the day" control its own Broadcast style (its own module class), positioned so it no longer overlaps the logout button.
- [ ] **Step 4: Checks + browser** — four checks; confirm refocus refreshes, the message clears, and the commissioner + logout controls no longer overlap.
- [ ] **Step 5: Commit** — `fix(ux): focus refresh, turn-message auto-clear, commissioner button style`.

---

### Task 11: Remove dead globals + reconcile override sheets

**Files:**
- Modify: `app/globals.css` (remove dead classes/vars), `app/organized-mobile.css`, `app/mobile-overrides.css`

**Interfaces:** consumes Task 1 tokens.

- [ ] **Step 1: Prove the globals classes are dead** — `grep -rn "shell\|brand-lockup\|eyebrow\|\bcard\b" components/ app/ --include="*.tsx"` and confirm `.shell`/`.card`/`.brand-lockup`/`.eyebrow` from `globals.css` are unreferenced by components (they use `styles.*`). If any IS used, keep it and note why.
- [ ] **Step 2: Remove** the dead classes and the unused `:root` var block from `globals.css`; keep the font imports, body/noise, and focus styles.
- [ ] **Step 3: Sweep the override sheets** — grep `organized-mobile.css`/`mobile-overrides.css` for any remaining old-palette hex values (`#10243d`, `#0b6f9b`, `#e24a36`, `#132238`, `#f7f5ee`, etc.) and update them to Broadcast tokens/values so mobile matches desktop.
- [ ] **Step 4: Checks + browser** — four checks; the app still renders correctly at desktop and 390px mobile with no stale colors.
- [ ] **Step 5: Commit** — `chore(design): remove dead globals and reconcile mobile overrides to Broadcast`.

---

### Task 12: Touch targets + responsive audit

**Files:**
- Modify: whichever component/module styles need target/overflow fixes (found during the audit)

**Interfaces:** consumes Task 1 tokens.

- [ ] **Step 1: Audit** — at 390px and 360px widths (dev server + browser), verify every interactive control (answer buttons, bottom nav, HUD pills, sheet action, segmented toggles, invite copy, commissioner/logout, report) is ≥44×44px and there is NO horizontal page overflow. List failures.
- [ ] **Step 2: Fix** the failures with minimal CSS (min-height/min-width, padding, wrapping) in the module/override sheets.
- [ ] **Step 3: Checks + browser** — four checks; re-audit at 360/390px — all targets ≥44px, no overflow.
- [ ] **Step 4: Commit** — `fix(design): touch targets and mobile overflow`.

---

### Task 13: Final validation and closeout

**Files:**
- Modify: `IMPLEMENTATION_STATUS.md`, `docs/superpowers/backlog.md`

**Interfaces:** consumes everything above.

- [ ] **Step 1: Clean-room** — `npm run stack:reset` then (stack env exported) `npm test && npm run test:db && npm run test:smoke && npm run typecheck && npm run build && npm run lint`; all pass. Capture counts.
- [ ] **Step 2: Full Broadcast click-through (controller/browser)** — auth → league entry (onboarding) → lobby → game shell/map/HUD/dock → question (visual timer) → result poster → standings → feed → report dialog → commissioner control, every screen in Broadcast, at 390px, no horizontal overflow, ≥44px targets, no native dialogs, no stale dark screens.
- [ ] **Step 3: Update docs** — mark P2b complete in `IMPLEMENTATION_STATUS.md` (Broadcast applied across all screens; UX fixes; onboarding; touch targets), note P2c (motion/animated map) and P2d (PWA) remain; move any deferred visual nits to `docs/superpowers/backlog.md`.
- [ ] **Step 4: Commit** — `docs(status): record P2b Broadcast restyle closeout`.
