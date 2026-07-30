// packages/core/src/review-workflow/schemas.ts — Zod schemas for workflow domain values

import { z } from 'zod';
import {
  ACCEPTANCE_CRITERION_KINDS,
  ACCEPTANCE_CRITERION_STATUSES,
  ACTOR_TYPES,
  AGENT_ADAPTER_KINDS,
  ASSIGNED_ROLES,
  AUTHORITIES,
  BATCH_STATES,
  BLOCKABLE_BATCH_STATES,
  COMMAND_RECEIPT_STATUSES,
  COMMIT_PERMISSIONS,
  COMMIT_POLICIES,
  DISPOSITION_KINDS,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  IDENTITY_ASSURANCE_LEVELS,
  IMPLEMENTATION_COMMIT_MODES,
  INVOCATION_RESULT_STATUSES,
  RESUMABLE_BATCH_STATES,
  REVIEWER_DECISIONS,
  REVIEW_KINDS,
  SAFE_BLOCKED_RESUME_STATES,
  TRANSITION_COMMAND_TYPES,
  TRANSITION_REJECTION_CODES,
  VERIFICATION_ACCEPTANCE_MODES,
  VERIFICATION_ATTESTATION_DECISIONS,
  VERIFICATION_OBSERVED_STATUSES,
  VERIFICATION_TYPES,
  WORKFLOW_STATUSES,
} from './types.js';

const idSchema = z.string().min(1);
export const isoTimestampSchema = z.string().datetime({ offset: true });
export const contentHashSchema = z.string().min(1);
export const gitShaSchema = z
  .string()
  .regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/i, 'Expected a Git SHA');

export const batchStateSchema = z.enum(BATCH_STATES);
export const actorTypeSchema = z.enum(ACTOR_TYPES);
export const authoritySchema = z.enum(AUTHORITIES);
export const assignedRoleSchema = z.enum(ASSIGNED_ROLES);
export const agentAdapterKindSchema = z.enum(AGENT_ADAPTER_KINDS);
export const commitPermissionSchema = z.enum(COMMIT_PERMISSIONS);
export const identityAssuranceLevelSchema = z.enum(IDENTITY_ASSURANCE_LEVELS);
export const commitPolicySchema = z.enum(COMMIT_POLICIES);
export const implementationCommitModeSchema = z.enum(IMPLEMENTATION_COMMIT_MODES);

export const identityEvidenceSchema = z
  .object({
    kind: z.string().min(1),
    source: z.string().min(1),
    value: z.string().min(1).optional(),
    valueHash: contentHashSchema.optional(),
    observedAt: isoTimestampSchema,
  })
  .strict();

export const authenticatedSubjectEvidenceSchema = z
  .object({
    source: z.string().min(1),
    subjectIdHash: contentHashSchema,
    assertedByCli: z.boolean(),
  })
  .strict();

export const agentAssignmentSchema = z
  .object({
    assignmentId: idSchema,
    workflowId: idSchema,
    batchId: idSchema.optional(),
    assignedRole: assignedRoleSchema,
    configuredAgentKey: z.string().min(1),
    configuredModelAlias: z.string().min(1),
    expectedAdapterKind: agentAdapterKindSchema,
    provider: z.string().min(1),
    configuredModel: z.string().min(1),
    executable: z.string().min(1).optional(),
    versionConstraint: z.string().min(1).optional(),
    commitPermission: commitPermissionSchema,
    configurationHash: contentHashSchema,
    assignedAt: isoTimestampSchema,
  })
  .strict();

export const actorExecutionIdentitySchema = z
  .object({
    actorExecutionId: idSchema,
    actorType: actorTypeSchema,
    assignmentId: idSchema.optional(),
    invocationIdentityId: idSchema.optional(),
    sessionIdentityId: idSchema.optional(),
    authoritiesExercised: z.array(authoritySchema).min(1),
    identityAssurance: identityAssuranceLevelSchema,
    observedEvidence: z.array(identityEvidenceSchema),
    startedAt: isoTimestampSchema,
    finishedAt: isoTimestampSchema.optional(),
  })
  .strict();

export const invocationIdentitySchema = z
  .object({
    invocationId: idSchema,
    commandId: idSchema,
    actorMechanism: z.string().min(1),
    adapterKind: agentAdapterKindSchema.optional(),
    executablePath: z.string().min(1).optional(),
    executableHash: contentHashSchema.optional(),
    cliVersion: z.string().min(1).optional(),
    codemootVersion: z.string().min(1).optional(),
    configuredModel: z.string().min(1).optional(),
    reportedModel: z.string().min(1).optional(),
    workingDirectory: z.string().min(1),
    processId: z.number().int().positive().optional(),
    processInstanceFingerprint: contentHashSchema.optional(),
    authenticatedSubject: authenticatedSubjectEvidenceSchema.optional(),
    rawMetadataLocation: z.string().min(1).optional(),
    startedAt: isoTimestampSchema,
    finishedAt: isoTimestampSchema.optional(),
    resultStatus: z.enum(INVOCATION_RESULT_STATUSES),
  })
  .strict();

export const sessionIdentitySchema = z
  .object({
    sessionIdentityId: idSchema,
    workflowId: idSchema,
    providerOrAdapter: z.string().min(1),
    vendorSessionId: z.string().min(1),
    creatingInvocationId: idSchema,
    resumedFromSessionIdentityId: idSchema.optional(),
    resumeLineage: z.array(idSchema),
    assignedRole: assignedRoleSchema,
    createdAt: isoTimestampSchema,
    lastUsedAt: isoTimestampSchema,
  })
  .strict();

export const workflowRunSchema = z
  .object({
    workflowId: idSchema,
    status: z.enum(WORKFLOW_STATUSES),
    generalPlanVersionId: idSchema,
    refinedPlanVersionId: idSchema.optional(),
    implementerAssignmentId: idSchema,
    reviewerAssignmentId: idSchema,
    configurationHash: contentHashSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.implementerAssignmentId === value.reviewerAssignmentId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewerAssignmentId'],
        message: 'Implementer and reviewer assignments must differ',
      });
    }
  });

export const reviewWorkflowBatchSchema = z
  .object({
    batchId: idSchema,
    workflowId: idSchema,
    ordinal: z.number().int().positive(),
    persistedState: batchStateSchema,
    aggregateVersion: z.number().int().nonnegative(),
    currentPlanVersionId: idSchema,
    implementerAssignmentId: idSchema,
    reviewerAssignmentId: idSchema,
    originalBatchBaseSha: gitShaSchema.optional(),
    blockedFromState: z.enum(BLOCKABLE_BATCH_STATES).optional(),
    blockedResumeState: z.enum(RESUMABLE_BATCH_STATES).optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.implementerAssignmentId === value.reviewerAssignmentId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewerAssignmentId'],
        message: 'Implementer and reviewer assignments must differ',
      });
    }
    if (
      value.persistedState === 'BLOCKED' &&
      (value.blockedFromState === undefined || value.blockedResumeState === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockedResumeState'],
        message: 'Blocked batches require their source and kernel-derived resume states',
      });
    }
    if (
      value.persistedState !== 'BLOCKED' &&
      (value.blockedFromState !== undefined || value.blockedResumeState !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockedResumeState'],
        message: 'Only blocked batches may retain block context',
      });
    }
    if (
      value.blockedFromState !== undefined &&
      value.blockedResumeState !== undefined &&
      SAFE_BLOCKED_RESUME_STATES[value.blockedFromState] !== value.blockedResumeState
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockedResumeState'],
        message: 'Blocked resume state must match the kernel mapping for its source state',
      });
    }
  });

export const evidenceReferenceSchema = z
  .object({
    kind: z.enum(['FILE', 'DIFF', 'COMMAND', 'PLAN', 'LOG', 'BROWSER', 'OTHER']),
    location: z.string().min(1),
    description: z.string().min(1),
    contentHash: contentHashSchema.optional(),
  })
  .strict();

export const generalPlanVersionSchema = z
  .object({
    generalPlanVersionId: idSchema,
    workflowId: idSchema,
    version: z.number().int().positive(),
    sourceType: z.string().min(1),
    sourceLocation: z.string().min(1).optional(),
    content: z.string().min(1),
    contentHash: contentHashSchema,
    authorEvidence: z.array(identityEvidenceSchema),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const planRequirementSchema = z
  .object({
    requirementId: idSchema,
    generalPlanVersionId: idSchema,
    sourceReference: z.string().min(1),
    statement: z.string().min(1),
    required: z.boolean(),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const repositoryAuditSchema = z
  .object({
    repositoryAuditId: idSchema,
    workflowId: idSchema,
    repositoryRoot: z.string().min(1),
    branch: z.string().min(1),
    headSha: gitShaSchema,
    dirty: z.boolean(),
    evidence: z.array(evidenceReferenceSchema),
    actorExecutionId: idSchema,
    observedAt: isoTimestampSchema,
  })
  .strict();

export const requirementCoverageSchema = z
  .object({
    requirementId: idSchema,
    batchPlanVersionIds: z.array(idSchema),
    acceptanceCriterionIds: z.array(idSchema),
  })
  .strict();

export const refinedPlanVersionSchema = z
  .object({
    refinedPlanVersionId: idSchema,
    workflowId: idSchema,
    generalPlanVersionId: idSchema,
    repositoryAuditId: idSchema,
    repositoryContextSha: gitShaSchema,
    version: z.number().int().positive(),
    contentHash: contentHashSchema,
    batchPlanVersionIds: z.array(idSchema),
    requirementCoverage: z.array(requirementCoverageSchema),
    actorExecutionId: idSchema,
    createdAt: isoTimestampSchema,
  })
  .strict();

export const acceptanceCriterionSchema = z
  .object({
    acceptanceCriterionId: idSchema,
    batchPlanVersionId: idSchema,
    kind: z.enum(ACCEPTANCE_CRITERION_KINDS),
    statement: z.string().min(1),
    required: z.boolean(),
    passCondition: z.string().min(1),
    status: z.enum(ACCEPTANCE_CRITERION_STATUSES),
    sourceRequirementIds: z.array(idSchema),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const verificationCommandSpecSchema = z
  .object({
    executable: z.string().min(1),
    arguments: z.array(z.string()),
    workingDirectory: z.string().min(1),
    verificationType: z.enum(VERIFICATION_TYPES),
    relatedCriterionIds: z.array(idSchema),
  })
  .strict();

export const browserAcceptanceCriteriaSchema = z.discriminatedUnion('applicability', [
  z
    .object({
      applicability: z.literal('APPLICABLE'),
      criterionIds: z.array(idSchema).min(1),
    })
    .strict(),
  z
    .object({
      applicability: z.literal('NOT_APPLICABLE'),
      reason: z.string().min(1),
    })
    .strict(),
]);

export const batchPlanVersionSchema = z
  .object({
    batchPlanVersionId: idSchema,
    workflowId: idSchema,
    batchId: idSchema,
    version: z.number().int().positive(),
    supersedesVersionId: idSchema.optional(),
    contentHash: contentHashSchema,
    repositoryContextSha: gitShaSchema,
    objective: z.string().min(1),
    currentRepositoryEvidence: z.array(evidenceReferenceSchema).min(1),
    dependencies: z.array(idSchema),
    candidateFiles: z.array(z.string().min(1)),
    technicalImplementation: z.array(z.string().min(1)).min(1),
    userJourney: z.array(z.string().min(1)).min(1),
    expectedBehaviour: z.array(z.string().min(1)).min(1),
    technicalAcceptanceCriteria: z.array(idSchema),
    userFacingAcceptanceCriteria: z.array(idSchema),
    cliAcceptanceCriteria: z.array(idSchema),
    browserAcceptanceCriteria: browserAcceptanceCriteriaSchema,
    verificationCommands: z.array(verificationCommandSpecSchema),
    manualVerification: z.array(z.string().min(1)),
    documentationChanges: z.array(z.string().min(1)),
    outOfScope: z.array(z.string().min(1)),
    rollbackBoundary: z.string().min(1),
    addressedFindingIds: z.array(idSchema),
    actorExecutionId: idSchema,
    createdAt: isoTimestampSchema,
  })
  .strict();

export const reviewedArtifactReferenceSchema = z
  .object({
    artifactId: idSchema.optional(),
    contentHash: contentHashSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.artifactId === undefined && value.contentHash === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A reviewed artifact requires an ID or content hash',
      });
    }
  });

export const findingSchema = z
  .object({
    findingId: idSchema,
    workflowId: idSchema,
    batchId: idSchema,
    reviewRoundId: idSchema,
    reviewRoundNumber: z.number().int().positive(),
    reviewKind: z.enum(REVIEW_KINDS),
    severity: z.enum(FINDING_SEVERITIES),
    category: z.enum(FINDING_CATEGORIES),
    title: z.string().min(1),
    description: z.string().min(1),
    repositoryEvidence: z.array(evidenceReferenceSchema).min(1),
    affectedFiles: z.array(z.string().min(1)),
    acceptanceCriterionId: idSchema.optional(),
    expectedResult: z.string().min(1),
    observedResult: z.string().min(1),
    requiredAction: z.string().min(1),
    reviewerActorExecutionId: idSchema,
    reviewedArtifact: reviewedArtifactReferenceSchema,
    repositoryContextSha: gitShaSchema,
    reviewedCommitSha: gitShaSchema.optional(),
    status: z.enum(FINDING_STATUSES),
    occurrenceLinks: z.array(idSchema),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.reviewKind === 'CODE' || value.reviewKind === 'FINAL_AUDIT') &&
      value.reviewedCommitSha === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewedCommitSha'],
        message: 'Code and final-audit findings require a reviewed commit SHA',
      });
    }
  });

export const dispositionResultTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('PLAN'),
      planVersionId: idSchema,
      planContentHash: contentHashSchema,
      repositoryContextSha: gitShaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('CODE'),
      resultingCommitSha: gitShaSchema,
    })
    .strict(),
]);

export const dispositionReviewSchema = z
  .object({
    decision: z.enum(REVIEWER_DECISIONS),
    reviewerActorExecutionId: idSchema.optional(),
    rationale: z.string().min(1).optional(),
    decidedAt: isoTimestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasAnyDecisionEvidence =
      value.reviewerActorExecutionId !== undefined ||
      value.rationale !== undefined ||
      value.decidedAt !== undefined;
    const hasDecisionEvidence =
      value.reviewerActorExecutionId !== undefined &&
      value.rationale !== undefined &&
      value.decidedAt !== undefined;
    if (value.decision === 'PENDING' && hasAnyDecisionEvidence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Pending disposition review cannot include completed decision evidence',
      });
    }
    if (value.decision !== 'PENDING' && !hasDecisionEvidence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Completed disposition review requires reviewer, rationale, and timestamp',
      });
    }
  });

export const findingDispositionSchema = z
  .object({
    dispositionId: idSchema,
    findingId: idSchema,
    disposition: z.enum(DISPOSITION_KINDS),
    explanation: z.string().min(1),
    actorExecutionId: idSchema,
    filesChanged: z.array(z.string().min(1)),
    verificationRecordIds: z.array(idSchema),
    evidence: z.array(evidenceReferenceSchema).min(1),
    resultTarget: dispositionResultTargetSchema,
    reviewerDecision: dispositionReviewSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const verificationExecutionOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('EXITED'),
      exitCode: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ERROR'),
      errorCode: z.string().min(1).optional(),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('TIMED_OUT'),
      timeoutMs: z.number().int().positive(),
    })
    .strict(),
]);

export const verificationRecordSchema = z
  .object({
    verificationRecordId: idSchema,
    command: z.string().min(1),
    arguments: z.array(z.string()),
    workingDirectory: z.string().min(1),
    startedAt: isoTimestampSchema,
    finishedAt: isoTimestampSchema,
    outcome: verificationExecutionOutcomeSchema,
    outputSummary: z.string(),
    fullLogLocation: z.string().min(1),
    fullLogHash: contentHashSchema,
    relatedCriterionIds: z.array(idSchema),
    relatedFindingIds: z.array(idSchema),
    commitSha: gitShaSchema,
    executorActorExecutionId: idSchema,
    executorActorType: actorTypeSchema,
    executorAssignmentId: idSchema.optional(),
    verificationType: z.enum(VERIFICATION_TYPES),
    toolVersion: z.string().min(1).optional(),
    configurationHash: contentHashSchema,
    observedStatus: z.enum(VERIFICATION_OBSERVED_STATUSES),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedStatus =
      value.outcome.kind === 'TIMED_OUT'
        ? 'TIMED_OUT'
        : value.outcome.kind === 'ERROR'
          ? 'ERROR'
          : value.outcome.exitCode === 0
            ? 'SUCCEEDED'
            : 'FAILED';
    if (value.observedStatus !== expectedStatus) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observedStatus'],
        message: `Observed status must be ${expectedStatus} for the supplied outcome`,
      });
    }
    if (value.executorActorType === 'AGENT' && value.executorAssignmentId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executorAssignmentId'],
        message: 'Agent verification executors require assignment identity',
      });
    }
  });

export const attestationInvalidationSchema = z
  .object({
    invalidatedAt: isoTimestampSchema,
    reason: z.string().min(1),
    currentHeadSha: gitShaSchema.optional(),
  })
  .strict();

export const verificationAttestationSchema = z
  .object({
    verificationAttestationId: idSchema,
    verificationRecordId: idSchema,
    evidenceHash: contentHashSchema,
    workflowId: idSchema,
    batchId: idSchema,
    relatedCriterionIds: z.array(idSchema),
    relatedFindingIds: z.array(idSchema),
    decision: z.enum(VERIFICATION_ATTESTATION_DECISIONS),
    acceptanceMode: z.enum(VERIFICATION_ACCEPTANCE_MODES),
    rationale: z.string().min(1),
    attestorActorExecutionId: idSchema,
    attestorActorType: actorTypeSchema,
    attestorAssignmentId: idSchema.optional(),
    authorityExercised: z.literal('VERIFICATION_ATTESTOR'),
    recordVerificationType: z.enum(VERIFICATION_TYPES),
    recordExecutorActorExecutionId: idSchema,
    recordExecutorActorType: actorTypeSchema,
    recordExecutorAssignmentId: idSchema.optional(),
    reviewedCommitSha: gitShaSchema,
    policyConfigurationHash: contentHashSchema,
    createdAt: isoTimestampSchema,
    invalidation: attestationInvalidationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const acceptanceActorMatches =
      (value.acceptanceMode === 'AUTOMATIC_POLICY' && value.attestorActorType === 'SYSTEM') ||
      (value.acceptanceMode === 'REVIEWER' && value.attestorActorType === 'AGENT') ||
      (value.acceptanceMode === 'HUMAN' && value.attestorActorType === 'HUMAN') ||
      (value.acceptanceMode === 'CI' && value.attestorActorType === 'CI');
    if (!acceptanceActorMatches) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attestorActorType'],
        message: 'Attestor actor type must match the selected acceptance mode',
      });
    }
    if (value.attestorActorType === 'AGENT' && value.attestorAssignmentId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attestorAssignmentId'],
        message: 'Agent verification attestors require assignment identity',
      });
    }
    if (
      value.recordExecutorActorType === 'AGENT' &&
      value.recordExecutorAssignmentId === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recordExecutorAssignmentId'],
        message: 'Agent verification executors require assignment identity',
      });
    }
    if (
      value.decision === 'ACCEPTED' &&
      value.acceptanceMode === 'AUTOMATIC_POLICY' &&
      value.attestorActorType !== 'SYSTEM'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attestorActorType'],
        message: 'Automatic policy acceptance requires a system attestor',
      });
    }

    const requiresIndependentAttestor =
      value.recordVerificationType === 'manual' || value.recordVerificationType === 'browser';
    if (value.decision === 'ACCEPTED' && requiresIndependentAttestor) {
      if (value.acceptanceMode === 'AUTOMATIC_POLICY') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['acceptanceMode'],
          message: 'Manual and browser evidence cannot be accepted automatically',
        });
      }
      if (value.attestorActorExecutionId === value.recordExecutorActorExecutionId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attestorActorExecutionId'],
          message: 'Manual and browser evidence require an independent attestor',
        });
      }
      if (
        value.attestorAssignmentId !== undefined &&
        value.attestorAssignmentId === value.recordExecutorAssignmentId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attestorAssignmentId'],
          message: 'Manual and browser evidence cannot be attested by the executor assignment',
        });
      }
    }
  });

export const implementationAttemptSchema = z
  .object({
    implementationAttemptId: idSchema,
    workflowId: idSchema,
    batchId: idSchema,
    attemptNumber: z.number().int().positive(),
    approvedPlanVersionId: idSchema,
    approvedPlanContentHash: contentHashSchema,
    originalBatchBaseSha: gitShaSchema,
    startingHeadSha: gitShaSchema,
    implementerAssignmentId: idSchema,
    implementerActorExecutionId: idSchema,
    summary: z.string().min(1),
    claimedChangedFiles: z.array(z.string().min(1)),
    claimedVerificationRecordIds: z.array(idSchema),
    startedAt: isoTimestampSchema,
    finishedAt: isoTimestampSchema.optional(),
  })
  .strict();

export const implementationReadyEvidenceSchema = z
  .object({
    implementationReadyEvidenceId: idSchema,
    implementationAttemptId: idSchema,
    actorExecutionId: idSchema,
    worktreeFingerprint: contentHashSchema,
    changedFiles: z.array(z.string().min(1)),
    summary: z.string().min(1),
    capturedAt: isoTimestampSchema,
  })
  .strict();

export const gitIdentityMetadataSchema = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    timestamp: isoTimestampSchema.optional(),
  })
  .strict();

export const domainValidationResultSchema = z
  .object({
    valid: z.boolean(),
    evidence: z.array(z.string().min(1)),
  })
  .strict();

export const implementationCommitSchema = z
  .object({
    implementationAttemptId: idSchema,
    implementationReadyEvidenceId: idSchema,
    resultingCommitSha: gitShaSchema,
    parentShas: z.array(gitShaSchema).min(1),
    treeSha: gitShaSchema,
    creatorActorExecutionId: idSchema,
    creationMode: implementationCommitModeSchema,
    gitAuthor: gitIdentityMetadataSchema,
    gitCommitter: gitIdentityMetadataSchema,
    cleanWorktreeValidation: domainValidationResultSchema,
    ancestryValidation: domainValidationResultSchema,
    validatedAt: isoTimestampSchema,
  })
  .strict();

export const gitShaVocabularySchema = z
  .object({
    originalBatchBaseSha: gitShaSchema,
    previousReviewedImplementationSha: gitShaSchema,
    currentImplementationSha: gitShaSchema,
    currentBranchHeadSha: gitShaSchema,
  })
  .strict();

export const gitReviewRangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('INITIAL'), fromSha: gitShaSchema, toSha: gitShaSchema }).strict(),
  z.object({ kind: z.literal('CUMULATIVE'), fromSha: gitShaSchema, toSha: gitShaSchema }).strict(),
  z
    .object({
      kind: z.literal('INCREMENTAL_CORRECTION'),
      fromSha: gitShaSchema,
      toSha: gitShaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('FINAL_GATE'),
      fromSha: gitShaSchema,
      toSha: gitShaSchema,
      implementationToHeadIsEmpty: z.boolean(),
    })
    .strict(),
]);

export const changedFileSchema = z
  .object({
    path: z.string().min(1),
    status: z.string().min(1),
    previousPath: z.string().min(1).optional(),
  })
  .strict();

export const reviewRangeEvidenceSchema = z
  .object({
    vocabulary: gitShaVocabularySchema,
    ranges: z.array(gitReviewRangeSchema).min(1),
    patchHash: contentHashSchema,
    changedFiles: z.array(changedFileSchema),
    cumulativePatchLocation: z.string().min(1),
    incrementalPatchLocation: z.string().min(1).optional(),
    capturedAt: isoTimestampSchema,
  })
  .strict();

export const roleSeparationEvidenceSchema = z
  .object({
    implementerAssignment: agentAssignmentSchema,
    reviewerAssignment: agentAssignmentSchema,
    implementerSessionIdentityId: idSchema.optional(),
    reviewerSessionIdentityId: idSchema.optional(),
    minimumIdentityAssurance: identityAssuranceLevelSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.implementerAssignment.assignedRole !== 'IMPLEMENTER') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implementerAssignment', 'assignedRole'],
        message: 'Implementer assignment must carry the IMPLEMENTER role',
      });
    }
    if (value.reviewerAssignment.assignedRole !== 'REVIEWER') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewerAssignment', 'assignedRole'],
        message: 'Reviewer assignment must carry the REVIEWER role',
      });
    }
    if (value.implementerAssignment.workflowId !== value.reviewerAssignment.workflowId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewerAssignment', 'workflowId'],
        message: 'Role assignments must belong to the same workflow',
      });
    }
    if (
      value.implementerAssignment.batchId !== undefined &&
      value.reviewerAssignment.batchId !== undefined &&
      value.implementerAssignment.batchId !== value.reviewerAssignment.batchId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewerAssignment', 'batchId'],
        message: 'Batch-scoped role assignments must belong to the same batch',
      });
    }
    if (
      value.implementerAssignment.assignmentId === value.reviewerAssignment.assignmentId ||
      value.implementerAssignment.configuredAgentKey === value.reviewerAssignment.configuredAgentKey
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewerAssignment'],
        message: 'Implementer and reviewer must be different configured agents',
      });
    }
    if (
      value.implementerSessionIdentityId !== undefined &&
      value.implementerSessionIdentityId === value.reviewerSessionIdentityId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewerSessionIdentityId'],
        message: 'Implementer and reviewer cannot share a session identity',
      });
    }
  });

export const planReviewApprovalEvidenceSchema = z
  .object({
    reviewedPlanVersionId: idSchema,
    currentPlanVersionId: idSchema,
    reviewedPlanContentHash: contentHashSchema,
    currentPlanContentHash: contentHashSchema,
    unresolvedFindingCount: z.number().int().nonnegative(),
    incompleteDispositionCount: z.number().int().nonnegative(),
    roleSeparation: roleSeparationEvidenceSchema,
  })
  .strict();

export const revisedPlanEvidenceSchema = z
  .object({
    previousPlanVersionId: idSchema,
    revisedPlanVersionId: idSchema,
    revisedPlanContentHash: contentHashSchema,
    dispositionCount: z.number().int().nonnegative(),
    findingCount: z.number().int().nonnegative(),
  })
  .strict();

export const implementationStartEvidenceSchema = z
  .object({
    approvedPlanVersionId: idSchema,
    currentPlanVersionId: idSchema,
    roleSeparation: roleSeparationEvidenceSchema,
  })
  .strict();

export const implementationReadyTransitionEvidenceSchema = z
  .object({
    implementationReady: implementationReadyEvidenceSchema,
    roleSeparation: roleSeparationEvidenceSchema,
  })
  .strict();

export const commitCompletionEvidenceSchema = z
  .object({
    commitPolicy: commitPolicySchema,
    creationMode: implementationCommitModeSchema,
    implementerAssignment: agentAssignmentSchema,
    providedCommitSha: gitShaSchema,
    resultingCommitSha: gitShaSchema,
    currentHeadSha: gitShaSchema,
    cleanWorktree: z.boolean(),
    ancestryValid: z.boolean(),
  })
  .strict();

export const codeReviewEvidenceSchema = z
  .object({
    reviewedCommitSha: gitShaSchema,
    currentHeadSha: gitShaSchema,
    cleanWorktree: z.boolean(),
    unresolvedFindingCount: z.number().int().nonnegative(),
    incompleteDispositionCount: z.number().int().nonnegative(),
    roleSeparation: roleSeparationEvidenceSchema,
  })
  .strict();

export const mergeApprovalEvidenceSchema = z
  .object({
    reviewedCommitSha: gitShaSchema,
    currentHeadSha: gitShaSchema,
    cleanWorktree: z.boolean(),
    unresolvedCriticalOrHighFindingCount: z.number().int().nonnegative(),
    incompleteDispositionCount: z.number().int().nonnegative(),
    requiredCriteriaPassed: z.boolean(),
    requiredVerificationComplete: z.boolean(),
    requiredAttestationsAccepted: z.boolean(),
    manualAndBrowserEvidenceIndependentlyAttested: z.boolean(),
    finalDiffReviewed: z.boolean(),
    scopeMatchesApprovedPlan: z.boolean(),
    documentationComplete: z.boolean(),
    roleSeparation: roleSeparationEvidenceSchema,
  })
  .strict();

export const verificationFailureEvidenceSchema = z
  .object({
    reviewedCommitSha: gitShaSchema,
    currentHeadSha: gitShaSchema,
    failedVerificationRecordIds: z.array(idSchema).min(1),
  })
  .strict();

export const staleApprovalEvidenceSchema = z
  .object({
    persistedApprovalSha: gitShaSchema,
    currentHeadSha: gitShaSchema,
  })
  .strict();

export const externalMergeEvidenceSchema = z
  .object({
    approvedCommitSha: gitShaSchema,
    currentHeadSha: gitShaSchema,
    mergeCommitSha: gitShaSchema,
    effectiveApprovalValid: z.boolean(),
  })
  .strict();

export const transitionCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CREATE_BATCH') }).strict(),
  z
    .object({
      type: z.literal('START_PLAN_REVIEW'),
      roleSeparation: roleSeparationEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('APPROVE_PLAN'),
      evidence: planReviewApprovalEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('REJECT_PLAN'),
      evidence: planReviewApprovalEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('SUBMIT_REVISED_PLAN'),
      evidence: revisedPlanEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('START_IMPLEMENTATION'),
      evidence: implementationStartEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('MARK_IMPLEMENTATION_READY'),
      evidence: implementationReadyTransitionEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('RESUME_IMPLEMENTATION'),
      roleSeparation: roleSeparationEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('COMPLETE_IMPLEMENTATION'),
      evidence: commitCompletionEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('START_CODE_REVIEW'),
      evidence: codeReviewEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('REJECT_CODE_REVIEW'),
      evidence: codeReviewEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('APPROVE_CODE_REVIEW'),
      evidence: codeReviewEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('FAIL_VERIFICATION'),
      evidence: verificationFailureEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('APPROVE_FOR_MERGE'),
      evidence: mergeApprovalEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('RECONCILE_STALE_APPROVAL'),
      evidence: staleApprovalEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('RECORD_EXTERNAL_MERGE'),
      evidence: externalMergeEvidenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('BLOCK_BATCH'),
      reason: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal('RESUME_BATCH') }).strict(),
  z
    .object({
      type: z.literal('CANCEL_BATCH'),
      reason: z.string().min(1),
    })
    .strict(),
]);

export const stateChangingCommandRequestSchema = z
  .object({
    commandId: idSchema,
    workflowId: idSchema,
    batchId: idSchema,
    expectedAggregateVersion: z.number().int().nonnegative(),
    canonicalRequestHash: contentHashSchema,
    targetCommitSha: gitShaSchema.optional(),
    requester: actorExecutionIdentitySchema,
    authorityExercised: authoritySchema,
    command: transitionCommandSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.requester.authoritiesExercised.includes(value.authorityExercised)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorityExercised'],
        message: 'Command authority must be present in requester authorities',
      });
    }
  });

export const commandReceiptSchema = z
  .object({
    commandId: idSchema,
    workflowId: idSchema,
    batchId: idSchema,
    commandType: z.enum(TRANSITION_COMMAND_TYPES),
    expectedAggregateVersion: z.number().int().nonnegative(),
    canonicalRequestHash: contentHashSchema,
    targetCommitSha: gitShaSchema.optional(),
    requesterActorExecutionId: idSchema,
    authorityExercised: authoritySchema,
    status: z.enum(COMMAND_RECEIPT_STATUSES),
    sideEffectIdentity: idSchema.optional(),
    resultingAggregateVersion: z.number().int().nonnegative().optional(),
    resultingEventSequence: z.number().int().nonnegative().optional(),
    resultHash: contentHashSchema.optional(),
    errorCode: z.string().min(1).optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const transitionRejectionCodeSchema = z.enum(TRANSITION_REJECTION_CODES);

export const approvalValidityInputSchema = z
  .object({
    persistedState: batchStateSchema,
    persistedApprovalSha: gitShaSchema.optional(),
    currentHeadSha: gitShaSchema,
    invalidationPersisted: z.boolean(),
  })
  .strict();

export const effectiveBatchStateSchema = z
  .object({
    persistedState: batchStateSchema,
    effectiveState: batchStateSchema,
    approvalValid: z.boolean(),
  })
  .strict();
