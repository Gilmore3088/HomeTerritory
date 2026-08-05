---
status: pending
priority: p2
issue_id: 012
tags: [code-review]
dependencies: []
---
# css append layers and copy duplication

## Problem Statement
~96 lines of P2b override blocks in territory-game-v2.module.css re-declare properties whose base rules sit earlier in the same file, leaving dead dark-theme values and forcing artificial specificity bumps; fold them into the base rules (~80 LOC). Also: 'It's X's turn' is hand-written in three places, border copy has two spellings, and SeasonComplete duplicates StandingsOverlay's ranked list (~18 LOC) (code-simplicity-reviewer 3,4,5,8).

## Acceptance Criteria
- [ ] Addressed and verified by the existing suite
