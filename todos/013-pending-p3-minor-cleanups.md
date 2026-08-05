---
status: pending
priority: p3
issue_id: 013
tags: [code-review, quality]
dependencies: []
---
# Minor cleanups from review

- `readSavedGroupId` mutates storage (deletes the legacy key) despite its name; extract `removeLegacyGroupKey()` and call it once at bootstrap. Also no try/catch around localStorage (Safari lockdown throws would break loadGroups). [kieran L1]
- Hoist `loadSnapshotRef` and `maxSecondsRef` above first textual reference — currently runtime-safe only because those closures defer past render. [kieran L2]
- `maxSecondsRef` is read during render for the timer bar; derive `totalSeconds` as state keyed to the attempt instead. [kieran L3]
- `ResultCopyInput.status` should be a union, not `string`; delete `blockedReason`'s unreachable `onCooldown`/`alreadyFortifiedToday` inputs until a caller exists. [kieran L4, simplicity 1]
- Extract `isMyTurn(snapshot)` (the `!== false` back-compat rule is encoded twice) and name `pips={5}` as MAX_DAILY_ACTIONS. [kieran L5, L6]
- Inline `isStaleLoad`'s one-line `!==`; add the five phantom CSS tokens (--paper-2, --mine-ink, --rival-ink, --neutral-line, --font-display) to the token block or use literals. [simplicity 6,7]
- Migration comment overstates the fallback: at the 2-void cap the defender has no open session to "ride with" and forfeits at the deadline. Consider enforcing the cap inside report_question instead. Add an index on game_sessions.attack_id later. [data-integrity]
- test-signup: body-size cap is advisory (missing/NaN content-length bypasses it); a 23505 unique-violation on the color/home race should return 409 "league filled up, try again" rather than a 500. Pin workflow actions by SHA and scope secrets to the steps that need them. [security L2, L3, L5]

## Acceptance Criteria
- [ ] Items triaged; cheap ones applied
