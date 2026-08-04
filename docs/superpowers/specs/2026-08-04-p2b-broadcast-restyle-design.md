# Territory — Phase 2b: Broadcast design system + screen restyle Design

Date: 2026-08-04
Status: Approved (user pre-authorized autonomous execution; visual direction locked earlier)

## Background

Phase 2 is the mobile UX + visual redesign, decomposed into P2a–P2d. P2a
(Foundation — unified data layer, turn process, commissioner advance) is
merged. This is **P2b**: build the Broadcast design system and apply it across
every screen, folding in the P2-backlog UX papercut fixes, touch targets, and
onboarding/empty states.

**Broadcast is locked** (user picked it decisively from three mockups): light,
editorial, poster-bold, saturated team colors, the real US map as hero.
Reference: `.superpowers/brainstorm/*/content/three-real.html` (option 3
"arena") and its token block.

Motion/juice and the animated map are **P2c** (not here). PWA wiring is **P2d**.
P2b is the static visual system + the functional UX fixes.

## Current styling architecture (verified 2026-08-04)

- `components/territory-game-v2.module.css` is the LIVE stylesheet (minified,
  long lines). It declares the working design tokens on its shared selector —
  `--ink:#132238; --navy:#10243d; --blue:#0b6f9b; --red:#e24a36;
  --paper:#f7f5ee; --muted:#6a7889; --line:...` — and every component's classes
  (`.app`, `.authPage`, `.lobbyPage`, `.board`, `.mapSvg`, `.missionDock`,
  `.questionPage`, `.resultPage`, overlays, nav, etc.). Components apply these
  via `styles.X` (CSS-module local names).
- `app/globals.css` sets the font imports (Fraunces / Public Sans / IBM Plex
  Mono), the body paper background + noise texture, and focus styles. Its
  `.shell` / `.card` / `.brand-lockup` / `.eyebrow` classes are NOT used by the
  current components (dead — a leftover token set). Its `:root` vars
  (`--paper:#F2EFE4`, etc.) are likewise unused by the live UI.
- `app/mobile-overrides.css` + `app/organized-mobile.css` are GLOBAL sheets
  (imported in `app/layout.tsx`) that override the module using attribute
  selectors like `[class*="territory-game-v2-module"][class*="__app"]`. ~100
  selectors couple to the module's generated class names (backlog-noted
  coupling — do NOT rename the module).
- Map colors live in `data/us-states.ts`-adjacent `lib/game-constants.ts`:
  `PLAYER_COLORS[]`, `NEUTRAL`, `INK`, `PAPER`, `DANGER` — these drive the SVG
  fills in `components/territory-map.tsx`.

Implication: Broadcast is delivered by (1) rethemeing the token values, (2)
restyling the few screens whose treatment must change (notably the dark
question/result screens → Broadcast), (3) recoloring the map constants, (4)
updating the mobile override sheets in lockstep, and (5) removing the dead
`globals.css` classes. Not a rewrite.

## Broadcast tokens (the design system)

Establish these as the single source of truth (replace the module's shared-
selector `:root`-style var block; mirror any needed subset in `globals.css`
`:root` only if a global consumer needs them):

- Surfaces: `--paper: #faf7ef`, `--paper-2: #f0ece0` (page gradient),
  `--card: #ffffff`, `--ink: #111111`, `--line: #ddd6c6`.
- Team / state: `--mine: #1d6fe0` (your states, blue), `--mine-ink: #0a4fb0`,
  `--rival: #e0332f` (rivals, red / danger), `--rival-ink: #a81f1c`,
  `--neutral: #e7e3d8` (unclaimed), `--neutral-line: #c8c2b2`,
  `--gold: #f5d020` (target / accent), `--muted: rgba(17,17,17,.55)`.
- Contrast surfaces: `--dock: #111111` (bottom dock / nav, white text) —
  Broadcast keeps a black dock/CTA against the light page.
- Type: editorial serif display (keep Fraunces/Georgia already loaded) at
  heavier weight/contrast for headlines; bold sans (Public Sans) for HUD
  numbers, labels, buttons. Poster-scale headline sizing.
- Focus ring: `2px solid var(--ink)` (retain the accessible focus style).

PLAYER_COLORS (in `lib/game-constants.ts`) become a saturated poster palette
seeded with `--mine` blue and distinct bold hues (blue, red, green, amber,
violet, teal, orange, slate) readable as flat fills on the light map; `NEUTRAL
= #e7e3d8`, `PAPER = #faf7ef`, `INK = #111111`, `DANGER = #e0332f`.

## Screen-by-screen restyle (Broadcast language)

Each screen keeps its structure and behavior; only the visual treatment
changes to the tokens above.

- **Landing / auth** (`auth-stage.tsx` + module `.authPage`): bone-white hero
  with heavy black editorial headline, the light US map watermark (Texas in
  `--rival` red), a clean white sign-in card with a black primary CTA. Replace
  the current dark-navy hero.
- **League entry / lobby / league picker** (`league-entry.tsx`,
  `lobby-stage.tsx`, `game-overlays.tsx`): light cards, black CTAs, the invite
  strip in `--dock` black with gold code; the map on the light Broadcast base.
- **Game shell / map / HUD / mission dock** (`game-shell.tsx`,
  `territory-map.tsx`): the HERO. Light page, saturated team-color states,
  white HUD stat pills, a black mission dock with a red primary CTA and gold
  "your move" label (matches the locked mockup). This screen is restyled and
  controller-verified FIRST (see plan).
- **Question screen** (`question-arena.tsx` + `.questionPage`): convert the
  dark-navy takeover to Broadcast light "focus mode" — bone background, heavy
  black poster question type, a large faint state watermark, answer buttons as
  white cards with black text (selected = filled ink), and the timer as a
  VISUAL countdown (ring or bar) not just seconds. Streak pips in `--mine`.
- **Result screen** (`.resultPage`): a saturated full-color poster moment —
  `--mine` blue field for success, `--rival` red for failure, big black/white
  editorial verdict. Add distinct **timeout** copy (see UX fixes).
- **Standings / feed overlays** (`game-overlays.tsx`): light editorial list
  rows, bold rank numerals, team-color avatars.

## UX papercut fixes (from backlog, folded in)

- **Visual timer + distinct timeout copy** (`question-arena.tsx`): render a
  countdown ring/bar; on expiry, the auto-submit result shows a distinct
  "Time's up" message, not the generic "Incorrect." A pure helper
  `resultCopy({ status, timedOut })` (new, unit-tested) picks the message.
- **Blocked-action reasons** (`game-shell.tsx` `TerritorySheet`): when the
  action button is disabled, show WHY (no actions left / cooling down / already
  fortified today / not your border / contested). A pure helper
  `blockedReason(...)` (new, unit-tested) returns the label; the existing
  `isTerritoryActionBlocked` (lib/game-rules.ts) informs it.
- **Custom in-app dialog** replacing `window.prompt`/`window.alert` in the
  report flow (`game-runtime-controls.tsx`): a small in-app modal (Broadcast-
  styled) collects the report reason and shows the quarantine/refund
  confirmation as a toast — no native dialogs, no full-page reload.
- **P2a-deferred items:** restore a refresh on window `focus`/`visibilitychange`
  in the shared data hook; auto-clear the turn-banner `message` so "X is up"
  does not linger. (Both were deferred from P2a's final review.)

## Onboarding / empty states

Designed in Broadcast: first-run when the user has no leagues (a welcoming
"create or join" hero rather than a bare `LeagueEntry`), lobby "waiting for
players / home states" state, "season not started" commissioner prompt, and
empty **feed** / **standings** states ("the map is quiet — the first correct
answer changes that"). These are presentation states over existing data.

## Touch targets & responsive

Audit interactive elements for ≥44×44px tap targets on mobile (answer buttons,
nav, HUD pills, sheet controls, the commissioner button — which P2a left
reusing `styles.logout`; give it its own Broadcast style here and stop it
overlapping logout). Keep the `max-width` mobile shell; verify no horizontal
overflow at 390px and 360px widths.

## Architecture decisions (made here)

- **Retheme in place**, do not rewrite the module or rename it (preserves the
  `organized-mobile.css` coupling). Change token VALUES + the specific
  treatments listed; update the two mobile override sheets in lockstep where a
  value or dark→light treatment changes.
- **Remove the dead `globals.css` classes** (`.shell`, `.card`, `.brand-lockup`,
  `.eyebrow`, and its unused `:root` vars) to end the two-token-system
  confusion; keep the font imports, body/noise, and focus styles. Confirm via
  grep that no component references them before deletion.
- **Map recolor lives in `lib/game-constants.ts`** (single source for SVG
  fills), not scattered in the component.
- The question/result dark screens become Broadcast (light focus mode / saturated
  poster) — a deliberate, documented departure from their current dark
  treatment, to keep one coherent light system.

## Testing

- **Pure helpers** get node-test coverage: `resultCopy({status, timedOut})`,
  `blockedReason(...)`. The report-dialog state logic, if extracted, gets a
  unit test.
- **No game-logic regressions:** the existing 32 unit / 41 DB / 1 smoke tests
  stay green; `npm run typecheck`, `npm run build`, `npm run lint` exit 0.
- **Visual verification (controller, browser):** the hero game screen is
  verified against the locked Broadcast mockup FIRST; then a full click-through
  of every restyled screen (auth → lobby → game → question → result →
  standings → feed → report dialog → empty states) at 390px width, checking no
  horizontal overflow and ≥44px targets.

## Out of scope (later)

Motion/juice and animated map interactions (P2c). PWA install (P2d). No
game-rules or RPC behavior changes except the small UX-fix helpers above.

## Done criteria

- Broadcast tokens are the single source of truth; the dead `globals.css`
  classes are gone; the map constants are Broadcast-colored.
- Every screen (auth, league entry, lobby, league picker, game shell/map/HUD/
  dock, question, result, standings, feed) renders in the Broadcast language,
  controller-verified in the browser starting from the hero screen.
- UX fixes shipped: visual timer + distinct timeout copy, blocked-action
  reasons, custom in-app report dialog (no native prompt/alert), focus refresh
  restored, turn-banner message auto-clears.
- Onboarding/empty states present for no-leagues, lobby-waiting,
  season-not-started, empty feed/standings.
- Touch targets ≥44px; no horizontal overflow at 360–390px; commissioner
  control has its own style and no longer overlaps logout.
- Full test suite green; new pure helpers unit-tested.
