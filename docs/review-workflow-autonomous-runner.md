# Autonomous Workflow Runner

`codemoot workflow run --plan <plan.md> [--background]` drives a complete review-gated
workflow — refine, per-batch plan review, implementation, commit, bounded code reviews and
corrections, reviewer-attested verification, single final audit, gate, push — with no human
command between ordinary phases. It is a targeted extension: every phase calls the EXISTING
coordinators, so all identity, session-continuity, receipt-idempotency, and merge-gate
guarantees apply unchanged. **CodeMoot never merges.**

## Pre-flight: check the contracts before spending a run
```bash
codemoot workflow preflight
```
One real model call, judged by the real parser, in about a minute. It builds the SAME
instruction the workflow builds — from the same zod schema — sends it once, and hands the
answer to the SAME parser that would reject it mid-run. No workflow, no outline, no branch,
no database, no state. Exit code is non-zero on failure, so it chains:

```bash
codemoot workflow preflight && codemoot workflow run --plan <plan.md> --background
```

`--contract <kind>` selects one (default `BATCH_PLAN_RESULT`, the one that fails most) or
`all` to check every contract an agent is asked to produce. A rejected response is written to
`.cowork/preflight/<KIND>.rejected.txt` — the point is to see what the model actually
produced, not just that it was refused. `--timeout` defaults to 900s, deliberately shorter
than `cliAdapter.timeout`: a gate must fail fast.

This exists because four contract-shape defects — a wrong `contractKind`, missing top-level
fields, undescribed nested shapes, and an undescribed discriminated union — were each
discovered only *after* a successful 13-43 minute invocation costing $2-5. Every one of them
would have surfaced here in about a minute.

What it does **not** prove: prompt parity beyond the instruction block (real prompts also
carry the plan and repository audit), cross-batch rules that only exist across several
documents, and reliability — one valid document is not proof the next one is valid.

## Branch lifecycle
A clean worktree is required. The base branch and immutable base SHA are recorded, work
happens on `codemoot/<plan-slug>-<short-id>` for the whole workflow, the active branch is
verified before every phase, pushes happen only after each batch's gate passes, and remote
HEAD is verified after every push and at completion. No merge, rebase, reset, clean, stash,
force-push, or branch deletion — ever.

## Plan-as-is: skip refinement and plan review entirely

`--plan-as-is` (or `reviewGated.planAsIs: true`) uses the supplied plan **verbatim**: no
model rewrites it into batch plans, and no plan-review gate runs. Batches come from the
plan's own `Batch N` headings (siblings of the first such heading; deeper ones are that
batch's content), each batch is opened by an explicit operator-authority
`ACCEPT_PLAN_AS_IS` transition instead of a reviewer approval, and everything from
implementation onward is unchanged. Use it when the plan was already authored and reviewed
outside the workflow.

Two things to know before driving it:

- **Verification runs the plan's own commands** — fenced ` ```sh ` blocks under any
  "Verification" heading, one per line, executed as written via `sh -c` (plan-wide before
  the first batch heading, or scoped inside a batch). A batch that declares none falls back
  to a minimal worktree check and says so with a logged WARNING, because that check proves
  nothing about correctness. Put your real checks in the plan.
- **The mode engages or the run refuses.** If plan-as-is cannot be recorded in both the
  configuration snapshot and the frozen runner state — a stale `@codemoot/core` build, for
  instance — `workflow run` fails with a named error rather than silently falling back to
  the rewrite. The mode is frozen at start like the limits, so config edits and dropped
  flags never flip a running workflow.

The rest of this section describes the DEFAULT (refined) path.

## Plan refinement is per batch
Refinement issues ONE invocation per batch, never a single response carrying the whole plan:

1. **Outline** — the refined plan content, requirement coverage, and each batch's id,
   ordinal, and objective. Small by construction; no batch bodies.
2. **One invocation per batch** — the complete batch plan, **persisted the moment it
   completes** (`review_workflow_refinement_drafts`).

A failure at batch N preserves batches 1..N-1 and the next run resumes at N. This exists
because a single-response refinement of a ten-batch plan exceeded the model's output
ceiling after 43 minutes and produced nothing: batch 1 was lost because batch 9 made the
answer too long, and there was nothing to resume from because nothing had been stored.
Every other phase — implementation, review, verification — was already per batch.

## Limits and stop reasons
All limits live under `reviewGated.autonomous` (finite, schema-validated; defaults: 3
code-review rounds, 2 correction passes) and are FROZEN into the runner state at workflow
start — editing configuration between workers never changes enforcement. Review and
correction limits can never exceed the immutable coordinator pacing contract in the
workflow's configuration snapshot; the effective limit is the minimum of the two plus any
explicit human grants. `FIX_AGAIN` is always available: consuming it resumes a blocked batch
through the kernel (`RESUME_BATCH` with a recorded grant) and extends the contract by
exactly one round and one correction pass — nothing extends silently. A finite cost budget
(`maxCostUsdPerWorkflow`) is enforced from the audited cost, and failed invocations are
audited and budget-counted too. On any limit, blocker, continuity failure, or push failure the runner stops with a
stable machine-readable reason (`PLAN_REVIEW_LIMIT_REACHED`, `CODE_REVIEW_LIMIT_REACHED`,
`CORRECTION_LIMIT_REACHED`, `VERIFICATION_LIMIT_REACHED`, `INVOCATION_LIMIT_REACHED`,
`BATCH/WORKFLOW_RUNTIME_LIMIT_REACHED`, `NO_PROGRESS_LIMIT_REACHED`, `TOKEN_BUDGET_REACHED`,
`SESSION_CONTINUITY_FAILURE`, `PUSH_FAILED`, `WORKER_HEARTBEAT_EXPIRED`,
`HUMAN_DECISION_REQUIRED`, …), persists a checkpoint summary, notifies the owner exactly
once, and preserves the branch and worktree. Limits never reset or extend silently; the batch
count is frozen at refinement and agents cannot add batches. Invocation and token budgets are
enforced from the immutable invocation audit, not from agent self-reporting.

Human decisions (`codemoot workflow decide <wf> --action fix_again|accept_risk|cancel
--rationale "..." [--findings a,b]`) are recorded immutably with actor, finding IDs,
rationale, commit SHA, and timestamp; `accept_risk` overrides are SHA-bound.

## Pause, interruption, and resumption
`codemoot workflow pause <id>` (or the worker's first interrupt signal) requests a graceful
pause: the durable status becomes `PAUSE_REQUESTED`, no new action is scheduled, the current
atomic action finishes and persists its receipt, logs, response, and resulting state, and
the workflow settles to `PAUSED_BY_USER` — branch, worktree, sessions, jobs, events, and
every counter stay exactly as they were. A second interrupt is a hard kill.
`codemoot workflow resume <id> [--background]` verifies the repository and workflow branch,
reconciles receipts, sessions, heartbeats, and pacing from durable state, and continues
automatically from the next unfinished authorised action, reusing the existing batch role
sessions. Pacing, review, correction, token, runtime, and invocation budgets never reset.
`workflow run --plan` ALWAYS creates a new workflow and refuses an existing ID outright.

On restart after a crash: SUCCEEDED actions replay their persisted results, RESERVED
actions that never started begin safely, RUNNING actions with a completed receipt settle
from it, and an agent invocation whose external outcome is unknown stops the workflow with
`OUTCOME_UNKNOWN` — it is NEVER automatically repeated; a human verifies the outcome and
continues with `workflow decide`. Success is never inferred from files alone.

## Monitoring
`workflow watch` streams durable heartbeats (each carrying worker, batch, phase, current
HEAD, and the persisted ACTIVE invocation identity) (generated by CodeMoot on a timer — no LLM, no
tokens) and checkpoints; a running workflow whose heartbeat ages past
`heartbeatExpirySeconds` is reported `STALLED (WORKER_HEARTBEAT_EXPIRED)` and is never
blindly re-invoked. `workflow status` distinguishes `PAUSING`, `PAUSED_BY_USER`,
`RESUMING`, `STALLED`, and `OUTCOME_UNKNOWN` observed states. `workflow status`, `workflow events --tail`, `workflow logs
[--batch|--phase|--invocation]` (full immutable prompt/response audit with hashes, session
outcome, tokens, timing — secrets redacted with hash markers), and `workflow export
--output <file>` complete the surface.

## Completion
After the last batch the runner verifies local/remote HEAD parity and transitions to
`READY_FOR_HUMAN_VERIFICATION`, printing branch, base/final/remote SHAs, batch and round
usage, deferred findings, risk overrides, token totals, the audit-export command, and a
recommended PR title/summary. Verification and merging remain human work.

## Recovery and exclusivity
Exactly one live worker may run a workflow: `run`/`run-resume` acquire an exclusive lease
(renewed by every heartbeat) and a second worker is refused until the lease expires. A
restarted worker re-enters each batch at the stage the persisted DOMAIN state proves —
completed plan reviews, implementations, verifications, and final audits are never re-run.
`workflow status` and `watch` persist `WORKER_HEARTBEAT_EXPIRED` (and notify once) when both
the heartbeat and the lease have expired.

## Honesty guarantees
- Plan revisions are real: a NEEDS_REVISION plan review triggers an implementer-authored
  `PLAN_REVISION_RESULT` (complete revised plan + one response per open finding), persisted
  as a new immutable plan version through the kernel's `SUBMIT_REVISED_PLAN` command.
- Corrections are honest: the implementer receives the complete persisted findings
  (description, files, expected/observed, required action, evidence) and must author its own
  `DISPOSITION_RESULT`; nothing is synthesized, and the capture rejects missing or extra
  findings.
- Human decisions are validated AND applied to the domain: one pending decision at a time,
  `accept_risk` may name only the recorded unresolved blocking set, decisions are SHA-bound
  and invalidated if HEAD moves, and the deciding human is persisted as a `WORKFLOW_OWNER`
  execution. Consumption issues the real kernel transitions: `RESUME_BATCH` unblocks the
  batch, and `ACCEPT_FINDINGS_RISK` (a HUMAN-only, SHA-bound kernel command) moves it to
  VERIFYING; the merge gate excludes exactly those risk-accepted findings and nothing else.
- Forbidden git operations are blocked at the execution boundary: agent subprocesses run
  with a PATH-first, DENY-BY-DEFAULT git guard — it parses git's global options (including
  `-C`/`-c` prefixes) to find the real subcommand and permits only a read/commit allowlist
  (status, diff, log, show, add, commit, rev-parse, ls-files, grep, blame, describe,
  cat-file, shortlog, count-objects, version, help, mv). Agent subprocesses additionally run
  credential-less: no global/system git config, no terminal prompts, no askpass, and SSH
  itself disabled (`GIT_SSH_COMMAND=false`), so authenticated pushes fail even through an
  absolute git binary. Pushes to origin are also blocked at the git-config level
  (`remote.origin.pushurl` sentinel — the user's original push URL is preserved and restored
  by the same try/finally that owns the worker, on every exit path); only the gated PUSH
  phase lifts it. Every phase also runs inside pre/post repository invariants: active
  branch, untouched base branch, unchanged remote outside PUSH.
  OWNER-ACCEPTED LIMITATION (explicitly accepted by the workflow owner, 2026-07-31, as an
  amendment to the original branch-safety requirement): an agent with arbitrary shell
  access can still write to a credential-free LOCAL file remote or mutate `.git` internals
  through an absolute git binary; preventing that final tail requires OS-level sandboxing
  outside CodeMoot's process boundary. The pre/post invariants detect and stop on any such
  damage before further phases or pushes.
- Completion runs workflow-level verification and a final audit: every batch's verification
  commands are re-executed at the FINAL HEAD, every batch must be gate-approved with its
  approval SHA in the final history (the final batch's approval still effective), no
  unresolved blockers may remain beyond SHA-bound accepted risk, and audit coverage must be
  complete — all before `READY_FOR_HUMAN_VERIFICATION`.

## Known limitations
- Verification acceptance is reviewer-judged (a dedicated resumed reviewer assessment
  invocation attests with `REVIEWER` mode); it is bounded by
  `maxVerificationAttemptsPerCommand` and by the deny-by-default attestation policy.
- Adapter stderr reaches the audit through the invocation-layer capture (capped and
  secret-redacted); out-of-band probe failures surface in the structured failure details
  instead.
