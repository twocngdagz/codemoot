// Background execution without weakening idempotency: the durable command receipt is the
// single source of truth for every job outcome. A worker consults the receipt BEFORE
// executing and settles EXCLUSIVELY from it afterwards — an executor's return value never
// decides success, and a retry after any crash either replays the recorded outcome or
// refuses to re-invoke. It never repeats an agent or verification invocation.

import type {
  ReviewWorkflowCommandStore,
  StoredReviewWorkflowCommand,
} from '../memory/review-workflow-command-store.js';
import type { ReviewWorkflowJobStore } from './store.js';
import {
  type EnqueueJobInput,
  type ReviewWorkflowJob,
  ReviewWorkflowJobError,
  type RunNextJobInput,
  type RunNextJobResult,
} from './types.js';

const DEFAULT_LEASE_SECONDS = 1800;

export class ReviewWorkflowJobService {
  constructor(
    private readonly jobStore: ReviewWorkflowJobStore,
    private readonly commandStore: ReviewWorkflowCommandStore,
  ) {}

  /**
   * Records the request to run one workflow operation in the background. The operation's
   * command ID and its expected receipt identity are bound to the job at enqueue time;
   * every worker attempt reuses them, so the synchronous replay guarantees carry over
   * unchanged and settlement can verify the receipt belongs to this exact operation.
   */
  enqueue(input: EnqueueJobInput): ReviewWorkflowJob {
    return this.jobStore.enqueue(input);
  }

  /**
   * Claims and processes the next runnable job. Receipt-first, receipt-last semantics:
   * - a pre-existing receipt settles the job immediately (validated against the job's
   *   expected identity) — no executor runs;
   * - otherwise the executor runs with the job's command ID, and the job settles from the
   *   receipt the operation produced — never from the executor's return value or throw;
   * - an executor outcome without any receipt is retried while attempts remain (nothing was
   *   reserved) and otherwise fails; it can never produce job success;
   * - an expired job whose attempts are exhausted settles from its receipt alone, so no
   *   crash strands a job in RUNNING.
   */
  async runNext(input: RunNextJobInput): Promise<RunNextJobResult> {
    const job = this.jobStore.claimNext(
      input.workerId,
      input.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    );
    if (job === null) return { outcome: 'IDLE' };

    const stored = this.commandStore.get(job.commandId);
    if (stored !== null) return this.settleFromReceipt(job, input.workerId, stored, 'REPLAYED');

    // No receipt exists. If this claim was a reconciliation of an exhausted, expired job,
    // the operation never started and may not be started now.
    if (job.attemptCount > job.maxAttempts) {
      return {
        outcome: 'FAILED',
        job: this.jobStore.fail(
          job.jobId,
          input.workerId,
          'ATTEMPTS_EXHAUSTED',
          `Job ${job.jobId} exhausted its attempts without producing a command receipt`,
        ),
      };
    }

    const executor = input.executors[job.jobType];
    if (executor === undefined) {
      // Settle the claim safely before surfacing the configuration error — the job must not
      // stay RUNNING until lease expiry, and the claim never reached the operation so it
      // must not consume an execution attempt (a maxAttempts:1 job stays runnable once an
      // executor is registered).
      this.jobStore.requeueWithoutAttempt(
        job.jobId,
        input.workerId,
        'EXECUTOR_MISSING',
        `No executor is registered for job type ${job.jobType}`,
      );
      throw new ReviewWorkflowJobError(
        'EXECUTOR_MISSING',
        `No executor is registered for job type ${job.jobType}`,
      );
    }

    let executorError: string | null = null;
    try {
      await executor(job);
    } catch (error) {
      executorError = error instanceof Error ? error.message : 'Job execution failed';
    }

    // Settle exclusively from the receipt the operation produced (or failed to produce).
    const receipt = this.commandStore.get(job.commandId);
    if (receipt !== null) return this.settleFromReceipt(job, input.workerId, receipt, 'EXECUTED');
    if (executorError === null) {
      return {
        outcome: 'FAILED',
        job: this.jobStore.fail(
          job.jobId,
          input.workerId,
          'RECEIPT_MISSING',
          `Job ${job.jobId} returned without producing command receipt ${job.commandId}; success cannot be derived`,
        ),
      };
    }
    if (job.attemptCount < job.maxAttempts) {
      return {
        outcome: 'RETRY_SCHEDULED',
        job: this.jobStore.requeue(job.jobId, input.workerId, 'EXECUTION_FAILED', executorError),
      };
    }
    return {
      outcome: 'FAILED',
      job: this.jobStore.fail(job.jobId, input.workerId, 'EXECUTION_FAILED', executorError),
    };
  }

  cancel(jobId: string): ReviewWorkflowJob {
    return this.jobStore.cancel(jobId);
  }

  /**
   * Settles a claimed job from its durable command receipt — the only authority on the
   * outcome. The receipt must match the job's full expected identity (workflow, batch,
   * command vocabulary, side-effect kind and identity); a mismatched receipt means the
   * command ID was consumed by a different operation, which is a terminal failure.
   */
  private settleFromReceipt(
    job: ReviewWorkflowJob,
    workerId: string,
    stored: StoredReviewWorkflowCommand,
    successOutcome: 'REPLAYED' | 'EXECUTED',
  ): RunNextJobResult {
    const mismatch = this.receiptMismatch(job, stored);
    if (mismatch !== null) {
      return {
        outcome: 'FAILED',
        job: this.jobStore.fail(
          job.jobId,
          workerId,
          'RECEIPT_MISMATCH',
          `Command ${job.commandId} does not belong to this job's operation: ${mismatch}`,
        ),
      };
    }
    const status = stored.receipt.status;
    if (status === 'SUCCEEDED') {
      return {
        outcome: successOutcome,
        job: this.jobStore.succeed(job.jobId, workerId, stored.result),
        result: stored.result,
      };
    }
    if (status === 'FAILED_FINAL' || status === 'TIMED_OUT' || status === 'RECONCILED') {
      return {
        outcome: 'FAILED',
        job: this.jobStore.fail(
          job.jobId,
          workerId,
          stored.receipt.errorCode ?? status,
          `Command ${job.commandId} finished as ${status}; the recorded outcome is final`,
        ),
      };
    }
    if (status === 'OUTCOME_UNKNOWN') {
      return {
        outcome: 'RECONCILED_UNKNOWN',
        job: this.jobStore.fail(
          job.jobId,
          workerId,
          'OUTCOME_UNKNOWN',
          `Command ${job.commandId} already has an unknown outcome awaiting reconciliation`,
        ),
      };
    }
    // RESERVED or RUNNING: an attempt reserved (and possibly started) the external side
    // effect and then died. Repeating the invocation is forbidden; record that the outcome
    // is unknown and surface the job as failed for human reconciliation.
    this.commandStore.recordOutcome({
      commandId: job.commandId,
      status: 'OUTCOME_UNKNOWN',
      errorCode: 'WORKER_LOST',
    });
    return {
      outcome: 'RECONCILED_UNKNOWN',
      job: this.jobStore.fail(
        job.jobId,
        workerId,
        'OUTCOME_UNKNOWN',
        `Command ${job.commandId} was reserved by a lost worker; its side effect must be reconciled, never repeated`,
      ),
    };
  }

  private receiptMismatch(
    job: ReviewWorkflowJob,
    stored: StoredReviewWorkflowCommand,
  ): string | null {
    if (stored.request.workflowId !== job.workflowId) {
      return `receipt workflow ${stored.request.workflowId} differs from job workflow ${job.workflowId}`;
    }
    if (stored.request.batchId !== job.batchId) {
      return `receipt batch ${stored.request.batchId} differs from job batch ${job.batchId}`;
    }
    if (stored.request.command.type !== job.expectedReceipt.commandType) {
      return `receipt command ${stored.request.command.type} differs from expected ${job.expectedReceipt.commandType}`;
    }
    const sideEffect = stored.sideEffect;
    if (job.expectedReceipt.sideEffectKind === null) {
      if (sideEffect !== null) return 'receipt has a side effect but none was expected';
      return null;
    }
    if (sideEffect === null || sideEffect.kind !== job.expectedReceipt.sideEffectKind) {
      return `receipt side-effect kind ${sideEffect?.kind ?? 'none'} differs from expected ${job.expectedReceipt.sideEffectKind}`;
    }
    if (
      job.expectedReceipt.sideEffectIdentity !== undefined &&
      sideEffect.sideEffectIdentity !== job.expectedReceipt.sideEffectIdentity
    ) {
      return `receipt side-effect identity ${sideEffect.sideEffectIdentity ?? 'none'} differs from expected ${job.expectedReceipt.sideEffectIdentity}`;
    }
    return null;
  }
}
