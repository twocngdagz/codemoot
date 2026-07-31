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
    expect(config.reviewGated?.pacing.maxCodeReviewRounds).toBe(3);
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

describe('autonomous limits configuration', () => {
  it('never exceeds the immutable coordinator pacing contract', () => {
    const config = loadConfig({ preset: 'review-gated', skipFile: true });
    const autonomous = config.reviewGated?.autonomous;
    const pacing = config.reviewGated?.pacing;
    expect(autonomous?.maxCodeReviewRoundsPerBatch).toBeLessThanOrEqual(
      pacing?.maxCodeReviewRounds ?? 0,
    );
    expect(autonomous?.maxCorrectionPassesPerBatch).toBeLessThanOrEqual(
      pacing?.maxCorrectionPasses ?? 0,
    );
  });

  it('defaults every autonomous limit to a finite validated value', () => {
    const config = loadConfig({ preset: 'review-gated', skipFile: true });
    const autonomous = config.reviewGated?.autonomous;
    expect(autonomous).toBeDefined();
    if (autonomous === undefined) return;
    expect(autonomous).toMatchObject({
      maxPlanReviewRoundsPerBatch: 2,
      maxCodeReviewRoundsPerBatch: 3,
      maxCorrectionPassesPerBatch: 2,
      maxVerificationAttemptsPerCommand: 2,
      maxFinalAuditsPerBatch: 1,
      maxAgentInvocationsPerBatch: 12,
      maxTotalAgentInvocations: 100,
      maxBatchRuntimeMinutes: 240,
      maxWorkflowRuntimeMinutes: 1440,
      maxConsecutiveNoProgressActions: 2,
      maxInputTokensPerBatch: 500_000,
      maxOutputTokensPerBatch: 100_000,
      maxCostUsdPerWorkflow: 25,
      heartbeatIntervalSeconds: 30,
      heartbeatExpirySeconds: 120,
    });
    for (const value of Object.values(autonomous)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});
