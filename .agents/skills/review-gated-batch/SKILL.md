---
name: review-gated-batch
description: Execute an approved product batch as one atomic unit, including one complete implementation pass, one consolidated initial review, one consolidated correction pass, and one final review. Use whenever Codex implements or reviews an approved batch.
---

## Batch execution rule

An approved batch is one atomic unit of work.

The implementer must complete the entire batch before requesting review. The implementer must
not stop or report after individual fixes, tests, commits, findings, or informal slices.

The implementer may stop early only when:

- the approved requirements contradict each other
- required credentials or systems are unavailable
- the work requires a material scope change
- a destructive or irreversible action requires owner approval
- a genuine external blocker prevents further work

Failing tests, fixture changes, type errors, implementation decisions, missing regression
tests, and correctable defects are not blockers. Resolve them within the current implementation
pass.

The reviewer must inspect the complete batch and return one consolidated finding list. The
reviewer must not report findings incrementally or review individual corrections separately.

The implementer then addresses every finding in one consolidated correction pass.

The reviewer performs one final review. The result must be:

- `APPROVED`
- `NEEDS_REVISION`
- `BLOCKED`

There are at most two review rounds:

1. Initial complete review
2. Final complete re-review

No agent may create informal sub-batches, process tooling, controller infrastructure, or
additional workflow layers while executing an approved product plan.

Non-blocking improvements are recorded for later and do not interrupt the current batch.
