---
name: build
description: Build features through the review-gated batch workflow — plan intake, refinement, per-batch implementation with independent review, verification, and a hard merge gate.
user-invocable: true
---

# /build — Review-Gated Batch Workflow

## Usage
`/build <task description or plan file>`

## Description
The documented build path: an external plan is imported and refined into complete batch
plans, then each batch runs one bounded implement → review → correct → final-review cycle,
followed by verification, a single final audit, and a merge gate that checks every condition
against durable evidence. Two separated agents (implementer and reviewer) with distinct CLI
adapters do the work; a debate is **not** required at any point (the `/debate` skill remains
available for ad-hoc questions).

Legacy note: the old autonomous loop (`codemoot build start`) is deprecated — it still works
but prints a stderr warning and receives no new capabilities. See
`docs/review-workflow-adoption.md` for migration and for the identity/commit limitations.

## Instructions

### Phase 0: Plan intake
1. Write (or receive) the plan as a Markdown file with explicit requirements.
2. `codemoot workflow start --plan <plan.md>` — imports the plan and captures a repository
   audit. Save the workflowId.
3. `codemoot workflow refine <workflow-id>` — the refiner turns the plan into complete,
   reviewable batch plans with acceptance criteria and verification commands.

### Phase 1: Per-batch bounded cycle (repeat per batch ordinal N)
1. `codemoot batch review-plan <workflow-id> <N>` — independent plan review; revise until
   approved.
2. Implement and commit:
   ```bash
   codemoot batch implement <workflow-id> <N> --commit-mode agent
   codemoot batch complete-implementation <workflow-id> <N> --commit <sha> --commit-mode agent
   ```
   (Use `--commit-mode human` when a human creates the implementation commit.)
3. `codemoot batch review-code <workflow-id> <N>` — ONE complete initial review.
4. Correction pass (at most once, only when the review returned blockers), in this exact
   order:
   ```bash
   codemoot batch resume-implementation <workflow-id> <N>
   codemoot batch implement <workflow-id> <N> --commit-mode agent
   codemoot batch complete-implementation <workflow-id> <N> --commit <corrected-sha> --commit-mode agent
   codemoot batch respond <workflow-id> <N> --file <dispositions.json>
   codemoot batch review-code <workflow-id> <N>
   ```
   The final `review-code` is the ONE bounded final review (round 2). Never a third
   automatic round — unresolved CRITICAL/HIGH blockers escalate to a human decision.

### Phase 2: Verification and gate
1. Per plan verification command index `i`:
   ```bash
   codemoot batch verify <workflow-id> <N> --command <i>
   ```
   (add `--background` to enqueue; `codemoot workflow jobs run` processes the queue).
2. Attest each successful record — acceptance requires independent judgment:
   ```bash
   codemoot batch attest-verification <workflow-id> <N> --record <record-id> --mode human --decision accepted --rationale "<what was independently confirmed>"
   ```
3. `codemoot batch final-audit <workflow-id> <N>` — the single completeness audit.
4. `codemoot batch gate <workflow-id> <N>` — approves for merge only when every condition
   passes against durable evidence.
5. Merge externally, then record it:
   ```bash
   codemoot batch mark-merged <workflow-id> <N> --merge-sha <sha>
   ```
   The merge happens outside CodeMoot and is recorded by a HUMAN or CI actor; CodeMoot
   verifies the merge commit exists and contains the approved commit, but does not
   authenticate who performed the merge. CodeMoot never executes merges.

### Observability
- `codemoot workflow status <workflow-id>` — batch states plus effective approval state.
- `codemoot workflow events <workflow-id> --cursor <name> --ack` — incremental event feed.
- MCP: `codemoot_workflow_status|events|gate|jobs` expose the same operations to clients.

## Configuration
`codemoot init --preset review-gated` writes a starting `.cowork.yml` (Claude implementer,
Codex reviewer, strict identity separation, all gates required, debate disabled).
