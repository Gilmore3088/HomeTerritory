---
status: pending
priority: p1
issue_id: 005
tags: [code-review, architecture]
dependencies: []
---
# Two independent blocked-action rule engines (plan mandated one)

## Problem Statement
The plan required `isTerritoryActionBlocked = (blockedReason(...) !== null)` — a single source of truth. The implementation keeps both `lib/game-rules.ts` and `lib/ux-copy.ts` implementing precedence independently, and `components/game-shell.tsx` calls both (one for `disabled`, one for the caption). They already disagree: game-rules exempts non-move kinds from the turn gate, blockedReason applies it to all kinds; and blockedReason's cooldown/fortified branches have no counterpart in the disable predicate. The first caller to wire `onCooldown` gets an enabled button captioned "blocked".

## Findings
- architecture-strategist R2 (clearest arbitrated-design violation), code-simplicity-reviewer #2, kieran-typescript-reviewer L4.

## Proposed Solutions
1. Derive: `isTerritoryActionBlocked` calls `blockedReason(...) !== null`, TerritorySheet derives `disabled` from the reason. (Small — recommended)
2. One function returning `{ blocked, reason }`. (Small, wider call-site churn)

## Acceptance Criteria
- [ ] Exactly one precedence ladder exists in the codebase
- [ ] A disabled button's caption can never contradict its disabled state
- [ ] Existing game-rules tests still pass
