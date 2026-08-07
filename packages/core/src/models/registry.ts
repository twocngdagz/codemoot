// packages/core/src/models/registry.ts — Role-capable CLI bridge registry

import type { CliAdapterKind, ModelConfig, ProjectConfig } from '../types/config.js';
import { ModelError } from '../utils/errors.js';
import type { CliBridge } from './bridge.js';
import { ClaudeCliAdapter } from './claude-cli-adapter.js';
import { CliAdapter } from './cli-adapter.js';
import { type CliProbeResult, probeCliCommand } from './cli-runtime-evidence.js';
import { CursorCliAdapter } from './cursor-cli-adapter.js';

/** All registered models implement the common CLI bridge contract. */
export type ModelAdapter = CliBridge;

export interface ModelAdapterHealth extends CliProbeResult {
  readonly alias: string;
  readonly adapterKind: CliAdapterKind;
  readonly model: string;
}

export class ModelRegistry {
  private models = new Map<string, ModelAdapter>();
  private configs = new Map<string, ModelConfig>();
  private constructor() {}

  /**
   * Build a registry from a ProjectConfig.
   * Model provider and cliAdapter.kind select the concrete bridge.
   */
  static fromConfig(config: ProjectConfig, projectDir?: string): ModelRegistry {
    const registry = new ModelRegistry();
    for (const [alias, modelConfig] of Object.entries(config.models)) {
      registry.models.set(alias, createModelAdapter(modelConfig, projectDir));
      registry.configs.set(alias, modelConfig);
    }
    return registry;
  }

  /**
   * Resolve auto mode — probe codex CLI availability.
   * Kept for API compatibility; all models are CLI now.
   */
  async resolveAutoMode(): Promise<void> {
    // No-op: all models are CLI adapters, no auto detection needed
  }

  /** Get the adapter for an alias, or null if not found. */
  tryGetAdapter(alias: string): ModelAdapter | null {
    return this.models.get(alias) ?? null;
  }

  /** Get the adapter for an alias. Throws if not found. */
  getAdapter(alias: string): ModelAdapter {
    const adapter = this.models.get(alias);
    if (!adapter) {
      throw new ModelError(
        `Unknown model alias: "${alias}". Available: ${[...this.models.keys()].join(', ')}`,
      );
    }
    return adapter;
  }

  /** Check if an alias is backed by CLI adapter (always true now). */
  isCliMode(_alias: string): boolean {
    return true;
  }

  /** Get the ModelConfig for an alias. */
  getModelConfig(alias: string): ModelConfig {
    const config = this.configs.get(alias);
    if (!config) {
      throw new ModelError(`Unknown model alias: "${alias}"`);
    }
    return config;
  }

  /** Resolve role -> alias -> ModelAdapter. */
  getAdapterForRole(role: string, config: ProjectConfig): ModelAdapter {
    const roleConfig = config.roles[role];
    if (!roleConfig) {
      throw new ModelError(
        `Unknown role: "${role}". Available: ${Object.keys(config.roles).join(', ')}`,
      );
    }
    return this.getAdapter(roleConfig.model);
  }

  /** Resolve role -> alias -> ModelConfig. */
  getModelConfigForRole(role: string, config: ProjectConfig): ModelConfig {
    const roleConfig = config.roles[role];
    if (!roleConfig) {
      throw new ModelError(`Unknown role: "${role}"`);
    }
    return this.getModelConfig(roleConfig.model);
  }

  /** List all registered model aliases. */
  listAliases(): string[] {
    return [...this.models.keys()];
  }

  /**
   * Health check every configured adapter independently.
   */
  async healthCheckAll(): Promise<Map<string, boolean>> {
    const details = await this.healthCheckDetails();
    const results = new Map<string, boolean>();
    for (const [alias, detail] of details) {
      results.set(alias, detail.available);
    }
    return results;
  }

  async healthCheckDetails(projectDir = process.cwd()): Promise<Map<string, ModelAdapterHealth>> {
    const checks = await Promise.all(
      [...this.configs].map(async ([alias, config]) => {
        const adapterKind = resolveModelAdapterKind(config);
        const command =
          config.cliAdapter?.command ??
          (adapterKind === 'claude' ? defaultClaudeCommand() : defaultCodexCommand());
        const probe = await probeCliCommand(command, projectDir, cliProbeEnvironment());
        return [
          alias,
          {
            ...probe,
            alias,
            adapterKind,
            model: config.model,
          },
        ] as const;
      }),
    );
    return new Map(checks);
  }
}

/** Compatibility factory for callers that explicitly require the legacy Codex adapter. */
function createCliAdapter(config: ModelConfig, projectDir?: string): CliAdapter {
  const adapterConfig = config.cliAdapter ?? getDefaultCliConfig(projectDir);
  return new CliAdapter({
    command: adapterConfig.command,
    args: adapterConfig.args,
    provider: config.provider,
    model: config.model,
    cliName: 'codex',
    projectDir,
    // Seconds in config, milliseconds in the adapter — the same resolution the claude
    // factory performs below. Without this, `cliAdapter.idleTimeout` validated and had no
    // effect on codex: the runner fell through to its hardcoded default and killed a
    // configured-900s reviewer at 120s of normal reasoning silence.
    ...('idleTimeout' in adapterConfig && typeof adapterConfig.idleTimeout === 'number'
      ? { idleTimeout: adapterConfig.idleTimeout * 1000 }
      : {}),
  });
}

function createModelAdapter(config: ModelConfig, projectDir?: string): ModelAdapter {
  const kind = resolveModelAdapterKind(config);
  if (kind === 'cursor') {
    const adapterConfig = config.cliAdapter;
    return new CursorCliAdapter({
      command: adapterConfig?.command ?? defaultCursorCommand(),
      args: adapterConfig?.args ?? [],
      model: config.model,
      projectDir,
      timeout: (adapterConfig?.timeout ?? config.timeout) * 1000,
      ...(adapterConfig?.idleTimeout === undefined
        ? {}
        : { idleTimeout: adapterConfig.idleTimeout * 1000 }),
      envAllowlist: adapterConfig?.envAllowlist,
    });
  }
  if (kind === 'claude') {
    const adapterConfig = config.cliAdapter;
    return new ClaudeCliAdapter({
      command: adapterConfig?.command ?? defaultClaudeCommand(),
      args: adapterConfig?.args ?? [],
      model: config.model,
      projectDir,
      timeout: (adapterConfig?.timeout ?? config.timeout) * 1000,
      ...(adapterConfig?.idleTimeout === undefined
        ? {}
        : { idleTimeout: adapterConfig.idleTimeout * 1000 }),
      envAllowlist: adapterConfig?.envAllowlist,
    });
  }
  return createCliAdapter(config, projectDir);
}

export function resolveModelAdapterKind(config: ModelConfig): CliAdapterKind {
  if (config.cliAdapter?.kind !== undefined) return config.cliAdapter.kind;
  if (config.provider === 'anthropic') return 'claude';
  if (config.provider === 'cursor') return 'cursor';
  return 'codex';
}

/** Default codex CLI adapter config. */
function getDefaultCliConfig(projectDir?: string): {
  command: string;
  args: string[];
  timeout: number;
} {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const args = projectDir ? ['exec'] : ['exec', '--skip-git-repo-check'];
  return {
    command: `codex${ext}`,
    args,
    timeout: 600_000,
  };
}

function defaultCodexCommand(): string {
  return process.platform === 'win32' ? 'codex.cmd' : 'codex';
}

function defaultCursorCommand(): string {
  return process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent';
}

function defaultClaudeCommand(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function cliProbeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'SystemRoot'].flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

export { createCliAdapter, createModelAdapter };
