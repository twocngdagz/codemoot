import { describe, expect, it } from 'vitest';
import {
  HandoffParseError,
  buildStructuredHandoffPrompt,
  deriveDispositionId,
  deriveFindingId,
  finalAuditResultContractSchema,
  implementationResultContractSchema,
  materializeFindings,
  parseDispositionResult,
  parseFinalAuditResult,
  parseImplementationResult,
  parseRefinementResult,
  parseReviewResult,
  refinementResultContractSchema,
  requireExpectedFindingIds,
  requireExpectedTarget,
  reviewResultContractSchema,
} from '../../../src/review-workflow-contracts/index.js';
import type {
  CodeReviewTarget,
  FindingDraft,
  PlanReviewTarget,
} from '../../../src/review-workflow-contracts/index.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(64);
const PLAN_TARGET: PlanReviewTarget = {
  kind: 'PLAN',
  planVersionId: 'plan-v1',
  planContentHash: HASH_C,
  repositoryContextSha: SHA_A,
};
const CODE_TARGET: CodeReviewTarget = {
  kind: 'CODE',
  reviewedCommitSha: SHA_B,
  repositoryContextSha: SHA_A,
  reviewRangeEvidenceId: 'range-1',
  patchHash: HASH_C,
};
const FINDING: FindingDraft = {
  findingKey: 'B7-001',
  severity: 'high',
  category: 'correctness',
  title: 'Incorrect transition',
  description: 'The transition can skip review.',
  repositoryEvidence: [
    {
      kind: 'FILE',
      location: 'packages/core/src/example.ts:10',
      description: 'The unchecked transition target.',
    },
  ],
  affectedFiles: ['packages/core/src/example.ts'],
  expectedResult: 'Review is required.',
  observedResult: 'Review can be skipped.',
  requiredAction: 'Validate the transition.',
  occurrenceLinks: [],
};

function reviewResult(target: PlanReviewTarget | CodeReviewTarget = PLAN_TARGET): object {
  return {
    schemaVersion: 1,
    contractKind: 'REVIEW_RESULT',
    target,
    verdict: 'NEEDS_REVISION',
    summary: 'One blocking finding.',
    findings: [FINDING],
  };
}

describe('review workflow handoff contracts', () => {
  it('parses all five versioned contract kinds', () => {
    expect(
      parseRefinementResult(
        JSON.stringify({
          schemaVersion: 1,
          contractKind: 'REFINEMENT_RESULT',
          summary: 'Refined into one batch.',
          refinedPlanContent: '# Refined plan',
          batchPlanVersionIds: ['batch-plan-1'],
          requirementCoverage: [
            {
              requirementId: 'requirement-1',
              batchPlanVersionIds: ['batch-plan-1'],
              acceptanceCriterionIds: ['criterion-1'],
            },
          ],
        }),
      ).contractKind,
    ).toBe('REFINEMENT_RESULT');
    expect(parseReviewResult(JSON.stringify(reviewResult())).contractKind).toBe('REVIEW_RESULT');
    expect(
      parseImplementationResult(
        JSON.stringify({
          schemaVersion: 1,
          contractKind: 'IMPLEMENTATION_RESULT',
          outcome: 'COMPLETE',
          summary: 'Implemented.',
          changedFiles: ['packages/core/src/example.ts'],
          verificationRecordIds: [],
        }),
      ).contractKind,
    ).toBe('IMPLEMENTATION_RESULT');
    expect(
      parseDispositionResult(
        JSON.stringify({
          schemaVersion: 1,
          contractKind: 'DISPOSITION_RESULT',
          target: {
            kind: 'CODE',
            resultingCommitSha: SHA_B,
          },
          summary: 'Finding fixed.',
          dispositions: [
            {
              findingId: 'finding-1',
              disposition: 'FIXED',
              explanation: 'Added the guard.',
              filesChanged: ['packages/core/src/example.ts'],
              verificationRecordIds: [],
              evidence: [
                {
                  kind: 'DIFF',
                  location: 'packages/core/src/example.ts',
                  description: 'Guard added.',
                },
              ],
            },
          ],
        }),
      ).contractKind,
    ).toBe('DISPOSITION_RESULT');
    expect(
      parseFinalAuditResult(
        JSON.stringify({
          schemaVersion: 1,
          contractKind: 'FINAL_AUDIT_RESULT',
          target: {
            kind: 'FINAL_AUDIT',
            reviewedCommitSha: SHA_B,
            repositoryContextSha: SHA_A,
            reviewRangeEvidenceId: 'range-final',
            patchHash: HASH_C,
            refinedPlanVersionId: 'refined-plan-1',
          },
          verdict: 'APPROVED',
          summary: 'All requirements pass.',
          findings: [],
          requirementChecks: [
            {
              subjectId: 'requirement-1',
              status: 'PASSED',
              explanation: 'Implemented.',
              evidence: [
                {
                  kind: 'DIFF',
                  location: 'packages/core/src/example.ts',
                  description: 'Implementation evidence.',
                },
              ],
            },
          ],
          acceptanceCriterionChecks: [],
          scopeComplete: true,
          documentationComplete: true,
        }),
      ).contractKind,
    ).toBe('FINAL_AUDIT_RESULT');
  });

  it('rejects prose, trailing text, unknown fields, and wrong versions', () => {
    // Fenced JSON used to be listed here as a rejection, on the reasonable stance that the
    // agent must return one JSON object and nothing else. Measurement overturned that: the
    // prompt already forbids fences, models fence anyway and nondeterministically, and the
    // document inside is intact — so the rule only ever destroyed correct work at the cost
    // of a paid invocation. A single fence carries no ambiguity, so it is now decoded; see
    // 'a markdown code fence is transport, not content'. Everything else here still fails,
    // including trailing text, which genuinely IS ambiguous about where the document ends.
    for (const raw of ['APPROVED', `${JSON.stringify(reviewResult())}\nApproved.`]) {
      expect(() => parseReviewResult(raw)).toThrowError(HandoffParseError);
    }
    expect(
      reviewResultContractSchema.safeParse({ ...reviewResult(), unexpected: true }).success,
    ).toBe(false);
    expect(
      reviewResultContractSchema.safeParse({ ...reviewResult(), schemaVersion: 2 }).success,
    ).toBe(false);
  });

  it('requires explicit, internally consistent verdicts', () => {
    expect(
      reviewResultContractSchema.safeParse({
        ...reviewResult(),
        verdict: 'APPROVED',
      }).success,
    ).toBe(false);
    expect(
      reviewResultContractSchema.safeParse({
        ...reviewResult(),
        verdict: 'NEEDS_REVISION',
        findings: [],
      }).success,
    ).toBe(false);
    expect(
      finalAuditResultContractSchema.safeParse({
        schemaVersion: 1,
        contractKind: 'FINAL_AUDIT_RESULT',
        target: {
          kind: 'FINAL_AUDIT',
          reviewedCommitSha: SHA_B,
          repositoryContextSha: SHA_A,
          reviewRangeEvidenceId: 'range-final',
          patchHash: HASH_C,
          refinedPlanVersionId: 'refined-plan-1',
        },
        verdict: 'APPROVED',
        summary: 'Incomplete audit.',
        findings: [],
        requirementChecks: [],
        acceptanceCriterionChecks: [],
        scopeComplete: false,
        documentationComplete: true,
      }).success,
    ).toBe(false);
  });

  it('validates browser findings as browser evidence instead of prose claims', () => {
    const browserFinding = {
      ...FINDING,
      findingKey: 'B7-BROWSER',
      severity: 'medium',
      category: 'browser_behaviour',
    };
    expect(
      reviewResultContractSchema.safeParse({
        ...reviewResult(),
        findings: [browserFinding],
      }).success,
    ).toBe(false);
    expect(
      reviewResultContractSchema.safeParse({
        ...reviewResult(),
        findings: [
          {
            ...browserFinding,
            repositoryEvidence: [
              {
                kind: 'BROWSER',
                location: 'browser://checkout',
                description: 'Rendered checkout screenshot and interaction trace.',
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('validates contract-specific completeness and uniqueness', () => {
    expect(
      refinementResultContractSchema.safeParse({
        schemaVersion: 1,
        contractKind: 'REFINEMENT_RESULT',
        summary: 'Duplicate batch.',
        refinedPlanContent: '# Plan',
        batchPlanVersionIds: ['batch-plan-1', 'batch-plan-1'],
        requirementCoverage: [],
      }).success,
    ).toBe(false);
    expect(
      refinementResultContractSchema.safeParse({
        schemaVersion: 1,
        contractKind: 'REFINEMENT_RESULT',
        summary: 'Uncovered requirement.',
        refinedPlanContent: '# Plan',
        batchPlanVersionIds: ['batch-plan-1'],
        requirementCoverage: [
          {
            requirementId: 'requirement-1',
            batchPlanVersionIds: [],
            acceptanceCriterionIds: [],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      implementationResultContractSchema.safeParse({
        schemaVersion: 1,
        contractKind: 'IMPLEMENTATION_RESULT',
        outcome: 'BLOCKED',
        summary: 'Cannot proceed.',
        changedFiles: [],
        verificationRecordIds: [],
      }).success,
    ).toBe(false);
  });

  it('binds responses to authoritative targets and complete finding sets', () => {
    expect(() => requireExpectedTarget(PLAN_TARGET, PLAN_TARGET)).not.toThrow();
    expect(() =>
      requireExpectedTarget(PLAN_TARGET, { ...PLAN_TARGET, planVersionId: 'other' }),
    ).toThrow(HandoffParseError);
    expect(() =>
      requireExpectedFindingIds(['finding-2', 'finding-1'], ['finding-1', 'finding-2']),
    ).not.toThrow();
    expect(() => requireExpectedFindingIds(['finding-1'], ['finding-1', 'finding-2'])).toThrow(
      HandoffParseError,
    );
  });

  it('derives stable, scope-bound finding and disposition IDs', () => {
    const findingInput = {
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      reviewRoundId: 'round-1',
      reviewKind: 'CODE',
      findingKey: 'B7-001',
    };
    expect(deriveFindingId(findingInput)).toBe(deriveFindingId(findingInput));
    expect(deriveFindingId({ ...findingInput, reviewRoundId: 'round-2' })).not.toBe(
      deriveFindingId(findingInput),
    );
    const dispositionInput = {
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      findingId: 'finding-1',
      actorExecutionId: 'actor-1',
      target: {
        kind: 'CODE',
        resultingCommitSha: SHA_B,
      },
    };
    expect(deriveDispositionId(dispositionInput)).toBe(deriveDispositionId(dispositionInput));
  });

  it('materializes plan and code findings through the same lifecycle contract', () => {
    const common = {
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      reviewRoundNumber: 1,
      reviewerActorExecutionId: 'reviewer-1',
      findings: [FINDING],
      createdAt: '2026-07-30T10:00:00+10:00',
    };
    const planFinding = materializeFindings({
      ...common,
      reviewRoundId: 'plan-round',
      reviewKind: 'PLAN',
      target: PLAN_TARGET,
    })[0];
    const codeFinding = materializeFindings({
      ...common,
      reviewRoundId: 'code-round',
      reviewKind: 'CODE',
      target: CODE_TARGET,
    })[0];
    expect(planFinding).toMatchObject({ status: 'OPEN', reviewKind: 'PLAN' });
    expect(planFinding?.reviewedCommitSha).toBeUndefined();
    expect(codeFinding).toMatchObject({
      status: 'OPEN',
      reviewKind: 'CODE',
      reviewedCommitSha: SHA_B,
    });
  });

  it('builds prompts that forbid prose inference and preserve structured context', () => {
    const prompt = buildStructuredHandoffPrompt({
      contractKind: 'REVIEW_RESULT',
      task: 'Review the batch.',
      context: { target: PLAN_TARGET },
    });
    expect(prompt).toContain('Return exactly one JSON object');
    expect(prompt).toContain('Do not use Markdown fences or add prose');
    expect(prompt).toContain('"contractKind": "REVIEW_RESULT"');
    expect(prompt).toContain('"planVersionId": "plan-v1"');
  });
});

describe('a markdown code fence is transport, not content', () => {
  // A real pre-flight produced a CONTRACT-PERFECT refinement outline — every field right,
  // ordinals sequential, IDs unique — that was rejected for its wrapper alone. Models fence
  // nondeterministically: the prompt above already says "Do not use Markdown fences", and
  // the model fenced anyway. Instructions cannot fix this; decoding the envelope can.
  const DOCUMENT = {
    schemaVersion: 1,
    contractKind: 'IMPLEMENTATION_RESULT',
    outcome: 'COMPLETE',
    summary: 'Implemented the batch.',
    changedFiles: ['src/example.ts'],
    verificationRecordIds: [],
  };

  it('accepts a fenced document, with or without a language tag', () => {
    for (const opener of ['```json', '```JSON', '```']) {
      const fenced = `${opener}\n${JSON.stringify(DOCUMENT, null, 2)}\n\`\`\``;
      expect(parseImplementationResult(fenced).summary, opener).toBe('Implemented the batch.');
    }
  });

  it('accepts a fence introduced by prose', () => {
    const fenced = `Here is the document:\n\`\`\`json\n${JSON.stringify(DOCUMENT)}\n\`\`\``;
    expect(parseImplementationResult(fenced).outcome).toBe('COMPLETE');
  });

  it('does NOT change how an unfenced document parses', () => {
    // The direct parse runs first and is untouched, so nothing that parses today can parse
    // differently — only previously-failing input ever reaches the unwrap.
    expect(parseImplementationResult(JSON.stringify(DOCUMENT)).outcome).toBe('COMPLETE');
  });

  it('preserves a document whose own CONTENT contains code fences', () => {
    // The refined plan is Markdown and legitimately contains ```bash blocks. Stopping at
    // the first inner fence would truncate the document, so the OUTERMOST fence is used.
    const withInnerFences = {
      schemaVersion: 1,
      contractKind: 'REFINEMENT_RESULT',
      summary: 'Refined.',
      refinedPlanContent: '# Plan\n\n```bash\npnpm test\n```\n\nDone.',
      batchPlanVersionIds: ['workflow-1:batch:1:plan:1'],
      requirementCoverage: [],
    };
    const unfenced = JSON.stringify(withInnerFences);
    expect(parseRefinementResult(unfenced).refinedPlanContent).toContain('```bash');

    const fenced = `\`\`\`json\n${JSON.stringify(withInnerFences, null, 2)}\n\`\`\``;
    expect(parseRefinementResult(fenced).refinedPlanContent).toContain('```bash');
  });

  it('rejects a response carrying two candidate documents as ambiguous', () => {
    const two = `\`\`\`json\n${JSON.stringify(DOCUMENT)}\n\`\`\`\n\nOr:\n\n\`\`\`json\n${JSON.stringify(DOCUMENT)}\n\`\`\``;
    expect(() => parseImplementationResult(two)).toThrow(HandoffParseError);
  });

  it('still rejects a response that is not JSON at all', () => {
    expect(() => parseImplementationResult('I could not complete this task.')).toThrow(
      /exactly one valid JSON value/,
    );
    expect(() => parseImplementationResult('```\nnot json\n```')).toThrow(
      /exactly one valid JSON value/,
    );
  });

  it('still applies the STRICT schema to whatever the fence contained', () => {
    // Decoding an envelope must not relax a contract: the same rejection, same path.
    const invented = { ...DOCUMENT, notes: 'an invented key' };
    expect(() =>
      parseImplementationResult(`\`\`\`json\n${JSON.stringify(invented)}\n\`\`\``),
    ).toThrow(/schema validation/);
  });
});
