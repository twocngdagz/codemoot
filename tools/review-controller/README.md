# Repository Review Controller

This dependency-free Node.js 22 controller makes the review-gated batch workflow executable.
Chat, memory, summaries, and agent acknowledgements cannot control a workflow because they do
not provide exclusive ownership, atomic updates, or enforceable transition guards. The
controller combines a local state file, an exclusive lock, validated JSON artefacts, fresh Git
evidence, and thin Codex/Claude repository skills.

The canonical process is `docs/workflow/review-gated-protocol.md`. Live state is local at
`.cowork/workflow-state.json`; do not edit it by hand.

## Configure executors

Copy the tracked example and adjust command arrays to locally supported CLI options:

```bash
cp .cowork/controller-config.example.json .cowork/controller-config.json
```

The detected invocation shapes when this controller was added were:

```json
{
  "implementer": {
    "agent": "codex",
    "command": "codex",
    "args": ["exec", "-"],
    "promptDelivery": "stdin",
    "timeoutMs": 1800000
  },
  "reviewer": {
    "agent": "claude",
    "command": "claude",
    "args": ["--print", "--output-format", "text"],
    "promptDelivery": "stdin",
    "timeoutMs": 1800000
  }
}
```

Arguments are never shell-parsed. For file delivery, set `promptDelivery` to `file` and put
`{promptFile}` in the argument array; when omitted, the prompt path is appended. Environment
values reach agents only when their names appear in `environmentVariableAllowlist`. Store no
secrets in the JSON file.

Codex prompts invoke `$review-gated-batch`; Claude prompts invoke `/review-gated-batch`.
Automated tests use deterministic fake executables and never invoke either real CLI.

## Initialise a batch

`init` creates runtime directories and a live state file. It refuses to overwrite state unless
`--force` is explicit.

```bash
node tools/review-controller/controller.mjs init \
  --workflow-id example-workflow \
  --batch 1 \
  --phase IMPLEMENT \
  --implementer codex \
  --reviewer claude \
  --plan docs/plans/batch-01.md \
  --base-sha "$(git rev-parse HEAD)" \
  --criterion "The approved batch acceptance criterion" \
  --commit-message "feat: implement approved batch"
```

Repeat `--criterion` for every required acceptance criterion. Repeat
`--merge-blocking-criterion` only for criteria that the approved plan explicitly marks as
merge-blocking. The controller passes the full lists to the reviewer and rejects a review that
does not cover them. When initialising directly at `REVIEW_INITIAL` and no `--criterion` is
supplied, the controller adopts the criteria from the validated complete implementation report.

To start at `REVIEW_INITIAL`, supply a complete, valid `--implementation-report`. This supports
work completed before controller initialisation without pretending the controller performed
that implementation.

## Commands

```bash
pnpm workflow:status
pnpm workflow:controller validate .cowork/reviews/batch-3-initial-review.json
pnpm workflow:run-once
pnpm workflow:run
pnpm workflow:controller reconcile
```

- `status` prints the active batch, phase, authorised role/agent, pass counts, findings,
  artefacts, automation flags, and stop reason.
- `validate <file>` detects and validates one artefact without changing state.
- `run-once` performs exactly one authorised controller action.
- `run-until-stop` continues without acknowledgement pauses until a defined stop condition.
- `reconcile` inspects stale locks, uncertain invocations, artefacts, Git state, manual commits,
  and required pushes. It never blindly repeats an uncertain invocation.

## Review and feedback limits

Initial review is one complete pass. `CRITICAL` and `HIGH` findings block. `MEDIUM`, `LOW`, and
`SUGGESTION` findings are deferred unless an approved merge-blocking medium criterion is cited.
The implementer receives every blocker together and has one correction pass. Final review is
one verification pass and may add only a critical/high regression introduced by that
correction. There is no second correction or third review.

Invalid agent output is saved under `.cowork/raw/`. The controller permits at most one
formatting-only repair using the existing analysis. A second invalid result stops at
`HUMAN_DECISION_REQUIRED`.

## Stop conditions and automatic progression

Continuous mode stops at:

- `HUMAN_DECISION_REQUIRED`, `BLOCKED`, or `DONE`;
- `READY_TO_COMMIT` while auto-commit is disabled and no matching manual commit exists;
- `CLOSE_BATCH` while a required push is not automated or already verified;
- disabled auto-advance after closure;
- the controller action limit;
- an unavailable or failed agent;
- an invalid artefact after the repair allowance; or
- an uncertain interrupted invocation.

When approval, checks, commit policy, push policy, an approved next batch, and auto-advance all
agree, the controller enters the next `IMPLEMENT` phase and invokes its implementer without
waiting for chat acknowledgement. `approvedBatches` in controller configuration supplies the
ordered next-batch plan, criteria, and explicit commit message.

To enable automation safely, set `autoCommit`, `autoPush`, and `autoAdvance` deliberately in
`.cowork/controller-config.json`. Auto-commit stages only the reviewed file set, rejects
pre-existing staged changes, and requires an explicit commit message. Auto-push uses
`git push <remote> <branch>` without force. The controller never resets, stashes, cleans,
rebases, merges, or force-pushes.

## Integrity and recovery

State writes use temporary-file-plus-rename. An exclusive `.cowork/controller.lock` prevents
concurrent runs. The controller hashes state before invocation; agent state tampering is
restored and rejected. Reviewer and formatting-repair invocations must leave the product
worktree unchanged.

After a crash, run:

```bash
pnpm workflow:controller reconcile
```

A stale lock is removed only when its recorded process is absent. An invocation left
`IN_PROGRESS` has an uncertain outcome and is escalated rather than repeated.

## Begin current Batch 3 review later

Do not run this while Batch 3 implementation or its report is incomplete. Once the approved
plan exists at `docs/plans/batch-03.md` and the complete report exists at
`.cowork/reports/batch-3-implementation-report.json`, initialise review with:

```bash
node tools/review-controller/controller.mjs init \
  --workflow-id codemoot-review-gated-redesign \
  --batch 3 \
  --phase REVIEW_INITIAL \
  --implementer codex \
  --reviewer claude \
  --plan docs/plans/batch-03.md \
  --base-sha 60ce775 \
  --implementation-report .cowork/reports/batch-3-implementation-report.json \
  --commit-message "feat(core): add review workflow git evidence service"
```

This uses the complete implementation report's acceptance-criterion list as the required review
set. Repeated exact `--criterion` arguments from the approved plan may be added to make that
input independent of the report. This example deliberately does not execute or alter the
current Batch 3 work.
