# Review-Workflow Git Evidence

Batch 3 centralizes repository reads behind the `GitRepository` interface and
assembles review evidence through `ReviewWorkflowGitService`.

The local adapter is read-only. It does not create branches or worktrees, stash
changes, stage files, create commits, reset the repository, or merge anything.

## Trust boundary

Git facts are never accepted from a workflow request when they can be read from
the repository:

- current branch HEAD;
- clean or dirty worktree/index state, including untracked files;
- commit resolution, parents, tree, author, and committer metadata;
- ancestry;
- cumulative and incremental patches;
- changed-file status.

Multi-read operations capture the worktree before and after evidence assembly.
If HEAD or the status fingerprint changes, the operation fails with
`REPOSITORY_CHANGED_DURING_READ` before emitting patch artifacts.

Later batches must apply the same rule to persistence-derived facts. Finding and
disposition counts must be queried by the coordinating service inside the same
transaction scope used to evaluate and persist the command. They must not be
accepted from a caller or fetched once and passed through a long-running
operation.

## SHA vocabulary

- `B0`: immutable original batch base SHA.
- `P`: previous reviewed implementation SHA; `B0` for the first review.
- `I`: current committed implementation SHA.
- `H`: repository HEAD observed during evidence assembly.

The service requires a clean worktree and `I = H` before review evidence can be
captured. It verifies that both `B0` and `P` are ancestors of `I`.

`B0` is established once, from a fresh clean HEAD, when the approved batch enters
`IMPLEMENTING`. Batch-plan materialization does not guess the base of later batches.
Persistence rejects a missing start target and any attempt to replace an established base.

## Canonical review ranges

Patch content is generated with one canonical argument form:

```text
git diff --binary --full-index --find-renames <from> <to> --
```

| Review | Cumulative range | Incremental range |
| --- | --- | --- |
| Initial | `B0..I1` | Same artifact as cumulative |
| Correction | `B0..In` | `I(n-1)..In` |
| Final gate | `B0..H` | `I..H`, which must be empty |

Correction evidence always carries both cumulative and incremental artifacts.
The final gate recomputes the cumulative patch, requires its SHA-256 hash to
match the latest accepted code-review hash, and independently verifies that the
implementation-to-HEAD patch is empty.

Patch artifacts are written only after repository stability and all range
guards pass. The artifact sink supplies storage; the evidence hash always comes
from the fresh Git output rather than the sink or caller.

## Commit validation

Implementation completion receives an explicit commit SHA. Validation requires:

- the SHA equals fresh repository HEAD;
- the worktree and index are clean;
- the commit resolves with at least one parent;
- `B0` and the attempt starting HEAD are ancestors of the commit;
- attempt, implementation-ready evidence, assignment, and actor IDs agree;
- agent-created commits come from the assigned implementer execution and are
  explicitly permitted;
- human-created commits come from a human exercising `COMMIT_CREATOR` and are
  allowed by policy;
- a base-equal no-change result is rejected unless explicitly permitted.

Git author and committer metadata are evidence about the commit object. They are
not proof of which actor executed `git commit`.

## Effective approval

Effective approval is calculated from persisted state plus a freshly read HEAD.
A persisted `APPROVED_FOR_MERGE` record is reported as effectively
`APPROVAL_STALE` whenever its approval SHA differs from HEAD, even before an
invalidation event is persisted.
