// Releasing a TERMINALLY FAILED reservation so an authorised retry can proceed.
//
// The canonical request hash covers the requester's actor execution, which is honestly new
// on every run — a different process, separately attested. A retry of a failed command
// therefore never hashes identically, and idempotency rejects it as "already reserved for a
// different request". That made `fix_again` structurally unable to retry the refinement it
// exists to fix; it went unnoticed only because every earlier failure started a new
// workflow, giving fresh command IDs.
//
// The invariant idempotency protects is "never fabricate a side effect that did not
// happen". These tests pin the boundary: release is permitted exactly when nothing
// happened, and refused otherwise.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowCommandStore } from '../../../src/memory/review-workflow-command-store.js';
import { ReviewWorkflowStore } from '../../../src/memory/review-workflow-store.js';

const WORKFLOW_ID = 'workflow-supersede';
const BATCH_ID = `${WORKFLOW_ID}:batch:1`;
const COMMAND_ID = `${BATCH_ID}:create`;

function actor(suffix: string) {
  return {
    actorExecutionId: `${WORKFLOW_ID}:refiner:${suffix}`,
    actorType: 'SYSTEM' as const,
    authoritiesExercised: ['PLAN_REFINER' as const],
    identityAssurance: 'PROCESS_ATTESTED' as const,
    observedEvidence: [
      { kind: 'LOCAL_CLI' as const, source: 'codemoot', observedAt: '2026-08-02T00:00:00.000Z' },
    ],
    startedAt: '2026-08-02T00:00:00.000Z',
  };
}

function request(suffix: string) {
  const base = {
    commandId: COMMAND_ID,
    workflowId: WORKFLOW_ID,
    batchId: BATCH_ID,
    expectedAggregateVersion: 0,
    requester: actor(suffix),
    authorityExercised: 'PLAN_REFINER' as const,
    command: { type: 'CREATE_BATCH' as const },
  };
  // Mirrors withCanonicalHash: the hash covers the requester, so a new run never matches.
  return { ...base, canonicalRequestHash: `hash-${suffix}` };
}

describe('releaseFailedFinalReservation', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let commands: ReviewWorkflowCommandStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemoot-supersede-'));
    db = openDatabase(join(dir, 'test.db'));
    const store = new ReviewWorkflowStore(db);
    store.createWorkflow({
      workflowId: WORKFLOW_ID,
      status: 'ACTIVE',
      generalPlanVersionId: 'general-plan-1',
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      configurationHash: 'configuration-hash',
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
    commands = new ReviewWorkflowCommandStore(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  /** Reserve, then fail terminally — exactly what a rejected refinement leaves behind. */
  function reserveThenFail(suffix: string): void {
    commands.reserve(request(suffix));
    commands.recordOutcome({
      commandId: COMMAND_ID,
      status: 'FAILED_FINAL',
      errorCode: 'SCHEMA_INVALID',
      resultHash: 'result-hash',
      result: { code: 'SCHEMA_INVALID' },
    });
  }

  it('reproduces the block: a retry with a new actor cannot re-reserve', () => {
    reserveThenFail('run-9');
    expect(() => commands.reserve(request('run-10'))).toThrow(/already reserved for a different/);
  });

  it('frees the ID once released, and the retry then succeeds', () => {
    reserveThenFail('run-9');
    expect(commands.releaseFailedFinalReservation(COMMAND_ID, 'retry')).toBe(true);
    const reservation = commands.reserve(request('run-10'));
    expect(reservation.replayed).toBe(false);
    expect(commands.get(COMMAND_ID)?.receipt.status).toBe('RESERVED');
  });

  it('preserves the failed attempt rather than destroying it', () => {
    reserveThenFail('run-9');
    commands.releaseFailedFinalReservation(COMMAND_ID, 'Human-authorised refinement retry');
    const archived = db
      .prepare('SELECT command_id, reason, receipt_json FROM review_workflow_superseded_commands')
      .all() as { command_id: string; reason: string; receipt_json: string }[];
    expect(archived).toHaveLength(1);
    expect(archived[0]?.command_id).toBe(COMMAND_ID);
    expect(archived[0]?.reason).toBe('Human-authorised refinement retry');
    // The whole receipt, including its terminal error, is recoverable.
    expect(JSON.parse(String(archived[0]?.receipt_json)).receipt.errorCode).toBe('SCHEMA_INVALID');
  });

  it('refuses to release a command that is not terminally failed', () => {
    commands.reserve(request('run-9'));
    expect(() => commands.releaseFailedFinalReservation(COMMAND_ID, 'retry')).toThrow(
      /not FAILED_FINAL/,
    );
  });

  it('reports nothing to release when the command never existed', () => {
    expect(commands.releaseFailedFinalReservation(COMMAND_ID, 'retry')).toBe(false);
  });

  it('releases a command whose batch ALREADY EXISTS', () => {
    // The guard used to ask "does the batch exist?", which is the right question for exactly
    // one of twelve command types. Every other command REQUIRES the batch to exist — you
    // cannot plan-review a batch that was never created — so the old check refused all
    // eleven unconditionally, and the release could only rescue the one case it was written
    // for. That is the START_PLAN_REVIEW deadlock that stopped a live workflow.
    reserveThenFail('run-9');
    db.prepare(
      `INSERT INTO review_workflow_batches
         (batch_id, workflow_id, ordinal, persisted_state, aggregate_version,
          last_event_sequence, current_plan_version_id, implementer_assignment_id,
          reviewer_assignment_id, payload_json, record_hash, created_at, updated_at)
       VALUES (?, ?, 1, 'DRAFT', 1, 1, 'plan-1', 'assignment-implementer',
               'assignment-reviewer', '{}', 'hash', ?, ?)`,
    ).run(BATCH_ID, WORKFLOW_ID, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z');

    // The receipt recorded no durable state, so the retry is safe regardless of the batch.
    expect(commands.releaseFailedFinalReservation(COMMAND_ID, 'retry')).toBe(true);
    expect(commands.get(COMMAND_ID)).toBeNull();
  });

  it('still refuses a command that DID record durable state', () => {
    // The replacement guard has to be able to say no, or it is not a guard.
    reserveThenFail('run-9');
    db.prepare(
      'UPDATE review_workflow_command_receipts SET resulting_aggregate_version = 1 WHERE command_id = ?',
    ).run(COMMAND_ID);
    expect(() => commands.releaseFailedFinalReservation(COMMAND_ID, 'retry')).toThrow(
      /recorded durable state/,
    );
  });

  it('sweeps every retryable reservation for the batch in one authorised retry', () => {
    // One release call per phase is how the same wall reappeared at plan review after being
    // cleared at refinement. The retry frees them all.
    for (const suffix of ['create', 'review-1', 'implement']) {
      const id = `${BATCH_ID}:${suffix}`;
      commands.reserve({ ...request(suffix), commandId: id });
      commands.recordOutcome({
        commandId: id,
        status: 'FAILED_FINAL',
        errorCode: 'STOPPED',
        resultHash: 'h',
        result: { code: 'STOPPED' },
      });
    }
    const released = commands.releaseRetryableReservations(WORKFLOW_ID, BATCH_ID, 'retry');
    expect(released).toHaveLength(3);
    for (const suffix of ['create', 'review-1', 'implement']) {
      expect(commands.get(`${BATCH_ID}:${suffix}`)).toBeNull();
    }
  });

  it('sweeps nothing when there is nothing terminally failed', () => {
    commands.reserve(request('run-1'));
    expect(commands.releaseRetryableReservations(WORKFLOW_ID, BATCH_ID, 'retry')).toEqual([]);
    expect(commands.get(COMMAND_ID)?.receipt.status).toBe('RESERVED');
  });

  it('is idempotent enough to call unconditionally before a retry', () => {
    // The refinement path calls this every time; a clean first run must not be disturbed.
    expect(commands.releaseFailedFinalReservation(COMMAND_ID, 'retry')).toBe(false);
    expect(commands.reserve(request('run-1')).replayed).toBe(false);
  });
});

// Reserve-before-invoke opens a second window the sweep above cannot reach. A run stopped
// BETWEEN reserving and starting leaves a receipt that is RESERVED, not FAILED_FINAL — so
// `releaseRetryableReservations` skips it forever, while the deterministic command ID means
// the next attempt derives the same ID and collides with the corpse of its own predecessor.
describe('releaseUnstartedReservation', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let commands: ReviewWorkflowCommandStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemoot-unstarted-'));
    db = openDatabase(join(dir, 'test.db'));
    const store = new ReviewWorkflowStore(db);
    store.createWorkflow({
      workflowId: WORKFLOW_ID,
      status: 'ACTIVE',
      generalPlanVersionId: 'general-plan-1',
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      configurationHash: 'configuration-hash',
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
    commands = new ReviewWorkflowCommandStore(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  /** Exactly the live shape: receipt RESERVED, side effect NOT_STARTED, identity NULL. */
  function reserveWithoutStarting(suffix: string): void {
    commands.reserve(request(suffix), 'AGENT_INVOCATION');
  }

  it('reproduces the block: the sweep for failed commands cannot reach it', () => {
    reserveWithoutStarting('run-9');
    expect(commands.releaseRetryableReservations(WORKFLOW_ID, BATCH_ID, 'retry')).toEqual([]);
    expect(() => commands.releaseFailedFinalReservation(COMMAND_ID, 'retry')).toThrow(
      /not FAILED_FINAL/,
    );
    expect(() => commands.reserve(request('run-10'), 'AGENT_INVOCATION')).toThrow(
      /already reserved for a different/,
    );
  });

  it('AC1: frees the ID, and the resumed attempt reserves and starts its own side effect', () => {
    reserveWithoutStarting('run-9');
    expect(commands.releaseUnstartedReservation(COMMAND_ID, 'resumed attempt')).toBe(true);
    expect(commands.reserve(request('run-10'), 'AGENT_INVOCATION').replayed).toBe(false);
    expect(commands.claimSideEffect(COMMAND_ID, 'invocation-run-10').shouldInvoke).toBe(true);
  });

  it('preserves the abandoned reservation rather than destroying it', () => {
    reserveWithoutStarting('run-9');
    commands.releaseUnstartedReservation(COMMAND_ID, 'Unstarted reservation superseded');
    const archived = db
      .prepare('SELECT command_id, reason, receipt_json FROM review_workflow_superseded_commands')
      .all() as { command_id: string; reason: string; receipt_json: string }[];
    expect(archived).toHaveLength(1);
    expect(archived[0]?.reason).toBe('Unstarted reservation superseded');
    // The archived receipt keeps the abandoned attempt's requester on the record.
    expect(JSON.parse(String(archived[0]?.receipt_json)).request.requester.actorExecutionId).toBe(
      actor('run-9').actorExecutionId,
    );
    // Its side-effect row followed the receipt to the superseded ID; nothing was deleted.
    const sideEffects = db
      .prepare('SELECT command_id, state FROM review_workflow_command_side_effects')
      .all() as { command_id: string; state: string }[];
    expect(sideEffects).toHaveLength(1);
    expect(sideEffects[0]?.command_id).toMatch(/:superseded:\d+$/);
    expect(sideEffects[0]?.state).toBe('NOT_STARTED');
  });

  it('AC3: refuses a reservation whose side effect already started', () => {
    reserveWithoutStarting('run-9');
    commands.claimSideEffect(COMMAND_ID, 'invocation-run-9');
    expect(() => commands.releaseUnstartedReservation(COMMAND_ID, 'retry')).toThrow(
      /not RESERVED, and is not an unstarted reservation/,
    );
  });

  it('AC3: refuses a reservation bound to an identity even if the side effect row lags', () => {
    // Belt and braces: the claim binds the receipt and moves the side effect in one
    // transaction, so a bound identity alone proves the external call may have been made.
    reserveWithoutStarting('run-9');
    db.prepare(
      'UPDATE review_workflow_command_receipts SET side_effect_identity = ? WHERE command_id = ?',
    ).run('invocation-run-9', COMMAND_ID);
    expect(() => commands.releaseUnstartedReservation(COMMAND_ID, 'retry')).toThrow(
      /bound to side-effect identity/,
    );
  });

  it('AC3: refuses a terminally failed reservation — that is the other release', () => {
    reserveWithoutStarting('run-9');
    commands.recordOutcome({
      commandId: COMMAND_ID,
      status: 'FAILED_FINAL',
      errorCode: 'STOPPED',
      resultHash: 'result-hash',
      result: { code: 'STOPPED' },
    });
    expect(() => commands.releaseUnstartedReservation(COMMAND_ID, 'retry')).toThrow(
      /is FAILED_FINAL, not RESERVED/,
    );
  });

  it('AC3: refuses a reservation that recorded durable state', () => {
    reserveWithoutStarting('run-9');
    db.prepare(
      'UPDATE review_workflow_command_receipts SET resulting_aggregate_version = 1 WHERE command_id = ?',
    ).run(COMMAND_ID);
    expect(() => commands.releaseUnstartedReservation(COMMAND_ID, 'retry')).toThrow(
      /recorded durable state/,
    );
  });

  it('reports nothing to release when the command never existed', () => {
    expect(commands.releaseUnstartedReservation(COMMAND_ID, 'retry')).toBe(false);
  });
});
