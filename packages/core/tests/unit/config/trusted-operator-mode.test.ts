// Trusted-operator mode, and the configuration-hash scoping that goes with it.
//
// Over two days of real single-operator use, thirteen stops were caused by the harness and
// none by the plan, the codebase or an agent. Not one guard caught a genuine problem; each
// fired on itself. These guards are correct for a fleet of untrusted agents nobody watches.
// They are cost without benefit for one person approving every step on their own machine.
//
// What must NOT change is anything that prevents real damage: the git guard, push blocking,
// the merge gate, immutable evidence, and reviewer/implementer separation.

import { describe, expect, it } from 'vitest';
import { projectConfigSchema } from '../../../src/config/schema.js';
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
    ...overrides,
    reviewGated: {
      identity: { minimumAssurance: 'process_attested', prohibitSharedSessions: true },
      ...((overrides.reviewGated as Record<string, unknown>) ?? {}),
    },
  });
}

describe('configuration hash scope', () => {
  it('IGNORES operational limits, so raising a budget does not block resume', () => {
    // The wall that made a stuck workflow unrecoverable: the limit was frozen, and editing
    // it changed the hash, so `resolveReviewWorkflowRoles` refused the assignments.
    const before = hashReviewWorkflowConfiguration(config());
    const after = hashReviewWorkflowConfiguration(
      config({ reviewGated: { autonomous: { maxInputTokensPerBatch: 40_000_000 } } }),
    );
    expect(after).toBe(before);
  });

  it('still changes when a ROLE ASSIGNMENT would change', () => {
    // The hash exists to detect stale assignments, and must keep doing exactly that.
    const before = hashReviewWorkflowConfiguration(config());
    expect(
      hashReviewWorkflowConfiguration(
        config({
          models: {
            implementer: { provider: 'anthropic', model: 'claude-sonnet-5' },
            reviewer: { provider: 'anthropic', model: 'claude-fable-5' },
          },
        }),
      ),
    ).not.toBe(before);
    expect(
      hashReviewWorkflowConfiguration(
        config({
          models: {
            implementer: { provider: 'anthropic', model: 'claude-opus-5' },
            reviewer: { provider: 'anthropic', model: 'claude-fable-5' },
            spare: { provider: 'anthropic', model: 'claude-sonnet-5' },
          },
          roles: { implementer: { model: 'spare' }, reviewer: { model: 'reviewer' } },
        }),
      ),
    ).not.toBe(before);
  });

  it('still changes when the identity policy changes', () => {
    expect(
      hashReviewWorkflowConfiguration(
        config({
          reviewGated: {
            identity: {
              minimumAssurance: 'authenticated_subject',
              prohibitSharedSessions: true,
            },
          },
        }),
      ),
    ).not.toBe(hashReviewWorkflowConfiguration(config()));
  });
});

describe('operatorMode', () => {
  it('defaults to untrusted_fleet — it is opt-in and never inferred', () => {
    expect(config().reviewGated?.operatorMode).toBe('untrusted_fleet');
  });

  it('accepts trusted_local when the operator asks for it', () => {
    expect(
      config({ reviewGated: { operatorMode: 'trusted_local' } }).reviewGated?.operatorMode,
    ).toBe('trusted_local');
  });

  it('does not relax session isolation — that is the product, not a guard', () => {
    // prohibitSharedSessions: false must still be rejected even in trusted_local.
    expect(() =>
      config({
        reviewGated: {
          operatorMode: 'trusted_local',
          identity: { minimumAssurance: 'config_only', prohibitSharedSessions: false },
        },
      }),
    ).toThrow();
  });

  it('accepts weaker ASSURANCE in trusted_local, and rejects it otherwise', () => {
    expect(() =>
      config({
        reviewGated: {
          operatorMode: 'trusted_local',
          identity: { minimumAssurance: 'config_only', prohibitSharedSessions: true },
        },
      }),
    ).not.toThrow();
    expect(() =>
      config({
        reviewGated: {
          identity: { minimumAssurance: 'config_only', prohibitSharedSessions: true },
        },
      }),
    ).toThrow(/process_attested/);
  });
});
