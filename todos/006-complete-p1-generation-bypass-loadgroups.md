---
status: pending
priority: p1
issue_id: 006
tags: [code-review, session, race]
dependencies: []
---
# Staleness guard omits group identity; loadGroups bypasses the generation bump

## Problem Statement
The plan required dropping any response whose `{generation, groupId}` no longer matches. The implementation compares generation only, and only `selectGroup` bumps it — but `loadGroups` also changes the active group (`setGroupId(next)`, reachable from league create/join and lobby refresh) with no bump. An in-flight snapshot for league A can then land under league B's identity until the trailing rerun corrects it.

## Findings
- architecture-strategist R1, kieran-typescript-reviewer M1.

## Proposed Solutions
1. Capture the target `id` with the generation and compare both when the response lands. (Small — recommended)
2. Bump the generation inside `loadGroups` when `next !== groupId`. (Small, easy to forget at a future third site)

## Acceptance Criteria
- [ ] A snapshot response for a superseded group is dropped, not rendered
