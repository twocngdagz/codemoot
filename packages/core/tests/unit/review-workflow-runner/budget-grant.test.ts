// A human-authorised token-budget extension on a LIVE workflow.
//
// Limits are frozen into runner state at start so an agent cannot quietly widen its own
// allowance, and editing `.cowork.yml` cannot help either — the configuration hash covers
// the whole file, so any edit invalidates the role assignments and blocks resume. Both are
// deliberate. Together they left no way to continue a workflow whose budget turned out to
// be structurally too small: one plan review used 1.5M input tokens against a 750k
// per-BATCH limit, and the only option was to discard ten staged batch plans and re-pay
// ~$37 to reach the same place.
//
// The grant is the sanctioned escape: additive, human-only, immutably logged.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowStore } from '../../../src/memory/review-workflow-store.js';
import { ReviewWorkflowRunnerStore } from '../../../src/review-workflow-runner/store.js';

const WORKFLOW_ID = 'workflow-budget';

describe('grantBudget', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let store: ReviewWorkflowRunnerStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemoot-budget-'));
    db = openDatabase(join(dir, 'test.db'));
    new ReviewWorkflowStore(db).createWorkflow({
      workflowId: WORKFLOW_ID,
      status: 'ACTIVE',
      generalPlanVersionId: 'general-plan-1',
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      configurationHash: 'configuration-hash',
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
    store = new ReviewWorkflowRunnerStore(db);
    store.initState({
      workflowId: WORKFLOW_ID,
      branch: 'codemoot/plan-x',
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
    });
  });

  afterEach(() => {
    db.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('starts at zero, so an ungranted workflow is exactly its frozen contract', () => {
    expect(store.require(WORKFLOW_ID).counters.budgetGrants).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('is additive rather than a replacement', () => {
    store.grantBudget({
      workflowId: WORKFLOW_ID,
      inputTokens: 1_000_000,
      outputTokens: 0,
      actor: 'roy',
      rationale: 'plan review needs 1.5M',
    });
    const total = store.grantBudget({
      workflowId: WORKFLOW_ID,
      inputTokens: 500_000,
      outputTokens: 200_000,
      actor: 'roy',
      rationale: 'second batch',
    });
    expect(total).toEqual({ inputTokens: 1_500_000, outputTokens: 200_000 });
    expect(store.require(WORKFLOW_ID).counters.budgetGrants).toEqual(total);
  });

  it('never edits the frozen limits — the original contract stays readable', () => {
    const before = store.require(WORKFLOW_ID).limits;
    store.grantBudget({
      workflowId: WORKFLOW_ID,
      inputTokens: 9_000_000,
      outputTokens: 0,
      actor: 'roy',
      rationale: 'large plan',
    });
    expect(store.require(WORKFLOW_ID).limits).toEqual(before);
  });

  it('records the actor and rationale in the immutable runner log', () => {
    store.grantBudget({
      workflowId: WORKFLOW_ID,
      inputTokens: 250_000,
      outputTokens: 0,
      actor: 'roy',
      rationale: 'measured 1.5M on plan review',
    });
    const entry = store
      .listLog(WORKFLOW_ID)
      .find((row) => row.entryType === 'DECISION' && row.message.includes('Token budget'));
    expect(entry, 'a grant must be recorded as a DECISION').toBeDefined();
    expect(entry?.message).toContain('roy');
    expect(JSON.stringify(entry?.payload)).toContain('measured 1.5M on plan review');
  });

  it('survives a reload — the grant is durable, not in-memory', () => {
    store.grantBudget({
      workflowId: WORKFLOW_ID,
      inputTokens: 42,
      outputTokens: 7,
      actor: 'roy',
      rationale: 'durability',
    });
    expect(new ReviewWorkflowRunnerStore(db).require(WORKFLOW_ID).counters.budgetGrants).toEqual({
      inputTokens: 42,
      outputTokens: 7,
    });
  });
});
