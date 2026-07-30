# Review Workflow Merge Gate

Batch 12 adds the final merge gate: verification execution and attestation via the CLI, the
single bounded final completeness audit, full gate evaluation, stale-approval reconciliation,
and external-merge recording. CodeMoot **never executes merges**; it only records evidence
about them.

## Module

`packages/core/src/review-workflow-gate/` exports (root namespace `reviewWorkflowGate`):

- `ReviewWorkflowGateStore` — read model extending the implementation store with
  `listBatchFindings`, `listVerificationRecords`, `listAttestationsForRecord`,
  `listPlanRequirementIds`, and `listFinalAudits`.
- `ReviewWorkflowGateService` — `executeVerification`, `finalAudit`, `evaluateGate`,
  `effectiveState`, `reconcileStaleApproval`, `markMerged`.

## Final completeness audit (`batch final-audit`)

One bounded audit per batch, performed by the assigned reviewer while the batch is
`VERIFYING`:

- The service captures a `FINAL_GATE` review range whose cumulative patch hash must equal the
  approved code review's `patchHash` (H = I, empty `I..H`), persisting it under the stable
  identifier `<batchId>:range:final-gate`.
- The reviewer receives the authoritative `FINAL_AUDIT` target, the workflow requirement IDs,
  the plan's acceptance-criterion IDs, the cumulative diff, and the deferred (non-blocking)
  findings, and must return one strict `FINAL_AUDIT_RESULT` contract echoing the target and
  covering exactly those IDs.
- The invocation is reserved before the subprocess starts (reserve-before-invoke) and is
  completed with `succeedWithoutTransition`: the audit is evidence, not a state change — the
  batch stays `VERIFYING`.
- A worktree or HEAD mutation by the auditor rejects the artefact
  (`REVIEWER_MODIFIED_WORKTREE`); a second audit is refused (`FINAL_AUDIT_EXISTS`).
- New findings are permitted only at critical/high severity; an approved audit requires
  complete scope, documentation, and passing checks (contract-enforced).
- A `NEEDS_REVISION` final audit immediately transitions the batch to `BLOCKED`
  (resume state `VERIFYING`, event `BATCH_BLOCKED`): the single bounded audit is exhausted,
  so an unresolved outcome is a **human decision**, never another automatic review round.

## Verification via the CLI

- `batch verify --command <n>` executes the plan's nth approved verification command through
  `ReviewWorkflowGateService.executeVerification`, which reserves the command receipt and its
  `VERIFICATION_EXECUTION` side effect **before** the subprocess starts and persists the
  observed `VerificationRecord` (facts only — success is evidence, never acceptance). The
  default command ID is the stable `<batchId>:verify:<n>`; a same-ID retry replays the
  persisted record without re-executing anything.
- `batch attest-verification --record <id> --mode automatic|human --decision accepted|rejected
  --rationale <text>` records a `VerificationAttestation`. The policy derives **only from
  authoritative or durable sources** — nothing is echoed from the record and nothing is
  operator-asserted: the approved command must match a plan verification command, the pinned
  commit is the approved code review's reviewed commit, and the configuration hash is freshly
  derived. Facts without a durable evidence source are treated as **UNPROVEN and deny
  automatic acceptance**: no runner captures tool versions today, so the tool-version pin can
  never be satisfied and parser confidence always requires judgment; baseline comparison
  derives from the approved command's verification type (lint/static-analysis evidence is
  baseline-relative and requires the assigned reviewer). In practice automatic acceptance is
  denied until durable tool-version capture exists — acceptance requires independent human or
  reviewer judgment. Criterion policies derive from criterion kinds: MANUAL/BROWSER/
  USER_FACING criteria always require independent judgment.

## Idempotent replay and stable command identity

Every gate operation (`verify`, `final-audit`, `gate`, `reconcile-stale`, `mark-merged`)
checks its command receipt **before** any state guard: a same-ID retry of a completed
operation returns the recorded outcome (record, audit, approval, batch) without re-running
side effects or emitting duplicate events. Replay is bound to the operation's **full
identity** — workflow ID, batch ID, transition-command vocabulary, side-effect kind (which
distinguishes verification's `VERIFICATION_EXECUTION` from the audit's `AGENT_INVOCATION`),
the claimed side-effect identity for verification, and the recorded merge SHA for
`mark-merged` — so a command ID can never replay another batch's outcome or a different
operation's payload; any mismatch fails with `COMMAND_REPLAY_MISMATCH`. The CLI defaults every command to a stable ID
(`<batchId>:gate`, `<batchId>:final-audit`, `<batchId>:mark-merged`, …), overridable with
`--id`, and accepts `--expected-version <n>` to pin the expected batch aggregate version,
which the command store enforces at reservation.

## Gate evaluation (`batch gate`)

`evaluateGate` requires `VERIFYING` and derives **every** condition from persisted facts and
fresh repository reads; nothing is caller-supplied:

| Condition | Derivation |
| --- | --- |
| `HEAD_MATCHES_REVIEWED_COMMIT` | fresh HEAD equals the approved code review's target |
| `CLEAN_WORKTREE` | fresh worktree read |
| `UNRESOLVED_CRITICAL_OR_HIGH_FINDINGS` | OPEN critical/high findings without an ACCEPTED disposition |
| `INCOMPLETE_DISPOSITIONS` | dispositions decided but not ACCEPTED for blocking findings |
| `REQUIRED_CRITERIA_PASSED` | every required criterion has a SUCCEEDED, accepted record at the reviewed commit |
| `REQUIRED_VERIFICATION_COMPLETE` | every plan verification command has a matching SUCCEEDED accepted record |
| `REQUIRED_ATTESTATIONS_ACCEPTED` | at least one record exists and every record has an ACCEPTED attestation |
| `MANUAL_BROWSER_INDEPENDENT_ATTESTATION` | MANUAL/BROWSER criteria accepted via REVIEWER or HUMAN modes |
| `FINAL_DIFF_REVIEWED` | the FINAL_GATE range capture succeeds against the accepted cumulative hash |
| `SCOPE_MATCHES_APPROVED_PLAN` / `DOCUMENTATION_COMPLETE` | the latest APPROVED final audit at the reviewed commit attests both |

All conditions pass → the system reconciler actor (`SYSTEM`, `SYSTEM_RECONCILER`,
`PROCESS_ATTESTED`) issues `APPROVE_FOR_MERGE`; the kernel re-derives the transition and the
event `BATCH_GATE_APPROVED` persists `{approvedCommitSha}`. Any failure returns the full
condition report plus the failed-condition names and changes nothing.

## Effective state and stale approvals

A persisted approval becomes **effectively stale immediately** when HEAD no longer equals the
approved commit — before any reconciliation runs:

- `status` reports both `state` (persisted) and `effectiveState`/`approvalValid` derived via
  `readEffectiveApproval` from the persisted `BATCH_GATE_APPROVED` SHA.
- `batch reconcile-stale` / `reconcileStaleApproval` persists the observation
  (`RECONCILE_STALE_APPROVAL` → `APPROVAL_STALE`, event `APPROVAL_STALE_RECONCILED`). It
  refuses while HEAD still matches (`APPROVAL_NOT_STALE`), and staleness never un-persists —
  the batch must be re-verified through a new gate cycle.

## Merge recording (`batch mark-merged`)

`markMerged` records an **externally performed** merge: it requires `APPROVED_FOR_MERGE`, an
effective (non-stale) approval, and a HUMAN or CI recorder with `MERGE_RECORDER` authority.
The recorded merge commit must **exist in the repository and contain the approved commit**
(ancestry-verified via Git); a missing or non-descendant SHA rejects with
`MERGE_COMMIT_INVALID`, so a fabricated `MERGED` state cannot be recorded. It transitions to
`MERGED` via `RECORD_EXTERNAL_MERGE` and persists `BATCH_MERGED` with the approved and merge
commit SHAs. A stale approval rejects with `APPROVAL_NOT_EFFECTIVE`.
