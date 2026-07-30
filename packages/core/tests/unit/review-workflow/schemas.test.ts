import { describe, expect, it } from 'vitest';
import {
  actorExecutionIdentitySchema,
  agentAssignmentSchema,
  batchPlanVersionSchema,
  commandReceiptSchema,
  findingDispositionSchema,
  findingSchema,
  gitShaSchema,
  implementationCommitSchema,
  invocationIdentitySchema,
  reviewRangeEvidenceSchema,
  reviewWorkflowBatchSchema,
  roleSeparationEvidenceSchema,
  sessionIdentitySchema,
  stateChangingCommandRequestSchema,
  transitionCommandSchema,
  verificationAttestationSchema,
  verificationRecordSchema,
  workflowRunSchema,
} from '../../../src/review-workflow/index.js';

const NOW = '2026-07-29T00:00:00.000Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_256 = 'c'.repeat(64);

const IMPLEMENTER_ASSIGNMENT = {
  assignmentId: 'assignment-implementer',
  workflowId: 'workflow-1',
  assignedRole: 'IMPLEMENTER',
  configuredAgentKey: 'claude-agent',
  configuredModelAlias: 'claude-model',
  expectedAdapterKind: 'CLAUDE',
  provider: 'anthropic',
  configuredModel: 'claude-test',
  commitPermission: 'AUTHORIZED',
  configurationHash: 'configuration-hash',
  assignedAt: NOW,
} as const;

const REVIEWER_ASSIGNMENT = {
  assignmentId: 'assignment-reviewer',
  workflowId: 'workflow-1',
  assignedRole: 'REVIEWER',
  configuredAgentKey: 'codex-agent',
  configuredModelAlias: 'codex-model',
  expectedAdapterKind: 'CODEX',
  provider: 'openai',
  configuredModel: 'codex-test',
  commitPermission: 'DENIED',
  configurationHash: 'configuration-hash',
  assignedAt: NOW,
} as const;

const REVIEWER_ACTOR = {
  actorExecutionId: 'actor-reviewer',
  actorType: 'AGENT',
  assignmentId: REVIEWER_ASSIGNMENT.assignmentId,
  invocationIdentityId: 'invocation-reviewer',
  sessionIdentityId: 'session-reviewer',
  authoritiesExercised: ['REVIEWER'],
  identityAssurance: 'PROCESS_ATTESTED',
  observedEvidence: [
    {
      kind: 'CLI_VERSION',
      source: 'codex',
      value: 'codex-test',
      observedAt: NOW,
    },
  ],
  startedAt: NOW,
  finishedAt: NOW,
} as const;

const EVIDENCE = {
  kind: 'FILE',
  location: 'packages/core/src/example.ts',
  description: 'Repository evidence',
} as const;

function makeBatchPlan() {
  return {
    batchPlanVersionId: 'batch-plan-1',
    workflowId: 'workflow-1',
    batchId: 'batch-1',
    version: 1,
    contentHash: 'batch-plan-hash',
    repositoryContextSha: SHA_A,
    objective: 'Define the pure workflow domain.',
    currentRepositoryEvidence: [EVIDENCE],
    dependencies: [],
    candidateFiles: ['packages/core/src/review-workflow/types.ts'],
    technicalImplementation: ['Add immutable domain types.'],
    userJourney: ['A caller submits a guarded transition.'],
    expectedBehaviour: ['The transition is accepted or rejected without I/O.'],
    technicalAcceptanceCriteria: ['criterion-technical'],
    userFacingAcceptanceCriteria: ['criterion-user'],
    cliAcceptanceCriteria: [],
    browserAcceptanceCriteria: {
      applicability: 'NOT_APPLICABLE',
      reason: 'The web package is a placeholder.',
    },
    verificationCommands: [
      {
        executable: 'pnpm',
        arguments: ['test'],
        workingDirectory: '.',
        verificationType: 'test',
        relatedCriterionIds: ['criterion-technical'],
      },
    ],
    manualVerification: ['Review the diff.'],
    documentationChanges: ['No user documentation in Batch 1.'],
    outOfScope: ['Persistence.'],
    rollbackBoundary: 'Remove the additive module.',
    addressedFindingIds: [],
    actorExecutionId: 'actor-refiner',
    createdAt: NOW,
  };
}

function makeFinding(reviewKind: 'PLAN' | 'CODE' | 'FINAL_AUDIT') {
  return {
    findingId: `finding-${reviewKind.toLowerCase()}`,
    workflowId: 'workflow-1',
    batchId: 'batch-1',
    reviewRoundId: 'review-round-1',
    reviewRoundNumber: 1,
    reviewKind,
    severity: 'high',
    category: 'correctness',
    title: 'Guard is incomplete',
    description: 'The transition lacks a required guard.',
    repositoryEvidence: [EVIDENCE],
    affectedFiles: ['packages/core/src/review-workflow/state-machine.ts'],
    acceptanceCriterionId: 'criterion-technical',
    expectedResult: 'Invalid transitions are rejected.',
    observedResult: 'A transition was accepted.',
    requiredAction: 'Add the missing guard.',
    reviewerActorExecutionId: REVIEWER_ACTOR.actorExecutionId,
    reviewedArtifact: {
      artifactId: reviewKind === 'PLAN' ? 'batch-plan-1' : 'implementation-1',
      contentHash: `${reviewKind.toLowerCase()}-hash`,
    },
    repositoryContextSha: SHA_A,
    reviewedCommitSha: reviewKind === 'PLAN' ? undefined : SHA_B,
    status: 'OPEN',
    occurrenceLinks: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeVerificationRecord(type: 'test' | 'manual' | 'browser' = 'test') {
  return {
    verificationRecordId: `verification-${type}`,
    command: type === 'test' ? 'pnpm' : type,
    arguments: type === 'test' ? ['test'] : [],
    workingDirectory: '.',
    startedAt: NOW,
    finishedAt: NOW,
    outcome: {
      kind: 'EXITED',
      exitCode: 0,
    },
    outputSummary: 'Completed.',
    fullLogLocation: `.cowork/logs/${type}.log`,
    fullLogHash: `${type}-log-hash`,
    relatedCriterionIds: ['criterion-technical'],
    relatedFindingIds: [],
    commitSha: SHA_B,
    executorActorExecutionId: 'actor-implementer',
    executorActorType: 'AGENT',
    executorAssignmentId: IMPLEMENTER_ASSIGNMENT.assignmentId,
    evidenceSource: 'CODEMOOT_EXECUTED',
    verificationType: type,
    toolVersion: '1.0.0',
    configurationHash: 'verification-config-hash',
    observedStatus: 'SUCCEEDED',
  };
}

function makeAttestation(type: 'test' | 'manual' | 'browser' = 'test') {
  return {
    verificationAttestationId: `attestation-${type}`,
    verificationRecordId: `verification-${type}`,
    evidenceHash: `${type}-evidence-hash`,
    workflowId: 'workflow-1',
    batchId: 'batch-1',
    relatedCriterionIds: ['criterion-technical'],
    relatedFindingIds: [],
    decision: 'ACCEPTED',
    acceptanceMode: type === 'test' ? 'AUTOMATIC_POLICY' : 'REVIEWER',
    rationale: 'The evidence satisfies the criterion.',
    attestorActorExecutionId: type === 'test' ? 'actor-system' : 'actor-reviewer',
    attestorActorType: type === 'test' ? 'SYSTEM' : 'AGENT',
    attestorAssignmentId: type === 'test' ? undefined : REVIEWER_ASSIGNMENT.assignmentId,
    authorityExercised: 'VERIFICATION_ATTESTOR',
    recordVerificationType: type,
    recordExecutorActorExecutionId: 'actor-implementer',
    recordExecutorActorType: 'AGENT',
    recordExecutorAssignmentId: IMPLEMENTER_ASSIGNMENT.assignmentId,
    reviewedCommitSha: SHA_B,
    policyConfigurationHash: 'policy-hash',
    createdAt: NOW,
  };
}

describe('identity schemas', () => {
  it('accepts separate assignments and execution identity', () => {
    expect(agentAssignmentSchema.safeParse(IMPLEMENTER_ASSIGNMENT).success).toBe(true);
    expect(agentAssignmentSchema.safeParse(REVIEWER_ASSIGNMENT).success).toBe(true);
    expect(actorExecutionIdentitySchema.safeParse(REVIEWER_ACTOR).success).toBe(true);
  });

  it('requires an actor execution to carry an authority', () => {
    expect(
      actorExecutionIdentitySchema.safeParse({
        ...REVIEWER_ACTOR,
        authoritiesExercised: [],
      }).success,
    ).toBe(false);
  });

  it('accepts invocation and resumable session identities', () => {
    const invocation = {
      invocationId: 'invocation-reviewer',
      commandId: 'command-review',
      actorMechanism: 'cli',
      adapterKind: 'CODEX',
      executablePath: '/usr/local/bin/codex',
      executableHash: 'executable-hash',
      cliVersion: '1.0.0',
      codemootVersion: '0.2.14',
      configuredModel: 'codex-test',
      reportedModel: 'codex-test',
      workingDirectory: '/project',
      processId: 123,
      processInstanceFingerprint: 'process-hash',
      rawMetadataLocation: '.cowork/invocations/reviewer.json',
      startedAt: NOW,
      finishedAt: NOW,
      resultStatus: 'SUCCEEDED',
    };
    const session = {
      sessionIdentityId: 'session-reviewer',
      workflowId: 'workflow-1',
      providerOrAdapter: 'CODEX',
      vendorSessionId: 'thread-1',
      creatingInvocationId: 'invocation-reviewer',
      resumeLineage: [],
      assignedRole: 'REVIEWER',
      createdAt: NOW,
      lastUsedAt: NOW,
    };

    expect(invocationIdentitySchema.safeParse(invocation).success).toBe(true);
    expect(sessionIdentitySchema.safeParse(session).success).toBe(true);
  });

  it('rejects credential-like undeclared invocation fields', () => {
    const result = invocationIdentitySchema.safeParse({
      invocationId: 'invocation-1',
      commandId: 'command-1',
      actorMechanism: 'cli',
      workingDirectory: '/project',
      startedAt: NOW,
      resultStatus: 'RUNNING',
      authenticationToken: 'must-not-be-stored',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a workflow with the same assignment in both roles', () => {
    const result = workflowRunSchema.safeParse({
      workflowId: 'workflow-1',
      status: 'ACTIVE',
      generalPlanVersionId: 'general-plan-1',
      implementerAssignmentId: 'assignment-shared',
      reviewerAssignmentId: 'assignment-shared',
      configurationHash: 'config-hash',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a batch with the same assignment in both roles', () => {
    const result = reviewWorkflowBatchSchema.safeParse({
      batchId: 'batch-1',
      workflowId: 'workflow-1',
      ordinal: 1,
      persistedState: 'DRAFT',
      aggregateVersion: 0,
      currentPlanVersionId: 'batch-plan-1',
      implementerAssignmentId: 'assignment-shared',
      reviewerAssignmentId: 'assignment-shared',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.success).toBe(false);
  });

  it('requires a kernel-derived resume state exactly while a batch is blocked', () => {
    const base = {
      batchId: 'batch-1',
      workflowId: 'workflow-1',
      ordinal: 1,
      aggregateVersion: 3,
      currentPlanVersionId: 'batch-plan-1',
      implementerAssignmentId: IMPLEMENTER_ASSIGNMENT.assignmentId,
      reviewerAssignmentId: REVIEWER_ASSIGNMENT.assignmentId,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(
      reviewWorkflowBatchSchema.safeParse({
        ...base,
        persistedState: 'BLOCKED',
        blockedFromState: 'DRAFT',
        blockedResumeState: 'DRAFT',
      }).success,
    ).toBe(true);
    expect(
      reviewWorkflowBatchSchema.safeParse({
        ...base,
        persistedState: 'BLOCKED',
      }).success,
    ).toBe(false);
    expect(
      reviewWorkflowBatchSchema.safeParse({
        ...base,
        persistedState: 'DRAFT',
        blockedFromState: 'DRAFT',
        blockedResumeState: 'VERIFYING',
      }).success,
    ).toBe(false);
    expect(
      reviewWorkflowBatchSchema.safeParse({
        ...base,
        persistedState: 'BLOCKED',
        blockedFromState: 'DRAFT',
        blockedResumeState: 'VERIFYING',
      }).success,
    ).toBe(false);
  });

  it('rejects same-agent and shared-session role separation evidence', () => {
    const base = {
      implementerAssignment: IMPLEMENTER_ASSIGNMENT,
      reviewerAssignment: REVIEWER_ASSIGNMENT,
      implementerSessionIdentityId: 'session-shared',
      reviewerSessionIdentityId: 'session-shared',
      minimumIdentityAssurance: 'PROCESS_ATTESTED',
    };
    expect(roleSeparationEvidenceSchema.safeParse(base).success).toBe(false);
    expect(
      roleSeparationEvidenceSchema.safeParse({
        ...base,
        reviewerSessionIdentityId: 'session-reviewer',
        reviewerAssignment: {
          ...REVIEWER_ASSIGNMENT,
          configuredAgentKey: IMPLEMENTER_ASSIGNMENT.configuredAgentKey,
        },
      }).success,
    ).toBe(false);
  });
});

describe('plan and finding schemas', () => {
  it('accepts all sixteen batch plan sections with explicit browser N/A', () => {
    expect(batchPlanVersionSchema.safeParse(makeBatchPlan()).success).toBe(true);
  });

  it('rejects an empty browser not-applicable reason', () => {
    const result = batchPlanVersionSchema.safeParse({
      ...makeBatchPlan(),
      browserAcceptanceCriteria: {
        applicability: 'NOT_APPLICABLE',
        reason: '',
      },
    });
    expect(result.success).toBe(false);
  });

  it('requires applicable browser criteria to contain stable IDs', () => {
    const result = batchPlanVersionSchema.safeParse({
      ...makeBatchPlan(),
      browserAcceptanceCriteria: {
        applicability: 'APPLICABLE',
        criterionIds: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts plan and code findings in one lifecycle', () => {
    expect(findingSchema.safeParse(makeFinding('PLAN')).success).toBe(true);
    expect(findingSchema.safeParse(makeFinding('CODE')).success).toBe(true);
  });

  it('requires a reviewed commit SHA for code findings', () => {
    const result = findingSchema.safeParse({
      ...makeFinding('CODE'),
      reviewedCommitSha: undefined,
    });
    expect(result.success).toBe(false);
  });

  it('requires a reviewed commit SHA for final-audit findings', () => {
    const result = findingSchema.safeParse({
      ...makeFinding('FINAL_AUDIT'),
      reviewedCommitSha: undefined,
    });
    expect(result.success).toBe(false);
  });

  it('accepts plan and code disposition result targets', () => {
    const base = {
      dispositionId: 'disposition-1',
      findingId: 'finding-1',
      disposition: 'FIXED',
      explanation: 'The finding was addressed.',
      actorExecutionId: 'actor-implementer',
      filesChanged: ['packages/core/src/review-workflow/types.ts'],
      verificationRecordIds: ['verification-test'],
      evidence: [EVIDENCE],
      reviewerDecision: {
        decision: 'PENDING',
      },
      createdAt: NOW,
      updatedAt: NOW,
    };

    expect(
      findingDispositionSchema.safeParse({
        ...base,
        resultTarget: {
          kind: 'PLAN',
          planVersionId: 'batch-plan-2',
          planContentHash: 'plan-hash-2',
          repositoryContextSha: SHA_A,
        },
      }).success,
    ).toBe(true);

    expect(
      findingDispositionSchema.safeParse({
        ...base,
        resultTarget: {
          kind: 'CODE',
          resultingCommitSha: SHA_B,
        },
      }).success,
    ).toBe(true);
  });

  it('requires reviewer evidence for a completed disposition decision', () => {
    const result = findingDispositionSchema.safeParse({
      dispositionId: 'disposition-1',
      findingId: 'finding-1',
      disposition: 'FIXED',
      explanation: 'Fixed.',
      actorExecutionId: 'actor-implementer',
      filesChanged: [],
      verificationRecordIds: [],
      evidence: [EVIDENCE],
      resultTarget: {
        kind: 'CODE',
        resultingCommitSha: SHA_B,
      },
      reviewerDecision: {
        decision: 'ACCEPTED',
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.success).toBe(false);
  });

  it('rejects partial reviewer evidence on a pending disposition', () => {
    const result = findingDispositionSchema.safeParse({
      dispositionId: 'disposition-1',
      findingId: 'finding-1',
      disposition: 'FIXED',
      explanation: 'Fixed.',
      actorExecutionId: 'actor-implementer',
      filesChanged: [],
      verificationRecordIds: [],
      evidence: [EVIDENCE],
      resultTarget: {
        kind: 'CODE',
        resultingCommitSha: SHA_B,
      },
      reviewerDecision: {
        decision: 'PENDING',
        reviewerActorExecutionId: REVIEWER_ACTOR.actorExecutionId,
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.success).toBe(false);
  });
});

describe('verification schemas', () => {
  it('accepts a factual verification record independently of attestation', () => {
    expect(verificationRecordSchema.safeParse(makeVerificationRecord()).success).toBe(true);
  });

  it('rejects an observed status inconsistent with the execution outcome', () => {
    const result = verificationRecordSchema.safeParse({
      ...makeVerificationRecord(),
      observedStatus: 'FAILED',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a verification record that finishes before it starts', () => {
    const result = verificationRecordSchema.safeParse({
      ...makeVerificationRecord(),
      startedAt: '2026-07-29T00:01:00.000Z',
      finishedAt: '2026-07-29T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it.each([
    {
      outcome: { kind: 'ERROR', errorCode: 'EXEC_FAILURE', message: 'Command failed to start.' },
      observedStatus: 'ERROR',
    },
    {
      outcome: { kind: 'TIMED_OUT', timeoutMs: 30_000 },
      observedStatus: 'TIMED_OUT',
    },
  ] as const)('accepts $observedStatus verification outcomes', ({ outcome, observedStatus }) => {
    expect(
      verificationRecordSchema.safeParse({
        ...makeVerificationRecord(),
        outcome,
        observedStatus,
      }).success,
    ).toBe(true);
  });

  it('requires assignment identity for an agent verification executor', () => {
    const result = verificationRecordSchema.safeParse({
      ...makeVerificationRecord(),
      executorAssignmentId: undefined,
    });
    expect(result.success).toBe(false);
  });

  it('accepts automatic system attestation for ordinary successful evidence', () => {
    expect(verificationAttestationSchema.safeParse(makeAttestation()).success).toBe(true);
  });

  it.each(['manual', 'browser'] as const)(
    'accepts independent reviewer attestation for %s evidence',
    (verificationType) => {
      expect(
        verificationAttestationSchema.safeParse(makeAttestation(verificationType)).success,
      ).toBe(true);
    },
  );

  it('accepts independent human attestation for manual evidence', () => {
    expect(
      verificationAttestationSchema.safeParse({
        ...makeAttestation('manual'),
        acceptanceMode: 'HUMAN',
        attestorActorExecutionId: 'actor-human-attestor',
        attestorActorType: 'HUMAN',
        attestorAssignmentId: undefined,
      }).success,
    ).toBe(true);
  });

  it.each(['manual', 'browser'] as const)(
    'rejects automatic acceptance for %s evidence',
    (verificationType) => {
      const result = verificationAttestationSchema.safeParse({
        ...makeAttestation(verificationType),
        acceptanceMode: 'AUTOMATIC_POLICY',
        attestorActorType: 'SYSTEM',
      });
      expect(result.success).toBe(false);
    },
  );

  it.each(['manual', 'browser'] as const)(
    'rejects executor self-attestation for %s evidence',
    (verificationType) => {
      const result = verificationAttestationSchema.safeParse({
        ...makeAttestation(verificationType),
        attestorActorExecutionId: 'actor-implementer',
        attestorAssignmentId: IMPLEMENTER_ASSIGNMENT.assignmentId,
      });
      expect(result.success).toBe(false);
    },
  );

  it.each(['manual', 'browser'] as const)(
    'rejects assignment omission for %s agent attestation',
    (verificationType) => {
      expect(
        verificationAttestationSchema.safeParse({
          ...makeAttestation(verificationType),
          attestorAssignmentId: undefined,
        }).success,
      ).toBe(false);
      expect(
        verificationAttestationSchema.safeParse({
          ...makeAttestation(verificationType),
          recordExecutorAssignmentId: undefined,
        }).success,
      ).toBe(false);
    },
  );

  it.each(['manual', 'browser'] as const)(
    'rejects a non-reviewer actor masquerading under reviewer mode for %s evidence',
    (verificationType) => {
      const result = verificationAttestationSchema.safeParse({
        ...makeAttestation(verificationType),
        attestorActorType: 'SYSTEM',
        attestorAssignmentId: undefined,
      });
      expect(result.success).toBe(false);
    },
  );
});

describe('commit, Git range, and idempotency schemas', () => {
  it('accepts only 40-character SHA-1 or 64-character SHA-256 object IDs', () => {
    expect(gitShaSchema.safeParse(SHA_A).success).toBe(true);
    expect(gitShaSchema.safeParse(SHA_256).success).toBe(true);
    expect(gitShaSchema.safeParse('a'.repeat(41)).success).toBe(false);
    expect(gitShaSchema.safeParse('a'.repeat(63)).success).toBe(false);
  });

  it('accepts implementation commit evidence without treating Git author as actor proof', () => {
    const result = implementationCommitSchema.safeParse({
      implementationAttemptId: 'attempt-1',
      implementationReadyEvidenceId: 'ready-1',
      resultingCommitSha: SHA_B,
      parentShas: [SHA_A],
      treeSha: SHA_B,
      creatorActorExecutionId: 'actor-human-committer',
      creationMode: 'HUMAN_CREATED',
      gitAuthor: {
        name: 'Developer',
        email: 'developer@example.com',
        timestamp: NOW,
      },
      gitCommitter: {
        name: 'Developer',
        email: 'developer@example.com',
        timestamp: NOW,
      },
      cleanWorktreeValidation: {
        valid: true,
        evidence: ['Worktree snapshot was clean.'],
      },
      ancestryValidation: {
        valid: true,
        evidence: ['Original base is an ancestor.'],
      },
      validatedAt: NOW,
    });
    expect(result.success).toBe(true);
  });

  it('accepts explicit B0, P, I, H review-range evidence', () => {
    const result = reviewRangeEvidenceSchema.safeParse({
      vocabulary: {
        originalBatchBaseSha: SHA_A,
        previousReviewedImplementationSha: SHA_A,
        currentImplementationSha: SHA_B,
        currentBranchHeadSha: SHA_B,
      },
      ranges: [
        {
          kind: 'INITIAL',
          fromSha: SHA_A,
          toSha: SHA_B,
        },
        {
          kind: 'CUMULATIVE',
          fromSha: SHA_A,
          toSha: SHA_B,
        },
        {
          kind: 'INCREMENTAL_CORRECTION',
          fromSha: SHA_A,
          toSha: SHA_B,
        },
        {
          kind: 'FINAL_GATE',
          fromSha: SHA_A,
          toSha: SHA_B,
          implementationToHeadIsEmpty: true,
        },
      ],
      patchHash: 'patch-hash',
      changedFiles: [
        {
          path: 'packages/core/src/review-workflow/types.ts',
          status: 'A',
        },
      ],
      cumulativePatchLocation: '.cowork/reviews/cumulative.patch',
      capturedAt: NOW,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a state-changing request with explicit idempotency fields', () => {
    const result = stateChangingCommandRequestSchema.safeParse({
      commandId: 'command-plan-review',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      expectedAggregateVersion: 2,
      canonicalRequestHash: 'request-hash',
      targetCommitSha: SHA_A,
      requester: REVIEWER_ACTOR,
      authorityExercised: 'REVIEWER',
      command: {
        type: 'START_PLAN_REVIEW',
        roleSeparation: {
          implementerAssignment: IMPLEMENTER_ASSIGNMENT,
          reviewerAssignment: REVIEWER_ASSIGNMENT,
          implementerSessionIdentityId: 'session-implementer',
          reviewerSessionIdentityId: 'session-reviewer',
          minimumIdentityAssurance: 'PROCESS_ATTESTED',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('requires implementation-ready and failed-verification transition evidence', () => {
    expect(
      transitionCommandSchema.safeParse({
        type: 'MARK_IMPLEMENTATION_READY',
        evidence: {
          implementationReady: {
            implementationReadyEvidenceId: 'ready-1',
            implementationAttemptId: 'attempt-1',
            actorExecutionId: 'actor-implementer',
            worktreeFingerprint: 'worktree-hash',
            changedFiles: ['packages/core/src/review-workflow/types.ts'],
            summary: 'Ready to commit.',
            capturedAt: NOW,
          },
          roleSeparation: {
            implementerAssignment: IMPLEMENTER_ASSIGNMENT,
            reviewerAssignment: REVIEWER_ASSIGNMENT,
            implementerSessionIdentityId: 'session-implementer',
            reviewerSessionIdentityId: 'session-reviewer',
            minimumIdentityAssurance: 'PROCESS_ATTESTED',
          },
        },
      }).success,
    ).toBe(true);
    expect(
      transitionCommandSchema.safeParse({
        type: 'FAIL_VERIFICATION',
        evidence: {
          reviewedCommitSha: SHA_B,
          currentHeadSha: SHA_B,
          failedVerificationRecordIds: [],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a command authority absent from requester evidence', () => {
    const result = stateChangingCommandRequestSchema.safeParse({
      commandId: 'command-plan-review',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      expectedAggregateVersion: 2,
      canonicalRequestHash: 'request-hash',
      requester: REVIEWER_ACTOR,
      authorityExercised: 'IMPLEMENTER',
      command: {
        type: 'CREATE_BATCH',
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a command receipt prepared for Batch 2 persistence', () => {
    const result = commandReceiptSchema.safeParse({
      commandId: 'command-plan-review',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      commandType: 'START_PLAN_REVIEW',
      expectedAggregateVersion: 2,
      canonicalRequestHash: 'request-hash',
      targetCommitSha: SHA_A,
      requesterActorExecutionId: REVIEWER_ACTOR.actorExecutionId,
      authorityExercised: 'REVIEWER',
      status: 'RESERVED',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.success).toBe(true);
  });
});
