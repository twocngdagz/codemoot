# Repository Instructions

Read and follow `AGENTS.md` for repository-wide development rules.

## Review-Gated Batch Workflow

For review-gated batches, invoke `/review-gated-batch` and follow
`docs/workflow/review-gated-protocol.md`. The controller-owned
`.cowork/workflow-state.json` is authoritative; chat and memory are supporting context only.
Return one complete review artefact—never incremental findings. Initial review, correction,
and final re-review are limited to one pass each. CRITICAL/HIGH findings block; MEDIUM/LOW/
SUGGESTION findings are deferred, and final re-review may not introduce optional findings.
Perform only the action authorised by state, stop afterward, and never start another batch
without a controller transition. Only the controller decides commit, push, closure, or
advancement.
