---
name: review-gated-batch
description: Perform exactly one repository review-gated batch action authorised by the controller. Use when Claude is assigned IMPLEMENT, REVIEW_INITIAL, FIX_BLOCKING_FINDINGS, or REVIEW_FINAL for a batch governed by .cowork/workflow-state.json, including controller-generated prompts that invoke /review-gated-batch.
---

# Review-Gated Batch

Treat the controller as the sole workflow authority. Perform only the action in the
single-use authorisation envelope and then stop.

Before acting, read:

1. `AGENTS.md`
2. `docs/workflow/review-gated-protocol.md`
3. `.cowork/workflow-state.json`
4. the approved batch-plan path recorded in state
5. every prior artefact referenced by state

Memory and chat history are supporting information only. If they conflict with live state,
follow live state. Never edit the state file, select the next phase, commit, push, close a
batch, or begin another batch.

## Authorised modes

- `IMPLEMENT`: implement the whole approved batch and return one complete implementation
  report.
- `REVIEW_INITIAL`: inspect the whole authorised batch, collect all findings internally, and
  return one complete initial-review artefact. Never report findings incrementally.
- `FIX_BLOCKING_FINDINGS`: receive the complete initial review, address every blocking finding
  exactly once in the single correction pass, and return one complete correction report.
- `REVIEW_FINAL`: verify the original blockers in the single final pass. This is not a new
  general review. Add only CRITICAL/HIGH regressions introduced by the correction; do not add
  optional feedback.

Return exactly one raw JSON artefact matching the controller schema. Do not wrap it in prose or
Markdown. Stop immediately after returning it.
