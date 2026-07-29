import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowCommandStore } from '../../../src/memory/review-workflow-command-store.js';
import {
  type PersistableReviewWorkflowEntity,
  ReviewWorkflowPersistenceError,
  ReviewWorkflowStore,
} from '../../../src/memory/review-workflow-store.js';
import type {
  AcceptanceCriterion,
  ActorExecutionIdentity,
  AgentAssignment,
  BatchPlanVersion,
  Finding,
  FindingDisposition,
  GeneralPlanVersion,
  ImplementationAttempt,
  ImplementationCommit,
  ImplementationReadyEvidence,
  InvocationIdentity,
  PlanRequirement,
  RefinedPlanVersion,
  RepositoryAudit,
  ReviewRangeEvidence,
  ReviewWorkflowBatch,
  SessionIdentity,
  StateChangingCommandRequest,
  VerificationAttestation,
  VerificationRecord,
  WorkflowRun,
} from '../../../src/review-workflow/types.js';

const NOW = '2026-07-29T00:00:00.000Z';
const LATER = '2026-07-29T00:01:00.000Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const WORKFLOW: WorkflowRun = {
  workflowId: 'workflow-1',
  status: 'ACTIVE',
  generalPlanVersionId: 'general-plan-1',
  refinedPlanVersionId: 'refined-plan-1',
  implementerAssignmentId: 'assignment-implementer',
  reviewerAssignmentId: 'assignment-reviewer',
  configurationHash: 'configuration-hash',
  createdAt: NOW,
  updatedAt: NOW,
};

const BATCH: ReviewWorkflowBatch = {
  batchId: 'batch-1',
  workflowId: WORKFLOW.workflowId,
  ordinal: 1,
  persistedState: 'DRAFT',
  aggregateVersion: 0,
  currentPlanVersionId: 'batch-plan-1',
  implementerAssignmentId: WORKFLOW.implementerAssignmentId,
  reviewerAssignmentId: WORKFLOW.reviewerAssignmentId,
  originalBatchBaseSha: SHA_A,
  createdAt: NOW,
  updatedAt: NOW,
};

const OWNER: ActorExecutionIdentity = {
  actorExecutionId: 'actor-owner',
  actorType: 'HUMAN',
  authoritiesExercised: ['WORKFLOW_OWNER'],
  identityAssurance: 'CLI_ASSERTED',
  observedEvidence: [],
  startedAt: NOW,
};

function commandRequest(): StateChangingCommandRequest {
  return {
    commandId: 'command-block',
    workflowId: WORKFLOW.workflowId,
    batchId: BATCH.batchId,
    expectedAggregateVersion: 0,
    canonicalRequestHash: 'request-hash',
    requester: OWNER,
    authorityExercised: 'WORKFLOW_OWNER',
    command: { type: 'BLOCK_BATCH', reason: 'Waiting for external evidence.' },
  };
}

describe('ReviewWorkflowStore', () => {
  let db: Database.Database;
  let store: ReviewWorkflowStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new ReviewWorkflowStore(db);
    store.createWorkflow(WORKFLOW);
    store.createBatch(BATCH);
  });

  afterEach(() => {
    db.close();
  });

  it('creates and retrieves workflow and batch snapshots', () => {
    expect(store.getWorkflow(WORKFLOW.workflowId)).toEqual(WORKFLOW);
    expect(store.getBatch(BATCH.batchId)).toEqual(BATCH);
    expect(store.createWorkflow(WORKFLOW)).toEqual({ inserted: false });
    expect(store.createBatch(BATCH)).toEqual({ inserted: false });
  });

  it('enforces workflow foreign keys for batch snapshots', () => {
    expect(() =>
      store.createBatch({
        ...BATCH,
        batchId: 'batch-orphan',
        workflowId: 'missing-workflow',
        ordinal: 2,
      }),
    ).toThrow();
  });

  it('persists and validates every Batch 1 entity category', () => {
    const commandStore = new ReviewWorkflowCommandStore(db);
    commandStore.reserve(commandRequest());

    const implementerAssignment: AgentAssignment = {
      assignmentId: WORKFLOW.implementerAssignmentId,
      workflowId: WORKFLOW.workflowId,
      batchId: BATCH.batchId,
      assignedRole: 'IMPLEMENTER',
      configuredAgentKey: 'claude-implementer',
      configuredModelAlias: 'claude',
      expectedAdapterKind: 'CLAUDE',
      provider: 'anthropic',
      configuredModel: 'claude-model',
      commitPermission: 'AUTHORIZED',
      configurationHash: 'assignment-hash-implementer',
      assignedAt: NOW,
    };
    const reviewerAssignment: AgentAssignment = {
      assignmentId: WORKFLOW.reviewerAssignmentId,
      workflowId: WORKFLOW.workflowId,
      batchId: BATCH.batchId,
      assignedRole: 'REVIEWER',
      configuredAgentKey: 'codex-reviewer',
      configuredModelAlias: 'codex',
      expectedAdapterKind: 'CODEX',
      provider: 'openai',
      configuredModel: 'codex-model',
      commitPermission: 'DENIED',
      configurationHash: 'assignment-hash-reviewer',
      assignedAt: NOW,
    };
    const implementerActor: ActorExecutionIdentity = {
      actorExecutionId: 'actor-implementer',
      actorType: 'AGENT',
      assignmentId: implementerAssignment.assignmentId,
      invocationIdentityId: 'invocation-implementer',
      sessionIdentityId: 'session-implementer',
      authoritiesExercised: ['IMPLEMENTER', 'COMMIT_CREATOR'],
      identityAssurance: 'PROCESS_ATTESTED',
      observedEvidence: [],
      startedAt: NOW,
      finishedAt: LATER,
    };
    const reviewerActor: ActorExecutionIdentity = {
      actorExecutionId: 'actor-reviewer',
      actorType: 'AGENT',
      assignmentId: reviewerAssignment.assignmentId,
      authoritiesExercised: ['REVIEWER'],
      identityAssurance: 'PROCESS_ATTESTED',
      observedEvidence: [],
      startedAt: NOW,
      finishedAt: LATER,
    };
    const generalPlan: GeneralPlanVersion = {
      generalPlanVersionId: WORKFLOW.generalPlanVersionId,
      workflowId: WORKFLOW.workflowId,
      version: 1,
      sourceType: 'MARKDOWN',
      content: '# General plan',
      contentHash: 'general-plan-hash',
      authorEvidence: [],
      createdAt: NOW,
    };
    const requirement: PlanRequirement = {
      requirementId: 'requirement-1',
      generalPlanVersionId: generalPlan.generalPlanVersionId,
      sourceReference: 'General plan §1',
      statement: 'Persist review workflow evidence.',
      required: true,
      createdAt: NOW,
    };
    const audit: RepositoryAudit = {
      repositoryAuditId: 'audit-1',
      workflowId: WORKFLOW.workflowId,
      repositoryRoot: '/repository',
      branch: 'master',
      headSha: SHA_A,
      dirty: false,
      evidence: [
        {
          kind: 'FILE',
          location: 'package.json',
          description: 'Repository manifest.',
        },
      ],
      actorExecutionId: OWNER.actorExecutionId,
      observedAt: NOW,
    };
    const refinedPlan: RefinedPlanVersion = {
      refinedPlanVersionId: 'refined-plan-1',
      workflowId: WORKFLOW.workflowId,
      generalPlanVersionId: generalPlan.generalPlanVersionId,
      repositoryAuditId: audit.repositoryAuditId,
      repositoryContextSha: SHA_A,
      version: 1,
      contentHash: 'refined-plan-hash',
      batchPlanVersionIds: [BATCH.currentPlanVersionId],
      requirementCoverage: [
        {
          requirementId: requirement.requirementId,
          batchPlanVersionIds: [BATCH.currentPlanVersionId],
          acceptanceCriterionIds: ['criterion-1'],
        },
      ],
      actorExecutionId: OWNER.actorExecutionId,
      createdAt: NOW,
    };
    const batchPlan: BatchPlanVersion = {
      batchPlanVersionId: BATCH.currentPlanVersionId,
      workflowId: WORKFLOW.workflowId,
      batchId: BATCH.batchId,
      version: 1,
      contentHash: 'batch-plan-hash',
      repositoryContextSha: SHA_A,
      objective: 'Persist workflow state.',
      currentRepositoryEvidence: [
        {
          kind: 'FILE',
          location: 'packages/core/src/memory/database.ts',
          description: 'Existing SQLite migration seam.',
        },
      ],
      dependencies: [],
      candidateFiles: ['packages/core/src/memory/database.ts'],
      technicalImplementation: ['Add additive tables.'],
      userJourney: ['Existing commands continue to work.'],
      expectedBehaviour: ['Retries replay stored command results.'],
      technicalAcceptanceCriteria: ['criterion-1'],
      userFacingAcceptanceCriteria: [],
      cliAcceptanceCriteria: [],
      browserAcceptanceCriteria: {
        applicability: 'NOT_APPLICABLE',
        reason: 'The web package is a placeholder.',
      },
      verificationCommands: [],
      manualVerification: ['Inspect the migrated schema.'],
      documentationChanges: ['Document idempotency.'],
      outOfScope: ['Subprocess invocation.'],
      rollbackBoundary: 'Old code ignores additive tables.',
      addressedFindingIds: [],
      actorExecutionId: OWNER.actorExecutionId,
      createdAt: NOW,
    };
    const criterion: AcceptanceCriterion = {
      acceptanceCriterionId: 'criterion-1',
      batchPlanVersionId: batchPlan.batchPlanVersionId,
      kind: 'TECHNICAL',
      statement: 'A stale aggregate write fails.',
      required: true,
      passCondition: 'The store reports AGGREGATE_VERSION_CONFLICT.',
      status: 'PENDING',
      sourceRequirementIds: [requirement.requirementId],
      createdAt: NOW,
    };
    const invocation: InvocationIdentity = {
      invocationId: 'invocation-owner',
      commandId: commandRequest().commandId,
      actorMechanism: 'HUMAN_CLI',
      workingDirectory: '/repository',
      startedAt: NOW,
      finishedAt: LATER,
      resultStatus: 'SUCCEEDED',
    };
    const session: SessionIdentity = {
      sessionIdentityId: 'session-owner',
      workflowId: WORKFLOW.workflowId,
      providerOrAdapter: 'human-cli',
      vendorSessionId: 'terminal-1',
      creatingInvocationId: invocation.invocationId,
      resumeLineage: [],
      assignedRole: 'REVIEWER',
      createdAt: NOW,
      lastUsedAt: LATER,
    };
    const attempt: ImplementationAttempt = {
      implementationAttemptId: 'attempt-1',
      workflowId: WORKFLOW.workflowId,
      batchId: BATCH.batchId,
      attemptNumber: 1,
      approvedPlanVersionId: batchPlan.batchPlanVersionId,
      approvedPlanContentHash: batchPlan.contentHash,
      originalBatchBaseSha: SHA_A,
      startingHeadSha: SHA_A,
      implementerAssignmentId: implementerAssignment.assignmentId,
      implementerActorExecutionId: implementerActor.actorExecutionId,
      summary: 'Implemented persistence.',
      claimedChangedFiles: ['packages/core/src/memory/database.ts'],
      claimedVerificationRecordIds: [],
      startedAt: NOW,
      finishedAt: LATER,
    };
    const readyEvidence: ImplementationReadyEvidence = {
      implementationReadyEvidenceId: 'ready-1',
      implementationAttemptId: attempt.implementationAttemptId,
      actorExecutionId: implementerActor.actorExecutionId,
      worktreeFingerprint: 'worktree-hash',
      changedFiles: attempt.claimedChangedFiles,
      summary: 'Ready for a commit.',
      capturedAt: LATER,
    };
    const commit: ImplementationCommit = {
      implementationAttemptId: attempt.implementationAttemptId,
      implementationReadyEvidenceId: readyEvidence.implementationReadyEvidenceId,
      resultingCommitSha: SHA_B,
      parentShas: [SHA_A],
      treeSha: SHA_C,
      creatorActorExecutionId: implementerActor.actorExecutionId,
      creationMode: 'AGENT_AUTHORIZED',
      gitAuthor: {},
      gitCommitter: {},
      cleanWorktreeValidation: { valid: true, evidence: ['clean'] },
      ancestryValidation: { valid: true, evidence: ['ancestor'] },
      validatedAt: LATER,
    };
    const finding: Finding = {
      findingId: 'finding-1',
      workflowId: WORKFLOW.workflowId,
      batchId: BATCH.batchId,
      reviewRoundId: 'review-round-1',
      reviewRoundNumber: 1,
      reviewKind: 'PLAN',
      severity: 'medium',
      category: 'architecture',
      title: 'Persist command receipts first',
      description: 'Side effects require durable reservation.',
      repositoryEvidence: batchPlan.currentRepositoryEvidence,
      affectedFiles: ['packages/core/src/memory/database.ts'],
      acceptanceCriterionId: criterion.acceptanceCriterionId,
      expectedResult: 'A receipt exists before invocation.',
      observedResult: 'No receipt store existed.',
      requiredAction: 'Add command reservation.',
      reviewerActorExecutionId: reviewerActor.actorExecutionId,
      reviewedArtifact: { artifactId: batchPlan.batchPlanVersionId },
      repositoryContextSha: SHA_A,
      status: 'OPEN',
      occurrenceLinks: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const disposition: FindingDisposition = {
      dispositionId: 'disposition-1',
      findingId: finding.findingId,
      disposition: 'FIXED',
      explanation: 'Added durable command reservation.',
      actorExecutionId: implementerActor.actorExecutionId,
      filesChanged: ['packages/core/src/memory/review-workflow-command-store.ts'],
      verificationRecordIds: [],
      evidence: [
        {
          kind: 'FILE',
          location: 'packages/core/src/memory/review-workflow-command-store.ts',
          description: 'Command receipt implementation.',
        },
      ],
      resultTarget: {
        kind: 'PLAN',
        planVersionId: batchPlan.batchPlanVersionId,
        planContentHash: batchPlan.contentHash,
        repositoryContextSha: SHA_A,
      },
      reviewerDecision: {
        decision: 'ACCEPTED',
        reviewerActorExecutionId: reviewerActor.actorExecutionId,
        rationale: 'The plan now covers reservation.',
        decidedAt: LATER,
      },
      createdAt: NOW,
      updatedAt: LATER,
    };
    const verificationRecord: VerificationRecord = {
      verificationRecordId: 'verification-1',
      command: 'pnpm',
      arguments: ['test'],
      workingDirectory: '/repository',
      startedAt: NOW,
      finishedAt: LATER,
      outcome: { kind: 'EXITED', exitCode: 0 },
      outputSummary: 'Tests passed.',
      fullLogLocation: '/logs/test.log',
      fullLogHash: 'verification-log-hash',
      relatedCriterionIds: [criterion.acceptanceCriterionId],
      relatedFindingIds: [finding.findingId],
      commitSha: SHA_B,
      executorActorExecutionId: 'actor-verification-executor',
      executorActorType: 'HUMAN',
      verificationType: 'test',
      configurationHash: 'verification-configuration-hash',
      observedStatus: 'SUCCEEDED',
    };
    const attestation: VerificationAttestation = {
      verificationAttestationId: 'attestation-1',
      verificationRecordId: verificationRecord.verificationRecordId,
      evidenceHash: 'verification-evidence-hash',
      workflowId: WORKFLOW.workflowId,
      batchId: BATCH.batchId,
      relatedCriterionIds: verificationRecord.relatedCriterionIds,
      relatedFindingIds: verificationRecord.relatedFindingIds,
      decision: 'ACCEPTED',
      acceptanceMode: 'HUMAN',
      rationale: 'The verification evidence is complete.',
      attestorActorExecutionId: OWNER.actorExecutionId,
      attestorActorType: 'HUMAN',
      authorityExercised: 'VERIFICATION_ATTESTOR',
      recordVerificationType: verificationRecord.verificationType,
      recordExecutorActorExecutionId: verificationRecord.executorActorExecutionId,
      recordExecutorActorType: verificationRecord.executorActorType,
      reviewedCommitSha: SHA_B,
      policyConfigurationHash: 'policy-hash',
      createdAt: LATER,
    };
    const rangeEvidence: ReviewRangeEvidence = {
      vocabulary: {
        originalBatchBaseSha: SHA_A,
        previousReviewedImplementationSha: SHA_A,
        currentImplementationSha: SHA_B,
        currentBranchHeadSha: SHA_B,
      },
      ranges: [{ kind: 'INITIAL', fromSha: SHA_A, toSha: SHA_B }],
      patchHash: 'patch-hash',
      changedFiles: [{ path: 'packages/core/src/memory/database.ts', status: 'M' }],
      cumulativePatchLocation: '/patches/cumulative.patch',
      capturedAt: LATER,
    };

    const entities: readonly {
      readonly id: string;
      readonly entity: PersistableReviewWorkflowEntity;
    }[] = [
      {
        id: implementerAssignment.assignmentId,
        entity: { kind: 'AGENT_ASSIGNMENT', value: implementerAssignment },
      },
      {
        id: reviewerAssignment.assignmentId,
        entity: { kind: 'AGENT_ASSIGNMENT', value: reviewerAssignment },
      },
      {
        id: implementerActor.actorExecutionId,
        entity: { kind: 'ACTOR_EXECUTION', value: implementerActor },
      },
      {
        id: reviewerActor.actorExecutionId,
        entity: { kind: 'ACTOR_EXECUTION', value: reviewerActor },
      },
      {
        id: invocation.invocationId,
        entity: { kind: 'INVOCATION_IDENTITY', value: invocation },
      },
      {
        id: session.sessionIdentityId,
        entity: { kind: 'SESSION_IDENTITY', value: session },
      },
      {
        id: generalPlan.generalPlanVersionId,
        entity: { kind: 'GENERAL_PLAN_VERSION', value: generalPlan },
      },
      {
        id: requirement.requirementId,
        entity: { kind: 'PLAN_REQUIREMENT', value: requirement },
      },
      {
        id: audit.repositoryAuditId,
        entity: { kind: 'REPOSITORY_AUDIT', value: audit },
      },
      {
        id: refinedPlan.refinedPlanVersionId,
        entity: { kind: 'REFINED_PLAN_VERSION', value: refinedPlan },
      },
      {
        id: batchPlan.batchPlanVersionId,
        entity: { kind: 'BATCH_PLAN_VERSION', value: batchPlan },
      },
      {
        id: criterion.acceptanceCriterionId,
        entity: { kind: 'ACCEPTANCE_CRITERION', value: criterion },
      },
      {
        id: attempt.implementationAttemptId,
        entity: { kind: 'IMPLEMENTATION_ATTEMPT', value: attempt },
      },
      {
        id: readyEvidence.implementationReadyEvidenceId,
        entity: { kind: 'IMPLEMENTATION_READY_EVIDENCE', value: readyEvidence },
      },
      {
        id: commit.resultingCommitSha,
        entity: { kind: 'IMPLEMENTATION_COMMIT', value: commit },
      },
      {
        id: finding.findingId,
        entity: { kind: 'FINDING', value: finding },
      },
      {
        id: disposition.dispositionId,
        entity: { kind: 'FINDING_DISPOSITION', value: disposition },
      },
      {
        id: verificationRecord.verificationRecordId,
        entity: {
          kind: 'VERIFICATION_RECORD',
          workflowId: WORKFLOW.workflowId,
          batchId: BATCH.batchId,
          value: verificationRecord,
        },
      },
      {
        id: attestation.verificationAttestationId,
        entity: { kind: 'VERIFICATION_ATTESTATION', value: attestation },
      },
      {
        id: 'range-1',
        entity: {
          kind: 'REVIEW_RANGE_EVIDENCE',
          reviewRangeEvidenceId: 'range-1',
          workflowId: WORKFLOW.workflowId,
          batchId: BATCH.batchId,
          value: rangeEvidence,
        },
      },
    ];

    for (const { id, entity } of entities) {
      expect(store.saveEntity(entity)).toEqual({ inserted: true });
      expect(store.getEntity(entity.kind, id)).toEqual(entity);
      expect(store.saveEntity(entity)).toEqual({ inserted: false });
    }

    expect(store.getEntity('GENERAL_PLAN_VERSION', refinedPlan.refinedPlanVersionId)).toBeNull();
    expect(store.getEntity('REFINED_PLAN_VERSION', batchPlan.batchPlanVersionId)).toBeNull();
  });

  it('rejects conflicting immutable entity content and direct evidence mutation', () => {
    const plan = {
      generalPlanVersionId: WORKFLOW.generalPlanVersionId,
      workflowId: WORKFLOW.workflowId,
      version: 1,
      sourceType: 'MARKDOWN',
      content: '# Original',
      contentHash: 'plan-hash',
      authorEvidence: [],
      createdAt: NOW,
    };
    store.saveEntity({ kind: 'GENERAL_PLAN_VERSION', value: plan });

    try {
      store.saveEntity({
        kind: 'GENERAL_PLAN_VERSION',
        value: { ...plan, content: '# Changed', contentHash: 'changed-hash' },
      });
      throw new Error('Expected immutable entity conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewWorkflowPersistenceError);
      if (!(error instanceof ReviewWorkflowPersistenceError)) throw error;
      expect(error.code).toBe('IMMUTABLE_ENTITY_CONFLICT');
    }

    expect(() =>
      db
        .prepare(
          `UPDATE review_workflow_plan_documents
           SET content_hash = 'mutated'
           WHERE document_id = ?`,
        )
        .run(plan.generalPlanVersionId),
    ).toThrow('immutable');
  });
});
