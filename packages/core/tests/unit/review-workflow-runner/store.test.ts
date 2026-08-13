// The frozen batch scope's durable life: written at init, read back, rewritten only by the
// explicit setter (which also clears a stale scope-stop record), and surviving the v24
// migration — a pre-v24 database reads every existing workflow as unscoped, which is what
// it was.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowStore } from '../../../src/memory/review-workflow-store.js';
import { ReviewWorkflowRunnerStore } from '../../../src/review-workflow-runner/store.js';

const WORKFLOW_ID = 'workflow-scope-store';
const NOW = '2026-08-13T12:00:00.000Z';

function createWorkflowRow(db: Database.Database): void {
  new ReviewWorkflowStore(db).createWorkflow({
    workflowId: WORKFLOW_ID,
    status: 'ACTIVE',
    generalPlanVersionId: `${WORKFLOW_ID}:general-plan`,
    implementerAssignmentId: 'assignment-implementer',
    reviewerAssignmentId: 'assignment-reviewer',
    configurationHash: 'configuration-hash',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function initState(store: ReviewWorkflowRunnerStore, maxBatches?: number): void {
  store.initState({
    workflowId: WORKFLOW_ID,
    branch: 'codemoot/test',
    baseBranch: 'master',
    baseSha: '9'.repeat(40),
    ...(maxBatches === undefined ? {} : { maxBatches }),
  });
}

describe('ReviewWorkflowRunnerStore batch scope', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    createWorkflowRow(db);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips maxBatches through init; absent means unscoped', () => {
    const store = new ReviewWorkflowRunnerStore(db);
    initState(store, 3);
    expect(store.require(WORKFLOW_ID).maxBatches).toBe(3);
  });

  it('reads back no scope when none was frozen', () => {
    const store = new ReviewWorkflowRunnerStore(db);
    initState(store);
    expect(store.require(WORKFLOW_ID).maxBatches).toBeUndefined();
  });

  it('setMaxBatches rewrites the scope and clears a stale scope-stop record — nothing else', () => {
    const store = new ReviewWorkflowRunnerStore(db);
    initState(store, 1);
    store.update(WORKFLOW_ID, {
      stopReason: 'BATCH_SCOPE_REACHED',
      stopDetails: 'stopped at scope 1',
    });
    store.setMaxBatches(WORKFLOW_ID, 2);
    const widened = store.require(WORKFLOW_ID);
    expect(widened.maxBatches).toBe(2);
    expect(widened.stopReason).toBeUndefined();
    expect(widened.stopDetails).toBeUndefined();
    // A NON-scope stop record is not the setter's to clear.
    store.update(WORKFLOW_ID, { stopReason: 'PUSH_FAILED', stopDetails: 'remote rejected' });
    store.setMaxBatches(WORKFLOW_ID, 3);
    expect(store.require(WORKFLOW_ID).stopReason).toBe('PUSH_FAILED');
    expect(store.require(WORKFLOW_ID).maxBatches).toBe(3);
  });

  it('setMaxBatches on a missing workflow fails loudly', () => {
    const store = new ReviewWorkflowRunnerStore(db);
    expect(() => store.setMaxBatches('no-such-workflow', 2)).toThrow(/No runner state/);
  });

  it('migrates a pre-v24 database: the column appears and existing rows read as unscoped', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codemoot-scope-migration-'));
    const path = join(directory, 'cowork.db');
    try {
      // Simulate the pre-v24 shape: a real database whose runner-state table has no
      // max_batches column but already holds a workflow row.
      const before = openDatabase(path);
      createWorkflowRow(before);
      initState(new ReviewWorkflowRunnerStore(before));
      before.exec('ALTER TABLE review_workflow_runner_state DROP COLUMN max_batches');
      before.close();

      // Re-opening runs the migrations: the column is added, the old row is unscoped.
      const after = openDatabase(path);
      const store = new ReviewWorkflowRunnerStore(after);
      expect(store.require(WORKFLOW_ID).maxBatches).toBeUndefined();
      // And the migrated row accepts a scope like any other.
      store.setMaxBatches(WORKFLOW_ID, 1);
      expect(store.require(WORKFLOW_ID).maxBatches).toBe(1);
      after.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
