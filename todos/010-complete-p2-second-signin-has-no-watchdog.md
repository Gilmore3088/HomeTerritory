---
status: pending
priority: p2
issue_id: 010
tags: [code-review]
dependencies: []
---
# second signin has no watchdog

## Problem Statement
The Web-Lock watchdog covers only the sign-in branch of auth-stage.tsx; the post-signup sign-in can hang forever showing 'Working…' (kieran M4). A fired watchdog also leaves the original promise pending, so a stale resolution can write over a later attempt's state.

## Acceptance Criteria
- [ ] Addressed and verified by the existing suite
