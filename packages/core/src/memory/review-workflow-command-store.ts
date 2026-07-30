// Durable command reservation, replay, and optimistic batch transitions.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  commandReceiptSchema,
  reviewWorkflowBatchSchema,
  stateChangingCommandRequestSchema,
} from '../review-workflow/schemas.js';
import { transitionBatch } from '../review-workflow/state-machine.js';
import type {
  AllowedTransition,
  CommandReceipt,
  ReviewWorkflowBatch,
  StateChangingCommandRequest,
} from '../review-workflow/types.js';
import { ReviewWorkflowPersistenceError, ReviewWorkflowStore } from './review-workflow-store.js';

export const REVIEW_WORKFLOW_SIDE_EFFECT_KINDS = [
  'AGENT_INVOCATION',
  'VERIFICATION_EXECUTION',
] as const;

export type ReviewWorkflowSideEffectKind = (typeof REVIEW_WORKFLOW_SIDE_EFFECT_KINDS)[number];

export const REVIEW_WORKFLOW_SIDE_EFFECT_STATES = [
  'NOT_STARTED',
  'STARTING',
  'OUTCOME_RECORDED',
] as const;

export type ReviewWorkflowSideEffectState = (typeof REVIEW_WORKFLOW_SIDE_EFFECT_STATES)[number];

export interface ReviewWorkflowCommandSideEffect {
  readonly commandId: string;
  readonly kind: ReviewWorkflowSideEffectKind;
  readonly state: ReviewWorkflowSideEffectState;
  readonly sideEffectIdentity?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly outcomeRecordedAt?: string;
  readonly updatedAt: string;
}

export interface StoredReviewWorkflowCommand {
  readonly request: StateChangingCommandRequest;
  readonly receipt: CommandReceipt;
  readonly sideEffect: ReviewWorkflowCommandSideEffect | null;
  readonly result: unknown;
}

export interface CommandReservation {
  readonly replayed: boolean;
  readonly command: StoredReviewWorkflowCommand;
}

export interface SideEffectClaim {
  readonly shouldInvoke: boolean;
  readonly command: StoredReviewWorkflowCommand;
}

export interface CommandCompletion {
  readonly replayed: boolean;
  readonly command: StoredReviewWorkflowCommand;
}

export type NonTransitionCommandOutcomeStatus =
  | 'FAILED_FINAL'
  | 'TIMED_OUT'
  | 'OUTCOME_UNKNOWN'
  | 'RECONCILED';

type Clock = () => Date;

const receiptRowSchema = z.object({
  command_id: z.string(),
  workflow_id: z.string(),
  batch_id: z.string(),
  command_type: z.string(),
  expected_aggregate_version: z.number().int().nonnegative(),
  canonical_request_hash: z.string(),
  target_commit_sha: z.string().nullable(),
  requester_actor_execution_id: z.string(),
  authority_exercised: z.string(),
  status: z.string(),
  side_effect_identity: z.string().nullable(),
  resulting_aggregate_version: z.number().int().nonnegative().nullable(),
  resulting_event_sequence: z.number().int().nonnegative().nullable(),
  result_hash: z.string().nullable(),
  result_json: z.string().nullable(),
  error_code: z.string().nullable(),
  request_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const sideEffectRowSchema = z.object({
  command_id: z.string(),
  side_effect_kind: z.enum(REVIEW_WORKFLOW_SIDE_EFFECT_KINDS),
  state: z.enum(REVIEW_WORKFLOW_SIDE_EFFECT_STATES),
  side_effect_identity: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  outcome_recorded_at: z.string().nullable(),
  updated_at: z.string(),
});

const batchPersistenceRowSchema = z.object({
  workflow_id: z.string(),
  persisted_state: z.string(),
  aggregate_version: z.number().int().nonnegative(),
  last_event_sequence: z.number().int().nonnegative(),
  payload_json: z.string(),
});

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ReviewWorkflowPersistenceError(
      'PERSISTED_DATA_INVALID',
      'Review workflow command persistence received a non-serializable value',
    );
  }
  return serialized;
}

function parseStoredJson(serialized: string, description: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    throw new ReviewWorkflowPersistenceError(
      'PERSISTED_DATA_INVALID',
      `Stored ${description} is invalid JSON`,
    );
  }
}

function hashRecord(value: unknown): string {
  return createHash('sha256').update(serializeJson(value)).digest('hex');
}

function requireNonEmpty(value: string, description: string): string {
  if (value.length === 0) {
    throw new ReviewWorkflowPersistenceError(
      'PERSISTED_DATA_INVALID',
      `${description} must not be empty`,
    );
  }
  return value;
}

export class ReviewWorkflowCommandStore {
  private readonly workflowStore: ReviewWorkflowStore;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock = () => new Date(),
  ) {
    this.workflowStore = new ReviewWorkflowStore(db);
  }

  reserve(
    request: StateChangingCommandRequest,
    sideEffectKind?: ReviewWorkflowSideEffectKind,
  ): CommandReservation {
    const parsedRequest = stateChangingCommandRequestSchema.parse(request);

    return this.db.transaction(() => {
      const existing = this.get(parsedRequest.commandId);
      if (existing !== null) {
        this.assertReplayMatches(existing, parsedRequest, sideEffectKind);
        return { replayed: true, command: existing };
      }

      this.assertWorkflowExists(parsedRequest.workflowId);
      this.assertExpectedVersionAtReservation(parsedRequest);
      this.workflowStore.saveEntity({ kind: 'ACTOR_EXECUTION', value: parsedRequest.requester });

      const timestamp = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO review_workflow_command_receipts (
            command_id,
            workflow_id,
            batch_id,
            command_type,
            expected_aggregate_version,
            canonical_request_hash,
            target_commit_sha,
            requester_actor_execution_id,
            authority_exercised,
            status,
            request_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?)`,
        )
        .run(
          parsedRequest.commandId,
          parsedRequest.workflowId,
          parsedRequest.batchId,
          parsedRequest.command.type,
          parsedRequest.expectedAggregateVersion,
          parsedRequest.canonicalRequestHash,
          parsedRequest.targetCommitSha ?? null,
          parsedRequest.requester.actorExecutionId,
          parsedRequest.authorityExercised,
          serializeJson(parsedRequest),
          timestamp,
          timestamp,
        );

      if (sideEffectKind !== undefined) {
        this.db
          .prepare(
            `INSERT INTO review_workflow_command_side_effects (
              command_id,
              side_effect_kind,
              state,
              created_at,
              updated_at
            ) VALUES (?, ?, 'NOT_STARTED', ?, ?)`,
          )
          .run(parsedRequest.commandId, sideEffectKind, timestamp, timestamp);
      }

      return {
        replayed: false,
        command: this.requireCommand(parsedRequest.commandId),
      };
    })();
  }

  get(commandId: string): StoredReviewWorkflowCommand | null {
    const row = this.db
      .prepare('SELECT * FROM review_workflow_command_receipts WHERE command_id = ?')
      .get(commandId);
    if (row === undefined) return null;

    const parsed = receiptRowSchema.parse(row);
    const request = stateChangingCommandRequestSchema.parse(
      parseStoredJson(parsed.request_json, 'command request'),
    );
    const receipt = commandReceiptSchema.parse({
      commandId: parsed.command_id,
      workflowId: parsed.workflow_id,
      batchId: parsed.batch_id,
      commandType: parsed.command_type,
      expectedAggregateVersion: parsed.expected_aggregate_version,
      canonicalRequestHash: parsed.canonical_request_hash,
      ...(parsed.target_commit_sha === null ? {} : { targetCommitSha: parsed.target_commit_sha }),
      requesterActorExecutionId: parsed.requester_actor_execution_id,
      authorityExercised: parsed.authority_exercised,
      status: parsed.status,
      ...(parsed.side_effect_identity === null
        ? {}
        : { sideEffectIdentity: parsed.side_effect_identity }),
      ...(parsed.resulting_aggregate_version === null
        ? {}
        : { resultingAggregateVersion: parsed.resulting_aggregate_version }),
      ...(parsed.resulting_event_sequence === null
        ? {}
        : { resultingEventSequence: parsed.resulting_event_sequence }),
      ...(parsed.result_hash === null ? {} : { resultHash: parsed.result_hash }),
      ...(parsed.error_code === null ? {} : { errorCode: parsed.error_code }),
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
    });

    return {
      request,
      receipt,
      sideEffect: this.getSideEffect(commandId),
      result:
        parsed.result_json === null ? null : parseStoredJson(parsed.result_json, 'command result'),
    };
  }

  claimSideEffect(commandId: string, sideEffectIdentity: string): SideEffectClaim {
    requireNonEmpty(sideEffectIdentity, 'Side-effect identity');

    return this.db.transaction(() => {
      const stored = this.requireCommand(commandId);
      const sideEffect = stored.sideEffect;
      if (sideEffect === null) {
        throw new ReviewWorkflowPersistenceError(
          'SIDE_EFFECT_NOT_RESERVED',
          `Command ${commandId} has no reserved side effect`,
        );
      }

      if (sideEffect.state !== 'NOT_STARTED') {
        if (sideEffect.sideEffectIdentity !== sideEffectIdentity) {
          throw new ReviewWorkflowPersistenceError(
            'IDEMPOTENCY_CONFLICT',
            `Command ${commandId} is already bound to a different side-effect identity`,
          );
        }
        return { shouldInvoke: false, command: stored };
      }

      if (stored.receipt.status !== 'RESERVED') {
        throw new ReviewWorkflowPersistenceError(
          'COMMAND_STATE_CONFLICT',
          `Command ${commandId} cannot start a side effect from ${stored.receipt.status}`,
        );
      }

      const timestamp = this.timestamp();
      const sideEffectUpdate = this.db
        .prepare(
          `UPDATE review_workflow_command_side_effects
           SET state = 'STARTING',
               side_effect_identity = ?,
               started_at = ?,
               updated_at = ?
           WHERE command_id = ? AND state = 'NOT_STARTED'`,
        )
        .run(sideEffectIdentity, timestamp, timestamp, commandId);
      const receiptUpdate = this.db
        .prepare(
          `UPDATE review_workflow_command_receipts
           SET status = 'RUNNING',
               side_effect_identity = ?,
               updated_at = ?
           WHERE command_id = ? AND status = 'RESERVED'`,
        )
        .run(sideEffectIdentity, timestamp, commandId);

      if (sideEffectUpdate.changes !== 1 || receiptUpdate.changes !== 1) {
        throw new ReviewWorkflowPersistenceError(
          'COMMAND_STATE_CONFLICT',
          `Command ${commandId} side-effect claim lost an optimistic race`,
        );
      }

      return {
        shouldInvoke: true,
        command: this.requireCommand(commandId),
      };
    })();
  }

  succeedWithBatchCreation(input: {
    readonly commandId: string;
    readonly transition: AllowedTransition;
    readonly batch: ReviewWorkflowBatch;
    readonly eventType: string;
    readonly eventPayload: Readonly<Record<string, unknown>>;
    readonly resultHash: string;
    readonly result?: unknown;
  }): CommandCompletion {
    requireNonEmpty(input.eventType, 'Event type');
    requireNonEmpty(input.resultHash, 'Result hash');
    const batch = reviewWorkflowBatchSchema.parse(input.batch);

    return this.db.transaction(() => {
      const stored = this.requireCommand(input.commandId);
      if (stored.receipt.status === 'SUCCEEDED') {
        this.assertSuccessfulReplay(stored, input.resultHash);
        return { replayed: true, command: stored };
      }
      this.assertCanComplete(stored);

      if (stored.request.command.type !== 'CREATE_BATCH') {
        throw new ReviewWorkflowPersistenceError(
          'COMMAND_STATE_CONFLICT',
          `Command ${input.commandId} is not a valid batch-creation transition`,
        );
      }
      const transition = this.deriveAllowedTransition(stored, null);
      this.assertTransitionMatches(input.commandId, input.transition, transition);
      if (
        batch.workflowId !== stored.request.workflowId ||
        batch.batchId !== stored.request.batchId ||
        batch.persistedState !== transition.nextState ||
        batch.aggregateVersion !== stored.request.expectedAggregateVersion + 1
      ) {
        throw new ReviewWorkflowPersistenceError(
          'AGGREGATE_VERSION_CONFLICT',
          `Created batch ${batch.batchId} does not match the reserved command aggregate`,
        );
      }
      if (this.workflowStore.getBatch(batch.batchId) !== null) {
        throw new ReviewWorkflowPersistenceError(
          'AGGREGATE_VERSION_CONFLICT',
          `Batch ${batch.batchId} already exists`,
        );
      }

      const sequence = 1;
      const payloadJson = serializeJson(batch);
      const recordHash = hashRecord({ kind: 'BATCH', value: batch });
      this.db
        .prepare(
          `INSERT INTO review_workflow_batches (
            batch_id,
            workflow_id,
            ordinal,
            persisted_state,
            aggregate_version,
            last_event_sequence,
            current_plan_version_id,
            implementer_assignment_id,
            reviewer_assignment_id,
            original_batch_base_sha,
            blocked_from_state,
            blocked_resume_state,
            payload_json,
            record_hash,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          batch.batchId,
          batch.workflowId,
          batch.ordinal,
          batch.persistedState,
          batch.aggregateVersion,
          sequence,
          batch.currentPlanVersionId,
          batch.implementerAssignmentId,
          batch.reviewerAssignmentId,
          batch.originalBatchBaseSha ?? null,
          batch.blockedFromState ?? null,
          batch.blockedResumeState ?? null,
          payloadJson,
          recordHash,
          batch.createdAt,
          batch.updatedAt,
        );

      this.insertEvent({
        stored,
        sequence,
        aggregateVersion: batch.aggregateVersion,
        eventType: input.eventType,
        eventPayload: input.eventPayload,
        createdAt: batch.updatedAt,
      });
      this.completeReceipt({
        stored,
        status: 'SUCCEEDED',
        resultHash: input.resultHash,
        result: input.result,
        aggregateVersion: batch.aggregateVersion,
        eventSequence: sequence,
        updatedAt: batch.updatedAt,
      });

      return {
        replayed: false,
        command: this.requireCommand(input.commandId),
      };
    })();
  }

  succeedWithTransition(input: {
    readonly commandId: string;
    readonly transition: AllowedTransition;
    readonly eventType: string;
    readonly eventPayload: Readonly<Record<string, unknown>>;
    readonly resultHash: string;
    readonly result?: unknown;
    readonly transitionActorExecutionId?: string;
  }): CommandCompletion {
    requireNonEmpty(input.eventType, 'Event type');
    requireNonEmpty(input.resultHash, 'Result hash');

    return this.db.transaction(() => {
      const stored = this.requireCommand(input.commandId);
      if (stored.receipt.status === 'SUCCEEDED') {
        this.assertSuccessfulReplay(stored, input.resultHash);
        return { replayed: true, command: stored };
      }
      this.assertCanComplete(stored);
      if (stored.request.command.type === 'CREATE_BATCH') {
        throw new ReviewWorkflowPersistenceError(
          'COMMAND_STATE_CONFLICT',
          `CREATE_BATCH command ${input.commandId} requires batch-creation completion`,
        );
      }

      const row = this.requireBatchRow(stored.request.batchId);
      if (
        row.workflow_id !== stored.request.workflowId ||
        row.aggregate_version !== stored.request.expectedAggregateVersion
      ) {
        throw new ReviewWorkflowPersistenceError(
          'AGGREGATE_VERSION_CONFLICT',
          `Batch ${stored.request.batchId} changed after command ${input.commandId} was reserved`,
        );
      }

      const currentBatch = reviewWorkflowBatchSchema.parse(
        parseStoredJson(row.payload_json, 'batch aggregate'),
      );
      const transitionActor = this.resolveTransitionActor(stored, input.transitionActorExecutionId);
      const transition = this.deriveAllowedTransitionForActor(
        stored,
        currentBatch,
        transitionActor,
      );
      this.assertTransitionMatches(input.commandId, input.transition, transition);
      const nextVersion = row.aggregate_version + 1;
      const nextSequence = row.last_event_sequence + 1;
      const updatedAt = this.timestamp();
      const nextBatch = this.nextBatchSnapshot(
        currentBatch,
        stored.request,
        transition,
        nextVersion,
        updatedAt,
      );
      const payloadJson = serializeJson(nextBatch);
      const recordHash = hashRecord({ kind: 'BATCH', value: nextBatch });

      const update = this.db
        .prepare(
          `UPDATE review_workflow_batches
           SET persisted_state = ?,
               aggregate_version = ?,
               last_event_sequence = ?,
               current_plan_version_id = ?,
               original_batch_base_sha = ?,
               blocked_from_state = ?,
               blocked_resume_state = ?,
               payload_json = ?,
               record_hash = ?,
               updated_at = ?
           WHERE batch_id = ? AND aggregate_version = ?`,
        )
        .run(
          nextBatch.persistedState,
          nextBatch.aggregateVersion,
          nextSequence,
          nextBatch.currentPlanVersionId,
          nextBatch.originalBatchBaseSha ?? null,
          nextBatch.blockedFromState ?? null,
          nextBatch.blockedResumeState ?? null,
          payloadJson,
          recordHash,
          nextBatch.updatedAt,
          nextBatch.batchId,
          currentBatch.aggregateVersion,
        );
      if (update.changes !== 1) {
        throw new ReviewWorkflowPersistenceError(
          'AGGREGATE_VERSION_CONFLICT',
          `Batch ${nextBatch.batchId} lost an optimistic update race`,
        );
      }

      this.insertEvent({
        stored,
        sequence: nextSequence,
        aggregateVersion: nextVersion,
        eventType: input.eventType,
        eventPayload: input.eventPayload,
        createdAt: updatedAt,
        actorExecutionId: transitionActor.actorExecutionId,
      });
      this.completeReceipt({
        stored,
        status: 'SUCCEEDED',
        resultHash: input.resultHash,
        result: input.result,
        aggregateVersion: nextVersion,
        eventSequence: nextSequence,
        updatedAt,
      });

      return {
        replayed: false,
        command: this.requireCommand(input.commandId),
      };
    })();
  }

  /**
   * Completes an invocation-only receipt: the external side effect ran and its evidence was
   * persisted, but the state transition it feeds is decided by a separate receipt. Requires a
   * claimed side effect so at-most-once semantics still hold.
   */
  succeedWithoutTransition(input: {
    readonly commandId: string;
    readonly resultHash: string;
    readonly result?: unknown;
  }): CommandCompletion {
    requireNonEmpty(input.resultHash, 'Result hash');
    return this.db.transaction(() => {
      const stored = this.requireCommand(input.commandId);
      if (stored.receipt.status === 'SUCCEEDED') {
        this.assertSuccessfulReplay(stored, input.resultHash);
        return { replayed: true, command: stored };
      }
      this.assertCanComplete(stored);
      if (stored.sideEffect === null) {
        throw new ReviewWorkflowPersistenceError(
          'COMMAND_STATE_CONFLICT',
          `Command ${input.commandId} has no side effect; complete it with its transition`,
        );
      }
      const updatedAt = this.timestamp();
      const update = this.db
        .prepare(
          `UPDATE review_workflow_command_receipts
           SET status = 'SUCCEEDED',
               result_hash = ?,
               result_json = ?,
               updated_at = ?
           WHERE command_id = ? AND status = ?`,
        )
        .run(
          input.resultHash,
          input.result === undefined ? null : serializeJson(input.result),
          updatedAt,
          input.commandId,
          stored.receipt.status,
        );
      if (update.changes !== 1) {
        throw new ReviewWorkflowPersistenceError(
          'COMMAND_STATE_CONFLICT',
          `Command ${input.commandId} completion lost an optimistic race`,
        );
      }
      this.markSideEffectOutcomeRecorded(input.commandId, updatedAt);
      return { replayed: false, command: this.requireCommand(input.commandId) };
    })();
  }

  recordOutcome(input: {
    readonly commandId: string;
    readonly status: NonTransitionCommandOutcomeStatus;
    readonly resultHash?: string;
    readonly result?: unknown;
    readonly errorCode?: string;
  }): CommandCompletion {
    if (input.resultHash !== undefined) requireNonEmpty(input.resultHash, 'Result hash');
    if (input.errorCode !== undefined) requireNonEmpty(input.errorCode, 'Error code');

    return this.db.transaction(() => {
      const stored = this.requireCommand(input.commandId);
      if (stored.receipt.status === input.status) {
        this.assertOutcomeReplay(stored, input);
        return { replayed: true, command: stored };
      }

      const reconciling = input.status === 'RECONCILED';
      const validSource = reconciling
        ? stored.receipt.status === 'TIMED_OUT' || stored.receipt.status === 'OUTCOME_UNKNOWN'
        : stored.receipt.status === 'RESERVED' || stored.receipt.status === 'RUNNING';
      if (!validSource) {
        throw new ReviewWorkflowPersistenceError(
          'COMMAND_STATE_CONFLICT',
          `Command ${input.commandId} cannot move from ${stored.receipt.status} to ${input.status}`,
        );
      }

      const updatedAt = this.timestamp();
      const update = this.db
        .prepare(
          `UPDATE review_workflow_command_receipts
           SET status = ?,
               result_hash = ?,
               result_json = ?,
               error_code = ?,
               updated_at = ?
           WHERE command_id = ? AND status = ?`,
        )
        .run(
          input.status,
          input.resultHash ?? null,
          input.result === undefined ? null : serializeJson(input.result),
          input.errorCode ?? null,
          updatedAt,
          input.commandId,
          stored.receipt.status,
        );
      if (update.changes !== 1) {
        throw new ReviewWorkflowPersistenceError(
          'COMMAND_STATE_CONFLICT',
          `Command ${input.commandId} outcome update lost an optimistic race`,
        );
      }

      if (input.status === 'FAILED_FINAL' || input.status === 'RECONCILED') {
        this.markSideEffectOutcomeRecorded(input.commandId, updatedAt);
      }

      return {
        replayed: false,
        command: this.requireCommand(input.commandId),
      };
    })();
  }

  private assertWorkflowExists(workflowId: string): void {
    if (this.workflowStore.getWorkflow(workflowId) === null) {
      throw new ReviewWorkflowPersistenceError(
        'WORKFLOW_NOT_FOUND',
        `Workflow ${workflowId} does not exist`,
      );
    }
  }

  private assertExpectedVersionAtReservation(request: StateChangingCommandRequest): void {
    const row = this.getBatchRow(request.batchId);
    if (row === null) {
      if (request.command.type === 'CREATE_BATCH' && request.expectedAggregateVersion === 0) return;
      throw new ReviewWorkflowPersistenceError(
        'BATCH_NOT_FOUND',
        `Batch ${request.batchId} does not exist`,
      );
    }
    if (
      row.workflow_id !== request.workflowId ||
      row.aggregate_version !== request.expectedAggregateVersion
    ) {
      throw new ReviewWorkflowPersistenceError(
        'AGGREGATE_VERSION_CONFLICT',
        `Batch ${request.batchId} is not at expected version ${request.expectedAggregateVersion}`,
      );
    }
  }

  private assertReplayMatches(
    stored: StoredReviewWorkflowCommand,
    request: StateChangingCommandRequest,
    sideEffectKind?: ReviewWorkflowSideEffectKind,
  ): void {
    const storedSideEffectKind = stored.sideEffect?.kind;
    const matches =
      stored.request.workflowId === request.workflowId &&
      stored.request.batchId === request.batchId &&
      stored.request.command.type === request.command.type &&
      stored.request.expectedAggregateVersion === request.expectedAggregateVersion &&
      stored.request.canonicalRequestHash === request.canonicalRequestHash &&
      stored.request.targetCommitSha === request.targetCommitSha &&
      stored.request.requester.actorExecutionId === request.requester.actorExecutionId &&
      stored.request.authorityExercised === request.authorityExercised &&
      serializeJson(stored.request) === serializeJson(request) &&
      storedSideEffectKind === sideEffectKind;
    if (!matches) {
      throw new ReviewWorkflowPersistenceError(
        'IDEMPOTENCY_CONFLICT',
        `Command ID ${request.commandId} was already reserved for a different request`,
      );
    }
  }

  private assertSuccessfulReplay(stored: StoredReviewWorkflowCommand, resultHash: string): void {
    if (stored.receipt.resultHash !== resultHash) {
      throw new ReviewWorkflowPersistenceError(
        'IDEMPOTENCY_CONFLICT',
        `Command ${stored.receipt.commandId} already succeeded with a different result`,
      );
    }
  }

  private assertOutcomeReplay(
    stored: StoredReviewWorkflowCommand,
    input: {
      readonly resultHash?: string;
      readonly result?: unknown;
      readonly errorCode?: string;
    },
  ): void {
    const resultMatches =
      input.result === undefined
        ? stored.result === null
        : serializeJson(input.result) === serializeJson(stored.result);
    if (
      stored.receipt.resultHash !== input.resultHash ||
      stored.receipt.errorCode !== input.errorCode ||
      !resultMatches
    ) {
      throw new ReviewWorkflowPersistenceError(
        'IDEMPOTENCY_CONFLICT',
        `Command ${stored.receipt.commandId} already recorded a different outcome`,
      );
    }
  }

  private assertCanComplete(stored: StoredReviewWorkflowCommand): void {
    if (stored.receipt.status !== 'RESERVED' && stored.receipt.status !== 'RUNNING') {
      throw new ReviewWorkflowPersistenceError(
        'COMMAND_STATE_CONFLICT',
        `Command ${stored.receipt.commandId} cannot complete from ${stored.receipt.status}`,
      );
    }
    if (stored.sideEffect !== null && stored.sideEffect.state !== 'STARTING') {
      throw new ReviewWorkflowPersistenceError(
        'COMMAND_STATE_CONFLICT',
        `Command ${stored.receipt.commandId} cannot complete before its side effect starts`,
      );
    }
  }

  private deriveAllowedTransition(
    stored: StoredReviewWorkflowCommand,
    currentBatch: ReviewWorkflowBatch | null,
    transitionActorExecutionId?: string,
  ): AllowedTransition {
    return this.deriveAllowedTransitionForActor(
      stored,
      currentBatch,
      this.resolveTransitionActor(stored, transitionActorExecutionId),
    );
  }

  private deriveAllowedTransitionForActor(
    stored: StoredReviewWorkflowCommand,
    currentBatch: ReviewWorkflowBatch | null,
    actor: StateChangingCommandRequest['requester'],
  ): AllowedTransition {
    const result = transitionBatch({
      currentState: currentBatch?.persistedState ?? null,
      command: stored.request.command,
      actor,
      ...(currentBatch?.blockedFromState === undefined
        ? {}
        : { blockedFromState: currentBatch.blockedFromState }),
      ...(currentBatch?.blockedResumeState === undefined
        ? {}
        : { blockedResumeState: currentBatch.blockedResumeState }),
    });
    if (!result.allowed) {
      throw new ReviewWorkflowPersistenceError(
        'COMMAND_STATE_CONFLICT',
        `Command ${stored.receipt.commandId} is not allowed: ${result.code}`,
      );
    }
    return result;
  }

  /**
   * Resolves the actor for kernel re-derivation. The receipt requester records who asked for
   * the command before any side effect ran; when an agent invocation produced richer
   * process-attested evidence, the caller names that persisted execution and the kernel is
   * re-evaluated against the durable record, never a caller-supplied object.
   */
  private resolveTransitionActor(
    stored: StoredReviewWorkflowCommand,
    transitionActorExecutionId: string | undefined,
  ): StateChangingCommandRequest['requester'] {
    if (transitionActorExecutionId === undefined) return stored.request.requester;
    const entity = this.workflowStore.getEntity('ACTOR_EXECUTION', transitionActorExecutionId);
    if (entity === null || entity.kind !== 'ACTOR_EXECUTION') {
      throw new ReviewWorkflowPersistenceError(
        'PERSISTED_DATA_INVALID',
        `Transition actor execution ${transitionActorExecutionId} is not persisted`,
      );
    }
    const claimedInvocationId = stored.sideEffect?.sideEffectIdentity;
    if (
      claimedInvocationId !== undefined &&
      entity.value.invocationIdentityId !== claimedInvocationId
    ) {
      throw new ReviewWorkflowPersistenceError(
        'COMMAND_STATE_CONFLICT',
        `Transition actor ${transitionActorExecutionId} is not bound to the claimed invocation ${claimedInvocationId}`,
      );
    }
    return entity.value;
  }

  private assertTransitionMatches(
    commandId: string,
    supplied: AllowedTransition,
    derived: AllowedTransition,
  ): void {
    if (
      supplied.commandType !== derived.commandType ||
      supplied.previousState !== derived.previousState ||
      supplied.nextState !== derived.nextState ||
      supplied.blockedFromState !== derived.blockedFromState ||
      supplied.blockedResumeState !== derived.blockedResumeState
    ) {
      throw new ReviewWorkflowPersistenceError(
        'COMMAND_STATE_CONFLICT',
        `Transition result does not match the kernel-derived result for command ${commandId}`,
      );
    }
  }

  private nextBatchSnapshot(
    current: ReviewWorkflowBatch,
    request: StateChangingCommandRequest,
    transition: AllowedTransition,
    aggregateVersion: number,
    updatedAt: string,
  ): ReviewWorkflowBatch {
    const { command } = request;
    const originalBatchBaseSha =
      command.type === 'START_IMPLEMENTATION'
        ? this.implementationBaseSha(current, request.targetCommitSha)
        : current.originalBatchBaseSha;
    const base = {
      batchId: current.batchId,
      workflowId: current.workflowId,
      ordinal: current.ordinal,
      persistedState: transition.nextState,
      aggregateVersion,
      currentPlanVersionId:
        command.type === 'SUBMIT_REVISED_PLAN'
          ? command.evidence.revisedPlanVersionId
          : current.currentPlanVersionId,
      implementerAssignmentId: current.implementerAssignmentId,
      reviewerAssignmentId: current.reviewerAssignmentId,
      ...(originalBatchBaseSha === undefined ? {} : { originalBatchBaseSha }),
      createdAt: current.createdAt,
      updatedAt,
    };
    if (transition.nextState !== 'BLOCKED') {
      return reviewWorkflowBatchSchema.parse(base);
    }
    if (transition.blockedFromState === undefined || transition.blockedResumeState === undefined) {
      throw new ReviewWorkflowPersistenceError(
        'PERSISTED_DATA_INVALID',
        'A blocked transition requires its kernel-derived block context',
      );
    }
    return reviewWorkflowBatchSchema.parse({
      ...base,
      blockedFromState: transition.blockedFromState,
      blockedResumeState: transition.blockedResumeState,
    });
  }

  private implementationBaseSha(
    current: ReviewWorkflowBatch,
    targetCommitSha: string | undefined,
  ): string {
    if (targetCommitSha === undefined) {
      throw new ReviewWorkflowPersistenceError(
        'PERSISTED_DATA_INVALID',
        'START_IMPLEMENTATION requires the fresh repository HEAD as its target commit SHA',
      );
    }
    if (
      current.originalBatchBaseSha !== undefined &&
      current.originalBatchBaseSha !== targetCommitSha
    ) {
      throw new ReviewWorkflowPersistenceError(
        'COMMAND_STATE_CONFLICT',
        'An established original batch base SHA cannot be replaced',
      );
    }
    return current.originalBatchBaseSha ?? targetCommitSha;
  }

  private insertEvent(input: {
    readonly stored: StoredReviewWorkflowCommand;
    readonly sequence: number;
    readonly aggregateVersion: number;
    readonly eventType: string;
    readonly eventPayload: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly actorExecutionId?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO review_workflow_events (
          workflow_id,
          batch_id,
          sequence,
          aggregate_version,
          event_type,
          command_id,
          actor_execution_id,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.stored.request.workflowId,
        input.stored.request.batchId,
        input.sequence,
        input.aggregateVersion,
        input.eventType,
        input.stored.receipt.commandId,
        input.actorExecutionId ?? input.stored.receipt.requesterActorExecutionId,
        serializeJson(input.eventPayload),
        input.createdAt,
      );
  }

  private completeReceipt(input: {
    readonly stored: StoredReviewWorkflowCommand;
    readonly status: 'SUCCEEDED';
    readonly resultHash: string;
    readonly result?: unknown;
    readonly aggregateVersion: number;
    readonly eventSequence: number;
    readonly updatedAt: string;
  }): void {
    const update = this.db
      .prepare(
        `UPDATE review_workflow_command_receipts
         SET status = ?,
             resulting_aggregate_version = ?,
             resulting_event_sequence = ?,
             result_hash = ?,
             result_json = ?,
             updated_at = ?
         WHERE command_id = ? AND status = ?`,
      )
      .run(
        input.status,
        input.aggregateVersion,
        input.eventSequence,
        input.resultHash,
        input.result === undefined ? null : serializeJson(input.result),
        input.updatedAt,
        input.stored.receipt.commandId,
        input.stored.receipt.status,
      );
    if (update.changes !== 1) {
      throw new ReviewWorkflowPersistenceError(
        'COMMAND_STATE_CONFLICT',
        `Command ${input.stored.receipt.commandId} completion lost an optimistic race`,
      );
    }
    this.markSideEffectOutcomeRecorded(input.stored.receipt.commandId, input.updatedAt);
  }

  private markSideEffectOutcomeRecorded(commandId: string, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE review_workflow_command_side_effects
         SET state = 'OUTCOME_RECORDED',
             outcome_recorded_at = ?,
             updated_at = ?
         WHERE command_id = ? AND state = 'STARTING'`,
      )
      .run(updatedAt, updatedAt, commandId);
  }

  private getBatchRow(batchId: string): z.infer<typeof batchPersistenceRowSchema> | null {
    const row = this.db
      .prepare(
        `SELECT
          workflow_id,
          persisted_state,
          aggregate_version,
          last_event_sequence,
          payload_json
        FROM review_workflow_batches
        WHERE batch_id = ?`,
      )
      .get(batchId);
    return row === undefined ? null : batchPersistenceRowSchema.parse(row);
  }

  private requireBatchRow(batchId: string): z.infer<typeof batchPersistenceRowSchema> {
    const row = this.getBatchRow(batchId);
    if (row === null) {
      throw new ReviewWorkflowPersistenceError(
        'BATCH_NOT_FOUND',
        `Batch ${batchId} does not exist`,
      );
    }
    return row;
  }

  private getSideEffect(commandId: string): ReviewWorkflowCommandSideEffect | null {
    const row = this.db
      .prepare('SELECT * FROM review_workflow_command_side_effects WHERE command_id = ?')
      .get(commandId);
    if (row === undefined) return null;
    const parsed = sideEffectRowSchema.parse(row);
    return {
      commandId: parsed.command_id,
      kind: parsed.side_effect_kind,
      state: parsed.state,
      ...(parsed.side_effect_identity === null
        ? {}
        : { sideEffectIdentity: parsed.side_effect_identity }),
      createdAt: parsed.created_at,
      ...(parsed.started_at === null ? {} : { startedAt: parsed.started_at }),
      ...(parsed.outcome_recorded_at === null
        ? {}
        : { outcomeRecordedAt: parsed.outcome_recorded_at }),
      updatedAt: parsed.updated_at,
    };
  }

  private requireCommand(commandId: string): StoredReviewWorkflowCommand {
    const stored = this.get(commandId);
    if (stored === null) {
      throw new ReviewWorkflowPersistenceError(
        'COMMAND_NOT_FOUND',
        `Command ${commandId} does not exist`,
      );
    }
    return stored;
  }

  private timestamp(): string {
    return this.clock().toISOString();
  }
}
