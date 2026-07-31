# Mandatory Role-Session Continuity

Each review-gated batch holds **exactly one active vendor session per role** (IMPLEMENTER,
REVIEWER), persisted in `review_workflow_batch_role_sessions` (one row per batch+role; a
vendor session can never serve two bindings — the UNIQUE constraint enforces cross-role and
cross-batch isolation). The registry — never the caller — decides between creating the role
session and resuming it:

- The **first** bound invocation for a role creates the vendor session and persists its ID.
- **Every later** bound invocation in the same batch must resume that exact vendor session:
  the correction pass resumes the initial implementation session; the bounded final review
  and the final audit resume the initial reviewer session.
- A **new batch** always starts new implementer and reviewer sessions.

Bound operations: implementation start/resume/execute (IMPLEMENTER); plan review, code-review
rounds, and the final audit (REVIEWER). Plan review is the batch's first reviewer contact and
creates the one reviewer role session; plan-revision rounds, the code review, and the final
audit all resume it. Only workflow-level plan refinement (which precedes batches) is outside
the batch role-session mandate.

## Fail-closed enforcement (`RoleInvocationService`)

When a binding exists, the adapter receives the exact persisted vendor session ID under
`strictResume` (fallback to a fresh session is forbidden at the adapter layer too). Failures
are stable, machine-readable, and stop the workflow — the coordinator blocks the batch with
reason `SESSION_CONTINUITY_FAILURE:<code>` so only a human decision can move it forward:

| Code | Meaning |
| --- | --- |
| `ROLE_SESSION_MISSING` | The operation requires a prior role session and none is persisted |
| `SESSION_RESUME_UNSUPPORTED` | The adapter cannot resume sessions (checked before invoking) |
| `SESSION_RESUME_FAILED` | The vendor rejected/expired the resume (no fallback attempted) |
| `SESSION_IDENTITY_MISMATCH` | The returned vendor session ID differs from the persisted one, or the vendor session is already bound to another batch |
| `SESSION_RESUME_REQUIRED` | The adapter answered without proving the resume |
| `CROSS_ROLE_SESSION_REUSE` | Implementer and reviewer may never share a vendor session |

## Continuity evidence

Every bound invocation attempt — including failures — appends one row to
`review_workflow_session_continuity`: workflow ID, batch ID, role, invocation ID, adapter
kind, requested resume session ID, returned session ID, and the outcome
(`CREATED` / `RESUMED` / `FAILED` with the error code). Command replay returns stored
results without invoking or resuming again.

## Adapter proof of continuity

- **Codex** (`codex exec resume <thread-id> - --json`): the CLI echoes the thread ID in its
  JSONL output, so continuity is provable; `resumedFromSessionId` is only claimed when the
  returned thread equals the requested one. Under `strictResume` a failed resume throws
  instead of silently falling back to a fresh exec.
- **Claude** (`claude … --resume <session-id>`): the returned `session_id` is compared to the
  requested one; `resumedFromSessionId` is only claimed on an exact echo. A `--resume` run
  that returns a different session ID (a fork) is treated as **unproven continuity** and
  fails closed with `SESSION_IDENTITY_MISMATCH` — CodeMoot never claims continuity the CLI
  cannot prove.
