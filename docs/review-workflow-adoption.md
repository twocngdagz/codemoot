# Adopting the Review-Gated Batch Workflow

Batch 15 makes review-gated batches the **documented build path**. The legacy autonomous
loop (`codemoot build …`) and the debate commands remain available — nothing is removed —
but new capability lands only in the review-gated workflow, and `codemoot build start` now
prints a deprecation warning on stderr.

## Migration from `codemoot build`

| Legacy step | Review-gated equivalent |
| --- | --- |
| `codemoot build start "<task>"` | Write the task as a Markdown plan, then `codemoot workflow start --plan <plan.md>` and `codemoot workflow refine <id>` |
| Mandatory debate phase | **None.** The workflow has no debate dependency; `codemoot debate …` remains available for ad-hoc questions |
| Implement + `build event impl_completed` | `batch implement --commit-mode agent` → `batch complete-implementation --commit <sha> --commit-mode agent` |
| `codemoot build review` loop until approved | One complete initial `batch review-code`; at most one correction pass in this exact order: `batch resume-implementation` → `batch implement --commit-mode agent` → `batch complete-implementation --commit <corrected-sha> --commit-mode agent` → `batch respond --file <dispositions.json>` → the ONE bounded final `batch review-code` (round 2). Unresolved CRITICAL/HIGH escalates to a human decision, never a third automatic round |
| Manual "completeness check" | `batch verify --command <i>` per plan verification command, then `batch attest-verification --record <record-id> --mode human --decision accepted --rationale "<why>"`, then the single `batch final-audit` |
| Done when GPT approves | `batch gate` approves for merge only when **every** condition passes against durable evidence; the merge happens externally and is recorded with `batch mark-merged --merge-sha <sha>` by a HUMAN or CI actor |

Start from a working configuration with:

```bash
codemoot init --preset review-gated
```

(Claude implementer, Codex reviewer, strict identity separation, all gates required, debate
disabled.)

## Explicit limitations

**Identity.** Agent identity assurance tops out at `PROCESS_ATTESTED` (process-observed
evidence) and human/CI actors at `CLI_ASSERTED` — there is no authenticated-subject identity
yet (tracked as issue #1). The configuration's `minimumAssurance` gates what the workflow
accepts; treat identity attribution as honest bookkeeping, not authentication.

**Commits and merges.** Implementation commits follow the configured commit policy
(`human_required` / `agent_authorized` / `either`): agent-created commits are validated
against the recorded worktree fingerprint, and human-created commits use the human-pending
creation mode. The workflow never pushes and never executes merges: merges happen externally
and are *recorded* by a HUMAN or CI actor (`mark-merged`, or the MCP gate tool which defaults
to a CI recorder). CodeMoot verifies the recorded merge commit exists and contains the
approved commit, but it does **not** authenticate who performed the merge — recorder identity
is `CLI_ASSERTED` bookkeeping.

**Verification acceptance.** Automatic attestation is currently always denied because
tool-version facts have no durable evidence source (the runner does not capture tool
versions); acceptance requires independent human or reviewer judgment.

**Background jobs.** Retried workers never repeat an agent or verification invocation; a
crash after a reservation surfaces as `OUTCOME_UNKNOWN` for human reconciliation rather than
being retried blind.

## Rollback

Adoption is documentation, a preset, a skill rewrite, and a stderr warning. Reverting those
restores the previous defaults without touching workflow functionality.
