---
status: pending
priority: p1
issue_id: 004
tags: [code-review, security, data-integrity]
dependencies: []
---
# A thrown error after createUser strands a confirmed account

## Problem Statement
`supabase/functions/test-signup/index.ts`: every checked `.error` path rolls the account back, but a *thrown* exception between `createUser` and the success return lands in the outer `catch` with no rollback. The stranded account is email-confirmed with no membership, so the address is soft-bricked ("account already exists" on retry, no league on sign-in).

## Findings
- security-sentinel M3. Related: a failed `deleteUser` inside rollback is logged, never retried.

## Proposed Solutions
1. Track `createdUserId` in the enclosing scope; the outer catch deletes it (one retry) before responding. (Small — recommended)
2. Collapse profile+membership+territory+player_actions into one security-definer RPC so GoTrue-vs-one-call is the only seam. (Large, correct long-term)

## Acceptance Criteria
- [ ] An exception after createUser leaves no auth user behind
