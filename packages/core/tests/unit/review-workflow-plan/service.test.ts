import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/schema.js';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowCommandStore } from '../../../src/memory/review-workflow-command-store.js';
import { ReviewWorkflowContractService } from '../../../src/review-workflow-contracts/service.js';
import { createReviewWorkflowConfigurationSnapshot } from '../../../src/review-workflow-identity/service.js';
import {
  ReviewWorkflowPlanService,
  deriveBatchPlanVersionId,
  deriveWorkflowBatchId,
} from '../../../src/review-workflow-plan/service.js';
import { ReviewWorkflowPlanStore } from '../../../src/review-workflow-plan/store.js';
import type {
  ActorExecutionIdentity,
  FindingSeverity,
  RoleSeparationEvidence,
} from '../../../src/review-workflow/types.js';

const NOW = '2026-07-30T10:00:00.000Z';
const SHA = 'a'.repeat(40);

function configuration() {
  return createReviewWorkflowConfigurationSnapshot(
    validateConfig({
      configVersion: 3,
      workflow: 'review-gated-batches',
      models: {
        implementer: {
          provider: 'anthropic',
          model: 'claude-supported',
          cliAdapter: {
            kind: 'claude',
            command: 'claude',
            args: [],
            timeout: 600,
            versionConstraint: '>=2',
          },
        },
        reviewer: {
          provider: 'openai',
          model: 'codex-supported',
          cliAdapter: {
            kind: 'codex',
            command: 'codex',
            args: ['exec'],
            timeout: 600,
            versionConstraint: '>=1',
          },
        },
      },
      roles: {
        implementer: { model: 'implementer' },
        reviewer: { model: 'reviewer' },
      },
      reviewGated: {
        identity: {
          minimumAssurance: 'process_attested',
          requireDifferentAdapterKinds: true,
          prohibitSharedSessions: true,
        },
        commit: { mode: 'either', agentMayCommit: true },
        gates: {
          planReview: 'required',
          codeReview: 'required',
          verification: 'required',
          humanMerge: 'required',
          blockingSeverities: ['critical', 'high'],
          requireAllFindingResponses: true,
          requireAcceptedAttestations: true,
        },
      },
      debate: { enabled: false },
    }),
    {
      workflowId: 'workflow-1',
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      assignedAt: NOW,
    },
  );
}

const OWNER: ActorExecutionIdentity = {
  actorExecutionId: 'owner-execution',
  actorType: 'HUMAN',
  authoritiesExercised: ['WORKFLOW_OWNER'],
  identityAssurance: 'CLI_ASSERTED',
  observedEvidence: [],
  startedAt: NOW,
};

const REFINER: ActorExecutionIdentity = {
  actorExecutionId: 'refiner-execution',
  actorType: 'HUMAN',
  authoritiesExercised: ['PLAN_REFINER'],
  identityAssurance: 'CLI_ASSERTED',
  observedEvidence: [],
  startedAt: NOW,
};

function refinementTranscript(
  requirementIds: readonly string[],
  invalidDependency = false,
): string {
  const firstBatchId = deriveWorkflowBatchId('workflow-1', 1);
  const secondBatchId = deriveWorkflowBatchId('workflow-1', 2);
  const firstPlanId = deriveBatchPlanVersionId(firstBatchId);
  const secondPlanId = deriveBatchPlanVersionId(secondBatchId);
  const batch = (
    batchId: string,
    planId: string,
    ordinal: number,
    dependencies: readonly string[],
    criterionId: string,
  ) => ({
    batchPlanVersionId: planId,
    batchId,
    ordinal,
    objective: `Deliver batch ${ordinal}`,
    currentRepositoryEvidence: [
      {
        kind: 'FILE',
        location: 'packages/core/src/index.ts',
        description: 'Current core public API.',
      },
    ],
    dependencies,
    candidateFiles: ['packages/core/src/index.ts'],
    technicalImplementation: ['Implement the approved objective.'],
    userJourney: ['The operator runs the documented command.'],
    expectedBehaviour: ['The command completes deterministically.'],
    acceptanceCriteria: [
      {
        acceptanceCriterionId: criterionId,
        kind: 'TECHNICAL',
        statement: `Batch ${ordinal} is complete.`,
        required: true,
        passCondition: 'The focused test passes.',
        sourceRequirementIds: [requirementIds[Math.min(ordinal - 1, requirementIds.length - 1)]],
      },
    ],
    technicalAcceptanceCriteria: [criterionId],
    userFacingAcceptanceCriteria: [],
    cliAcceptanceCriteria: [],
    browserAcceptanceCriteria: {
      applicability: 'NOT_APPLICABLE',
      reason: 'Core-only batch.',
    },
    verificationCommands: [
      {
        executable: 'pnpm',
        arguments: ['test'],
        workingDirectory: '.',
        verificationType: 'test',
        relatedCriterionIds: [criterionId],
      },
    ],
    manualVerification: [],
    documentationChanges: [],
    outOfScope: ['Implementation work from later batches.'],
    rollbackBoundary: `Revert batch ${ordinal}.`,
  });
  return JSON.stringify({
    schemaVersion: 1,
    contractKind: 'REFINEMENT_RESULT',
    summary: 'Two complete atomic batches.',
    refinedPlanContent: 'Batch 1, then Batch 2.',
    batchPlanVersionIds: [firstPlanId, secondPlanId],
    requirementCoverage: requirementIds.map((requirementId, index) => ({
      requirementId,
      batchPlanVersionIds: [index === 0 ? firstPlanId : secondPlanId],
      acceptanceCriterionIds: [index === 0 ? 'criterion-1' : 'criterion-2'],
    })),
    batchPlans: [
      batch(firstBatchId, firstPlanId, 1, invalidDependency ? [secondBatchId] : [], 'criterion-1'),
      batch(secondBatchId, secondPlanId, 2, [firstBatchId], 'criterion-2'),
    ],
  });
}

describe('ReviewWorkflowPlanService', () => {
  let db: Database.Database;
  let store: ReviewWorkflowPlanStore;
  let service: ReviewWorkflowPlanService;
  let requirementIds: readonly string[];
  let repositoryHead: string;
  let repositoryDirty: boolean;
  const snapshot = configuration();

  beforeEach(() => {
    repositoryHead = SHA;
    repositoryDirty = false;
    db = openDatabase(':memory:');
    store = new ReviewWorkflowPlanStore(db);
    service = new ReviewWorkflowPlanService(
      store,
      new ReviewWorkflowCommandStore(db, () => new Date(NOW)),
      new ReviewWorkflowContractService(store.workflowStore),
      {
        captureRepositoryAudit: (request) => ({
          repositoryAuditId: request.repositoryAuditId,
          workflowId: request.workflowId,
          repositoryRoot: '/repo',
          branch: 'master',
          headSha: repositoryHead,
          dirty: repositoryDirty,
          evidence: [
            {
              kind: 'COMMAND',
              location: '/repo',
              description: 'Fresh git status.',
            },
          ],
          actorExecutionId: request.actorExecutionId,
          observedAt: NOW,
        }),
      },
    );
    requirementIds = service.initialize({
      workflowId: 'workflow-1',
      planContent: '## Audit\nInspect the repository.\n\n## Gate\nReview every batch plan.',
      sourceType: 'MARKDOWN_FILE',
      sourceLocation: '/repo/plan.md',
      authorEvidence: [],
      owner: OWNER,
      configuration: snapshot,
      repositoryAuditId: 'audit-1',
      createdAt: NOW,
    }).requirementIds;
  });

  afterEach(() => db.close());

  it('persists a complete refinement, creates sequential draft batches, and updates the pointer', () => {
    const result = service.captureRefinement({
      transcriptId: 'refinement-transcript',
      workflowId: 'workflow-1',
      actorExecutionId: REFINER.actorExecutionId,
      rawTranscript: refinementTranscript(requirementIds),
      createdAt: NOW,
      expectedFirstBatchId: deriveWorkflowBatchId('workflow-1', 1),
      refinedPlanVersionId: 'refined-plan-1',
      repositoryAuditId: 'audit-1',
      version: 1,
      actor: REFINER,
    });

    expect(result.accepted).toBe(true);
    expect(service.getStatus('workflow-1').batches).toMatchObject([
      { ordinal: 1, persistedState: 'DRAFT', originalBatchBaseSha: SHA },
      { ordinal: 2, persistedState: 'DRAFT', originalBatchBaseSha: SHA },
    ]);
    expect(store.getWorkflow('workflow-1')?.refinedPlanVersionId).toBe('refined-plan-1');
    expect(
      store.getBatchPlan(deriveBatchPlanVersionId(deriveWorkflowBatchId('workflow-1', 1))),
    ).not.toBeNull();
    expect(
      store.listAcceptanceCriteria(
        deriveBatchPlanVersionId(deriveWorkflowBatchId('workflow-1', 1)),
      ),
    ).toHaveLength(1);
  });

  it('records and rejects a refinement that depends on a later batch', () => {
    const result = service.captureRefinement({
      transcriptId: 'invalid-refinement-transcript',
      workflowId: 'workflow-1',
      actorExecutionId: REFINER.actorExecutionId,
      rawTranscript: refinementTranscript(requirementIds, true),
      createdAt: NOW,
      expectedFirstBatchId: deriveWorkflowBatchId('workflow-1', 1),
      refinedPlanVersionId: 'refined-plan-invalid',
      repositoryAuditId: 'audit-1',
      version: 1,
      actor: REFINER,
    });

    expect(result).toMatchObject({
      accepted: false,
      error: { code: 'SCHEMA_INVALID' },
      transcript: { parseStatus: 'REJECTED' },
    });
    expect(service.getStatus('workflow-1').batches).toEqual([]);
    expect(store.workflowStore.getHandoffTranscript('invalid-refinement-transcript')).toEqual(
      result.transcript,
    );
  });

  it('rejects refinement when fresh repository state no longer matches the intake audit', () => {
    repositoryHead = 'b'.repeat(40);

    expect(() =>
      service.captureRefinement({
        transcriptId: 'stale-repository-refinement',
        workflowId: 'workflow-1',
        actorExecutionId: REFINER.actorExecutionId,
        rawTranscript: refinementTranscript(requirementIds),
        createdAt: NOW,
        expectedFirstBatchId: deriveWorkflowBatchId('workflow-1', 1),
        refinedPlanVersionId: 'refined-plan-stale',
        repositoryAuditId: 'audit-1',
        version: 1,
        actor: REFINER,
      }),
    ).toThrowError('Repository state changed');
    expect(service.getStatus('workflow-1').batches).toEqual([]);
  });

  it.each([
    {
      verdict: 'APPROVED',
      findings: [],
      expectedState: 'APPROVED_FOR_IMPLEMENTATION',
      expectedCount: 0,
    },
    {
      verdict: 'NEEDS_REVISION',
      findings: [
        {
          findingKey: 'B10-001',
          severity: 'high',
          category: 'correctness',
          title: 'Missing guard',
          description: 'The plan omits a required guard.',
          repositoryEvidence: [
            {
              kind: 'PLAN',
              location: 'batch plan',
              description: 'Guard is absent.',
            },
          ],
          affectedFiles: [],
          expectedResult: 'The guard is planned.',
          observedResult: 'The guard is missing.',
          requiredAction: 'Add the guard to the batch plan.',
          occurrenceLinks: [],
        },
      ],
      expectedState: 'PLAN_NEEDS_REVISION',
      expectedCount: 1,
    },
  ])(
    'moves an independently reviewed plan to $expectedState',
    ({ verdict, findings, expectedState, expectedCount }) => {
      const refinement = service.captureRefinement({
        transcriptId: 'reviewable-refinement',
        workflowId: 'workflow-1',
        actorExecutionId: REFINER.actorExecutionId,
        rawTranscript: refinementTranscript(requirementIds),
        createdAt: NOW,
        expectedFirstBatchId: deriveWorkflowBatchId('workflow-1', 1),
        refinedPlanVersionId: 'refined-plan-reviewable',
        repositoryAuditId: 'audit-1',
        version: 1,
        actor: REFINER,
      });
      expect(refinement.accepted).toBe(true);
      const batchId = deriveWorkflowBatchId('workflow-1', 1);
      const plan = store.getBatchPlan(deriveBatchPlanVersionId(batchId));
      expect(plan).not.toBeNull();
      if (plan === null) return;
      const reviewer: ActorExecutionIdentity = {
        actorExecutionId: `reviewer-${verdict}`,
        actorType: 'AGENT',
        assignmentId: snapshot.assignments.reviewer.assignmentId,
        sessionIdentityId: `reviewer-session-${verdict}`,
        authoritiesExercised: ['REVIEWER'],
        identityAssurance: 'PROCESS_ATTESTED',
        observedEvidence: [],
        startedAt: NOW,
      };
      const roleSeparation: RoleSeparationEvidence = {
        implementerAssignment: snapshot.assignments.implementer,
        reviewerAssignment: snapshot.assignments.reviewer,
        reviewerSessionIdentityId: reviewer.sessionIdentityId,
        minimumIdentityAssurance: 'PROCESS_ATTESTED',
      };
      const blockingSeverities: readonly FindingSeverity[] = ['critical', 'high'];
      const review = service.capturePlanReview({
        transcriptId: `review-transcript-${verdict}`,
        workflowId: 'workflow-1',
        batchId,
        actorExecutionId: reviewer.actorExecutionId,
        sessionIdentityId: reviewer.sessionIdentityId,
        rawTranscript: JSON.stringify({
          schemaVersion: 1,
          contractKind: 'REVIEW_RESULT',
          target: {
            kind: 'PLAN',
            planVersionId: plan.batchPlanVersionId,
            planContentHash: plan.contentHash,
            repositoryContextSha: plan.repositoryContextSha,
          },
          verdict,
          summary: verdict === 'APPROVED' ? 'Plan is complete.' : 'Plan needs one correction.',
          findings,
        }),
        createdAt: NOW,
        reviewRoundId: `review-round-${verdict}`,
        reviewRoundNumber: 1,
        actor: reviewer,
        roleSeparation,
        blockingSeverities,
      });

      expect(review.capture.accepted).toBe(true);
      expect(review.state).toBe(expectedState);
      expect(review.blockingFindingCount).toBe(expectedCount);
      expect(store.getBatch(batchId)?.persistedState).toBe(expectedState);
    },
  );
});
