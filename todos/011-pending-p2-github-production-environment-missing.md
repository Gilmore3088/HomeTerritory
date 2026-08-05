---
status: pending
priority: p2
issue_id: 011
tags: [code-review]
dependencies: []
---
# github production environment missing

## Problem Statement
deploy-supabase.yml declares environment: production and comments that required reviewers gate prod, but the repo has zero environments configured — GitHub auto-creates it unprotected and repo-level secrets resolve anyway, so a merge deploys unattended while the comment claims otherwise (security-sentinel M1). Owner action: create the environment with reviewers and move secrets into it; also assert verify_jwt's VALUE in CI, not just the block's presence (L4).

## Acceptance Criteria
- [ ] Addressed and verified by the existing suite
