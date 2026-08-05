---
status: pending
priority: p2
issue_id: 007
tags: [code-review]
dependencies: []
---
# groups error escalates over healthy screen

## Problem Statement
A single get_my_groups failure sets loadError unconditionally and evicts a player from a working lobby to the full-screen error; snapshot errors have a failCount>=2 && !snapshot dampener, groups errors have none and no poll retries them (architecture-strategist R3). Fix: only set a groups error when groups.length === 0.

## Acceptance Criteria
- [ ] Addressed and verified by the existing suite
