// Public contracts for repository-derived review-workflow evidence.

import type {
  ActorExecutionIdentity,
  AgentAssignment,
  BatchState,
  CommitCompletionEvidence,
  CommitPolicy,
  EffectiveBatchState,
  GitIdentityMetadata,
  GitSha,
  ImplementationAttempt,
  ImplementationCommit,
  ImplementationCommitMode,
  ImplementationReadyEvidence,
  ReviewRangeEvidence,
} from '../review-workflow/types.js';

export const REVIEW_WORKFLOW_GIT_ERROR_CODES = [
  'GIT_COMMAND_FAILED',
  'GIT_REFERENCE_INVALID',
  'REPOSITORY_CHANGED_DURING_READ',
  'DIRTY_WORKTREE',
  'HEAD_MISMATCH',
  'ANCESTRY_INVALID',
  'COMMIT_POLICY_DENIED',
  'ACTOR_NOT_ALLOWED',
  'ATTEMPT_MISMATCH',
  'NO_IMPLEMENTATION_CHANGE',
  'PATCH_HASH_MISMATCH',
  'PATCH_ARTIFACT_INVALID',
] as const;

export type ReviewWorkflowGitErrorCode = (typeof REVIEW_WORKFLOW_GIT_ERROR_CODES)[number];

export class ReviewWorkflowGitError extends Error {
  constructor(
    readonly code: ReviewWorkflowGitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewWorkflowGitError';
  }
}

export interface GitWorktreeSnapshot {
  readonly headSha: GitSha;
  readonly branch: string;
  readonly clean: boolean;
  readonly statusPorcelain: string;
  readonly changedPaths: readonly string[];
  readonly worktreeFingerprint: string;
}

export interface GitCommitSnapshot {
  readonly sha: GitSha;
  readonly treeSha: GitSha;
  readonly parentShas: readonly GitSha[];
  readonly author: GitIdentityMetadata;
  readonly committer: GitIdentityMetadata;
}

export interface GitDiffSnapshot {
  readonly fromSha: GitSha;
  readonly toSha: GitSha;
  readonly arguments: readonly string[];
  readonly patch: string;
  readonly patchHash: string;
  readonly changedFiles: ReviewRangeEvidence['changedFiles'];
}

export interface GitRepository {
  readonly repositoryRoot: string;
  readHeadSha(): GitSha;
  readWorktree(): GitWorktreeSnapshot;
  readCommit(sha: GitSha): GitCommitSnapshot;
  isAncestor(ancestorSha: GitSha, descendantSha: GitSha): boolean;
  readDiff(fromSha: GitSha, toSha: GitSha): GitDiffSnapshot;
}

export type GitPatchArtifactKind =
  | 'CUMULATIVE'
  | 'INCREMENTAL_CORRECTION'
  | 'IMPLEMENTATION_TO_HEAD';

export interface GitPatchArtifact {
  readonly kind: GitPatchArtifactKind;
  readonly fromSha: GitSha;
  readonly toSha: GitSha;
  readonly arguments: readonly string[];
  readonly patch: string;
  readonly patchHash: string;
}

export interface GitPatchArtifactSink {
  storePatch(artifact: GitPatchArtifact): string;
}

export interface RepositoryAuditRequest {
  readonly repositoryAuditId: string;
  readonly workflowId: string;
  readonly actorExecutionId: string;
}

export interface ImplementationCommitValidationRequest {
  readonly attempt: ImplementationAttempt;
  readonly implementationReadyEvidence: ImplementationReadyEvidence;
  readonly providedCommitSha: GitSha;
  readonly creator: ActorExecutionIdentity;
  readonly implementerAssignment: AgentAssignment;
  readonly commitPolicy: CommitPolicy;
  readonly creationMode: ImplementationCommitMode;
}

export interface ValidatedImplementationCommit {
  readonly implementationCommit: ImplementationCommit;
  readonly transitionEvidence: CommitCompletionEvidence;
}

interface ReviewRangeCaptureBase {
  readonly originalBatchBaseSha: GitSha;
  readonly currentImplementationSha: GitSha;
}

export interface InitialReviewRangeCaptureRequest extends ReviewRangeCaptureBase {
  readonly kind: 'INITIAL';
}

export interface CorrectionReviewRangeCaptureRequest extends ReviewRangeCaptureBase {
  readonly kind: 'CORRECTION';
  readonly previousReviewedImplementationSha: GitSha;
}

export interface FinalGateRangeCaptureRequest extends ReviewRangeCaptureBase {
  readonly kind: 'FINAL_GATE';
  readonly previousReviewedImplementationSha: GitSha;
  readonly acceptedCumulativePatchHash: string;
}

export type ReviewRangeCaptureRequest =
  | InitialReviewRangeCaptureRequest
  | CorrectionReviewRangeCaptureRequest
  | FinalGateRangeCaptureRequest;

export interface CapturedReviewRange {
  readonly evidence: ReviewRangeEvidence;
  readonly cumulativePatch: GitDiffSnapshot;
  readonly incrementalPatch?: GitDiffSnapshot;
}

export interface EffectiveApprovalRequest {
  readonly persistedState: BatchState;
  readonly persistedApprovalSha?: GitSha;
  readonly invalidationPersisted: boolean;
}

export interface EffectiveApprovalSnapshot extends EffectiveBatchState {
  readonly persistedApprovalSha?: GitSha;
  readonly currentHeadSha: GitSha;
  readonly invalidationPersisted: boolean;
  readonly observedAt: string;
}
