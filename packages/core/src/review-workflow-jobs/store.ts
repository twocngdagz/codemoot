// Durable job queue and event cursors for asynchronous workflow execution. Claims use a
// lease so a crashed worker's job becomes claimable again; every mutation is an optimistic
// UPDATE guarded by the state the caller observed.

import type Database from 'better-sqlite3';
import { z } from 'zod';
import { REVIEW_WORKFLOW_SIDE_EFFECT_KINDS } from '../memory/review-workflow-command-store.js';
import { type ReviewWorkflowEvent, ReviewWorkflowStore } from '../memory/review-workflow-store.js';
import { TRANSITION_COMMAND_TYPES } from '../review-workflow/types.js';
import {
  type EnqueueJobInput,
  REVIEW_WORKFLOW_JOB_STATUSES,
  REVIEW_WORKFLOW_JOB_TYPES,
  type ReviewWorkflowEventCursor,
  type ReviewWorkflowJob,
  ReviewWorkflowJobError,
  type ReviewWorkflowJobStatus,
  deriveExpectedReceipt,
} from './types.js';

const expectedReceiptSchema = z
  .object({
    commandType: z.enum(TRANSITION_COMMAND_TYPES),
    sideEffectKind: z.enum(REVIEW_WORKFLOW_SIDE_EFFECT_KINDS).nullable(),
    sideEffectIdentity: z.string().min(1).optional(),
  })
  .strict();

const jobRowSchema = z.object({
  job_id: z.string().min(1),
  workflow_id: z.string().min(1),
  batch_id: z.string().min(1),
  job_type: z.enum(REVIEW_WORKFLOW_JOB_TYPES),
  command_id: z.string().min(1),
  expected_receipt_json: z.string().min(1),
  status: z.enum(REVIEW_WORKFLOW_JOB_STATUSES),
  attempt_count: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  payload_json: z.string().min(1),
  result_json: z.string().nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  worker_id: z.string().nullable(),
  lease_expires_at: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

const cursorRowSchema = z.object({
  cursor_id: z.string().min(1),
  workflow_id: z.string().min(1),
  last_event_id: z.number().int().nonnegative(),
  updated_at: z.string().min(1),
});

const payloadSchema = z.record(z.string(), z.unknown());

type Clock = () => Date;

export class ReviewWorkflowJobStore {
  readonly workflowStore: ReviewWorkflowStore;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock = () => new Date(),
  ) {
    this.workflowStore = new ReviewWorkflowStore(db);
  }

  enqueue(input: EnqueueJobInput): ReviewWorkflowJob {
    const payload = payloadSchema.parse(input.payload);
    return this.db.transaction(() => {
      if (this.workflowStore.getWorkflow(input.workflowId) === null) {
        throw new ReviewWorkflowJobError(
          'WORKFLOW_NOT_FOUND',
          `Workflow ${input.workflowId} does not exist`,
        );
      }
      const batch = this.workflowStore.getBatch(input.batchId);
      if (batch === null || batch.workflowId !== input.workflowId) {
        throw new ReviewWorkflowJobError(
          'BATCH_NOT_FOUND',
          `Batch ${input.batchId} does not belong to workflow ${input.workflowId}`,
        );
      }
      if (this.get(input.jobId) !== null) {
        throw new ReviewWorkflowJobError('JOB_EXISTS', `Job ${input.jobId} already exists`);
      }
      if (this.getByCommandId(input.commandId) !== null) {
        throw new ReviewWorkflowJobError(
          'COMMAND_ALREADY_ENQUEUED',
          `Command ${input.commandId} is already owned by another job`,
        );
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO review_workflow_jobs (
            job_id, workflow_id, batch_id, job_type, command_id, expected_receipt_json,
            status, attempt_count, max_attempts, payload_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?, ?, ?)`,
        )
        .run(
          input.jobId,
          input.workflowId,
          input.batchId,
          input.jobType,
          input.commandId,
          JSON.stringify(
            expectedReceiptSchema.parse(deriveExpectedReceipt(input.jobType, input.commandId)),
          ),
          input.maxAttempts ?? 3,
          JSON.stringify(payload),
          now,
          now,
        );
      return this.require(input.jobId);
    })();
  }

  get(jobId: string): ReviewWorkflowJob | null {
    const row = this.db.prepare('SELECT * FROM review_workflow_jobs WHERE job_id = ?').get(jobId);
    return row === undefined ? null : this.toJob(row);
  }

  getByCommandId(commandId: string): ReviewWorkflowJob | null {
    const row = this.db
      .prepare('SELECT * FROM review_workflow_jobs WHERE command_id = ?')
      .get(commandId);
    return row === undefined ? null : this.toJob(row);
  }

  require(jobId: string): ReviewWorkflowJob {
    const job = this.get(jobId);
    if (job === null) {
      throw new ReviewWorkflowJobError('JOB_NOT_FOUND', `Job ${jobId} does not exist`);
    }
    return job;
  }

  list(workflowId: string, status?: ReviewWorkflowJobStatus): readonly ReviewWorkflowJob[] {
    const rows =
      status === undefined
        ? this.db
            .prepare(
              'SELECT * FROM review_workflow_jobs WHERE workflow_id = ? ORDER BY created_at, job_id',
            )
            .all(workflowId)
        : this.db
            .prepare(
              `SELECT * FROM review_workflow_jobs
               WHERE workflow_id = ? AND status = ?
               ORDER BY created_at, job_id`,
            )
            .all(workflowId, status);
    return rows.map((row) => this.toJob(row));
  }

  /**
   * Claims the oldest runnable job: QUEUED, or RUNNING with an expired lease (a crashed or
   * stalled worker). An expired job whose attempts are already exhausted is still claimable —
   * the service settles it from its receipt without ever re-invoking the operation — so no
   * crash can strand a job in RUNNING forever.
   */
  claimNext(workerId: string, leaseSeconds: number): ReviewWorkflowJob | null {
    return this.db.transaction(() => {
      const now = this.timestamp();
      const row = this.db
        .prepare(
          `SELECT * FROM review_workflow_jobs
           WHERE (status = 'QUEUED' AND attempt_count < max_attempts)
              OR (status = 'RUNNING' AND lease_expires_at < ?)
           ORDER BY created_at, job_id
           LIMIT 1`,
        )
        .get(now);
      if (row === undefined) return null;
      const job = this.toJob(row);
      const leaseExpiresAt = new Date(this.clock().getTime() + leaseSeconds * 1000).toISOString();
      const updated = this.db
        .prepare(
          `UPDATE review_workflow_jobs
           SET status = 'RUNNING',
               worker_id = ?,
               lease_expires_at = ?,
               attempt_count = attempt_count + 1,
               updated_at = ?
           WHERE job_id = ? AND status = ? AND attempt_count = ?`,
        )
        .run(workerId, leaseExpiresAt, now, job.jobId, job.status, job.attemptCount);
      if (updated.changes !== 1) return null;
      return this.require(job.jobId);
    })();
  }

  /** Completes a RUNNING job held by this worker; a cancelled job's late completion is a no-op. */
  succeed(jobId: string, workerId: string, result: unknown): ReviewWorkflowJob {
    const updated = this.db
      .prepare(
        `UPDATE review_workflow_jobs
         SET status = 'SUCCEEDED', result_json = ?, updated_at = ?
         WHERE job_id = ? AND status = 'RUNNING' AND worker_id = ?`,
      )
      .run(JSON.stringify(result ?? null), this.timestamp(), jobId, workerId);
    if (updated.changes !== 1) return this.require(jobId);
    return this.require(jobId);
  }

  fail(
    jobId: string,
    workerId: string,
    errorCode: string,
    errorMessage: string,
  ): ReviewWorkflowJob {
    this.db
      .prepare(
        `UPDATE review_workflow_jobs
         SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = ?
         WHERE job_id = ? AND status = 'RUNNING' AND worker_id = ?`,
      )
      .run(errorCode, errorMessage, this.timestamp(), jobId, workerId);
    return this.require(jobId);
  }

  /**
   * Returns a claim to QUEUED without consuming the attempt — for claims that never reached
   * the operation at all (e.g. no executor registered), so a bounded job cannot be stranded
   * by configuration errors.
   */
  requeueWithoutAttempt(
    jobId: string,
    workerId: string,
    errorCode: string,
    errorMessage: string,
  ): ReviewWorkflowJob {
    this.db
      .prepare(
        `UPDATE review_workflow_jobs
         SET status = 'QUEUED', worker_id = NULL, lease_expires_at = NULL,
             attempt_count = attempt_count - 1,
             error_code = ?, error_message = ?, updated_at = ?
         WHERE job_id = ? AND status = 'RUNNING' AND worker_id = ? AND attempt_count > 0`,
      )
      .run(errorCode, errorMessage, this.timestamp(), jobId, workerId);
    return this.require(jobId);
  }

  /** Returns a RUNNING job to QUEUED for a later attempt (the attempt was already counted). */
  requeue(
    jobId: string,
    workerId: string,
    errorCode: string,
    errorMessage: string,
  ): ReviewWorkflowJob {
    this.db
      .prepare(
        `UPDATE review_workflow_jobs
         SET status = 'QUEUED', worker_id = NULL, lease_expires_at = NULL,
             error_code = ?, error_message = ?, updated_at = ?
         WHERE job_id = ? AND status = 'RUNNING' AND worker_id = ?`,
      )
      .run(errorCode, errorMessage, this.timestamp(), jobId, workerId);
    return this.require(jobId);
  }

  cancel(jobId: string): ReviewWorkflowJob {
    const job = this.require(jobId);
    if (job.status !== 'QUEUED' && job.status !== 'RUNNING') {
      throw new ReviewWorkflowJobError(
        'INVALID_JOB_STATE',
        `Job ${jobId} is ${job.status} and can no longer be cancelled`,
      );
    }
    this.db
      .prepare(
        `UPDATE review_workflow_jobs
         SET status = 'CANCELLED', updated_at = ?
         WHERE job_id = ? AND status IN ('QUEUED', 'RUNNING')`,
      )
      .run(this.timestamp(), jobId);
    return this.require(jobId);
  }

  getCursor(cursorId: string): ReviewWorkflowEventCursor | null {
    const row = this.db
      .prepare('SELECT * FROM review_workflow_event_cursors WHERE cursor_id = ?')
      .get(cursorId);
    if (row === undefined) return null;
    const parsed = cursorRowSchema.parse(row);
    return {
      cursorId: parsed.cursor_id,
      workflowId: parsed.workflow_id,
      lastEventId: parsed.last_event_id,
      updatedAt: parsed.updated_at,
    };
  }

  /** Advances a consumer cursor; positions are monotonic and bound to one workflow. */
  advanceCursor(input: {
    readonly cursorId: string;
    readonly workflowId: string;
    readonly lastEventId: number;
  }): ReviewWorkflowEventCursor {
    return this.db.transaction(() => {
      const existing = this.getCursor(input.cursorId);
      const now = this.timestamp();
      if (existing === null) {
        if (this.workflowStore.getWorkflow(input.workflowId) === null) {
          throw new ReviewWorkflowJobError(
            'WORKFLOW_NOT_FOUND',
            `Workflow ${input.workflowId} does not exist`,
          );
        }
        this.db
          .prepare(
            `INSERT INTO review_workflow_event_cursors (cursor_id, workflow_id, last_event_id, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(input.cursorId, input.workflowId, input.lastEventId, now);
      } else {
        if (existing.workflowId !== input.workflowId) {
          throw new ReviewWorkflowJobError(
            'CURSOR_CONFLICT',
            `Cursor ${input.cursorId} belongs to workflow ${existing.workflowId}`,
          );
        }
        if (input.lastEventId < existing.lastEventId) {
          throw new ReviewWorkflowJobError(
            'CURSOR_CONFLICT',
            `Cursor ${input.cursorId} cannot move backwards from ${existing.lastEventId} to ${input.lastEventId}`,
          );
        }
        this.db
          .prepare(
            `UPDATE review_workflow_event_cursors
             SET last_event_id = ?, updated_at = ?
             WHERE cursor_id = ? AND last_event_id = ?`,
          )
          .run(input.lastEventId, now, input.cursorId, existing.lastEventId);
      }
      const cursor = this.getCursor(input.cursorId);
      if (cursor === null) {
        throw new ReviewWorkflowJobError('JOB_NOT_FOUND', `Cursor ${input.cursorId} vanished`);
      }
      return cursor;
    })();
  }

  listWorkflowEvents(
    workflowId: string,
    afterEventId = 0,
    limit = 100,
  ): readonly ReviewWorkflowEvent[] {
    return this.workflowStore.listWorkflowEvents(workflowId, afterEventId, limit);
  }

  private toJob(row: unknown): ReviewWorkflowJob {
    const parsed = jobRowSchema.parse(row);
    return {
      jobId: parsed.job_id,
      workflowId: parsed.workflow_id,
      batchId: parsed.batch_id,
      jobType: parsed.job_type,
      commandId: parsed.command_id,
      expectedReceipt: parseExpectedReceipt(parsed.expected_receipt_json),
      status: parsed.status,
      attemptCount: parsed.attempt_count,
      maxAttempts: parsed.max_attempts,
      payload: payloadSchema.parse(JSON.parse(parsed.payload_json)),
      result: parsed.result_json === null ? null : JSON.parse(parsed.result_json),
      ...(parsed.error_code === null ? {} : { errorCode: parsed.error_code }),
      ...(parsed.error_message === null ? {} : { errorMessage: parsed.error_message }),
      ...(parsed.worker_id === null ? {} : { workerId: parsed.worker_id }),
      ...(parsed.lease_expires_at === null ? {} : { leaseExpiresAt: parsed.lease_expires_at }),
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
    };
  }

  private timestamp(): string {
    return this.clock().toISOString();
  }
}

function parseExpectedReceipt(raw: string): ReviewWorkflowJob['expectedReceipt'] {
  const parsed = expectedReceiptSchema.parse(JSON.parse(raw));
  return {
    commandType: parsed.commandType,
    sideEffectKind: parsed.sideEffectKind,
    ...(parsed.sideEffectIdentity === undefined
      ? {}
      : { sideEffectIdentity: parsed.sideEffectIdentity }),
  };
}
