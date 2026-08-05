---
status: pending
priority: p1
issue_id: 002
tags: [code-review, quality, ux]
dependencies: []
---
# "Try again" after a failed timeout-submit strands the player

## Problem Statement
`components/question-arena.tsx`: on timeout the tick sets `timedOut.current = true` and auto-submits `""`. If that RPC fails, the error screen's "Try again" returns to a question card with `seconds === 0`, empty answer (Lock disabled), and `timedOut.current` permanently true so the auto-resubmit never re-arms. No control on the card leads anywhere.

## Findings
- kieran-typescript-reviewer H2 (merge blocker).

## Proposed Solutions
1. Keep the last submitted value in a ref; "Try again" re-invokes `submit(lastValue)`. (Small — recommended)
2. Reset `timedOut.current = false` on dismiss so the tick re-arms. (Small, retries only on the next tick)

## Acceptance Criteria
- [ ] A failed timeout-submit can be retried from the error screen
- [ ] No state where the question card has no working control
