# Review-Gated Batch Protocol

This protocol is the canonical human-readable specification for repository review-gated
batches. `.cowork/workflow-state.json`, written only by the controller, is the live source of
truth. Chat transcripts, agent memory, summaries, and acknowledgements are never authoritative
workflow state.

## Roles and authority

- `CONTROLLER` owns state, phase transitions, invocation, commit, push, batch closure,
  advancement, and escalation to a human.
- `IMPLEMENTER` performs only the authorised implementation or correction action.
- `REVIEWER` performs only the authorised initial or final review action.

The implementer and reviewer must be different configured agents. Neither agent is the
controller. Agents may not edit controller state or authorise another action.

## Phases

The only phases are:

```text
IMPLEMENT
REVIEW_INITIAL
FIX_BLOCKING_FINDINGS
REVIEW_FINAL
READY_TO_COMMIT
CLOSE_BATCH
ADVANCE_BATCH
HUMAN_DECISION_REQUIRED
BLOCKED
DONE
```

The normal paths are:

```text
IMPLEMENT → REVIEW_INITIAL → READY_TO_COMMIT
IMPLEMENT → REVIEW_INITIAL → FIX_BLOCKING_FINDINGS → REVIEW_FINAL → READY_TO_COMMIT
READY_TO_COMMIT → CLOSE_BATCH → ADVANCE_BATCH
```

There is one initial review, at most one correction, and at most one final re-review. There is
no second correction and no third reviewer pass. Only validated artefacts and successful
controller actions advance state; conversational text never does.

## Blocking policy

`CRITICAL` and `HIGH` findings block by default. `MEDIUM`, `LOW`, and `SUGGESTION` findings are
recorded and deferred by default. A `MEDIUM` finding may block only when the approved batch plan
explicitly marks the affected acceptance criterion merge-blocking and the finding cites that
criterion.

MEDIUM defers by default; integrity and approved-contract violations are HIGH by definition.

Deferred findings do not extend the active feedback loop. They remain recorded for later
triage.

## Initial review

The reviewer must complete the entire authorised review before responding. It must inspect:

- the approved batch plan and every acceptance criterion;
- the complete cumulative diff and every changed file;
- relevant surrounding code, test changes, and verification output;
- scope compliance; and
- CLI, browser, or user behaviour when applicable.

The reviewer collects all findings internally and returns all findings together in one complete
machine-readable artefact. It must not return the first finding and continue later, reference an
undefined finding ID, promise more findings, split the review across messages, stop at the first
defect, or claim completion after reviewing only part of the changed-file set.

An approved review has no blockers. A review requiring correction contains every blocker in the
same artefact.

## Correction

The implementer receives the complete initial-review artefact and addresses every original
blocking finding exactly once in one complete correction report. The allowed dispositions are:

```text
FIXED
NO_CHANGE_WITH_EVIDENCE
BLOCKED
SUPERSEDED
```

Corrections may not begin before a valid complete initial review exists. The correction report
must not be incremental or promise later dispositions.

## Final re-review

The final re-review is a bounded verification pass, not another general review. It verifies
every original blocking finding, the cumulative updated diff, and the incremental correction
diff. Each original blocker receives exactly one status:

```text
FIXED_AND_VERIFIED
ACCEPTED_NO_CHANGE
NOT_FIXED
REGRESSION_INTRODUCED
CANNOT_VERIFY
```

A new finding is allowed only for a `CRITICAL` or `HIGH` regression introduced by the
correction, with evidence identifying that correction. The reviewer must not add new medium or
low findings, suggestions, naming preferences, optional refactors, architecture preferences,
future-proofing work, or later-batch requirements.

The final verdict is exactly one of:

```text
APPROVED
HUMAN_DECISION_REQUIRED
BLOCKED
```

Unresolved material blockers require human decision. Verification that cannot proceed is
blocked. There is no final `NEEDS_REVISION` verdict and no further automatic agent loop.

## Controller transitions

```text
IMPLEMENT + complete implementation report → REVIEW_INITIAL
REVIEW_INITIAL + APPROVED → READY_TO_COMMIT
REVIEW_INITIAL + NEEDS_REVISION → FIX_BLOCKING_FINDINGS
REVIEW_INITIAL + BLOCKED → BLOCKED
FIX_BLOCKING_FINDINGS + complete correction report → REVIEW_FINAL
REVIEW_FINAL + APPROVED → READY_TO_COMMIT
REVIEW_FINAL + HUMAN_DECISION_REQUIRED → HUMAN_DECISION_REQUIRED
REVIEW_FINAL + BLOCKED → BLOCKED
READY_TO_COMMIT + approved commit verified → CLOSE_BATCH
CLOSE_BATCH + required push policy satisfied → ADVANCE_BATCH
ADVANCE_BATCH + approved next batch + autoAdvance → next IMPLEMENT
ADVANCE_BATCH + no remaining batch → DONE
```

When automatic advancement is enabled and all commit/push policy is satisfied, the controller
starts the next authorised action without waiting for agent acknowledgement. It still stops at
the configured action limit and at every explicit stop condition.

## Single-use authorisation

Every agent prompt identifies the workflow, batch, phase, authorised role and agent, one allowed
action, file-mutation permission, and stop condition. An agent must:

1. read the canonical state and referenced plan/artefacts;
2. perform only the authorised action;
3. return one complete raw JSON artefact;
4. avoid editing controller-owned state; and
5. stop immediately.

Only the controller may update state, change phase, close a batch, commit, push, authorise the
next batch, invoke the next role, or decide human intervention is required.

## Integrity and recovery

Before invocation, the controller hashes live state, records the authorised phase and target,
and acquires an exclusive lock. State writes are atomic. If an agent changes live state, the
controller restores controller-owned data, rejects the output as
`CONTROLLER_STATE_TAMPERED`, and does not advance.

The controller records an invocation before starting it. After interruption, it never blindly
repeats an invocation with an uncertain outcome; `reconcile` inspects the lock, state,
artefacts, Git state, and last action and escalates uncertainty.

Malformed output is saved and receives at most one formatting-only repair attempt. The repair
must use the existing analysis and may not rerun implementation or review work. A second
failure stops at `HUMAN_DECISION_REQUIRED`.

## Git policy

The controller reads fresh Git state before and after each phase, records base and reviewed
heads, verifies the reviewed changed-file set, and fingerprints the approved worktree. It
refuses commit if head or reviewed content changed after approval. It never automatically
resets, stashes, cleans, rebases, merges, or force-pushes.

Commit and push occur only when enabled. Commit messages come from explicit state or
configuration. Runtime files under `.cowork/` are never included in a product commit.
