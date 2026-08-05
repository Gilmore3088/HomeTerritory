---
status: pending
priority: p1
issue_id: 003
tags: [code-review, security]
dependencies: []
---
# CORS allowlist trusts a claimable *.vercel.app namespace and fails open to localhost

## Problem Statement
`supabase/functions/test-signup/index.ts`: `PREVIEW_ORIGIN` allows `https://hometerritory-<anything>.vercel.app`. Vercel subdomains are first-come-first-served, so anyone can deploy `hometerritory-evil` and hold an allowlisted origin — reinstating the crowdsourced-browser vector the allowlist was added to stop. The regex is also tested unconditionally, so setting `ALLOWED_ORIGINS` in prod does not disable it, and an unset `ALLOWED_ORIGINS` silently allows localhost in production.

## Findings
- security-sentinel M2 + L1.

## Proposed Solutions
1. Gate the preview regex behind an env flag prod does not set; require explicit `ALLOWED_ORIGINS` in prod and refuse Origin-bearing requests when it is empty and the URL is not local. (Small — recommended)
2. Drop preview support entirely; explicit list only. (Smallest, loses preview testing)

## Acceptance Criteria
- [ ] Production with ALLOWED_ORIGINS set rejects any hometerritory-*.vercel.app not in the list
- [ ] Production with ALLOWED_ORIGINS unset rejects all cross-origin requests (no localhost default)
