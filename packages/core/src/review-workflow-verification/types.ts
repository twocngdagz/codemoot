import type { z } from 'zod';
import type {
  GitSha,
  VerificationAttestation,
  VerificationCommandSpec,
  VerificationEvidenceSource,
  VerificationExecutionOutcome,
  VerificationRecord,
} from '../review-workflow/types.js';
import type * as schemas from './schemas.js';

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export const REVIEW_WORKFLOW_VERIFICATION_ERROR_CODES = [
  'WORKFLOW_CONTEXT_INVALID',
  'ACTOR_EXECUTION_NOT_FOUND',
  'EXECUTOR_AUTHORITY_MISSING',
  'ATTESTOR_AUTHORITY_MISSING',
  'AGENT_ASSIGNMENT_INVALID',
  'COMMAND_NOT_APPROVED',
  'HEAD_MISMATCH',
  'LOG_IMMUTABILITY_CONFLICT',
  'VERIFICATION_RECORD_NOT_FOUND',
  'VERIFICATION_RECORD_CONTEXT_INVALID',
  'ATTESTATION_POLICY_MISMATCH',
  'AUTOMATIC_ACCEPTANCE_DENIED',
  'INDEPENDENT_ATTESTOR_REQUIRED',
  'JUDGMENT_ATTESTOR_REQUIRED',
] as const;

export type ReviewWorkflowVerificationErrorCode =
  (typeof REVIEW_WORKFLOW_VERIFICATION_ERROR_CODES)[number];

export class ReviewWorkflowVerificationError extends Error {
  constructor(
    readonly code: ReviewWorkflowVerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewWorkflowVerificationError';
  }
}

export interface VerificationCommandExecution {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: VerificationExecutionOutcome;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VerificationCommandRunner {
  execute(input: {
    readonly command: VerificationCommandSpec;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<VerificationCommandExecution>;
}

export interface VerificationRepository {
  readHeadSha(): GitSha;
}

export interface VerificationLogContent {
  readonly schemaVersion: 1;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: VerificationExecutionOutcome;
  readonly stdout: string;
  readonly stderr: string;
}

export interface StoredVerificationLog {
  readonly location: string;
  readonly contentHash: string;
}

export interface VerificationLogStore {
  store(verificationRecordId: string, content: VerificationLogContent): StoredVerificationLog;
}

interface VerificationCaptureBase {
  readonly verificationRecordId: string;
  readonly workflowId: string;
  readonly batchId: string;
  readonly executorActorExecutionId: string;
  readonly relatedFindingIds: readonly string[];
  readonly configurationHash: string;
  readonly toolVersion?: string;
}

export interface ExecuteVerificationInput extends VerificationCaptureBase {
  readonly command: VerificationCommandSpec;
  readonly expectedCommitSha: GitSha;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface IngestVerificationInput extends VerificationCaptureBase {
  readonly evidenceSource: Exclude<VerificationEvidenceSource, 'CODEMOOT_EXECUTED'>;
  readonly command: VerificationCommandSpec;
  readonly commitSha: GitSha;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: VerificationExecutionOutcome;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VerificationCaptureResult {
  readonly record: VerificationRecord;
  readonly log: StoredVerificationLog;
  readonly headShaBefore?: GitSha;
  readonly headShaAfter?: GitSha;
  readonly headUnchanged?: boolean;
}

export type VerificationCriterionAcceptancePolicy = DeepReadonly<
  z.infer<typeof schemas.verificationCriterionAcceptancePolicySchema>
>;

export type VerificationAttestationPolicy = DeepReadonly<
  z.infer<typeof schemas.verificationAttestationPolicySchema>
>;

export interface AttestVerificationInput {
  readonly verificationAttestationId: string;
  readonly verificationRecordId: string;
  readonly workflowId: string;
  readonly batchId: string;
  readonly decision: VerificationAttestation['decision'];
  readonly acceptanceMode: VerificationAttestation['acceptanceMode'];
  readonly rationale: string;
  readonly attestorActorExecutionId: string;
  readonly currentHeadSha: GitSha;
  readonly policy: VerificationAttestationPolicy;
  readonly createdAt: string;
}

export interface VerificationContext {
  readonly workflowId: string;
  readonly batchId: string;
  readonly currentPlanVersionId: string;
  readonly workflowConfigurationHash: string;
  readonly implementerAssignmentId: string;
  readonly reviewerAssignmentId: string;
}
