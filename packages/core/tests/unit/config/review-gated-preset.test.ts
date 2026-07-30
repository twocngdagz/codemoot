// Batch 15 acceptance: the review-gated preset is a complete, valid configuration for the
// documented build path, and the workflow carries NO mandatory debate dependency.

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/loader.js';
import { listPresets } from '../../../src/config/presets.js';
import { createReviewWorkflowConfigurationSnapshot } from '../../../src/review-workflow-identity/service.js';

describe('review-gated preset', () => {
  it('is a listed preset producing a valid review-gated configuration', () => {
    expect(listPresets()).toContain('review-gated');
    const config = loadConfig({ preset: 'review-gated', skipFile: true });
    expect(config.workflow).toBe('review-gated-batches');
    expect(config.reviewGated?.identity.minimumAssurance).toBe('process_attested');
    expect(config.reviewGated?.gates.humanMerge).toBe('required');
    expect(config.reviewGated?.pacing.maxCodeReviewRounds).toBe(2);
  });

  it('has no debate dependency: the workflow configures with debate disabled', () => {
    const config = loadConfig({ preset: 'review-gated', skipFile: true });
    expect(config.debate?.enabled).toBe(false);
    // The identity snapshot — the root of every workflow run — derives entirely without
    // debate configuration.
    const snapshot = createReviewWorkflowConfigurationSnapshot(config, {
      workflowId: 'workflow-adoption',
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      assignedAt: '2026-07-31T12:00:00.000Z',
    });
    expect(snapshot.assignments.implementer.expectedAdapterKind).toBe('CLAUDE');
    expect(snapshot.assignments.reviewer.expectedAdapterKind).toBe('CODEX');
    expect(snapshot.identityPolicy.requireDifferentAdapterKinds).toBe(true);
  });
});
