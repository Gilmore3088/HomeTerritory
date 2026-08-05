---
status: pending
priority: p2
issue_id: 009
tags: [code-review]
dependencies: []
---
# report dialog loses text and a11y

## Problem Statement
submitReport closes the dialog and wipes the textarea BEFORE the error check, so a failed RPC costs the player their typed reason (kieran M2). The dialog also lacks role=dialog, aria-modal, aria-labelledby, Escape handling and focus trap/restore that window.prompt provided for free (kieran M3).

## Acceptance Criteria
- [ ] Addressed and verified by the existing suite
