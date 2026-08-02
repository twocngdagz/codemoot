// The configuration hash is PERSISTED, so the function that produces it is a storage
// format. `1f7d011` changed that function without a migration and bricked every in-flight
// workflow: the stored fingerprint could never again match, and there was no config edit to
// revert because the input never changed. These tests pin the two halves of the repair —
// and a golden value that makes the mistake unrepeatable without failing a test first.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectConfigSchema } from '../../../src/config/schema.js';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowStore } from '../../../src/memory/review-workflow-store.js';
import { hashReviewWorkflowConfiguration } from '../../../src/review-workflow-identity/service.js';

function config(overrides: Record<string, unknown> = {}) {
  return projectConfigSchema.parse({
    configVersion: 3,
    workflow: 'review-gated-batches',
    models: {
      implementer: { provider: 'anthropic', model: 'claude-opus-5' },
      reviewer: { provider: 'anthropic', model: 'claude-fable-5' },
    },
    roles: { implementer: { model: 'implementer' }, reviewer: { model: 'reviewer' } },
    reviewGated: {
      identity: { minimumAssurance: 'process_attested', prohibitSharedSessions: true },
      ...((overrides.reviewGated as Record<string, unknown>) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'reviewGated')),
  });
}

describe('hash function stability', () => {
  it('GOLDEN VALUE — changing this function requires a migration in the same commit', () => {
    // If this assertion fails, you have changed what hashReviewWorkflowConfiguration
    // produces for an unchanged configuration. That value is PERSISTED on every workflow
    // row and both of its assignment rows. Shipping the change without migrating those
    // rows bricks every in-flight workflow — it happened, live, at 1f7d011. Update this
    // fixture AND extend the heal in resolveRuntimeContext in the same commit.
    expect(hashReviewWorkflowConfiguration(config())).toBe(
      'bd4a3e8380cd0b507a2e2510f8062e8aef2ee8671e66accad343c8967cd5a200',
    );
  });

  it('is indifferent to operatorMode — the rescue hatch must not invalidate the rescue', () => {
    const base = hashReviewWorkflowConfiguration(config());
    expect(
      hashReviewWorkflowConfiguration(config({ reviewGated: { operatorMode: 'trusted_local' } })),
    ).toBe(base);
  });
});

describe('migrateConfigurationHash', () => {
  const WORKFLOW_ID = 'workflow-hash-migration';
  const IMPLEMENTER_ID = `${WORKFLOW_ID}:assignment:implementer`;
  const REVIEWER_ID = `${WORKFLOW_ID}:assignment:reviewer`;
  const LEGACY_HASH = 'a'.repeat(64);
  const NEW_HASH = 'b'.repeat(64);

  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let store: ReviewWorkflowStore;

  function assignment(assignmentId: string, role: 'IMPLEMENTER' | 'REVIEWER') {
    return {
      assignmentId,
      workflowId: WORKFLOW_ID,
      assignedRole: role,
      configuredAgentKey: role.toLowerCase(),
      configuredModelAlias: role.toLowerCase(),
      expectedAdapterKind: 'CLAUDE' as const,
      provider: 'anthropic',
      configuredModel: role === 'IMPLEMENTER' ? 'claude-opus-5' : 'claude-fable-5',
      commitPermission: 'AUTHORIZED' as const,
      configurationHash: LEGACY_HASH,
      assignedAt: '2026-08-01T13:28:00.000Z',
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemoot-hash-migration-'));
    db = openDatabase(join(dir, 'test.db'));
    store = new ReviewWorkflowStore(db);
    store.createWorkflow({
      workflowId: WORKFLOW_ID,
      status: 'ACTIVE',
      generalPlanVersionId: 'general-plan-1',
      implementerAssignmentId: IMPLEMENTER_ID,
      reviewerAssignmentId: REVIEWER_ID,
      configurationHash: LEGACY_HASH,
      createdAt: '2026-08-01T13:28:00.000Z',
      updatedAt: '2026-08-01T13:28:00.000Z',
    });
    store.saveEntity({
      kind: 'AGENT_ASSIGNMENT',
      value: assignment(IMPLEMENTER_ID, 'IMPLEMENTER'),
    });
    store.saveEntity({ kind: 'AGENT_ASSIGNMENT', value: assignment(REVIEWER_ID, 'REVIEWER') });
  });

  afterEach(() => {
    db.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites all three persisted copies — column, payload, and record hash', () => {
    store.migrateConfigurationHash({
      workflowId: WORKFLOW_ID,
      assignmentIds: [IMPLEMENTER_ID, REVIEWER_ID],
      toHash: NEW_HASH,
    });
    const workflow = db
      .prepare(
        'SELECT configuration_hash, payload_json FROM review_workflows WHERE workflow_id = ?',
      )
      .get(WORKFLOW_ID) as { configuration_hash: string; payload_json: string };
    expect(workflow.configuration_hash).toBe(NEW_HASH);
    expect(JSON.parse(workflow.payload_json).configurationHash).toBe(NEW_HASH);
    for (const id of [IMPLEMENTER_ID, REVIEWER_ID]) {
      const row = db
        .prepare(
          'SELECT configuration_hash, payload_json FROM review_workflow_agent_assignments WHERE assignment_id = ?',
        )
        .get(id) as { configuration_hash: string; payload_json: string };
      expect(row.configuration_hash).toBe(NEW_HASH);
      expect(JSON.parse(row.payload_json).configurationHash).toBe(NEW_HASH);
    }
    // The parsed entity round-trips — the record hash was recomputed, not left stale.
    const entity = store.getEntity('AGENT_ASSIGNMENT', IMPLEMENTER_ID);
    expect(entity?.kind === 'AGENT_ASSIGNMENT' ? entity.value.configurationHash : null).toBe(
      NEW_HASH,
    );
  });

  it('keeps the migrated entity idempotently re-savable under the immutability contract', () => {
    store.migrateConfigurationHash({
      workflowId: WORKFLOW_ID,
      assignmentIds: [IMPLEMENTER_ID, REVIEWER_ID],
      toHash: NEW_HASH,
    });
    // Same content, same hash: accepted as a no-op rather than a conflict.
    expect(() =>
      store.saveEntity({
        kind: 'AGENT_ASSIGNMENT',
        value: { ...assignment(IMPLEMENTER_ID, 'IMPLEMENTER'), configurationHash: NEW_HASH },
      }),
    ).not.toThrow();
    // The PRE-migration content now conflicts, which is exactly right.
    expect(() =>
      store.saveEntity({
        kind: 'AGENT_ASSIGNMENT',
        value: assignment(IMPLEMENTER_ID, 'IMPLEMENTER'),
      }),
    ).toThrow();
  });

  it('restores the immutability trigger — the escape hatch does not stay open', () => {
    store.migrateConfigurationHash({
      workflowId: WORKFLOW_ID,
      assignmentIds: [IMPLEMENTER_ID],
      toHash: NEW_HASH,
    });
    expect(() =>
      db
        .prepare("UPDATE review_workflow_agent_assignments SET configured_agent_key = 'evil'")
        .run(),
    ).toThrow(/immutable/);
  });
});
