import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import {
  ReviewWorkflowPersistenceError,
  ReviewWorkflowStore,
} from '../../../src/memory/review-workflow-store.js';
import {
  ReviewWorkflowContractService,
  hashHandoffContent,
} from '../../../src/review-workflow-contracts/index.js';
import type {
  CodeReviewTarget,
  DispositionResultContract,
  FinalAuditTarget,
  HandoffCaptureContext,
  HandoffTranscript,
  PlanReviewTarget,
} from '../../../src/review-workflow-contracts/index.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(64);
const CREATED_AT = '2026-07-30T10:00:00+10:00';
const PLAN_TARGET: PlanReviewTarget = {
  kind: 'PLAN',
  planVersionId: 'batch-plan-1',
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
const FINAL_TARGET: FinalAuditTarget = {
  kind: 'FINAL_AUDIT',
  reviewedCommitSha: SHA_B,
  repositoryContextSha: SHA_A,
  reviewRangeEvidenceId: 'range-final',
  patchHash: HASH_C,
  refinedPlanVersionId: 'refined-plan-1',
};

function findingDraft(findingKey = 'B7-001'): object {
  return {
    findingKey,
    severity: 'high',
    category: 'correctness',
    title: 'Unchecked state change',
    description: 'The state change bypasses review.',
    repositoryEvidence: [
      {
        kind: 'FILE',
        location: 'packages/core/src/example.ts:10',
        description: 'Unchecked transition.',
      },
    ],
    affectedFiles: ['packages/core/src/example.ts'],
    expectedResult: 'Review is mandatory.',
    observedResult: 'Review is bypassed.',
    requiredAction: 'Add the missing guard.',
    occurrenceLinks: [],
  };
}

describe('ReviewWorkflowContractService', () => {
  let db: Database.Database;
  let store: ReviewWorkflowStore;
  let service: ReviewWorkflowContractService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new ReviewWorkflowStore(db);
    service = new ReviewWorkflowContractService(store);
    store.createWorkflow({
      workflowId: 'workflow-1',
      status: 'ACTIVE',
      generalPlanVersionId: 'general-plan-1',
      implementerAssignmentId: 'implementer-assignment',
      reviewerAssignmentId: 'reviewer-assignment',
      configurationHash: HASH_C,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    store.createBatch({
      batchId: 'batch-1',
      workflowId: 'workflow-1',
      ordinal: 1,
      persistedState: 'DRAFT',
      aggregateVersion: 0,
      currentPlanVersionId: 'batch-plan-1',
      implementerAssignmentId: 'implementer-assignment',
      reviewerAssignmentId: 'reviewer-assignment',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
  });

  afterEach(() => db.close());

  function context(
    transcriptId: string,
    rawTranscript: string,
    actorExecutionId = 'reviewer-execution',
  ): HandoffCaptureContext & { readonly batchId: string } {
    return {
      transcriptId,
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      actorExecutionId,
      invocationId: 'invocation-1',
      sessionIdentityId: 'session-1',
      rawTranscript,
      createdAt: CREATED_AT,
    };
  }

  it('persists raw rejected output and creates no review artifacts or state approval', () => {
    const result = service.captureReview({
      ...context('transcript-invalid', 'APPROVED because it looks good.'),
      reviewRoundId: 'round-invalid',
      reviewRoundNumber: 1,
      expectedTarget: PLAN_TARGET,
    });

    expect(result).toMatchObject({
      accepted: false,
      error: { code: 'INVALID_JSON' },
      transcript: {
        parseStatus: 'REJECTED',
        rawTranscript: 'APPROVED because it looks good.',
      },
    });
    expect(store.getHandoffTranscript('transcript-invalid')).toEqual(result.transcript);
    expect(store.getStructuredReview('round-invalid')).toBeNull();
    expect(store.getBatch('batch-1')?.persistedState).toBe('DRAFT');
    expect(
      db
        .prepare(
          `SELECT raw_transcript
           FROM review_workflow_handoff_transcripts
           WHERE transcript_id = ?`,
        )
        .pluck()
        .get('transcript-invalid'),
    ).toBe('APPROVED because it looks good.');
  });

  it('persists a validated review, stable findings, and its raw transcript atomically', () => {
    const rawTranscript = JSON.stringify({
      schemaVersion: 1,
      contractKind: 'REVIEW_RESULT',
      target: PLAN_TARGET,
      verdict: 'NEEDS_REVISION',
      summary: 'One blocking finding.',
      findings: [findingDraft()],
    });
    const input = {
      ...context('transcript-plan-review', rawTranscript),
      reviewRoundId: 'plan-round-1',
      reviewRoundNumber: 1,
      expectedTarget: PLAN_TARGET,
    };
    const result = service.captureReview(input);

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const finding = result.value.findings[0];
    expect(finding).toMatchObject({
      reviewKind: 'PLAN',
      status: 'OPEN',
      reviewedArtifact: {
        artifactId: PLAN_TARGET.planVersionId,
        contentHash: PLAN_TARGET.planContentHash,
      },
    });
    expect(store.getStructuredReview('plan-round-1')).toEqual(result.value.review);
    expect(store.getEntity('FINDING', finding?.findingId ?? '')).toEqual({
      kind: 'FINDING',
      value: finding,
    });
    expect(result.transcript.parsedArtifactIds).toEqual(['plan-round-1', finding?.findingId]);
    expect(service.captureReview(input)).toEqual(result);
    expect(store.getBatch('batch-1')?.persistedState).toBe('DRAFT');
  });

  it('rejects a valid contract that echoes a stale target', () => {
    const result = service.captureReview({
      ...context(
        'transcript-stale-target',
        JSON.stringify({
          schemaVersion: 1,
          contractKind: 'REVIEW_RESULT',
          target: { ...PLAN_TARGET, planVersionId: 'stale-plan' },
          verdict: 'APPROVED',
          summary: 'No findings.',
          findings: [],
        }),
      ),
      reviewRoundId: 'round-stale',
      reviewRoundNumber: 1,
      expectedTarget: PLAN_TARGET,
    });
    expect(result).toMatchObject({
      accepted: false,
      error: { code: 'TARGET_MISMATCH' },
    });
    expect(store.getStructuredReview('round-stale')).toBeNull();
  });

  it('uses the same durable finding lifecycle for code review', () => {
    const result = service.captureReview({
      ...context(
        'transcript-code-review',
        JSON.stringify({
          schemaVersion: 1,
          contractKind: 'REVIEW_RESULT',
          target: CODE_TARGET,
          verdict: 'NEEDS_REVISION',
          summary: 'One code finding.',
          findings: [findingDraft('B7-CODE-001')],
        }),
      ),
      reviewRoundId: 'code-round-1',
      reviewRoundNumber: 1,
      expectedTarget: CODE_TARGET,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.findings[0]).toMatchObject({
      reviewKind: 'CODE',
      reviewedCommitSha: SHA_B,
      status: 'OPEN',
    });
  });

  it('persists explicit final-audit coverage alongside final-audit findings', () => {
    const result = service.captureFinalAudit({
      ...context(
        'transcript-final-audit',
        JSON.stringify({
          schemaVersion: 1,
          contractKind: 'FINAL_AUDIT_RESULT',
          target: FINAL_TARGET,
          verdict: 'APPROVED',
          summary: 'Everything passes.',
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
      ),
      reviewRoundId: 'final-round-1',
      reviewRoundNumber: 1,
      expectedTarget: FINAL_TARGET,
      expectedRequirementIds: ['requirement-1'],
      expectedAcceptanceCriterionIds: [],
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.review).toMatchObject({
      reviewKind: 'FINAL_AUDIT',
      verdict: 'APPROVED',
      scopeComplete: true,
      documentationComplete: true,
    });
  });

  it('rejects a final audit that omits an expected requirement or criterion', () => {
    const result = service.captureFinalAudit({
      ...context(
        'transcript-incomplete-final-audit',
        JSON.stringify({
          schemaVersion: 1,
          contractKind: 'FINAL_AUDIT_RESULT',
          target: FINAL_TARGET,
          verdict: 'APPROVED',
          summary: 'Claims complete coverage without checks.',
          findings: [],
          requirementChecks: [],
          acceptanceCriterionChecks: [],
          scopeComplete: true,
          documentationComplete: true,
        }),
      ),
      reviewRoundId: 'final-round-incomplete',
      reviewRoundNumber: 1,
      expectedTarget: FINAL_TARGET,
      expectedRequirementIds: ['requirement-1'],
      expectedAcceptanceCriterionIds: ['criterion-1'],
    });
    expect(result).toMatchObject({
      accepted: false,
      error: { code: 'SCHEMA_INVALID' },
    });
    expect(store.getStructuredReview('final-round-incomplete')).toBeNull();
  });

  it('persists refined-plan content by computed hash and validates requirement coverage', () => {
    const rawTranscript = JSON.stringify({
      schemaVersion: 1,
      contractKind: 'REFINEMENT_RESULT',
      summary: 'One batch covers the requirement.',
      refinedPlanContent: '# Refined plan\n\nImplement the contract.',
      batchPlanVersionIds: ['batch-plan-1'],
      requirementCoverage: [
        {
          requirementId: 'requirement-1',
          batchPlanVersionIds: ['batch-plan-1'],
          acceptanceCriterionIds: ['criterion-1'],
        },
      ],
    });
    const result = service.captureRefinement({
      transcriptId: 'transcript-refinement',
      workflowId: 'workflow-1',
      actorExecutionId: 'refiner-execution',
      rawTranscript,
      createdAt: CREATED_AT,
      generalPlanVersionId: 'general-plan-1',
      repositoryAuditId: 'audit-1',
      repositoryContextSha: SHA_A,
      refinedPlanVersionId: 'refined-plan-1',
      version: 1,
      expectedRequirementIds: ['requirement-1'],
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.refinedPlan.contentHash).toBe(
      hashHandoffContent('# Refined plan\n\nImplement the contract.'),
    );
    expect(store.getEntity('REFINED_PLAN_VERSION', 'refined-plan-1')).toEqual({
      kind: 'REFINED_PLAN_VERSION',
      value: result.value.refinedPlan,
    });
  });

  it('persists implementation claims without treating them as verification evidence', () => {
    const result = service.captureImplementation({
      ...context(
        'transcript-implementation',
        JSON.stringify({
          schemaVersion: 1,
          contractKind: 'IMPLEMENTATION_RESULT',
          outcome: 'COMPLETE',
          summary: 'Implemented the guard.',
          changedFiles: ['packages/core/src/example.ts'],
          verificationRecordIds: [],
        }),
        'implementer-execution',
      ),
      implementationAttemptId: 'attempt-1',
      attemptNumber: 1,
      approvedPlanVersionId: 'batch-plan-1',
      approvedPlanContentHash: HASH_C,
      originalBatchBaseSha: SHA_A,
      startingHeadSha: SHA_A,
      implementerAssignmentId: 'implementer-assignment',
      startedAt: '2026-07-30T09:00:00+10:00',
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.implementationAttempt).toMatchObject({
      claimedChangedFiles: ['packages/core/src/example.ts'],
      claimedVerificationRecordIds: [],
    });
    expect(
      db.prepare('SELECT COUNT(*) FROM review_workflow_verification_records').pluck().get(),
    ).toBe(0);
  });

  it('requires dispositions for the complete expected finding set', () => {
    const review = service.captureReview({
      ...context(
        'transcript-review-for-disposition',
        JSON.stringify({
          schemaVersion: 1,
          contractKind: 'REVIEW_RESULT',
          target: CODE_TARGET,
          verdict: 'NEEDS_REVISION',
          summary: 'One finding.',
          findings: [findingDraft()],
        }),
      ),
      reviewRoundId: 'round-for-disposition',
      reviewRoundNumber: 1,
      expectedTarget: CODE_TARGET,
    });
    expect(review.accepted).toBe(true);
    if (!review.accepted) return;
    const findingId = review.value.findings[0]?.findingId ?? '';
    const target: DispositionResultContract['target'] = {
      kind: 'CODE',
      resultingCommitSha: SHA_B,
    };
    const rawTranscript = JSON.stringify({
      schemaVersion: 1,
      contractKind: 'DISPOSITION_RESULT',
      target,
      summary: 'The finding was fixed.',
      dispositions: [
        {
          findingId,
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
    });
    const accepted = service.captureDispositions({
      ...context('transcript-disposition', rawTranscript, 'implementer-execution'),
      expectedTarget: target,
      expectedFindingIds: [findingId],
    });
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;
    expect(accepted.value.dispositions[0]).toMatchObject({
      findingId,
      reviewerDecision: { decision: 'PENDING' },
    });

    const rejected = service.captureDispositions({
      ...context('transcript-incomplete-disposition', rawTranscript, 'implementer-execution'),
      expectedTarget: target,
      expectedFindingIds: [findingId, 'finding-missing'],
    });
    expect(rejected).toMatchObject({
      accepted: false,
      error: { code: 'EXPECTED_FINDINGS_MISMATCH' },
    });

    const foreignRawTranscript = JSON.stringify({
      schemaVersion: 1,
      contractKind: 'DISPOSITION_RESULT',
      target,
      summary: 'Attempts to disposition an unrelated finding.',
      dispositions: [
        {
          findingId: 'foreign-finding',
          disposition: 'FIXED',
          explanation: 'Not part of this batch.',
          filesChanged: [],
          verificationRecordIds: [],
          evidence: [
            {
              kind: 'OTHER',
              location: 'external',
              description: 'Unrelated evidence.',
            },
          ],
        },
      ],
    });
    const foreign = service.captureDispositions({
      ...context('transcript-foreign-disposition', foreignRawTranscript, 'implementer-execution'),
      expectedTarget: target,
      expectedFindingIds: ['foreign-finding'],
    });
    expect(foreign).toMatchObject({
      accepted: false,
      error: { code: 'EXPECTED_FINDINGS_MISMATCH' },
    });
    expect(store.getHandoffTranscript('transcript-foreign-disposition')).toEqual(
      foreign.transcript,
    );
  });

  it('rejects persistence records whose raw hash or parsed artifact list is dishonest', () => {
    const transcript: HandoffTranscript = {
      transcriptId: 'transcript-integrity',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      contractKind: 'IMPLEMENTATION_RESULT',
      expectedSchemaVersion: 1,
      actorExecutionId: 'actor-1',
      rawTranscript: '{}',
      rawTranscriptHash: HASH_C,
      parseStatus: 'REJECTED',
      parsedArtifactIds: [],
      errorCode: 'SCHEMA_INVALID',
      errorMessage: 'Invalid.',
      createdAt: CREATED_AT,
    };
    expect(() => store.saveHandoffCapture({ transcript, entities: [] })).toThrowError(
      ReviewWorkflowPersistenceError,
    );

    const wrongArtifacts: HandoffTranscript = {
      transcriptId: 'transcript-artifacts',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      contractKind: 'IMPLEMENTATION_RESULT',
      expectedSchemaVersion: 1,
      actorExecutionId: 'actor-1',
      rawTranscript: '{}',
      rawTranscriptHash: hashHandoffContent('{}'),
      parseStatus: 'PARSED',
      parsedArtifactIds: ['not-the-entity'],
      createdAt: CREATED_AT,
    };
    expect(() =>
      store.saveHandoffCapture({
        transcript: wrongArtifacts,
        entities: [],
      }),
    ).toThrowError(ReviewWorkflowPersistenceError);

    const wrongContract: HandoffTranscript = {
      transcriptId: 'transcript-wrong-contract',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      contractKind: 'REFINEMENT_RESULT',
      expectedSchemaVersion: 1,
      actorExecutionId: 'implementer-execution',
      rawTranscript: '{}',
      rawTranscriptHash: hashHandoffContent('{}'),
      parseStatus: 'PARSED',
      parsedArtifactIds: ['attempt-wrong-contract'],
      createdAt: CREATED_AT,
    };
    expect(() =>
      store.saveHandoffCapture({
        transcript: wrongContract,
        entities: [
          {
            kind: 'IMPLEMENTATION_ATTEMPT',
            value: {
              implementationAttemptId: 'attempt-wrong-contract',
              workflowId: 'workflow-1',
              batchId: 'batch-1',
              attemptNumber: 2,
              approvedPlanVersionId: 'batch-plan-1',
              approvedPlanContentHash: HASH_C,
              originalBatchBaseSha: SHA_A,
              startingHeadSha: SHA_A,
              implementerAssignmentId: 'implementer-assignment',
              implementerActorExecutionId: 'implementer-execution',
              summary: 'Implementation attempt.',
              claimedChangedFiles: [],
              claimedVerificationRecordIds: [],
              startedAt: CREATED_AT,
            },
          },
        ],
      }),
    ).toThrowError(ReviewWorkflowPersistenceError);
    expect(store.getHandoffTranscript('transcript-wrong-contract')).toBeNull();
  });
});
