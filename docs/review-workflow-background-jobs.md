# Review Workflow Background Jobs and Event Cursors

Batch 13 adds asynchronous execution **without weakening idempotency**: a background job is a
durable request to run one workflow operation, and the operation's durable command receipt —
not the job row — is the single source of truth for its outcome. The synchronous workflow
remains fully usable; background execution is opt-in per command.

## Module

`packages/core/src/review-workflow-jobs/` (root namespace `reviewWorkflowJobs`):

- `ReviewWorkflowJobStore` — the `review_workflow_jobs` queue (lease-based claims, optimistic
  status updates) and `review_workflow_event_cursors` (durable consumer positions), plus the
  workflow-scoped incremental event reader.
- `ReviewWorkflowJobService` — `enqueue`, `runNext`, `cancel`.

## Original command-ID propagation and expected receipt identity

A job is bound at enqueue time to its operation's command ID (`UNIQUE` per job) **and** to the
receipt identity that operation is expected to produce. That identity is **derived internally
from the job type** (`deriveExpectedReceipt`) — never caller-supplied: every operation claims
a deterministic side-effect identity derived from its command ID (`<commandId>:record` for
verification, `<commandId>:code-review-invocation` for code review, whose claimed invocation
identity the CLI derives, and `<commandId>:final-audit-invocation`, which the gate service
claims directly), so the three job types are durably distinguishable even when a command ID
collides. Settlement validates the loaded receipt against the job's workflow, batch, and
derived identity: a receipt that belongs to a different workflow, batch, or operation —
including another job type's — is a terminal `RECEIPT_MISMATCH` failure, never a settlement
source. The worker additionally validates that the payload's ordinal resolves to the job's
authoritative batch **before** any invocation.

## Receipt-first, receipt-last worker semantics

`runNext` claims the oldest runnable job (QUEUED, or RUNNING with an expired lease — a
crashed worker) and consults the command receipt **before** executing; after the executor
returns or throws, the job settles **exclusively from the receipt the operation produced** —
an executor's return value never decides success:

| Receipt state (before or after execution) | Worker behavior |
| --- | --- |
| absent before execution | The operation never started — execute it with the job's command ID |
| absent after a normal executor return | `RECEIPT_MISSING` — the job **fails**; success cannot be derived without a receipt |
| absent after an executor throw | Retry (job returns to QUEUED) while attempts remain, else FAILED |
| mismatched identity | `RECEIPT_MISMATCH` — terminal failure, the command ID was consumed by a different operation |
| `SUCCEEDED` | Settle successfully with the recorded result (even if the executor threw afterwards); pre-existing receipts replay with **no executor call** |
| `FAILED_FINAL` / `TIMED_OUT` / `RECONCILED` | The recorded outcome is final — job FAILED with the recorded error (a service that records a rejection and returns normally is reported as the failure it is) |
| `RESERVED` / `RUNNING` | A worker died after reserving the side effect: the receipt is marked `OUTCOME_UNKNOWN` and the job fails for human reconciliation — the agent/verification invocation is **never repeated** |

Attempts are bounded by `max_attempts`; claims are leased so a lost worker's job becomes
claimable again after the lease expires, while its late `succeed`/`fail` writes are ignored by
the optimistic status guards (this also makes cancellation of a RUNNING job safe). An expired
job whose attempts are already exhausted is **still claimable for receipt-only settlement** —
it settles from whatever the receipt records (or fails `ATTEMPTS_EXHAUSTED` if none exists)
without ever re-invoking, so no crash can strand a job in RUNNING. A claim with no registered
executor is returned to QUEUED **without consuming an execution attempt** (the claim never
reached the operation), so even a `maxAttempts: 1` job becomes executable the moment an
executor is registered.

## CLI

- `batch verify | final-audit | review-code … --background` enqueues the operation and prints
  `{ status: 'QUEUED', jobId, commandId }` — job and command IDs, per the plan's acceptance
  criterion. Payloads are plain JSON validated strictly on the way back in.
- `workflow jobs run [--worker <id>] [--max-jobs <n>] [--lease <seconds>]` claims and
  processes queued jobs with the receipt-first semantics above.
- `workflow jobs list <workflow-id>` / `jobs show <job-id>` / `jobs cancel <job-id>`.

## Workflow event cursors

`review_workflow_events` rows carry a monotonically increasing `event_id`;
`listWorkflowEvents(workflowId, afterEventId, limit)` reads a workflow's events incrementally
across all of its batches. `workflow events <workflow-id>` exposes this read:

- `--after <event-id>` for stateless incremental reads;
- `--cursor <id>` for a durable named consumer position (created on first acknowledge), with
  `--ack` advancing it past the returned events. Cursors are monotonic (never move backwards)
  and bound to one workflow (`CURSOR_CONFLICT` otherwise).

## Out of scope

MCP exposure (Batch 14). The legacy `jobs` table used by `codemoot build` is untouched —
review-workflow jobs live in their own strictly validated tables.
