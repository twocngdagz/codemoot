# Review-Workflow Implementation Lifecycle

Batch implementation is deliberately split at the commit boundary:

```text
APPROVED_FOR_IMPLEMENTATION
  -> IMPLEMENTING
  -> AWAITING_COMMIT
  -> IMPLEMENTATION_COMPLETE
```

`codemoot batch implement <workflow-id> <ordinal>` performs the first two transitions.
`codemoot batch complete-implementation <workflow-id> <ordinal> --commit <sha> --commit-mode
<agent|human>` performs the last transition after validating the commit.
`codemoot batch resume-implementation <workflow-id> <ordinal>` returns an awaiting-commit batch
to `IMPLEMENTING` through a repository-stable implementer preflight when more work is required.

## Starting implementation

The implementation service reads the repository before invoking the implementer and requires a
clean worktree. A read-only preflight invocation establishes the process-attested implementer and
session identity. The preflight must return exactly `READY`; CodeMoot reads the repository again
and rejects the start if HEAD, branch, or the worktree fingerprint changed.

The successful `START_IMPLEMENTATION` command establishes `originalBatchBaseSha` from the fresh
HEAD in the same transaction as the state transition. The field is write-once. Batch plans are
materialized without guessing their future base, so a later batch starts from the repository HEAD
that actually exists when its approved implementation begins.

## Complete implementation pass

The implementer resumes the preflight session only after the batch is durably `IMPLEMENTING`.
The prompt contains the complete immutable batch plan, acceptance criteria, base SHA, and commit
ownership rule. It requires one strict `IMPLEMENTATION_RESULT` JSON object after the whole batch
is complete.

CodeMoot derives changed paths from fresh repository evidence:

- committed changes come from the base-to-HEAD Git diff;
- uncommitted changes come from porcelain status, including untracked paths;
- the model's `changedFiles` claim must match that derived set exactly.

The accepted transcript creates an immutable `ImplementationAttempt`. A complete result also
creates `ImplementationReadyEvidence` and transitions to `AWAITING_COMMIT`. A malformed handoff
or evidence mismatch records a final command failure and leaves the batch `IMPLEMENTING`. A
model-reported `BLOCKED` result is accepted only as an explicit conservative `BLOCK_BATCH`
transition; correctable implementation and test failures belong inside the same implementation
pass.

If a handoff is rejected while the batch remains `IMPLEMENTING`, rerunning `batch implement`
resumes the persisted implementer session and creates the next numbered attempt. Existing
uncommitted work is allowed on a human-created retry; changed-file evidence is still recomputed
against the immutable original base rather than only against the immediately preceding attempt.

## Commit ownership

Commit ownership comes from configuration:

- `human_required` leaves repository changes uncommitted and unchanged from the base HEAD;
- `agent_authorized` requires the implementing execution to create a new commit and leave a clean
  worktree;
- `either` defaults to the safer human-created path unless `--commit-mode agent` is explicit.

Only an implementer assignment with `commitPermission: AUTHORIZED` may exercise
`COMMIT_CREATOR`. A human-created completion records a distinct CLI-asserted human actor. An
agent-created completion reloads the immutable implementing execution; it does not accept a new
caller assertion about which agent created the commit.

Completion passes the explicit SHA to `ReviewWorkflowGitService`. The service requires fresh
HEAD equality, a clean worktree, valid base and attempt ancestry, matching attempt/ready/assignment
identities, and policy-compatible creator authority. The validated `ImplementationCommit` and
`COMPLETE_IMPLEMENTATION` transition are persisted atomically.

Git author and committer fields remain commit-object metadata, not authenticated proof of the
process that ran `git commit`. The process/session/assignment evidence records CodeMoot's strongest
available attribution.

## Scope boundary

The implementation half stops at the commit boundary; code review, disposition handling, and
the single bounded correction round are performed by the code-review half documented below.
This lifecycle still does not perform
verification acceptance, merge approval, merge execution, MCP registration, or background-job
orchestration. Those consume the durable implementation attempt, ready evidence, and validated
commit in later batches.

## Bounded code review and pacing

Code review is bounded by `reviewGated.pacing`, which the configuration snapshot carries into
every batch:

- `maxCodeReviewRounds` (1–2, default 2): round 1 is the one complete initial review; round 2
  is the single bounded final review. A third round is rejected outright with
  `PACING_EXHAUSTED`.
- `maxCorrectionPasses` (0–1, default 1): the single correction pass runs
  `NEEDS_REVISION → IMPLEMENTING` through `resume`; a second correction attempt is rejected
  with `PACING_EXHAUSTED` even after a human resume.

Each round captures authoritative Git range evidence first (`INITIAL` for round 1,
`CORRECTION` for round 2 with cumulative and incremental patches stored as content-addressed
artifacts), then invokes the reviewer read-only. A reviewer that changes HEAD, the index, or
the worktree is rejected with `REVIEWER_MODIFIED_WORKTREE` and its command fails finally.

The verdict is derived, not trusted: blocking findings are the persisted `OPEN` findings whose
severity is in `gates.blockingSeverities` (restricted to critical/high in the final round). A
reviewer verdict that contradicts the derived verdict fails with `REVIEW_POLICY_MISMATCH`.
Non-blocking findings are recorded and deferred — they never extend the correction loop.

Outcomes per round:

- No blocking findings → `APPROVE_CODE_REVIEW` → `VERIFYING`.
- Blocking findings with a correction pass remaining → `REJECT_CODE_REVIEW` →
  `NEEDS_REVISION`; the implementer must submit one consolidated `DISPOSITION_RESULT`
  (`batch respond --file …`) covering every blocking finding and targeting the corrected
  commit before the final review will start (`DISPOSITIONS_REQUIRED` otherwise).
- Blocking findings with no rounds or passes remaining → the batch is blocked with reason
  `REVIEW_ROUNDS_EXHAUSTED_HUMAN_DECISION_REQUIRED`. No further agent is invoked; only the
  human workflow owner may resume.

CLI:

```bash
codemoot batch review-code <workflow-id> <ordinal>
codemoot batch respond <workflow-id> <ordinal> --file dispositions.json
```
