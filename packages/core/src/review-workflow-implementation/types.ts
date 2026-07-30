import type { BridgeOptions } from '../models/bridge.js';
import type {
  HandoffCaptureResult,
  ImplementationCaptureValue,
} from '../review-workflow-contracts/service.js';
import type { GitWorktreeSnapshot } from '../review-workflow-git/types.js';
import type { ReviewWorkflowConfigurationSnapshot } from '../review-workflow-identity/types.js';
import type {
  ActorExecutionIdentity,
  ImplementationAttempt,
  ImplementationCommit,
  ImplementationCommitMode,
  ImplementationReadyEvidence,
  ReviewWorkflowBatch,
} from '../review-workflow/types.js';
import type { ResolvedRoleAdapter } from '../roles/role-manager.js';

export const REVIEW_WORKFLOW_IMPLEMENTATION_ERROR_CODES = [
  'WORKFLOW_NOT_FOUND',
  'BATCH_NOT_FOUND',
  'PLAN_NOT_FOUND',
  'CONFIGURATION_SCOPE_MISMATCH',
  'INVALID_STATE',
  'REPOSITORY_STATE_INVALID',
  'PREFLIGHT_INVALID',
  'COMMAND_ALREADY_RESERVED',
  'INVOCATION_MISMATCH',
  'COMMIT_MODE_DENIED',
  'IMPLEMENTATION_EVIDENCE_MISMATCH',
  'ATTEMPT_NOT_FOUND',
  'READY_EVIDENCE_NOT_FOUND',
  'CREATOR_NOT_FOUND',
  'TRANSITION_REJECTED',
  'PACING_EXHAUSTED',
  'CREATION_MODE_MISMATCH',
  'DISPOSITIONS_REQUIRED',
  'REVIEWER_MODIFIED_WORKTREE',
] as const;

export type ReviewWorkflowImplementationErrorCode =
  (typeof REVIEW_WORKFLOW_IMPLEMENTATION_ERROR_CODES)[number];

export class ReviewWorkflowImplementationError extends Error {
  constructor(
    readonly code: ReviewWorkflowImplementationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewWorkflowImplementationError';
  }
}

export interface StartImplementationInput {
  readonly workflowId: string;
  readonly batchId: string;
  readonly configuration: ReviewWorkflowConfigurationSnapshot;
  readonly resolution: ResolvedRoleAdapter;
  readonly commandId: string;
  readonly actorExecutionId: string;
  readonly invocationId: string;
  readonly sessionIdentityId: string;
  readonly prompt: string;
  readonly options?: BridgeOptions;
}

export interface StartImplementationResult {
  readonly batch: ReviewWorkflowBatch;
  readonly repository: GitWorktreeSnapshot;
  readonly implementerSessionIdentityId: string;
}

export interface ResumeImplementationInput {
  readonly workflowId: string;
  readonly batchId: string;
  readonly configuration: ReviewWorkflowConfigurationSnapshot;
  readonly resolution: ResolvedRoleAdapter;
  readonly commandId: string;
  readonly actorExecutionId: string;
  readonly invocationId: string;
  readonly sessionIdentityId: string;
  readonly previousSessionIdentityId: string;
  readonly prompt: string;
  readonly options?: BridgeOptions;
}

export interface ResumeImplementationResult {
  readonly batch: ReviewWorkflowBatch;
  readonly repository: GitWorktreeSnapshot;
  readonly implementerSessionIdentityId: string;
}

export interface ExecuteImplementationInput {
  readonly workflowId: string;
  readonly batchId: string;
  readonly configuration: ReviewWorkflowConfigurationSnapshot;
  readonly resolution: ResolvedRoleAdapter;
  readonly commandId: string;
  readonly actorExecutionId: string;
  readonly invocationId: string;
  readonly sessionIdentityId: string;
  readonly previousSessionIdentityId: string;
  readonly transcriptId: string;
  readonly implementationAttemptId: string;
  readonly implementationReadyEvidenceId: string;
  readonly attemptNumber: number;
  readonly creationMode: ImplementationCommitMode;
  readonly prompt: string;
  readonly options?: BridgeOptions;
}

export type ExecuteImplementationResult =
  | {
      readonly status: 'AWAITING_COMMIT';
      readonly batch: ReviewWorkflowBatch;
      readonly capture: HandoffCaptureResult<ImplementationCaptureValue>;
      readonly attempt: ImplementationAttempt;
      readonly implementationReadyEvidence: ImplementationReadyEvidence;
    }
  | {
      readonly status: 'BLOCKED';
      readonly batch: ReviewWorkflowBatch;
      readonly capture: HandoffCaptureResult<ImplementationCaptureValue>;
      readonly attempt: ImplementationAttempt;
    }
  | {
      readonly status: 'REJECTED';
      readonly batch: ReviewWorkflowBatch;
      readonly capture: HandoffCaptureResult<ImplementationCaptureValue>;
      readonly errorCode: string;
      readonly message: string;
    };

export interface CompleteImplementationInput {
  readonly workflowId: string;
  readonly batchId: string;
  readonly configuration: ReviewWorkflowConfigurationSnapshot;
  readonly implementationAttemptId: string;
  readonly implementationReadyEvidenceId: string;
  readonly providedCommitSha: string;
  readonly creationMode: ImplementationCommitMode;
  readonly humanCreator?: ActorExecutionIdentity;
  readonly commandId: string;
}

export interface CompleteImplementationResult {
  readonly batch: ReviewWorkflowBatch;
  readonly implementationCommit: ImplementationCommit;
}
