import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { projectConfigSchema, validateConfig } from '../../../src/config/schema.js';

describe('projectConfigSchema', () => {
  it('validates a complete valid config', () => {
    const result = projectConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  it('applies defaults for missing optional fields', () => {
    const minimal = {
      models: {
        test: {
          provider: 'openai',
          model: 'gpt-5.3-codex',
        },
      },
      roles: {
        architect: { model: 'test' },
      },
    };
    const result = projectConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('autonomous');
      expect(result.data.advanced.logLevel).toBe('info');
      expect(result.data.budget.perSession).toBe(5.0);
      expect(result.data.debate.maxRounds).toBe(3);
      expect(result.data.configVersion).toBe(3);
      expect(result.data.reviewGated.commit.mode).toBe('human_required');
    }
  });

  it('accepts a review-gated Claude/Codex identity configuration', () => {
    const result = projectConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      workflow: 'review-gated-batches',
      models: {
        implementer: {
          provider: 'anthropic',
          model: 'claude-supported',
          cliAdapter: {
            kind: 'claude',
            command: 'claude',
            args: [],
            timeout: 600,
          },
        },
        reviewer: {
          provider: 'openai',
          model: 'codex-supported',
          cliAdapter: {
            kind: 'codex',
            command: 'codex',
            args: ['exec'],
            timeout: 600,
          },
        },
      },
      roles: {
        implementer: { model: 'implementer' },
        reviewer: { model: 'reviewer' },
      },
      reviewGated: {
        ...DEFAULT_CONFIG.reviewGated,
        identity: {
          minimumAssurance: 'process_attested',
          requireDifferentAdapterKinds: true,
          prohibitSharedSessions: true,
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.models.implementer.cliAdapter?.kind).toBe('claude');
      expect(result.data.models.reviewer.cliAdapter?.kind).toBe('codex');
    }
  });

  it('infers an adapter kind when a v3 adapter omits it', () => {
    const result = projectConfigSchema.safeParse({
      models: {
        test: {
          provider: 'anthropic',
          model: 'claude-supported',
          cliAdapter: { command: 'claude', args: [], timeout: 600 },
        },
      },
      roles: { architect: { model: 'test' } },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.models.test.cliAdapter?.kind).toBe('claude');
    }
  });

  it('rejects invalid provider', () => {
    const bad = {
      ...DEFAULT_CONFIG,
      models: {
        test: {
          provider: 'invalid_provider',
          model: 'test',
        },
      },
    };
    const result = projectConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects provider and adapter-kind mismatches', () => {
    const result = projectConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      models: {
        test: {
          provider: 'openai',
          model: 'test',
          cliAdapter: { kind: 'claude', command: 'claude', args: [], timeout: 600 },
        },
      },
      roles: { architect: { model: 'test' } },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(
        'Claude CLI adapters require provider "anthropic"',
      );
    }
  });

  it.each([
    {
      name: 'the same configured agent',
      mutate: {
        roles: {
          implementer: { model: 'claude-agent' },
          reviewer: { model: 'claude-agent' },
        },
      },
      expected: 'different configured agent keys',
    },
    {
      name: 'the same adapter kind',
      mutate: {
        models: {
          'claude-agent': {
            provider: 'anthropic',
            model: 'claude-implementer',
            cliAdapter: { kind: 'claude', command: 'claude', args: [], timeout: 600 },
          },
          'codex-agent': {
            provider: 'anthropic',
            model: 'claude-reviewer',
            cliAdapter: { kind: 'claude', command: 'claude', args: [], timeout: 600 },
          },
        },
      },
      expected: 'different adapter kinds',
    },
    {
      name: 'a shared-session policy',
      mutate: {
        reviewGated: {
          identity: {
            minimumAssurance: 'process_attested',
            requireDifferentAdapterKinds: true,
            prohibitSharedSessions: false,
          },
          commit: { mode: 'human_required', agentMayCommit: false },
          gates: DEFAULT_CONFIG.reviewGated?.gates,
        },
      },
      expected: 'must prohibit shared implementer/reviewer sessions',
    },
    {
      name: 'config-only assurance',
      mutate: {
        reviewGated: {
          identity: {
            minimumAssurance: 'config_only',
            requireDifferentAdapterKinds: true,
            prohibitSharedSessions: true,
          },
          commit: { mode: 'human_required', agentMayCommit: false },
          gates: DEFAULT_CONFIG.reviewGated?.gates,
        },
      },
      expected: 'process_attested identity assurance or stronger',
    },
  ])('rejects review-gated configuration with $name', ({ mutate, expected }) => {
    const base = {
      ...DEFAULT_CONFIG,
      workflow: 'review-gated-batches',
      models: {
        'claude-agent': {
          provider: 'anthropic',
          model: 'claude-supported',
          cliAdapter: { kind: 'claude', command: 'claude', args: [], timeout: 600 },
        },
        'codex-agent': {
          provider: 'openai',
          model: 'codex-supported',
          cliAdapter: { kind: 'codex', command: 'codex', args: ['exec'], timeout: 600 },
        },
      },
      roles: {
        implementer: { model: 'claude-agent' },
        reviewer: { model: 'codex-agent' },
      },
      reviewGated: {
        identity: {
          minimumAssurance: 'process_attested',
          requireDifferentAdapterKinds: true,
          prohibitSharedSessions: true,
        },
        commit: { mode: 'human_required', agentMayCommit: false },
        gates: DEFAULT_CONFIG.reviewGated?.gates,
      },
    };
    const result = projectConfigSchema.safeParse({ ...base, ...mutate });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes(expected))).toBe(true);
    }
  });

  it('rejects commit mode and agent permission disagreement', () => {
    const result = projectConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      reviewGated: {
        ...DEFAULT_CONFIG.reviewGated,
        commit: { mode: 'human_required', agentMayCommit: true },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('agentMayCommit must be false');
    }
  });

  it('rejects temperature out of range', () => {
    const bad = {
      ...DEFAULT_CONFIG,
      models: {
        test: {
          provider: 'openai',
          model: 'test',
          temperature: 5.0,
        },
      },
    };
    const result = projectConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects invalid execution mode', () => {
    const bad = { ...DEFAULT_CONFIG, mode: 'turbo' };
    const result = projectConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects empty model name', () => {
    const bad = {
      ...DEFAULT_CONFIG,
      models: {
        test: {
          provider: 'openai',
          model: '',
        },
      },
    };
    const result = projectConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('validateConfig', () => {
  it('returns validated config for valid input', () => {
    const config = validateConfig(DEFAULT_CONFIG);
    expect(config.mode).toBe('autonomous');
    expect(config.models['codex-architect'].provider).toBe('openai');
  });

  it('throws ConfigError for invalid input', () => {
    expect(() => validateConfig({ models: 'not an object' })).toThrow('Invalid configuration');
  });

  it('throws ConfigError with field details', () => {
    try {
      validateConfig({ models: { bad: { provider: 'nope' } } });
    } catch (err) {
      expect((err as Error).name).toBe('ConfigError');
      expect((err as Error).message).toContain('Invalid configuration');
    }
  });
});
