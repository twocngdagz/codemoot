# Review Workflow Handoff Contracts

Review-workflow agents return versioned JSON contracts. The parser accepts the entire response
as one JSON value and validates it with a strict schema. Markdown fences, leading conclusions,
trailing explanations, unknown fields, stale targets, and unsupported schema versions are
rejected. No verdict is inferred from prose.

Every response is stored as an immutable handoff transcript before it can become durable plan,
review, finding, implementation, or disposition evidence. Rejected responses retain their raw
text, content hash, error code, actor execution, and invocation/session references, but create no
derived artifacts and authorize no workflow transition.

## Common rules

- `schemaVersion` is currently `1`.
- `contractKind` selects one of the five schemas below.
- Prompts must provide authoritative target and identity fields. Responses echo targets exactly;
  the service rejects stale or substituted targets.
- `findingKey` is unique within a review round. CodeMoot combines it with workflow, batch, round,
  and review kind to derive a stable SHA-256-based `findingId`.
- `PLAN` and `CODE` findings are materialized through the same `Finding` lifecycle. Code findings
  additionally bind to the reviewed commit and review-range patch hash.
- A `browser_behaviour` finding requires a `BROWSER` evidence reference.
- `APPROVED` cannot contain `critical` or `high` findings. Final-audit approval also requires
  complete scope, complete documentation, and no failed requirement or criterion checks.

## Refinement result

```json
{
  "schemaVersion": 1,
  "contractKind": "REFINEMENT_RESULT",
  "summary": "The approved plan is divided into two dependency-ordered batches.",
  "refinedPlanContent": "# Refined plan\n\n...",
  "batchPlanVersionIds": ["batch-plan-1", "batch-plan-2"],
  "requirementCoverage": [
    {
      "requirementId": "requirement-1",
      "batchPlanVersionIds": ["batch-plan-1"],
      "acceptanceCriterionIds": ["criterion-1"]
    }
  ]
}
```

The service computes the refined-plan content hash. Every expected requirement must appear once,
and coverage cannot reference an undeclared batch-plan version.

## Plan or code review result

```json
{
  "schemaVersion": 1,
  "contractKind": "REVIEW_RESULT",
  "target": {
    "kind": "CODE",
    "reviewedCommitSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "repositoryContextSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "reviewRangeEvidenceId": "range-1",
    "patchHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  },
  "verdict": "NEEDS_REVISION",
  "summary": "One blocking correctness finding.",
  "findings": [
    {
      "findingKey": "B7-001",
      "severity": "high",
      "category": "correctness",
      "title": "Review can be bypassed",
      "description": "The state change accepts an unreviewed target.",
      "repositoryEvidence": [
        {
          "kind": "FILE",
          "location": "packages/core/src/example.ts:10",
          "description": "The unchecked state change."
        }
      ],
      "affectedFiles": ["packages/core/src/example.ts"],
      "expectedResult": "Review is mandatory.",
      "observedResult": "Review can be skipped.",
      "requiredAction": "Validate the target.",
      "occurrenceLinks": []
    }
  ]
}
```

A plan target instead carries `planVersionId`, `planContentHash`, and `repositoryContextSha`.

## Implementation result

```json
{
  "schemaVersion": 1,
  "contractKind": "IMPLEMENTATION_RESULT",
  "outcome": "COMPLETE",
  "summary": "Implemented the target guard and focused regression coverage.",
  "changedFiles": [
    "packages/core/src/example.ts",
    "packages/core/tests/unit/example.test.ts"
  ],
  "verificationRecordIds": []
}
```

These are implementation claims. Listing a verification record does not create, execute, or
attest verification evidence. Verification execution belongs to the later verification batch.
A `BLOCKED` outcome must include `blockerReason`.

## Disposition result

```json
{
  "schemaVersion": 1,
  "contractKind": "DISPOSITION_RESULT",
  "target": {
    "kind": "CODE",
    "resultingCommitSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "summary": "All findings were addressed.",
  "dispositions": [
    {
      "findingId": "finding-example",
      "disposition": "FIXED",
      "explanation": "Added the target guard.",
      "filesChanged": ["packages/core/src/example.ts"],
      "verificationRecordIds": [],
      "evidence": [
        {
          "kind": "DIFF",
          "location": "packages/core/src/example.ts",
          "description": "The new target guard."
        }
      ]
    }
  ]
}
```

The caller supplies the authoritative set of open finding IDs. The result is rejected unless it
addresses that exact set once each. New dispositions start with a `PENDING` reviewer decision.

## Final-audit result

```json
{
  "schemaVersion": 1,
  "contractKind": "FINAL_AUDIT_RESULT",
  "target": {
    "kind": "FINAL_AUDIT",
    "reviewedCommitSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "repositoryContextSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "reviewRangeEvidenceId": "range-final",
    "patchHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "refinedPlanVersionId": "refined-plan-1"
  },
  "verdict": "APPROVED",
  "summary": "All required outcomes are evidenced.",
  "findings": [],
  "requirementChecks": [
    {
      "subjectId": "requirement-1",
      "status": "PASSED",
      "explanation": "The implementation meets the requirement.",
      "evidence": [
        {
          "kind": "DIFF",
          "location": "packages/core/src/example.ts",
          "description": "Implementation evidence."
        }
      ]
    }
  ],
  "acceptanceCriterionChecks": [],
  "scopeComplete": true,
  "documentationComplete": true
}
```

## Inspecting a capture

`ReviewWorkflowStore.getHandoffTranscript(transcriptId)` returns the raw capture and parse
outcome. `getStructuredReview(reviewRoundId)` returns the validated review record. Findings and
other derived entities remain available through `getEntity`.

For manual verification, compare `rawTranscriptHash` with SHA-256 of `rawTranscript`, confirm the
structured review target exactly matches the requested target, and confirm
`parsedArtifactIds` lists exactly the records created by the capture.
