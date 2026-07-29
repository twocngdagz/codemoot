// packages/core/src/review-workflow/types.ts — Pure review-gated workflow domain types

import type { z } from 'zod';
import type * as schemas from './schemas.js';

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export const BATCH_STATES = [
  'DRAFT',
  'PLAN_REVIEW',
  'PLAN_NEEDS_REVISION',
  'APPROVED_FOR_IMPLEMENTATION',
  'IMPLEMENTING',
  'AWAITING_COMMIT',
  'IMPLEMENTATION_COMPLETE',
  'CODE_REVIEW',
  'NEEDS_REVISION',
  'VERIFYING',
  'APPROVED_FOR_MERGE',
  'APPROVAL_STALE',
  'MERGED',
  'BLOCKED',
  'CANCELLED',
] as const;

export type BatchState = (typeof BATCH_STATES)[number];

export const TERMINAL_BATCH_STATES = ['MERGED', 'CANCELLED'] as const;
export type TerminalBatchState = (typeof TERMINAL_BATCH_STATES)[number];

export const BLOCKABLE_BATCH_STATES = [
  'DRAFT',
  'PLAN_REVIEW',
  'PLAN_NEEDS_REVISION',
  'APPROVED_FOR_IMPLEMENTATION',
  'IMPLEMENTING',
  'AWAITING_COMMIT',
  'IMPLEMENTATION_COMPLETE',
  'CODE_REVIEW',
  'NEEDS_REVISION',
  'VERIFYING',
  'APPROVED_FOR_MERGE',
  'APPROVAL_STALE',
] as const;

export type BlockableBatchState = (typeof BLOCKABLE_BATCH_STATES)[number];

export const RESUMABLE_BATCH_STATES = [
  'DRAFT',
  'PLAN_NEEDS_REVISION',
  'IMPLEMENTING',
  'AWAITING_COMMIT',
  'IMPLEMENTATION_COMPLETE',
  'NEEDS_REVISION',
  'VERIFYING',
] as const;

export type ResumableBatchState = (typeof RESUMABLE_BATCH_STATES)[number];

export const SAFE_BLOCKED_RESUME_STATES = {
  DRAFT: 'DRAFT',
  PLAN_REVIEW: 'DRAFT',
  PLAN_NEEDS_REVISION: 'PLAN_NEEDS_REVISION',
  APPROVED_FOR_IMPLEMENTATION: 'DRAFT',
  IMPLEMENTING: 'IMPLEMENTING',
  AWAITING_COMMIT: 'AWAITING_COMMIT',
  IMPLEMENTATION_COMPLETE: 'IMPLEMENTATION_COMPLETE',
  CODE_REVIEW: 'IMPLEMENTATION_COMPLETE',
  NEEDS_REVISION: 'NEEDS_REVISION',
  VERIFYING: 'VERIFYING',
  APPROVED_FOR_MERGE: 'VERIFYING',
  APPROVAL_STALE: 'NEEDS_REVISION',
} as const satisfies Record<BlockableBatchState, ResumableBatchState>;

export const ACTOR_TYPES = ['AGENT', 'HUMAN', 'CI', 'SYSTEM'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const AUTHORITIES = [
  'WORKFLOW_OWNER',
  'PLAN_REFINER',
  'IMPLEMENTER',
  'COMMIT_CREATOR',
  'REVIEWER',
  'VERIFICATION_EXECUTOR',
  'VERIFICATION_ATTESTOR',
  'MERGE_RECORDER',
  'SYSTEM_RECONCILER',
] as const;

export type Authority = (typeof AUTHORITIES)[number];

export const ASSIGNED_ROLES = ['IMPLEMENTER', 'REVIEWER'] as const;
export type AssignedRole = (typeof ASSIGNED_ROLES)[number];

export const AGENT_ADAPTER_KINDS = ['CLAUDE', 'CODEX'] as const;
export type AgentAdapterKind = (typeof AGENT_ADAPTER_KINDS)[number];

export const COMMIT_PERMISSIONS = ['DENIED', 'AUTHORIZED'] as const;
export type CommitPermission = (typeof COMMIT_PERMISSIONS)[number];

export const IDENTITY_ASSURANCE_LEVELS = [
  'AUTHENTICATED_SUBJECT',
  'CLI_ASSERTED',
  'PROCESS_ATTESTED',
  'CONFIG_ONLY',
] as const;

export type IdentityAssuranceLevel = (typeof IDENTITY_ASSURANCE_LEVELS)[number];

export const COMMIT_POLICIES = ['HUMAN_REQUIRED', 'AGENT_AUTHORIZED', 'EITHER'] as const;
export type CommitPolicy = (typeof COMMIT_POLICIES)[number];

export const IMPLEMENTATION_COMMIT_MODES = ['AGENT_AUTHORIZED', 'HUMAN_CREATED'] as const;
export type ImplementationCommitMode = (typeof IMPLEMENTATION_COMMIT_MODES)[number];

export const INVOCATION_RESULT_STATUSES = [
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'OUTCOME_UNKNOWN',
] as const;

export type InvocationResultStatus = (typeof INVOCATION_RESULT_STATUSES)[number];

export const WORKFLOW_STATUSES = ['ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export type WorkflowId = string;
export type BatchId = string;
export type AssignmentId = string;
export type ActorExecutionId = string;
export type InvocationId = string;
export type SessionIdentityId = string;
export type GeneralPlanVersionId = string;
export type RefinedPlanVersionId = string;
export type BatchPlanVersionId = string;
export type PlanRequirementId = string;
export type RepositoryAuditId = string;
export type AcceptanceCriterionId = string;
export type ReviewRoundId = string;
export type FindingId = string;
export type DispositionId = string;
export type VerificationRecordId = string;
export type VerificationAttestationId = string;
export type CommandId = string;
export type ImplementationAttemptId = string;
export type ImplementationReadyEvidenceId = string;
export type GitSha = string;
export type ContentHash = string;
export type PatchHash = string;
export type IsoTimestamp = string;

export type IdentityEvidence = DeepReadonly<z.infer<typeof schemas.identityEvidenceSchema>>;
export type AuthenticatedSubjectEvidence = DeepReadonly<
  z.infer<typeof schemas.authenticatedSubjectEvidenceSchema>
>;
export type AgentAssignment = DeepReadonly<z.infer<typeof schemas.agentAssignmentSchema>>;
export type ActorExecutionIdentity = DeepReadonly<
  z.infer<typeof schemas.actorExecutionIdentitySchema>
>;
export type InvocationIdentity = DeepReadonly<z.infer<typeof schemas.invocationIdentitySchema>>;
export type SessionIdentity = DeepReadonly<z.infer<typeof schemas.sessionIdentitySchema>>;
export type WorkflowRun = DeepReadonly<z.infer<typeof schemas.workflowRunSchema>>;
export type ReviewWorkflowBatch = DeepReadonly<z.infer<typeof schemas.reviewWorkflowBatchSchema>>;
export type EvidenceReference = DeepReadonly<z.infer<typeof schemas.evidenceReferenceSchema>>;
export type GeneralPlanVersion = DeepReadonly<z.infer<typeof schemas.generalPlanVersionSchema>>;
export type PlanRequirement = DeepReadonly<z.infer<typeof schemas.planRequirementSchema>>;
export type RepositoryAudit = DeepReadonly<z.infer<typeof schemas.repositoryAuditSchema>>;
export type RequirementCoverage = DeepReadonly<z.infer<typeof schemas.requirementCoverageSchema>>;
export type RefinedPlanVersion = DeepReadonly<z.infer<typeof schemas.refinedPlanVersionSchema>>;

export const ACCEPTANCE_CRITERION_KINDS = [
  'TECHNICAL',
  'USER_FACING',
  'CLI',
  'BROWSER',
  'MANUAL',
  'DOCUMENTATION',
] as const;

export type AcceptanceCriterionKind = (typeof ACCEPTANCE_CRITERION_KINDS)[number];

export const ACCEPTANCE_CRITERION_STATUSES = ['PENDING', 'PASSED', 'FAILED'] as const;
export type AcceptanceCriterionStatus = (typeof ACCEPTANCE_CRITERION_STATUSES)[number];

export type AcceptanceCriterion = DeepReadonly<z.infer<typeof schemas.acceptanceCriterionSchema>>;
export type VerificationCommandSpec = DeepReadonly<
  z.infer<typeof schemas.verificationCommandSpecSchema>
>;
export type BrowserAcceptanceCriteria = DeepReadonly<
  z.infer<typeof schemas.browserAcceptanceCriteriaSchema>
>;
export type BatchPlanVersion = DeepReadonly<z.infer<typeof schemas.batchPlanVersionSchema>>;

export const REVIEW_KINDS = ['PLAN', 'CODE', 'FINAL_AUDIT'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'suggestion'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CATEGORIES = [
  'correctness',
  'security',
  'architecture',
  'maintainability',
  'performance',
  'testing',
  'documentation',
  'scope',
  'user_behaviour',
  'browser_behaviour',
  'cli_behaviour',
  'acceptance_criteria',
  'verification',
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_STATUSES = [
  'OPEN',
  'RESPONSE_SUBMITTED',
  'RESOLVED',
  'BLOCKED',
  'SUPERSEDED',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export type ReviewedArtifactReference = DeepReadonly<
  z.infer<typeof schemas.reviewedArtifactReferenceSchema>
>;
export type Finding = DeepReadonly<z.infer<typeof schemas.findingSchema>>;

export const DISPOSITION_KINDS = [
  'FIXED',
  'NO_CHANGE_WITH_EVIDENCE',
  'BLOCKED',
  'SUPERSEDED',
] as const;

export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

export const REVIEWER_DECISIONS = ['PENDING', 'ACCEPTED', 'REJECTED'] as const;
export type ReviewerDecision = (typeof REVIEWER_DECISIONS)[number];

export type DispositionResultTarget = DeepReadonly<
  z.infer<typeof schemas.dispositionResultTargetSchema>
>;
export type DispositionReview = DeepReadonly<z.infer<typeof schemas.dispositionReviewSchema>>;
export type FindingDisposition = DeepReadonly<z.infer<typeof schemas.findingDispositionSchema>>;

export const VERIFICATION_TYPES = [
  'test',
  'lint',
  'typecheck',
  'build',
  'static_analysis',
  'security',
  'browser',
  'manual',
  'documentation',
  'custom',
] as const;

export type VerificationType = (typeof VERIFICATION_TYPES)[number];

export const VERIFICATION_OBSERVED_STATUSES = [
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'ERROR',
] as const;

export type VerificationObservedStatus = (typeof VERIFICATION_OBSERVED_STATUSES)[number];

export type VerificationExecutionOutcome = DeepReadonly<
  z.infer<typeof schemas.verificationExecutionOutcomeSchema>
>;
export type VerificationRecord = DeepReadonly<z.infer<typeof schemas.verificationRecordSchema>>;

export const VERIFICATION_ATTESTATION_DECISIONS = ['ACCEPTED', 'REJECTED'] as const;
export type VerificationAttestationDecision = (typeof VERIFICATION_ATTESTATION_DECISIONS)[number];

export const VERIFICATION_ACCEPTANCE_MODES = [
  'AUTOMATIC_POLICY',
  'REVIEWER',
  'HUMAN',
  'CI',
] as const;

export type VerificationAcceptanceMode = (typeof VERIFICATION_ACCEPTANCE_MODES)[number];

export type AttestationInvalidation = DeepReadonly<
  z.infer<typeof schemas.attestationInvalidationSchema>
>;
export type VerificationAttestation = DeepReadonly<
  z.infer<typeof schemas.verificationAttestationSchema>
>;
export type ImplementationAttempt = DeepReadonly<
  z.infer<typeof schemas.implementationAttemptSchema>
>;
export type ImplementationReadyEvidence = DeepReadonly<
  z.infer<typeof schemas.implementationReadyEvidenceSchema>
>;
export type GitIdentityMetadata = DeepReadonly<z.infer<typeof schemas.gitIdentityMetadataSchema>>;
export type DomainValidationResult = DeepReadonly<
  z.infer<typeof schemas.domainValidationResultSchema>
>;
export type ImplementationCommit = DeepReadonly<z.infer<typeof schemas.implementationCommitSchema>>;
export type GitShaVocabulary = DeepReadonly<z.infer<typeof schemas.gitShaVocabularySchema>>;
export type GitReviewRange = DeepReadonly<z.infer<typeof schemas.gitReviewRangeSchema>>;
export type InitialReviewRange = Extract<GitReviewRange, { readonly kind: 'INITIAL' }>;
export type CumulativeReviewRange = Extract<GitReviewRange, { readonly kind: 'CUMULATIVE' }>;
export type IncrementalCorrectionRange = Extract<
  GitReviewRange,
  { readonly kind: 'INCREMENTAL_CORRECTION' }
>;
export type FinalGateRange = Extract<GitReviewRange, { readonly kind: 'FINAL_GATE' }>;
export type ChangedFile = DeepReadonly<z.infer<typeof schemas.changedFileSchema>>;
export type ReviewRangeEvidence = DeepReadonly<z.infer<typeof schemas.reviewRangeEvidenceSchema>>;

export const COMMAND_RECEIPT_STATUSES = [
  'RESERVED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED_FINAL',
  'TIMED_OUT',
  'OUTCOME_UNKNOWN',
  'RECONCILED',
] as const;

export type CommandReceiptStatus = (typeof COMMAND_RECEIPT_STATUSES)[number];

type StateChangingCommandRequestShape = DeepReadonly<
  z.infer<typeof schemas.stateChangingCommandRequestSchema>
>;
export type StateChangingCommandRequest<TCommand extends TransitionCommand = TransitionCommand> =
  Omit<StateChangingCommandRequestShape, 'command'> & {
    readonly command: TCommand;
  };
export type CommandReceipt = DeepReadonly<z.infer<typeof schemas.commandReceiptSchema>>;
export type RoleSeparationEvidence = DeepReadonly<
  z.infer<typeof schemas.roleSeparationEvidenceSchema>
>;
export type PlanReviewApprovalEvidence = DeepReadonly<
  z.infer<typeof schemas.planReviewApprovalEvidenceSchema>
>;
export type RevisedPlanEvidence = DeepReadonly<z.infer<typeof schemas.revisedPlanEvidenceSchema>>;
export type ImplementationStartEvidence = DeepReadonly<
  z.infer<typeof schemas.implementationStartEvidenceSchema>
>;
export type ImplementationReadyTransitionEvidence = DeepReadonly<
  z.infer<typeof schemas.implementationReadyTransitionEvidenceSchema>
>;
export type CommitCompletionEvidence = DeepReadonly<
  z.infer<typeof schemas.commitCompletionEvidenceSchema>
>;
export type CodeReviewEvidence = DeepReadonly<z.infer<typeof schemas.codeReviewEvidenceSchema>>;
export type MergeApprovalEvidence = DeepReadonly<
  z.infer<typeof schemas.mergeApprovalEvidenceSchema>
>;
export type VerificationFailureEvidence = DeepReadonly<
  z.infer<typeof schemas.verificationFailureEvidenceSchema>
>;
export type StaleApprovalEvidence = DeepReadonly<
  z.infer<typeof schemas.staleApprovalEvidenceSchema>
>;
export type ExternalMergeEvidence = DeepReadonly<
  z.infer<typeof schemas.externalMergeEvidenceSchema>
>;

export const TRANSITION_COMMAND_TYPES = [
  'CREATE_BATCH',
  'START_PLAN_REVIEW',
  'APPROVE_PLAN',
  'REJECT_PLAN',
  'SUBMIT_REVISED_PLAN',
  'START_IMPLEMENTATION',
  'MARK_IMPLEMENTATION_READY',
  'RESUME_IMPLEMENTATION',
  'COMPLETE_IMPLEMENTATION',
  'START_CODE_REVIEW',
  'REJECT_CODE_REVIEW',
  'APPROVE_CODE_REVIEW',
  'FAIL_VERIFICATION',
  'APPROVE_FOR_MERGE',
  'RECONCILE_STALE_APPROVAL',
  'RECORD_EXTERNAL_MERGE',
  'BLOCK_BATCH',
  'RESUME_BATCH',
  'CANCEL_BATCH',
] as const;

export type TransitionCommand = DeepReadonly<z.infer<typeof schemas.transitionCommandSchema>>;

export type TransitionCommandType = TransitionCommand['type'];

export const TRANSITION_REJECTION_CODES = [
  'INVALID_TRANSITION',
  'AUTHORITY_REQUIRED',
  'ACTOR_TYPE_NOT_ALLOWED',
  'ROLE_VIOLATION',
  'SAME_AGENT',
  'SHARED_SESSION',
  'IDENTITY_ASSURANCE_INSUFFICIENT',
  'PLAN_VERSION_STALE',
  'PLAN_FINDINGS_UNRESOLVED',
  'CODE_FINDINGS_UNRESOLVED',
  'FINAL_AUDIT_FINDINGS_UNRESOLVED',
  'REVIEW_FINDINGS_REQUIRED',
  'FINDING_DISPOSITIONS_INCOMPLETE',
  'COMMIT_PERMISSION_DENIED',
  'COMMIT_SHA_MISMATCH',
  'DIRTY_WORKTREE',
  'GIT_ANCESTRY_INVALID',
  'REVIEW_SHA_STALE',
  'VERIFICATION_INCOMPLETE',
  'ATTESTATION_REQUIRED',
  'APPROVAL_STALE',
  'TERMINAL_STATE',
  'BLOCKED_RESUME_STATE_REQUIRED',
  'BLOCKED_RESUME_TARGET_INVALID',
] as const;

export type TransitionRejectionCode = (typeof TRANSITION_REJECTION_CODES)[number];

export interface AllowedTransition {
  readonly allowed: true;
  readonly commandType: TransitionCommandType;
  readonly previousState: BatchState | null;
  readonly nextState: BatchState;
  readonly blockedFromState?: BlockableBatchState;
  readonly blockedResumeState?: ResumableBatchState;
}

export interface RejectedTransition {
  readonly allowed: false;
  readonly commandType: TransitionCommandType;
  readonly state: BatchState | null;
  readonly code: TransitionRejectionCode;
  readonly message: string;
}

export type TransitionResult = AllowedTransition | RejectedTransition;

export interface TransitionInput {
  readonly currentState: BatchState | null;
  readonly command: TransitionCommand;
  readonly actor: ActorExecutionIdentity;
  readonly blockedFromState?: BatchState;
  readonly blockedResumeState?: BatchState;
}

export type ApprovalValidityInput = DeepReadonly<
  z.infer<typeof schemas.approvalValidityInputSchema>
>;
export type EffectiveBatchState = DeepReadonly<z.infer<typeof schemas.effectiveBatchStateSchema>>;
