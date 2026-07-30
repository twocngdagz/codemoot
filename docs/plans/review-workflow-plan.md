# CodeMoot Review-Gated Workflow — Revised Implementation Plan

This is the authoritative plan for the review-gated workflow implementation. Batches 1–10
are landed; this document governs Batches 11–15. Supplied by the workflow owner on
2026-07-30; committed to the repository so every batch review can cite its acceptance
criteria directly.

# 1. Executive recommendation

Preserve the previous architecture: add a deep `review-workflow` module to `@codemoot/core`,
backed by guarded SQLite state, immutable records, and append-only events. Do not enlarge the
shallow legacy `build` state strings or turn the existing YAML loader into a long-lived
repository workflow engine.

The revised workflow adds four essential refinements:

- File implementation and commit creation are separate. `AWAITING_COMMIT` makes the pause
  explicit, and agent commit permission is never assumed.
- Configured role assignment and actual execution identity are separate records.
- Every state-changing command is idempotent before an agent, verification command, or other
  side effect can run.
- Verification records facts; a separate attestation decides whether those facts satisfy an
  acceptance criterion.

The new path remains additive:

- Existing `review`, `fix`, `plan`, `run`, `build`, sessions, jobs, MCP tools, and SQLite data
  remain compatible.
- Debate remains an optional independent feature.
- Legacy `build` is deprecated only after the new path reaches feature parity.
- Human or protected CI retains merge authority.

# 2. Architectural decisions (D1–D12)

- **D1 — Add a dedicated review-workflow module.** `packages/core/src/review-workflow/`,
  narrow interface: commands, state, evidence, results.
- **D2 — Make commit ownership explicit.** `AWAITING_COMMIT` plus immutable
  `ImplementationCommit`. Default `human_required`; `agent_authorized`/`either` only via
  configuration.
- **D3 — Separate assignment from execution identity.** `AgentAssignment`,
  `ActorExecutionIdentity`, `InvocationIdentity`, `SessionIdentity` independent; enforce what
  can be proven and expose assurance limits.
- **D4 — Reserve commands before side effects.** Durable `CommandReceipt` before any agent or
  verification invocation; at-most-once per command ID.
- **D5 — Snapshot rows plus append-only events.** Optimistic `expectedAggregateVersion`.
- **D6 — Additive relational persistence.** Normalized identities/commands/reviews/findings/
  evidence/attestations; immutable plan documents as validated JSON plus hashes.
- **D7 — Git evidence authoritative.** `GitRepository` seam with exact
  base/current/previous-reviewed/HEAD semantics. Never auto-stash or assume commit permission.
- **D8 — One finding lifecycle for plan and code review.** `reviewKind` PLAN/CODE/FINAL_AUDIT;
  shared dispositions with discriminated result targets (plan hash vs commit SHA).
- **D9 — Separate verification from attestation.** Gate only on accepted attestations.
- **D10 — Compare baseline finding sets, not totals.** Normalized fingerprints, multiset
  difference; any introduced fingerprint fails even at equal totals.
- **D11 — Split adapter work into three batches** (identity/config, Claude adapter,
  registry/role integration).
- **D12 — Retain debate; deprecate build later.** The new module never invokes debate.

# 3. Domain model summary

## Identity and authority

`AgentAssignment` (configured expectation, snapshotted at workflow start),
`ActorExecutionIdentity` (actor attributed to a command/evidence/verdict),
`InvocationIdentity` (one actual process invocation; secrets never persisted),
`SessionIdentity` (vendor session continuity; same vendor session never serves both roles).

Identity assurance levels: `AUTHENTICATED_SUBJECT` > `CLI_ASSERTED` > `PROCESS_ATTESTED` >
`CONFIG_ONLY`. Different aliases alone never satisfy the self-review rule; the hard guard
requires different assignment IDs, agent keys, adapter kinds, invocation identities, and no
shared vendor session. Where authenticated account identity is unavailable, status must
disclose that independent accounts cannot be proven.

Authorities (independent of actor type): `WORKFLOW_OWNER`, `PLAN_REFINER`, `IMPLEMENTER`,
`COMMIT_CREATOR`, `REVIEWER`, `VERIFICATION_EXECUTOR`, `VERIFICATION_ATTESTOR`,
`MERGE_RECORDER`, `SYSTEM_RECONCILER`.

## Plans and plan review

`GeneralPlanVersion`, `PlanRequirement`, `RepositoryAudit`, `RefinedPlanVersion`,
`BatchPlanVersion` (immutable sixteen-field document), `AcceptanceCriterion`. Plan review
targets one immutable plan version/hash; rejection requires structured findings; revision
creates a new immutable version with a disposition for every prior finding; approval records
exact version, hash, repository-context SHA, round, and reviewer identity. Plan disposition
targets carry `planVersionId`/`planContentHash`/`repositoryContextSha`; code disposition
targets carry `resultingCommitSha`.

## Implementation and commit ownership

`ImplementationAttempt` (approved plan version/hash, B0, starting HEAD, implementer identity,
worktree fingerprint) and `ImplementationCommit` (SHA, parents, tree, creator identity,
creation mode `AGENT_AUTHORIZED | HUMAN_CREATED`, author/committer metadata as evidence not
proof, worktree-clean and ancestry validation). Commit policies: `human_required` (default),
`agent_authorized`, `either`. `complete-implementation` validates: SHA resolves and equals
HEAD; worktree/index clean; B0 is ancestor; expected lineage; attempt linkage; policy allows
the creation mode; agent commits match the assigned implementer invocation; human commits have
human `COMMIT_CREATOR` attestation; no-change results rejected unless the plan permits them.

## Git SHA and diff model

`B0` original batch base; `P` previous reviewed implementation SHA (`B0` first round); `I`
current committed implementation SHA; `H` current branch HEAD. Canonical patches:
`git diff --binary --full-index --find-renames <from> <to> --` with stored exact arguments,
patch hash, log location, changed files. Ranges — initial: `B0..I1` (cumulative =
incremental); round n cumulative: `B0..In`; correction incremental: `I(n-1)..In` (reviewer
receives both); final gate: recompute `B0..H`, require `H = I`, require `I..H` empty, require
cumulative hash to equal latest accepted code-review hash. Ancestry (`merge-base
--is-ancestor`) must pass for `B0→I` and `P→I`.

## Findings, dispositions, verification, attestation, baselines

Finding statuses: `OPEN`, `RESPONSE_SUBMITTED`, `RESOLVED`, `BLOCKED`, `SUPERSEDED`.
Dispositions immutable; all kinds require reviewer acceptance; non-code dispositions never
auto-accepted. `VerificationRecord` = facts (never says a criterion passed);
`VerificationAttestation` = acceptance (`AUTOMATIC_POLICY | REVIEWER | HUMAN | CI`).
Automatic acceptance only for exact approved commands, exit zero, matching tool/config hashes,
current SHA, criterion opt-in, non-manual/browser, no judgment triggers. Reviewer/human
attestation mandatory for manual, browser, external, implementer-only, baseline,
nonzero-exit, ambiguous, and static-analysis evidence. Baselines: immutable, tool/version/
config/SHA-bound, normalized finding fingerprints (rule, path, normalized message, symbol/
context, severity/category, occurrence index — line numbers as evidence, not identity),
multiset comparison; introduced ≠ ∅ fails regardless of totals; reviewer must attest
trustworthiness, comparability, empty introduced set, and normalization correctness.

## Command idempotency

Every state-changing request: command ID, expected aggregate version, canonical request hash,
target SHA where applicable, requester identity, authority. `CommandReceipt` statuses:
`RESERVED`, `RUNNING`, `SUCCEEDED`, `FAILED_FINAL`, `TIMED_OUT`, `OUTCOME_UNKNOWN`,
`RECONCILED`. Reservation precedes side effects; side-effect rows move `NOT_STARTED →
STARTING → OUTCOME_RECORDED`, never backwards. Same ID + same hash replays; same ID +
different hash/actor/SHA conflicts; interrupted invocations reconcile, never silently re-run.

## Persisted versus effective state

`persistedState` is the SQLite state; `effectiveState` derives from repository evidence.
Stale approval (`APPROVED_FOR_MERGE` at SHA A, HEAD B) is immediately unusable; reconciliation
persists `APPROVAL_STALE`; once persisted, returning to the old SHA never restores approval.

# 4. State model

States: `DRAFT`, `PLAN_REVIEW`, `PLAN_NEEDS_REVISION`, `APPROVED_FOR_IMPLEMENTATION`,
`IMPLEMENTING`, `AWAITING_COMMIT`, `IMPLEMENTATION_COMPLETE`, `CODE_REVIEW`,
`NEEDS_REVISION`, `VERIFYING`, `APPROVED_FOR_MERGE`, `APPROVAL_STALE`, `MERGED`, `BLOCKED`,
`CANCELLED` (final two-plus-`MERGED` semantics: `MERGED`/`CANCELLED` terminal; `BLOCKED`
resumes only to a safe recorded prior state, never directly to approval).

Key guarded transitions: plan approval requires all prior dispositions accepted and no
blocking findings; `AWAITING_COMMIT → IMPLEMENTATION_COMPLETE` via
`complete-implementation --commit <sha>` under commit policy/SHA/ancestry/clean-tree/linkage
validation; `CODE_REVIEW → VERIFYING` requires cumulative and incremental review complete and
dispositions accepted; `VERIFYING → APPROVED_FOR_MERGE` via full gate; HEAD mismatch makes
approval effectively stale immediately, then persisted by reconciliation;
`APPROVED_FOR_MERGE → MERGED` via `mark-merged` with valid effective approval and verified
external merge SHA.

# 5. CLI surface (target)

`workflow start|status|audit|refine|final-audit`; `batch list|show|review-plan|revise-plan|
implement|implementation-ready|complete-implementation|review-code|findings|respond|
review-dispositions|verify|attest-verification|gate|mark-merged`. State-changing commands
accept `--command-id`, `--expected-version`, target SHA; `--json` yields a versioned envelope
(command ID, aggregate version, persisted/effective state, current HEAD, identity assurance,
next actions).

# 6. Batch definitions

Batches 1–10 are landed (commits `e5bcef1`, `60ce775`, `fbccad4`, plus identity/config v3,
Claude adapter `d528189`, role bridges `c2059bf`, contracts `4bda80a`, verification,
baselines `2e1dae6`, plan lifecycle `d8d7fa4`). Remaining:

## Batch 11 — Implementation, commit pause, code review, and dispositions

- **Objective:** Workflow steps 7–12 and explicit commit ownership.
- **Candidate files:** Implementation coordinator, commit commands, code-review handlers, CLI,
  tests.
- **Technical implementation:** Implement, implementation-ready, resume,
  complete-implementation, code review, findings, responses, disposition decisions.
- **Expected behaviour:** Agent stops at `AWAITING_COMMIT` unless authorized; human can commit
  without becoming implementer.
- **Technical acceptance:** Both commit modes pass; unauthorized agent commit rejected;
  reviewer receives cumulative and incremental patches.
- **CLI acceptance:** Explicit `--commit` and creator identity; retries never re-invoke the
  agent.
- **User acceptance:** Status names implementer, commit creator, reviewer, identity assurance.
- **Browser acceptance:** Browser findings participate in the disposition loop.
- **Automated verification:** Commit modes, ranges, corrections, identity, timeout/reconcile,
  disposition tests.
- **Manual verification:** Real temp-repo changes with separate human-created and
  fake-agent-created commits.
- **Out of scope:** Final approval and merge.
- **Rollback:** Commands opt-in; commits are ordinary local Git history.

## Batch 12 — Verification CLI, final gate, stale approval, merge recording, completeness audit

- **Objective:** Workflow steps 13–17.
- **Candidate files:** Gate/final-audit coordinator; CLI verify/attest/gate/mark-merged
  handlers; tests.
- **Technical implementation:** Execute/attest evidence, evaluate full gate, compute effective
  state, persist stale reconciliation, record external merge, final audit.
- **Expected behaviour:** Persisted approval becomes effectively stale immediately on HEAD
  mismatch.
- **Technical acceptance:** Every gate condition has negative coverage; no stale approval or
  unaccepted evidence passes.
- **CLI acceptance:** Status shows persisted/effective state; `mark-merged` never invokes
  merge.
- **User acceptance:** Human/protected CI retains merge control.
- **Automated verification:** Gate, stale-state, merge, multi-batch, final-audit tests.
- **Out of scope:** Hosting-provider merge automation.
- **Rollback:** Disable new gate transport; no merge action to undo.

## Batch 13 — Background jobs and workflow events

- **Objective:** Asynchronous execution without weakening idempotency.
- **Technical implementation:** Workflow job types, original command-ID propagation, outcome
  reconciliation, workflow event cursors.
- **Technical acceptance:** Crash/retry/cancel scenarios preserve command receipt semantics;
  retried workers never repeat agent/verification invocation.
- **CLI acceptance:** `--background` returns job and command IDs.
- **Out of scope:** MCP.
- **Rollback:** Synchronous workflow remains usable.

## Batch 14 — Additive MCP workflow tools

- **Objective:** Expose stable workflow operations programmatically.
- **Technical implementation:** New tools calling the shared coordinator with command IDs and
  expected versions; existing five tools unchanged.
- **Technical acceptance:** New tool schemas validate identity/idempotency inputs and replay
  safely.
- **Out of scope:** Changing existing tool schemas.
- **Rollback:** Remove additive tools only.

## Batch 15 — Adoption, legacy deprecation, skills, and documentation

- **Objective:** Make review-gated batches the documented build path.
- **Technical implementation:** Replace `/build` instructions; stderr deprecation warning on
  legacy `codemoot build`; preserve debate; README/CONTRIBUTING/presets.
- **Technical acceptance:** No mandatory debate dependency remains in the new workflow.
- **User acceptance:** Migration and identity/commit limitations are explicit.
- **Out of scope:** Removing legacy build/debate or fixing the lint backlog.
- **Rollback:** Revert adoption/defaults without removing workflow functionality.

# 7. Testing strategy

Exhaustive transitions including `AWAITING_COMMIT`; both commit paths plus unauthorized
rejection; plan finding lifecycle and disposition decisions; actor/authority combinations;
assignment-vs-invocation mismatch; alias/session-reuse rejection; assurance disclosure; exact
Git ranges; HEAD changes before/during/after review; persisted-vs-effective approval; receipt
replay and hash conflict; crash before/after side-effect reservation; timeouts without
reinvocation; worker retry with original command ID; verification-vs-attestation; manual/
browser implementer-only refusal; baseline same-count/different-finding regression; tool/
config incompatibility; v8 DB and v2 config compatibility; legacy CLI and MCP compatibility;
deterministic fake Claude/Codex end-to-end; optional credentialed smoke tests.

# 8. Migration and compatibility

New workflow opt-in until Batch 15; additive SQLite only; legacy tables preserved
indefinitely; command receipts from first migration; config v3 with invoked-on-load migration;
old Codex-only configs valid; CLI stdout and MCP schemas unchanged; deprecations on stderr;
historical build approvals never promoted; assurance stored per action, never retroactively
strengthened; baselines immutable, never silently refreshed; rollback never drops audit data.

# 9. Open questions (tracked, non-blocking with documented defaults)

- Exact supported Claude CLI protocol evolution and authenticated-subject evidence.
- Safe stable authenticated account identifiers for either CLI.
- Human actor identity authentication in local CLI use.
- CI provider identity claims for `VERIFICATION_ATTESTOR` / `MERGE_RECORDER`.
- Branch strategy: batches currently accumulate on one workflow branch (adopted default);
  separate branches/worktrees remain a possible later refinement.
- Accepted external plan formats and requirement-ID conventions.
- Normalization policy when findings move files or change wording.
- Required assurance when process/session evidence exists but account identity does not.
- Trusted source for browser evidence.
