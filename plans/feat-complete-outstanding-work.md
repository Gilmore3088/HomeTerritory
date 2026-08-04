# feat: Complete Outstanding Work — Login/Session, Balance, Broadcast Restyle, Deploy Prep

## Enhancement Summary

**Deepened on:** 2026-08-04. **Agents:** repo-research, auth best-practices, deploy docs, spec-flow, architecture, security, simplicity, data-integrity, TypeScript-patterns (9 total).

**Key decisions from review arbitration:**
1. **Phase A restructure:** split the provider — session provider on top, game-state provider keyed by `user.id` below — so ALL hook state (including refs, realtime channels, in-flight responses) resets by construction on account switch. The enumerated wipe list is deleted, not extended (it's the pattern that caused the original bug).
2. **B1 (defense credits) DEFERRED** pending re-playtest: both playtest complaints trace to legibility, not economy; and every production playtest league is `test_mode`, where turn rotation already grants effectively unlimited actions — the credit would be nearly meaningless in the deployed environment. The fully de-risked spec is preserved in Appendix B1 for one-command revival.
3. **Two newly found real defects ship in this plan:** the defend-reroll exploit (report → void → re-defend free, walkable question bank) and `test-signup` creating auth accounts BEFORE its capacity check (unbounded account minting on every failure path).
4. **Phase D restructured as an ordered security gate** (verify-first → capacity fix → CORS → conditional throttle → error hygiene → pipeline hardening).
5. Simplicity cuts adopted: no backoff schedule (failure counter + ungated poll), no legacy-localStorage migration (delete the old key), no CI service containers now, manual post-deploy smoke via service key.

## Overview

Territory's core loop is validated ("decent game", playtest 2026-08-04); bots are removed (multiplayer-only). Execution order **A → B → C → D** (A→C coupling is load-bearing: C Task 10 touches the hook A rewrites; A∥B is possible under schedule pressure — their file sets are disjoint).

## Problem Statement (verified, file:line)

1. Wedge: one failed RPC strands the client. `loadSnapshot` toasts and gives up (`hooks/use-game-state.ts:85-88`); poll + realtime both die because both are gated on `snapshot?.season?.id` (`:120-135`). `get_my_groups` failure renders first-run `LeagueEntry` (duplicate-league risk, `territory-game.tsx:44`); `get_my_active_session` errors are silently ignored (`:90-98`).
2. Account-switch leaks: the render-phase wipe (`:46-53`) misses `operation/result/busy/toast`; the realtime channel and in-flight responses survive a user change; `GameRuntimeControls` holds the previous player's name.
3. Balance perception: `defend` costs 0 and is turn-exempt, but off-turn players are force-zeroed (`20260803180600...sql:42-44`) and turn-gated while MissionDock lies with "ACTIONS SPENT" (`components/game-shell.tsx:124-125`).
4. Economy is never explained in the UI (claim = 1 move + 1 question; attack = 1 move + 2-3 correct; fortify = 1 move + 1 question, once/day/state).
5. Broadcast redesign is 1/13 tasks done.
6. Nothing is deployed; the deploy workflow is credential-blocked; `test-signup` has real pre-deploy security defects (see D1/D2).

---

## Phase A — Login/Session Cleanup

**Files:** `hooks/game-data-context.tsx` (provider split + key), `hooks/use-game-state.ts`, `hooks/use-supabase-session.ts`, `components/territory-game.tsx`, `components/auth-stage.tsx`, `components/question-arena.tsx`, new `lib/group-storage.ts`, new `lib/snapshot-retry.ts` (pure decision logic), `components/game-overlays.tsx` (`LoadErrorScreen`), `lib/game-types.ts` (`GameLoadError`), unit tests.

### A0. Provider split + keyed remount (replaces the old "wipe list" approach)

- `GameDataProvider` splits: an outer session provider (`useSupabaseSession`) and an inner game-state provider mounted with `key={session?.user.id ?? "anon"}` wrapping **both** `TerritoryGame` and `GameRuntimeControls` (`app/page.tsx` is a server component — the key lives inside the provider module, NOT in page.tsx).
- Consequences (all by construction): hook state, `beganAtRef`, the `notify` timer, the realtime channel (effect cleanup on unmount), and in-flight RPC continuations (`setState` on unmounted hook is a no-op) all reset on account change; `TOKEN_REFRESHED` keeps the same `user.id` → no remount → a live question survives. Delete the render-phase wipe at `use-game-state.ts:46-53`.
- Belt-and-braces for the realtime channel: include `session.user.id` in the channel topic and keep `session?.user.id` (never the session object) in effect deps — the loader effects currently keyed on the session object re-run on every hourly token refresh; re-key them to `[session?.user.id, groupId]`.

### A1. Loader resilience (all three loaders)

- **Staleness guard:** monotonic generation counter (NOT `Date.now()`) + `groupId` captured per request; drop any response whose `{generation, groupId}` no longer matches. Generation bumps on group switch (`selectGroup`).
- **Single-flight with trailing rerun:** concurrent `loadSnapshot` calls share the in-flight promise; a call arriving mid-flight sets a dirty flag that triggers exactly one follow-up load after settle (plain collapse would swallow realtime-triggered refreshes).
- **Failure counter, no backoff schedule:** `failCount` ref increments on error, resets on success; render `LoadErrorScreen` when `failCount >= 2 && !snapshot`. The 20s poll re-keys to `[user.id, groupId]` (ungated from snapshot) so recovery is also automatic; realtime stays season-gated (its filters need `season_id`) and is bootstrapped by the first successful snapshot.
- **Status contract:** add to `GameState`: `loadError: GameLoadError | null` (`{ source: "groups" | "snapshot"; message: string }`) and `retryLoad(): Promise<void>`. No functions in state objects. `loadError` clears on success, account change, and `selectGroup`.
- **Branch order is part of the contract:** in `territory-game.tsx`, the `loadError` check comes BEFORE the `!groupId || groups.length === 0` branch (a failed `get_my_groups` must never render `LeagueEntry`).
- `get_my_active_session` errors surface via toast and retry on next poll; a restored-but-expired question resolves within one poll cycle.
- Extract retry/status decision logic into pure `lib/snapshot-retry.ts` (repo habit: `turn-reconcile.ts`), unit-tested without Supabase mocks.
- `LoadErrorScreen` is written directly in Broadcast tokens (they exist on main since P2b Task 1) — no C-phase restyle dependency.

### A2. (folded into A0)

### A3. Auth-path hygiene (trimmed)

- Comment on `use-supabase-session.ts` warning the `onAuthStateChange` callback must stay synchronous (`navigator.locks` deadlock).
- Auth-submit `busy` timeout in `auth-stage.tsx` (cheapest, most user-visible guard). The 8s `authReady` timeout screen is deferred until the hang is actually observed.

### A4. Per-user group selection

- New `lib/group-storage.ts` owns the key format: `readSavedGroupId(userId)` / `writeSavedGroupId(userId, groupId)` / `clearSavedGroupId(userId)`; scoped key `territory_group:${userId}`; the legacy unscoped key is **deleted unconditionally** (no migration — worst case a friend re-picks their league once; migration risks carrying account A's group into B's namespace).
- Kill the component write site: hook exposes `selectGroup(id)` (setGroupId + write + generation bump); LeaguePicker calls it. There are currently **three** raw call sites (`use-game-state.ts:68` read, `:71` write, `territory-game.tsx:85` write — note: `lib/game-selection.ts` does NOT read storage; `pickActiveGroup` takes `saved` as a param and its Finding-22 row-validation is what makes all this safe).

### A5. Two-window truth (docs only)

- Two same-profile windows share one cookie session by design (cannot hold two accounts). Document in `docs/HANDOFF.md` + README: two-account testing = normal + incognito; incognito's session dies with the window (closing mid-attack leaves the defense to the 24h timeout).

### A6. QuestionArena dead-ends

- On `game_submit_answer` error: show the error with "Return to map" clearing `operation`/`result`; same for the auto-timeout submit path. Ships minimal/unstyled on purpose (C Tasks 3/4 restyle around it).

**Phase A acceptance criteria**

- [ ] `group_snapshot` failing twice shows `LoadErrorScreen` (not the infinite splash); Retry targets the same group; the next poll tick also auto-recovers without user action.
- [ ] `get_my_groups` failure for a returning user renders the error screen, never `LeagueEntry` (assert branch order).
- [ ] Stale responses never overwrite newer snapshots (generation + group identity); concurrent loads collapse with a trailing rerun (a realtime event during an in-flight load is not lost).
- [ ] After sign-out + sign-in as another user: no frame renders the previous user's question/result/toast/busy/turn-banner name; the realtime channel is torn down; an in-flight response from the previous user cannot land.
- [ ] Token refresh mid-question: no remount, no reload, question untouched.
- [ ] User B's saved group is B's own; legacy key deleted; scoped key cleared on sign-out.
- [ ] Submit error in the question card always offers a way back to the map.
- [ ] Backlog rows 11 (stale operation) and 12 (dual polling) re-verified and struck as fixed.

---

## Phase B — Balance Pass (legibility first; credits deferred)

**Files:** `components/game-shell.tsx`, `components/game-runtime-controls.tsx`, `lib/game-rules.ts`, one migration `supabase/migrations/<ts>_defense_reroll_cap_and_grant_hygiene.sql`, DB tests.

### B2. Economy legibility (ships now — this is what the playtest actually asked for)

- MissionDock off-turn copy: "It's {turnHolderName}'s turn — you can defend if attacked." (`season.current_turn_name` is already in the snapshot). Kills "ACTIONS SPENT".
- Turn banner shows defense outcomes ("You repelled Texas.").
- TerritorySheet action button cost up-front: "Attack — 1 move, needs 2+ correct" (base wording; difficulty/catch-up modifiers make exact numbers player-specific — do NOT expose effective counts in the snapshot).
- HUD action pips render 0–5 (cap is 5).
- **Module ownership (prevents drift with C Task 2):** B threads `isMyTurn` into `lib/game-rules.ts` data flow and fixes copy; C Task 2's `blockedReason` then becomes the single source of truth with `isTerritoryActionBlocked = (blockedReason(...) !== null)` derived from it. Precedence: contested > not-your-turn > no-actions > cooldown > already-fortified > no-border.

### B3. Anti-grief migration (real exploit, exists today)

- **Defend-reroll cap:** `report_question` voids a defend session, and `game_begin_action`'s defend guard checks `status in ('active','completed','failed')` — `void` is missing, so a defender can report → void → re-defend at zero cost until they draw a known question. Fix: reject a new defend session when ≥2 voided defend sessions exist for that `attack_id` (one `exists()` clause beside the existing guard).
- Same migration: `revoke execute on function public.create_group(text, text[], integer) from authenticated;` and delete its exception from `AUTHENTICATED_EXECUTE_OTHER` in `tests/db/audit.test.ts` (closes the documented dead-grant).

### B1. Defense credits — DEFERRED (decision record)

Deferred pending a re-playtest after B2 lands, because: (a) both playtest complaints are legibility failures — nobody asked for a reward; (b) production playtest leagues are all `test_mode`, where `end_test_turn` grants a flat 3 with no rotation limit — actions are already effectively unlimited, so the credit is nearly meaningless in the deployed environment; (c) unmitigated, it converts the existing attack/repel hold-level farm into a free scoring loop. **The full de-risked spec (safe SQL, lock analysis, accrual caps, adversarial tests) is preserved in Appendix B1** — if the next playtest still wants defense rewarded, implement from there.

**Phase B acceptance criteria**

- [ ] Off-turn MissionDock names the turn holder; "ACTIONS SPENT" never renders when nothing was spent.
- [ ] Attack button shows "needs 2+ correct" consistent with server `required_correct` at standard difficulty; pips render 0-5.
- [ ] DB test: a third defend session for one attack after two voided ones is rejected; a legitimate second defend after one void still works.
- [ ] DB test: `create_group` (v1) is no longer authenticated-executable; audit allowlist updated.

---

## Phase C — P2b Broadcast Restyle Tasks 2–13

Execute `docs/superpowers/plans/2026-08-04-p2b-broadcast-restyle.md` Tasks 2–13 on a fresh branch off main, with amendments:

- [ ] **Re-verify the plan's "Codebase facts" after A + B merge** (A rewrites the hook Task 10 touches; A already built `LoadErrorScreen` in Broadcast style — Task 13 verifies it, no restyle needed).
- [ ] **Task 2 contract:** `blockedReason` gains `isMyTurn: boolean`, `turnHolderName?: string`; precedence per B2; `isTerritoryActionBlocked` becomes derived. `resultCopy` gains `actionType` (a timed-out defense — state lost — must not get generic "Time's up" copy).
- [ ] **Task 6/7 additions:** minimal "Season complete" full-screen panel (reuse snapshot scores; today an ended season falls through to a frozen `GameShell` at `territory-game.tsx:62` — route `season.status !== 'active'`); join-mid-active-season empty state (member with no home state).
- [ ] **Task 10:** owns focus/visibilitychange refresh as written (one-liner onto A's ungated loader).
- [ ] **Task 13 click-through additions:** off-turn dock state, `LoadErrorScreen`, defense-outcome banner, season-complete panel, timeout-on-defense result poster.
- [ ] Phase C stays CSS/UX-only (B's migration lands first).

---

## Phase D — Deploy Prep (ordered security gate)

Work through in order; each step gates the next:

1. **D3 — Verify `verify_jwt` empirically first.** `supabase.functions.invoke` sends the publishable key; the edge gateway may accept it with `verify_jwt = true`. Test against the hosted project; if the call passes the gateway, KEEP `verify_jwt = true` and skip D4 entirely.
2. **D1 — `test-signup` capacity-before-create (ship regardless of D3).** Today `admin.auth.admin.createUser` runs at `index.ts:54` and the 8-member cap check at `:87-93` — every full-league or failed-path signup mints a live confirmed account. Move group lookup + capacity + membership checks ABOVE `createUser`; every post-create failure path calls `admin.auth.admin.deleteUser(user.id)` (the restored `profiles_id_fkey on delete cascade` cleans up). DB test: N+1 signups against a full league create zero auth users.
3. **D2 — CORS allowlist ships in the same PR as any `verify_jwt` change.** Replace `Access-Control-Allow-Origin: *`: `ALLOWED_ORIGINS` env + anchored preview regex (`^https://hometerritory-[a-z0-9-]+\.vercel\.app$`); echo the origin only on match, omit otherwise, `Vary: Origin`; also reject POSTs with a present-but-unlisted `Origin`. Without this, a per-IP throttle counts victims' browsers.
4. **D4 — Throttle (ONLY if D3 proves `verify_jwt = false` is required).** `private.signup_attempts` table (peppered hashes of IP/code/email + `outcome`), one `SECURITY DEFINER public.record_signup_attempt` RPC (atomic count+insert; table in `private` so PostgREST can't see it, function in `public` so the grants-audit test still enumerates it; service_role-only grants). IP from `cf-connecting-ip` (Vercel is NOT in this path), IPv6 normalized to /64, fail closed (503 on RPC error). Windows: 5/15min + 20/24h per IP; 12/hour per code; 3 bad-code/hour → 429; global breaker 100/5min → 503; same generic body for throttled and bad-code. Prune (7-day retention) folded into the existing daily tick. Escalation path if abuse observed: Cloudflare Turnstile (one server-side fetch, no npm dep). Kill switch (document): set the group's `test_mode = false` — signup closes instantly.
5. **D5 — Error + input hygiene in `test-signup`:** stop returning raw Postgres/GoTrue `error.message` (log server-side, return generic + correlation id); cap `password` ≤128, `displayName` ≤40, strip control chars, guard content-length before `request.json()`. Note recorded: the distinct "email already exists" 409 is kept deliberately (UX) — bounded by throttle/invite gate.
6. **D6 — Pipeline hardening + owner checklist.**
   - Remove `supabase init --force` from `deploy-supabase.yml` (it clobbers `config.toml`, silently reverting `[functions.test-signup]`); add a CI assertion that the config block survives.
   - Add an edge-function deploy step (`supabase functions deploy test-signup`).
   - Move `SUPABASE_ACCESS_TOKEN`/`SUPABASE_DB_PASSWORD` into a GitHub `environment: production` with required reviewers.
   - `CRON_SECRET`: production environment ONLY (a preview deployment must not be able to force day-advances against prod); ≥32 random bytes; optionally gate the route on `VERCEL_ENV === 'production'`. Optional 5-line `timingSafeEqual` upgrade in `lib/cron-auth.ts`.
   - **Prod-schema baseline:** production is pre-Phase-1; before the first `db push`, verify the hosted project has no conflicting objects (bare `create table` migrations fail on name collisions) — wipe/repair the prod schema explicitly as a checklist line.
   - Post-deploy smoke: MANUAL 3-step check (sign up on a phone with a seed invite code) or a service-key script (`admin.createUser`, deleting its user afterward) — never the public signup path from CI.
   - **Owner checklist (credential-gated):** (1) the two GitHub secrets; run Deploy Supabase workflow (migration count generated from `ls supabase/migrations`, never hardcoded). (2) Supabase dashboard: Auth Site URL + redirect wildcard for previews, confirm email-confirmation setting matches local (`enable_confirmations = false`), create publishable + secret keys (real `sb_publishable_`, not legacy JWT). (3) Vercel: import repo; env vars `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL`. Hobby cron = once daily within the hour (fine for the tick).

**Deferred from D (recorded):** CI Supabase service container for `test:db`/`test:smoke` (stays backlog `P1-followup`); disposable-email blocking (invite code is the identity gate; league caps at 8 — build nothing).

---

## Dependencies & Risks

- A → C ordering is load-bearing (shared hook); A ∥ B possible (disjoint files). B's migration lands before C's branch. D3's result decides D4's existence.
- DB suite has a documented GoTrue flake (`AuthRetryableFetchError`) — remedy `docker restart supabase_kong_HomeTerritory`, rerun.
- Realtime under hosted connection limits untested (backlog P5) — post-deploy two-phone pass.

## Appendix B1 — Deferred defense-credit spec (implement only after re-playtest demand)

Column: `player_actions.pending_defense_credits integer not null default 0 check (pending_defense_credits between 0 and 2)`. Accrual (in `game_submit_answer` defend-success branch, ONLY if the `repelled` UPDATE affected a row): `insert ... on conflict (season_id,user_id) do update set pending_defense_credits = least(2, player_actions.pending_defense_credits + 1)` — upsert because a mid-season joiner may lack the row; cap in-expression so a 3rd repel can never abort a winning defense via CHECK violation. Anti-farm: credit at most once per (defender, attacker) pair per group-local day. Consumption is single-statement read-and-zero (never SELECT-then-UPDATE — the one real lost-update hazard): `end_test_turn` grant → `set actions_remaining = least(5, 3 + player_actions.pending_defense_credits), pending_defense_credits = 0` (reference the existing row, not EXCLUDED); `refresh_player_actions` non-test branch → credits consumed ONLY inside the `v_days > 0` locked update (zeroing outside it would wipe banked credits on every 20s poll). Season-end clear in `advance_season` is hygiene, not correctness (per-season PK isolates). Lock analysis: no deadlock (every `seasons/groups`-locking path acquires them before `player_actions`; `game_submit_answer` never locks either). Rollback: inverse migration restores the four function bodies BEFORE dropping the column (plpgsql is late-bound). Adversarial DB test required: 20 attack/repel cycles between two accounts yield bounded credits and bounded hold-level gain. Note: meaningful only in non-test leagues — write the DB test non-test-mode.

## References

- Handoff `docs/HANDOFF.md`; P2b plan + ledger; backlog rows 9-14 (11-12 stale — strike in A).
- Live SQL: `game_begin_action` + `game_submit_answer` → `20260803180700`/`20260803180900`; `refresh_player_actions` → `20260803180600`; `end_test_turn`/`group_snapshot`/`advance_season` → `20260804210000`; turn trigger → `20260730220000`; invite generator → `202607300728`; report voiding → `20260803180500`.
- Auth: supabase-js#1594 (locks deadlock), @supabase/ssr cookie sessions, signOut scopes, react.dev Preserving-and-Resetting-State.
- Deploy: Vercel CRON_SECRET convention + Hobby cron windows; Supabase managing-environments Actions pattern; new API keys migration; edge `verify_jwt` docs; `cf-connecting-ip` trust model.
