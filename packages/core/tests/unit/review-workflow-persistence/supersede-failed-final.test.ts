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

  it('is idempotent enough to call unconditionally before a retry', () => {
    // The refinement path calls this every time; a clean first run must not be disturbed.
    expect(commands.releaseFailedFinalReservation(COMMAND_ID, 'retry')).toBe(false);
    expect(commands.reserve(request('run-1')).replayed).toBe(false);
  });
});
