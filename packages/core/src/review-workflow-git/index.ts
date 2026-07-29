// Public Git evidence interface for the review-gated workflow.

export { LocalGitRepository } from './local-git-repository.js';
export { ReviewWorkflowGitService } from './service.js';
export {
  REVIEW_WORKFLOW_GIT_ERROR_CODES,
  ReviewWorkflowGitError,
} from './types.js';
export type {
  CapturedReviewRange,
  CorrectionReviewRangeCaptureRequest,
  EffectiveApprovalRequest,
  EffectiveApprovalSnapshot,
  FinalGateRangeCaptureRequest,
  GitCommitSnapshot,
  GitDiffSnapshot,
  GitPatchArtifact,
  GitPatchArtifactKind,
  GitPatchArtifactSink,
  GitRepository,
  GitWorktreeSnapshot,
  ImplementationCommitValidationRequest,
  InitialReviewRangeCaptureRequest,
  RepositoryAuditRequest,
  ReviewRangeCaptureRequest,
  ReviewWorkflowGitErrorCode,
  ValidatedImplementationCommit,
} from './types.js';
