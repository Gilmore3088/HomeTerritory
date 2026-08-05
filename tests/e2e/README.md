# End-to-end browser tests (Playwright, Python)

Deterministic golden-path E2E against the local stack, written with
Python Playwright (the audit tooling these grew from). They are not part
of `npm test` — run them manually before a release or after UI changes.

## Prerequisites

- Local stack running (`npm run stack:start`) with the seeded
  Advance Demo League (`commish@playtest.local` / `member@playtest.local`,
  password `playtest-password-1`)
- `npm run dev` serving on `http://localhost:3000`
- `pip install playwright && playwright install chromium`
- Docker access to `supabase_db_HomeTerritory` (the runner reads each
  served question's correct answer from the local DB so gameplay steps
  are deterministic, and temporarily flips the season status for the
  season-complete check — it reverts everything it touches)

## Run

```bash
python3 tests/e2e/golden_path.py
```

Exit code 0 with a `PASS` summary line per section; any `FAIL` line is a
regression. Screenshots land in `tests/e2e/shots/` (gitignored).

## What it covers

1. Auth errors are visible (wrong password, duplicate email)
2. Sign-in → map shell renders with dock, HUD, nav
3. Question flow: live timer, in-app report dialog, result poster,
   return to map, no native dialogs, no console errors
4. LoadErrorScreen after two failed snapshot loads + Retry recovery;
   blocked `get_my_groups` never renders LeagueEntry
5. Account switch: no frame shows the previous user's state; per-user
   saved league; key cleared on sign-out
6. Off-turn dock copy names the turn holder; no "ACTIONS SPENT"
7. Season-complete panel (status flipped and reverted in the DB)
8. Touch-target sweep: every interactive control ≥44×44px and no
   horizontal overflow at 390px and 360px

The two-account attack/defense orchestration (danger dock, timeout
poster, successful defense) mutates real game state, so it lives in the
audit record (`docs/superpowers/audit-2026-08-05.md`) rather than this
repeatable script.
