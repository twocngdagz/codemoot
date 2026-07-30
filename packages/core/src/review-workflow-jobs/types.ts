// Contracts for background workflow jobs and event cursors. A job is a durable request to
// run one workflow operation asynchronously; the operation's original command ID travels
// with the job so every retry lands on the same durable receipt.

import type { ReviewWorkflowSideEffectKind } from '../memory/review-workflow-command-store.js';
import type { TransitionCommand } from '../review-workflow/types.js';

export const REVIEW_WORKFLOW_JOB_TYPES = ['CODE_REVIEW', 'FINAL_AUDIT', 'VERIFICATION'] as const;
export type ReviewWorkflowJobType = (typeof REVIEW_WORKFLOW_JOB_TYPES)[number];

export const REVIEW_WORKFLOW_JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type ReviewWorkflowJobStatus = (typeof REVIEW_WORKFLOW_JOB_STATUSES)[number];

export const REVIEW_WORKFLOW_JOB_ERROR_CODES = [
  'WORKFLOW_NOT_FOUND',
  'BATCH_NOT_FOUND',
  'JOB_NOT_FOUND',
  'JOB_EXISTS',
  'COMMAND_ALREADY_ENQUEUED',
  'INVALID_JOB_STATE',
  'EXECUTOR_MISSING',
  'CURSOR_CONFLICT',
] as const;
export type ReviewWorkflowJobErrorCode = (typeof REVIEW_WORKFLOW_JOB_ERROR_CODES)[number];

export class ReviewWorkflowJobError extends Error {
  constructor(
    readonly code: ReviewWorkflowJobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewWorkflowJobError';
  }
}

/**
 * The receipt identity this job's operation is expected to produce. It is DERIVED from the
 * job type and command ID — never caller-supplied — and settlement validates every loaded
 * receipt against it (plus the job's workflow and batch), so a job can never settle from an
 * unrelated command or another job type's operation that shares its command ID.
 */
export interface ExpectedReceiptIdentity {
  readonly commandType: TransitionCommand['type'];
  readonly sideEffectKind: ReviewWorkflowSideEffectKind | null;
  readonly sideEffectIdentity?: string;
}

/**
 * The discriminated per-type receipt identities. Every operation claims a deterministic
 * side-effect identity derived from its command ID, which is what makes the three job
 * types durably distinguishable even when a command ID collides:
 * - VERIFICATION claims the derived verification-record identity;
 * - CODE_REVIEW invocations use the derived invocation identity (the code-review service
 *   binds its transition actor to the claimed invocation);
 * - FINAL_AUDIT claims its own derived invocation identity in the gate service.
 */
export function deriveExpectedReceipt(
  jobType: ReviewWorkflowJobType,
  commandId: string,
): ExpectedReceiptIdentity {
  switch (jobType) {
    case 'VERIFICATION':
      return {
        commandType: 'START_CODE_REVIEW',
        sideEffectKind: 'VERIFICATION_EXECUTION',
        sideEffectIdentity: `${commandId}:record`,
      };
    case 'CODE_REVIEW':
      return {
        commandType: 'START_CODE_REVIEW',
        sideEffectKind: 'AGENT_INVOCATION',
        sideEffectIdentity: `${commandId}:code-review-invocation`,
      };
    case 'FINAL_AUDIT':
      return {
        commandType: 'START_CODE_REVIEW',
        sideEffectKind: 'AGENT_INVOCATION',
        sideEffectIdentity: `${commandId}:final-audit-invocation`,
      };
  }
}

export interface ReviewWorkflowJob {
  readonly jobId: string;
  readonly workflowId: string;
  readonly batchId: string;
  readonly jobType: ReviewWorkflowJobType;
  readonly commandId: string;
  readonly expectedReceipt: ExpectedReceiptIdentity;
  readonly status: ReviewWorkflowJobStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly workerId?: string;
  readonly leaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnqueueJobInput {
  readonly jobId: string;
  readonly workflowId: string;
  readonly batchId: string;
  readonly jobType: ReviewWorkflowJobType;
  readonly commandId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly maxAttempts?: number;
}

/**
 * Executes the job's operation with the job's original command ID. The executor MUST pass
 * `job.commandId` through to the underlying workflow service unchanged — that is what makes
 * a retried worker replay the durable receipt instead of repeating the invocation.
 */
export type ReviewWorkflowJobExecutor = (job: ReviewWorkflowJob) => Promise<unknown>;

export interface RunNextJobInput {
  readonly workerId: string;
  readonly leaseSeconds?: number;
  readonly executors: Partial<Record<ReviewWorkflowJobType, ReviewWorkflowJobExecutor>>;
}

export type RunNextJobResult =
  | { readonly outcome: 'IDLE' }
  | { readonly outcome: 'EXECUTED'; readonly job: ReviewWorkflowJob; readonly result: unknown }
  | { readonly outcome: 'REPLAYED'; readonly job: ReviewWorkflowJob; readonly result: unknown }
  | { readonly outcome: 'RETRY_SCHEDULED'; readonly job: ReviewWorkflowJob }
  | { readonly outcome: 'FAILED'; readonly job: ReviewWorkflowJob }
  | { readonly outcome: 'RECONCILED_UNKNOWN'; readonly job: ReviewWorkflowJob };

export interface ReviewWorkflowEventCursor {
  readonly cursorId: string;
  readonly workflowId: string;
  readonly lastEventId: number;
  readonly updatedAt: string;
}
