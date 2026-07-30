# Review Workflow MCP Tools

Batch 14 adds four **additive** MCP tools exposing stable workflow operations
programmatically. The original five tools (`codemoot_review`, `codemoot_plan`,
`codemoot_debate`, `codemoot_memory`, `codemoot_cost`) are unchanged — their schemas are
pinned by a stability test — and rollback is removing the additive tools only.

Every state-changing action calls the **same shared coordinator services** the CLI uses
(`ReviewWorkflowGateService`, `ReviewWorkflowJobService`) with an explicit command ID and an
optional expected batch aggregate version, so programmatic callers get exactly the CLI's
identity, idempotency, and replay guarantees: a same-ID retry replays the durable receipt,
identity mismatches fail with `COMMAND_REPLAY_MISMATCH`, and version pins are enforced at
reservation. The workflow tool runtime is built lazily per call, so the MCP server still
starts cleanly outside a Git repository.

## Tools

- **`codemoot_workflow_status`** `{ workflowId }` — workflow plus per-batch persisted state,
  derived effective approval state (`effectiveState`, `approvalValid`, `approvedCommitSha`),
  and code-review round count. Read-only.
- **`codemoot_workflow_events`** `{ workflowId, after?, limit?, cursorId?, acknowledge? }` —
  incremental event reads by event ID; a named durable cursor resumes from its last position
  and `acknowledge: true` advances it past the returned events (schema-rejected without a
  cursor). Cursors are monotonic and workflow-bound.
- **`codemoot_workflow_gate`** `{ action, workflowId, ordinal, commandId, expectedVersion?,
  mergeCommitSha?, recorderActorType? }` — `evaluate` runs the full merge gate, `reconcile_stale`
  persists `APPROVAL_STALE`, and `mark_merged` records an external merge (SHA must exist and
  contain the approval; CodeMoot never executes merges). `commandId` is **required** by the
  schema; `mergeCommitSha` is schema-validated against the domain Git-SHA vocabulary
  (40- or 64-hex, case-insensitive). The merge recorder identity is
  derived from the command ID and persisted by the coordinator at reservation, defaulting to a
  `CI` actor for programmatic callers.
- **`codemoot_workflow_jobs`** `{ action, … }` — `enqueue` creates a background job for
  `verification` (requires the plan command index), `final_audit`, or `code_review` with the
  **same derived stable command IDs and worker-compatible payloads as the CLI's
  `--background`**, so an MCP-enqueued job is indistinguishable from a CLI-enqueued one and is
  processed by the same `workflow jobs run` worker under receipt-bound replay safety;
  `list`/`show`/`cancel` mirror the CLI job commands. Returns `{ jobId, commandId }` on
  enqueue.

## Input validation

Tool inputs are validated by strict zod schemas in `@codemoot/core`
(`workflowStatusInputSchema`, `workflowEventsInputSchema`, `workflowGateInputSchema`,
`workflowJobsInputSchema`) — discriminated by action and job type, rejecting unknown keys,
missing command IDs, malformed SHAs, and acknowledge-without-cursor before any service is
touched. The **advertised JSON Schemas are faithful mirrors** of that validation: per-branch
`oneOf` with exact required lists, bounds, conditional requirements (`if`/`then` for
acknowledge-without-cursor), the domain Git-SHA vocabulary (40- or 64-hex, case-insensitive),
and `additionalProperties: false` throughout — a dual-representation test asserts zod and the
advertised schema agree on a full accept/reject matrix.

`code_review` enqueue accepts **no** `expectedVersion`: the code-review coordinator derives
its reservation version itself, so a caller-supplied pin would be silently ignored — both
representations reject the field instead. Verification and final-audit jobs carry the pin
through to reservation.

## Errors

Workflow tools return a stable structured error shape,
`{ "error": { "code", "name", "message" } }` with `isError: true`: typed coordinator errors
expose their domain code (`COMMAND_REPLAY_MISMATCH`, `INVALID_STATE`, `JOB_NOT_FOUND`, …) and
schema rejections map to `INVALID_INPUT` with the zod issue list. The original five tools keep
their existing unstructured error behavior.

## Out of scope

Agent-invoking operations are never executed inside the MCP server process: long-running
implementer/reviewer work is enqueued as background jobs and executed by the CLI worker.
Existing tool schemas are untouched.
