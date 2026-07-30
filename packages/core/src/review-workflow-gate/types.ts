// Contracts for the final merge gate, stale-approval reconciliation, and merge recording.

import type {
  HandoffCaptureResult,
  ReviewCaptureValue,
} from '../review-workflow-contracts/service.js';
import type { ReviewWorkflowConfigurationSnapshot } from '../review-workflow-identity/types.js';
import type {
  BatchState,
  Finding,
  GitSha,
  MergeApprovalEvidence,
  ReviewWorkflowBatch,
  VerificationRecord,
} from '../review-workflow/types.js';
import type { RoleInvocationInput } from '../roles/role-invocation.js';
import type { ResolvedRoleAdapter } from '../roles/role-manager.js';

export const REVIEW_WORKFLOW_GATE_ERROR_CODES = [
  'WORKFLOW_NOT_FOUND',
  'BATCH_NOT_FOUND',
  'INVALID_STATE',
  'CONFIGURATION_SCOPE_MISMATCH',
  'CODE_REVIEW_APPROVAL_REQUIRED',
  'FINAL_AUDIT_EXISTS',
  'COMMAND_ALREADY_RESERVED',
  'INVOCATION_MISMATCH',
  'APPROVAL_EVENT_MISSING',
  'APPROVAL_NOT_EFFECTIVE',
  'APPROVAL_NOT_STALE',
  'TRANSITION_REJECTED',
  'MERGE_COMMIT_INVALID',
  'COMMAND_REPLAY_MISMATCH',
  'VERIFICATION_EXECUTION_FAILED',
] as const;

export type ReviewWorkflowGateErrorCode = (typeof REVIEW_WORKFLOW_GATE_ERROR_CODES)[number];

export class ReviewWorkflowGateError extends Error {
  constructor(
    readonly code: ReviewWorkflowGateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewWorkflowGateError';
  }
}

export interface FinalAuditPromptEvidence {
  readonly target: {
    readonly kind: 'FINAL_AUDIT';
    readonly reviewedCommitSha: GitSha;
    readonly repositoryContextSha: GitSha;
    readonly reviewRangeEvidenceId: string;
    readonly patchHash: string;
    readonly refinedPlanVersionId: string;
  };
  readonly requirementIds: readonly string[];
  readonly acceptanceCriterionIds: readonly string[];
  readonly cumulativePatch: string;
  readonly deferredFindings: readonly Finding[];
}

export interface FinalAuditInput {
  readonly workflowId: string;
  readonly batchId: string;
  readonly configuration: ReviewWorkflowConfigurationSnapshot;
  readonly resolution: ResolvedRoleAdapter;
  readonly commandId: string;
  readonly actorExecutionId: string;
  readonly invocationId: string;
  readonly sessionIdentityId: string;
  readonly previousSessionIdentityId?: string;
  readonly transcriptId: string;
  readonly expectedBatchVersion?: number;
  readonly buildPrompt: (evidence: FinalAuditPromptEvidence) => string;
  readonly options?: RoleInvocationInput['options'];
}

export interface FinalAuditResult {
  readonly capture: HandoffCaptureResult<ReviewCaptureValue>;
  readonly batch: ReviewWorkflowBatch;
  readonly replayed: boolean;
}

/**
 * Executes one approved verification command behind a durable reservation: the command
 * receipt and its VERIFICATION_EXECUTION side effect are claimed before the subprocess
 * starts, and a same-ID retry replays the persisted record instead of re-running anything.
 */
export interface GateVerificationExecutionInput {
  readonly workflowId: string;
  readonly batchId: string;
  readonly configuration: ReviewWorkflowConfigurationSnapshot;
  readonly commandId: string;
  readonly verificationRecordId: string;
  readonly expectedBatchVersion?: number;
  readonly run: () => Promise<VerificationRecord>;
}

export interface GateVerificationExecutionResult {
  readonly record: VerificationRecord;
  readonly replayed: boolean;
}

/** Every gate condition, individually derived from persisted facts and fresh repository reads. */
export interface GateConditionReport {
  readonly reviewedCommitSha: GitSha | null;
  readonly currentHeadSha: GitSha;
  readonly headMatchesReviewedCommit: boolean;
  readonly cleanWorktree: boolean;
  readonly unresolvedCriticalOrHighFindingCount: number;
  readonly incompleteDispositionCount: number;
  readonly requiredCriteriaPassed: boolean;
  readonly requiredVerificationComplete: boolean;
  readonly requiredAttestationsAccepted: boolean;
  readonly manualAndBrowserEvidenceIndependentlyAttested: boolean;
  readonly finalDiffReviewed: boolean;
  readonly scopeMatchesApprovedPlan: boolean;
  readonly documentationComplete: boolean;
}

export interface EvaluateGateInput {
  readonly workflowId: string;
  readonly batchId: string;
  readonly configuration: ReviewWorkflowConfigurationSnapshot;
  readonly commandId: string;
  readonly expectedBatchVersion?: number;
  readonly createdAt: string;
}

export type EvaluateGateResult =
  | {
      readonly approved: true;
      readonly batch: ReviewWorkflowBatch;
      readonly conditions: GateConditionReport;
      readonly evidence: MergeApprovalEvidence;
    }
  | {
      readonly approved: false;
      readonly batch: ReviewWorkflowBatch;
      readonly conditions: GateConditionReport;
      readonly failedConditions: readonly string[];
    };

export interface BatchEffectiveStateReport {
  readonly batchId: string;
  readonly persistedState: BatchState;
  readonly effectiveState: BatchState;
  readonly approvalValid: boolean;
  readonly persistedApprovalSha?: GitSha;
  readonly currentHeadSha: GitSha;
}

export interface ReconcileStaleApprovalInput {
  readonly workflowId: string;
  readonly batchId: string;
  readonly commandId: string;
  readonly expectedBatchVersion?: number;
  readonly createdAt: string;
}

export interface MarkMergedInput {
  readonly workflowId: string;
  readonly batchId: string;
  readonly mergeCommitSha: GitSha;
  readonly recorder: {
    readonly actorExecutionId: string;
    readonly actorType: 'HUMAN' | 'CI';
  };
  readonly commandId: string;
  readonly expectedBatchVersion?: number;
  readonly createdAt: string;
}
