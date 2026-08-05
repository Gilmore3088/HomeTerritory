---
status: pending
priority: p1
issue_id: 001
tags: [code-review, quality, session]
dependencies: []
---
# retryLoad clears loadError synchronously, flashing LeagueEntry

## Problem Statement
`hooks/use-game-state.ts` `retryLoad` calls `setLoadError(null)` before awaiting the loader. React re-renders with `loadError=null`, `groups=[]`, `groupId=null`, so `components/territory-game.tsx` renders `LeagueEntry` — with a live "Create league" button — for the whole retry RPC. This is exactly the duplicate-league window the error-before-groups branch order exists to prevent.

## Findings
- kieran-typescript-reviewer H1 (merge blocker). Both loaders already clear the error on success and re-set on failure, so the optimistic clear is unnecessary.

## Proposed Solutions
1. Delete `setLoadError(null)` from `retryLoad`; add a `retrying` boolean to `LoadErrorScreen` for feedback. (Small, low risk — recommended)
2. Keep the clear but add a `retrying` guard state to the branch condition. (Small, more state)

## Acceptance Criteria
- [ ] With `get_my_groups` failing, clicking Retry never renders LeagueEntry at any point
- [ ] The error screen shows retry feedback
