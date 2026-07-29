import { execFile } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { ClaudeCliAdapter } from '../../../src/models/claude-cli-adapter.js';
import { CliAdapter } from '../../../src/models/cli-adapter.js';
import { ModelRegistry } from '../../../src/models/registry.js';
import type { ProjectConfig } from '../../../src/types/config.js';

// Mock child_process to prevent actual CLI calls
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (error: Error, stdout: string, stderr: string) => void,
    ) => {
      cb(new Error('mock'), '', '');
    },
  ),
}));

describe('ModelRegistry', () => {
  function mixedConfig(inverse = false): ProjectConfig {
    const models: ProjectConfig['models'] = {
      claude: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        temperature: 0.4,
        timeout: 600,
        cliAdapter: {
          kind: 'claude',
          command: process.execPath,
          args: [],
          timeout: 600,
        },
      },
      codex: {
        provider: 'openai',
        model: 'gpt-5.3-codex',
        maxTokens: 4096,
        temperature: 0.3,
        timeout: 600,
        cliAdapter: {
          kind: 'codex',
          command: process.execPath,
          args: ['exec'],
          timeout: 600,
        },
      },
    };
    return {
      ...DEFAULT_CONFIG,
      models,
      roles: {
        ...DEFAULT_CONFIG.roles,
        implementer: { model: inverse ? 'codex' : 'claude' },
        reviewer: { model: inverse ? 'claude' : 'codex' },
      },
    };
  }

  it('creates registry from config', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    expect(registry.listAliases()).toContain('codex-architect');
    expect(registry.listAliases()).toContain('codex-reviewer');
  });

  it('getAdapter returns a CliAdapter for valid alias', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    const adapter = registry.getAdapter('codex-architect');
    expect(adapter).toBeInstanceOf(CliAdapter);
  });

  it('getAdapter throws for unknown alias', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    expect(() => registry.getAdapter('nonexistent')).toThrow('Unknown model alias');
  });

  it('getAdapterForRole resolves role -> alias -> adapter', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    const adapter = registry.getAdapterForRole('architect', DEFAULT_CONFIG);
    expect(adapter).toBeInstanceOf(CliAdapter);
  });

  it('getAdapterForRole throws for unknown role', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    expect(() => registry.getAdapterForRole('nonexistent', DEFAULT_CONFIG)).toThrow('Unknown role');
  });

  it('getModelConfig returns config for valid alias', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    const config = registry.getModelConfig('codex-architect');
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-5.3-codex');
  });

  it('getModelConfigForRole resolves role -> config', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    const config = registry.getModelConfigForRole('reviewer', DEFAULT_CONFIG);
    expect(config.provider).toBe('openai');
  });

  it('isCliMode always returns true', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    expect(registry.isCliMode('codex-architect')).toBe(true);
  });

  it('listAliases returns all registered aliases', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    const aliases = registry.listAliases();
    expect(aliases.length).toBeGreaterThanOrEqual(2);
  });

  it('selects Claude and Codex bridges in either role direction', () => {
    const forward = ModelRegistry.fromConfig(mixedConfig());
    expect(forward.getAdapterForRole('implementer', mixedConfig())).toBeInstanceOf(
      ClaudeCliAdapter,
    );
    expect(forward.getAdapterForRole('reviewer', mixedConfig())).toBeInstanceOf(CliAdapter);

    const inverseConfig = mixedConfig(true);
    const inverse = ModelRegistry.fromConfig(inverseConfig);
    expect(inverse.getAdapterForRole('implementer', inverseConfig)).toBeInstanceOf(CliAdapter);
    expect(inverse.getAdapterForRole('reviewer', inverseConfig)).toBeInstanceOf(ClaudeCliAdapter);
  });

  it('health-checks each configured adapter instead of copying one Codex result', async () => {
    vi.mocked(execFile).mockImplementation((command, _args, _options, callback) => {
      if (typeof callback !== 'function') return undefined as never;
      if (command === process.execPath) {
        callback(null, 'v22.23.1', '');
      } else {
        callback(new Error('unavailable'), '', '');
      }
      return undefined as never;
    });
    const config = mixedConfig();
    config.models.codex.cliAdapter = {
      ...config.models.codex.cliAdapter,
      kind: 'codex',
      command: '/definitely/missing/codex',
      args: ['exec'],
      timeout: 600,
    };
    const registry = ModelRegistry.fromConfig(config);

    const health = await registry.healthCheckDetails();

    expect(health.get('claude')).toMatchObject({
      available: true,
      adapterKind: 'claude',
      version: 'v22.23.1',
    });
    expect(health.get('codex')).toMatchObject({
      available: false,
      adapterKind: 'codex',
    });
  });
});
