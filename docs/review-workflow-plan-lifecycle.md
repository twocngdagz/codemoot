# Review Workflow Plan Lifecycle

Batch 10 adds the repository-aware planning boundary for review-gated workflows. It does not
implement an approved batch or review implementation code.

## Command flow

Run the commands from the repository being planned:

```bash
codemoot workflow start --plan ./product-plan.md
codemoot workflow refine <workflow-id>
codemoot workflow status <workflow-id>
codemoot batch list <workflow-id>
codemoot batch show <workflow-id> <ordinal>
codemoot batch review-plan <workflow-id> <ordinal>
```

`workflow start` imports the external Markdown plan, assigns stable requirement IDs, resolves the
configured implementer and reviewer roles, and captures Git HEAD, branch, and porcelain status
from a fresh repository read. The command fails if the worktree or index is dirty. The imported
plan and audit are immutable evidence.

`workflow refine` invokes only the assigned implementer bridge with `PLAN_REFINER` authority. The
response must be a whole-string, strict `REFINEMENT_RESULT` JSON object. It must include every
materialized batch plan and acceptance criterion, cover every imported requirement, use
sequential authoritative batch IDs, and depend only on earlier batches. A malformed or
incomplete response is retained as a rejected handoff and creates no batch.

`batch review-plan` invokes only the independently assigned reviewer. Its strict `REVIEW_RESULT`
must echo the persisted plan ID, content hash, and repository-context SHA. CodeMoot persists the
complete finding list, computes the blocking count from the configured severities, and asks the
Batch 1 kernel to approve or reject the plan. The model cannot choose a different target or
override the configured blocking policy.

## Persistence and identity

Plan intake is atomic: the workflow, two immutable assignments, owner execution, general plan,
requirements, and repository audit either all persist or none do.

Refinement binds the external invocation to the first `CREATE_BATCH` command receipt. Process
evidence is prepared first so the receipt names the actual execution; the receipt is then
reserved before the invocation, session, and execution rows are persisted. Batch creation is
kernel-derived. Materialized plans and criteria are captured with the raw refinement transcript,
and the workflow's current refined-plan pointer is updated in the same SQLite transaction.

Plan review similarly binds the reviewer invocation to `START_PLAN_REVIEW`, captures the
structured review against the current persisted plan, and then records either `APPROVE_PLAN` or
`REJECT_PLAN`. Implementer and reviewer assignments must differ, reviewer session evidence is
bound when available, and the configured minimum identity assurance is enforced by the kernel.

## Boundaries

- External plans are read, never rewritten in place.
- Git access is read-only.
- Model prose, Markdown fences, trailing text, unknown JSON fields, stale targets, forward
  dependencies, incomplete requirement coverage, and policy-inconsistent verdicts fail closed.
- Batch implementation, code review, verification execution, merge approval, jobs, MCP tools,
  and autonomous multi-batch coordination belong to later batches.
