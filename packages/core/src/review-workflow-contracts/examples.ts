// Canonical minimal VALID examples for every agent contract.
//
// Three real runs were rejected after a full successful invocation — 13–21 minutes and
// $3.40–$5.07 each — for field-name mistakes a machine could have caught for free
// (`kind` for `contractKind`, missing `refinedPlanContent`, `batchIds` for
// `batchPlanVersionIds`, invented `notes`). Every example here is parsed by the REAL
// parser in the test suite, so a schema change that would reject a described response
// breaks the build instead of a $5 workflow. The examples are embedded in the prompts, so
// the agent gets a proven-valid template rather than a description it must interpret.

export const REFINEMENT_RESULT_EXAMPLE = {
  schemaVersion: 1,
  contractKind: 'REFINEMENT_RESULT',
  summary: 'One-paragraph summary of the refinement.',
  refinedPlanContent: 'The complete refined plan content, as Markdown.',
  batchPlanVersionIds: ['workflow-1:batch:1:plan:1'],
  requirementCoverage: [
    {
      requirementId: 'requirement-abc123',
      batchPlanVersionIds: ['workflow-1:batch:1:plan:1'],
      acceptanceCriterionIds: ['criterion-1'],
    },
  ],
} as const;

export const REVIEW_RESULT_EXAMPLE = {
  schemaVersion: 1,
  contractKind: 'REVIEW_RESULT',
  target: {
    kind: 'PLAN',
    planVersionId: 'workflow-1:batch:1:plan:1',
    planContentHash: 'a'.repeat(64),
    repositoryContextSha: 'b'.repeat(40),
  },
  verdict: 'APPROVED',
  summary: 'One-paragraph summary of the review.',
  findings: [],
} as const;

export const IMPLEMENTATION_RESULT_EXAMPLE = {
  schemaVersion: 1,
  contractKind: 'IMPLEMENTATION_RESULT',
  outcome: 'COMPLETE',
  summary: 'One-paragraph summary of what was implemented.',
  changedFiles: ['src/example.ts'],
  verificationRecordIds: [],
} as const;

export const DISPOSITION_RESULT_EXAMPLE = {
  schemaVersion: 1,
  contractKind: 'DISPOSITION_RESULT',
  target: { kind: 'CODE', resultingCommitSha: 'c'.repeat(40) },
  summary: 'One-paragraph summary of the correction pass.',
  dispositions: [
    {
      findingId: 'finding-abc123',
      disposition: 'FIXED',
      explanation: 'What was changed and why it resolves the finding.',
      filesChanged: ['src/example.ts'],
      verificationRecordIds: [],
      evidence: [
        { kind: 'DIFF', location: 'src/example.ts', description: 'What the evidence shows.' },
      ],
    },
  ],
} as const;

export const FINAL_AUDIT_RESULT_EXAMPLE = {
  schemaVersion: 1,
  contractKind: 'FINAL_AUDIT_RESULT',
  target: {
    kind: 'FINAL_AUDIT',
    reviewedCommitSha: 'd'.repeat(40),
    repositoryContextSha: 'd'.repeat(40),
    reviewRangeEvidenceId: 'workflow-1:batch:1:range:1',
    patchHash: 'e'.repeat(64),
    refinedPlanVersionId: 'workflow-1:refined-plan:1',
  },
  verdict: 'APPROVED',
  summary: 'One-paragraph summary of the final audit.',
  findings: [],
  requirementChecks: [
    {
      subjectId: 'requirement-abc123',
      status: 'PASSED',
      explanation: 'How the requirement is satisfied.',
      evidence: [
        { kind: 'FILE', location: 'src/example.ts', description: 'What the evidence shows.' },
      ],
    },
  ],
  acceptanceCriterionChecks: [
    {
      subjectId: 'criterion-1',
      status: 'PASSED',
      explanation: 'How the criterion is satisfied.',
      evidence: [
        { kind: 'COMMAND', location: 'pnpm test', description: 'What the evidence shows.' },
      ],
    },
  ],
  scopeComplete: true,
  documentationComplete: true,
} as const;

/** Every contract example, keyed by contractKind — used by prompts and the round-trip test. */
export const CONTRACT_EXAMPLES = {
  REFINEMENT_RESULT: REFINEMENT_RESULT_EXAMPLE,
  REVIEW_RESULT: REVIEW_RESULT_EXAMPLE,
  IMPLEMENTATION_RESULT: IMPLEMENTATION_RESULT_EXAMPLE,
  DISPOSITION_RESULT: DISPOSITION_RESULT_EXAMPLE,
  FINAL_AUDIT_RESULT: FINAL_AUDIT_RESULT_EXAMPLE,
} as const;

export type ContractExampleKind = keyof typeof CONTRACT_EXAMPLES;
