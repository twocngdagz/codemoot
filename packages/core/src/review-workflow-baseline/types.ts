import type { z } from 'zod';
import type { GitSha } from '../review-workflow/types.js';
import type * as schemas from './schemas.js';

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export const BASELINE_APPROVAL_DECISIONS = ['ACCEPTED', 'REJECTED'] as const;
export const BASELINE_COMPARISON_RESULTS = ['PASSED', 'FAILED', 'INCOMPARABLE'] as const;
export const BASELINE_COMPARISON_ATTESTATION_DECISIONS = ['ACCEPTED', 'REJECTED'] as const;
export const BASELINE_INCOMPATIBILITY_CODES = [
  'COMMAND_MISMATCH',
  'TOOL_NAME_MISMATCH',
  'TOOL_VERSION_MISMATCH',
  'CONFIGURATION_INPUTS_MISMATCH',
  'CONFIGURATION_HASH_MISMATCH',
  'NORMALIZER_MISMATCH',
] as const;

export type NormalizedToolFinding = DeepReadonly<
  z.infer<typeof schemas.normalizedToolFindingSchema>
>;
export type VerificationBaseline = DeepReadonly<z.infer<typeof schemas.verificationBaselineSchema>>;
export type VerificationBaselineApproval = DeepReadonly<
  z.infer<typeof schemas.verificationBaselineApprovalSchema>
>;
export type VerificationBaselineComparison = DeepReadonly<
  z.infer<typeof schemas.verificationBaselineComparisonSchema>
>;
export type VerificationBaselineComparisonAttestation = DeepReadonly<
  z.infer<typeof schemas.verificationBaselineComparisonAttestationSchema>
>;
export type BaselineFindingArtifact = DeepReadonly<
  z.infer<typeof schemas.baselineFindingArtifactSchema>
>;
export type VerificationLogArtifact = DeepReadonly<
  z.infer<typeof schemas.verificationLogArtifactSchema>
>;
export type BaselineIncompatibilityCode = (typeof BASELINE_INCOMPATIBILITY_CODES)[number];

export interface ToolFindingNormalizer {
  readonly toolName: string;
  readonly normalizerId: string;
  readonly normalizationSchemaVersion: number;
  normalize(rawOutput: string): readonly NormalizedToolFinding[];
}

export interface StoredBaselineArtifact {
  readonly location: string;
  readonly contentHash: string;
}

export interface BaselineArtifactStore {
  store(artifactId: string, artifact: BaselineFindingArtifact): StoredBaselineArtifact;
}

export interface VerificationLogArtifactReader {
  read(location: string): string;
}

export interface BaselineRepository {
  readHeadSha(): GitSha;
}

export interface CaptureBaselineInput {
  readonly baselineId: string;
  readonly workflowId: string;
  readonly verificationRecordId: string;
  readonly configurationInputPaths: readonly string[];
  readonly captureActorExecutionId: string;
  readonly createdAt: string;
}

export interface ApproveBaselineInput {
  readonly baselineApprovalId: string;
  readonly baselineId: string;
  readonly reviewerActorExecutionId: string;
  readonly decision: VerificationBaselineApproval['decision'];
  readonly rationale: string;
  readonly createdAt: string;
}

export interface CompareBaselineInput {
  readonly comparisonId: string;
  readonly baselineId: string;
  readonly baselineApprovalId: string;
  readonly currentVerificationRecordId: string;
  readonly currentConfigurationInputPaths: readonly string[];
  readonly captureActorExecutionId: string;
  readonly createdAt: string;
}

export interface AttestBaselineComparisonInput {
  readonly comparisonAttestationId: string;
  readonly comparisonId: string;
  readonly reviewerActorExecutionId: string;
  readonly decision: VerificationBaselineComparisonAttestation['decision'];
  readonly rationale: string;
  readonly baselineTrustworthy: boolean;
  readonly toolVersionAndConfigurationComparable: boolean;
  readonly introducedSetEmpty: boolean;
  readonly normalizationReviewed: boolean;
  readonly createdAt: string;
}

export const REVIEW_WORKFLOW_BASELINE_ERROR_CODES = [
  'WORKFLOW_CONTEXT_INVALID',
  'VERIFICATION_RECORD_NOT_FOUND',
  'VERIFICATION_RECORD_CONTEXT_INVALID',
  'VERIFICATION_LOG_INVALID',
  'VERIFICATION_LOG_HASH_MISMATCH',
  'VERIFICATION_LOG_RECORD_MISMATCH',
  'ACTOR_EXECUTION_NOT_FOUND',
  'CAPTURE_AUTHORITY_MISSING',
  'REVIEWER_AUTHORITY_MISSING',
  'REVIEWER_ASSIGNMENT_INVALID',
  'INDEPENDENT_REVIEWER_REQUIRED',
  'BASELINE_NOT_FOUND',
  'BASELINE_APPROVAL_NOT_FOUND',
  'BASELINE_APPROVAL_REQUIRED',
  'BASELINE_APPROVAL_MISMATCH',
  'COMPARISON_NOT_FOUND',
  'COMPARISON_NOT_ACCEPTABLE',
  'HEAD_MISMATCH',
  'ARTIFACT_IMMUTABILITY_CONFLICT',
  'NORMALIZATION_FAILED',
] as const;

export type ReviewWorkflowBaselineErrorCode = (typeof REVIEW_WORKFLOW_BASELINE_ERROR_CODES)[number];

export class ReviewWorkflowBaselineError extends Error {
  constructor(
    readonly code: ReviewWorkflowBaselineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewWorkflowBaselineError';
  }
}
