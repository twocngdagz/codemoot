# Review-Workflow Command Idempotency

Every review-workflow state-changing command must be reserved in SQLite before any
agent invocation or verification execution begins.

## Durable records

`review_workflow_command_receipts` stores the command ID, canonical request hash,
expected aggregate version, target commit SHA, requester identity, exercised authority,
status, and eventual result.

Commands that require an external side effect also receive a
`review_workflow_command_side_effects` row:

```text
NOT_STARTED → STARTING → OUTCOME_RECORDED
```

Only the first atomic claim may move a row from `NOT_STARTED` to `STARTING`. A row never
returns to `NOT_STARTED`, so a retry cannot intentionally invoke the same agent or
verification command twice.

## Replay and conflict rules

- The same command ID and identical validated request replay the stored receipt/result.
- Reusing a command ID with a different request hash, actor, target SHA, command, or
  side-effect kind fails with `IDEMPOTENCY_CONFLICT`.
- A command reserved against a stale aggregate version fails with
  `AGGREGATE_VERSION_CONFLICT`.
- Before an aggregate write, the store re-derives the transition from the stored
  request, requester, current batch state, and blocked context. A caller-supplied
  transition that differs from the domain kernel result fails with
  `COMMAND_STATE_CONFLICT`.
- Batch snapshot updates, event appends, and successful receipt completion occur in one
  SQLite transaction.
- A timed-out or unknown started side effect is not rerun. It must be reconciled or
  deliberately replaced by a new command ID.

## Interruption behaviour

| Interruption point | Retry behaviour |
| --- | --- |
| Before reservation commits | Query/reserve the same command ID |
| After reservation, before claim | Resume from durable `NOT_STARTED` |
| After claim starts | Do not invoke again; record `OUTCOME_UNKNOWN` if necessary |
| After aggregate transaction commits | Replay the stored successful result |
| After timeout | Replay the timeout; use a new command only after reconciliation |

This contract provides at-most-once CodeMoot invocation for a command ID. It does not
claim that an external CLI cannot perform its own internal retries.

Batch 2 implements persistence and reservation only. It does not invoke subprocesses,
agents, verification commands, Git, or workflow CLI handlers.
