---
status: pending
priority: p2
issue_id: 008
tags: [code-review]
dependencies: []
---
# season complete dead end

## Problem Statement
territory-game.tsx routes any non-active season to SeasonComplete, which has no league switcher and no navigation — a multi-league player is trapped (only escape is Log out). The branch sits before every navigation affordance (architecture-strategist R4, kieran L6). Fix: add an 'Other leagues' action to the panel.

## Acceptance Criteria
- [ ] Addressed and verified by the existing suite
