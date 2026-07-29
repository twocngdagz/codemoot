import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { CURRENT_VERSION, migrateConfig } from '../../../src/config/migration.js';
import type { ProjectConfig } from '../../../src/types/config.js';
import { ConfigError } from '../../../src/utils/errors.js';

const TEST_DIR = join(tmpdir(), `codemoot-migration-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Build a minimal v1 config (no configVersion). */
function makeV1Config(): ProjectConfig {
  return {
    ...DEFAULT_CONFIG,
    configVersion: undefined,
    project: { name: 'test-project', description: 'test' },
  };
}

describe('migrateConfig', () => {
  it('migrates v1 config through v2 to configVersion 3', () => {
    const v1 = makeV1Config();
    const v1WithoutVersion = { ...v1 };
    v1WithoutVersion.configVersion = undefined;

    const migrated = migrateConfig(v1WithoutVersion);

    expect(migrated.configVersion).toBe(3);
    expect(migrated.debate.enabled).toBe(true);
    expect(migrated.reviewGated?.commit.mode).toBe('human_required');
  });

  it('returns config unchanged when already at current version', () => {
    const v3Config: ProjectConfig = {
      ...DEFAULT_CONFIG,
      configVersion: 3,
    };

    const result = migrateConfig(v3Config);
    expect(result).toBe(v3Config);
    expect(result.configVersion).toBe(3);
  });

  it('migrates v2 identity, adapter, commit, and gate defaults', () => {
    const v2Config: ProjectConfig = {
      ...DEFAULT_CONFIG,
      configVersion: 2,
      debate: {
        defaultPattern: 'proposal-critique',
        maxRounds: 3,
        consensusThreshold: 0.7,
      },
      reviewGated: undefined,
      models: {
        codex: {
          provider: 'openai',
          model: 'gpt-5.3-codex',
          maxTokens: 4096,
          temperature: 0.3,
          timeout: 120,
          cliAdapter: {
            command: 'codex',
            args: ['exec'],
            timeout: 600,
          },
        },
      },
    };

    const result = migrateConfig(v2Config);

    expect(result.configVersion).toBe(3);
    expect(result.models.codex.cliAdapter?.kind).toBe('codex');
    expect(result.debate.enabled).toBe(true);
    expect(result.reviewGated).toMatchObject({
      identity: {
        minimumAssurance: 'config_only',
        requireDifferentAdapterKinds: false,
        prohibitSharedSessions: true,
      },
      commit: { mode: 'human_required', agentMayCommit: false },
      gates: {
        blockingSeverities: ['critical', 'high'],
        requireAllFindingResponses: true,
        requireAcceptedAttestations: true,
      },
    });
  });

  it('throws ConfigError for future config version', () => {
    const futureConfig: ProjectConfig = {
      ...DEFAULT_CONFIG,
      configVersion: 99,
    };

    expect(() => migrateConfig(futureConfig)).toThrow(ConfigError);
    expect(() => migrateConfig(futureConfig)).toThrow('requires a newer version');
  });

  it('preserves unknown fields for forward compatibility', () => {
    const v1 = makeV1Config() as Record<string, unknown>;
    v1.customField = 'should-survive';
    v1.configVersion = undefined;

    const migrated = migrateConfig(v1 as ProjectConfig) as Record<string, unknown>;

    expect(migrated.customField).toBe('should-survive');
    expect(migrated.configVersion).toBe(3);
  });

  it('creates backup file before migration when configPath is provided', () => {
    const configPath = join(TEST_DIR, '.cowork.yml');
    const v1 = makeV1Config();
    writeFileSync(configPath, stringifyYaml(v1), 'utf-8');

    migrateConfig(v1, configPath);

    const backupPath = `${configPath}.bak`;
    expect(existsSync(backupPath)).toBe(true);
    const backupContent = readFileSync(backupPath, 'utf-8');
    expect(backupContent).toContain('plan-review-implement');
  });

  it('does not crash when backup creation fails', () => {
    const v1 = makeV1Config();
    const bogusPath = join(TEST_DIR, 'nonexistent', 'deep', 'config.yml');

    const migrated = migrateConfig(v1, bogusPath);
    expect(migrated.configVersion).toBe(3);
  });

  it('round-trip: all original fields are preserved after migration', () => {
    const v1 = makeV1Config();
    v1.configVersion = undefined;

    const migrated = migrateConfig(v1);

    expect(migrated.project.name).toBe(v1.project.name);
    expect(migrated.workflow).toBe(v1.workflow);
    expect(migrated.mode).toBe(v1.mode);
    expect(migrated.debate.maxRounds).toBe(v1.debate.maxRounds);

    for (const alias of Object.keys(v1.models)) {
      expect(migrated.models[alias].provider).toBe(v1.models[alias].provider);
      expect(migrated.models[alias].model).toBe(v1.models[alias].model);
    }
  });

  it('treats missing configVersion as v1', () => {
    const config = makeV1Config();
    const asRecord = config as Record<string, unknown>;
    asRecord.configVersion = undefined;

    const migrated = migrateConfig(config);
    expect(migrated.configVersion).toBe(3);
  });

  it('writes migrated config back to disk when configPath is provided', () => {
    const configPath = join(TEST_DIR, '.cowork.yml');
    const v1 = makeV1Config();
    writeFileSync(configPath, stringifyYaml(v1), 'utf-8');

    migrateConfig(v1, configPath);

    const written = readFileSync(configPath, 'utf-8');
    expect(written).toContain('configVersion: 3');
    expect(written).toContain('reviewGated:');
  });
});

describe('CURRENT_VERSION', () => {
  it('is 3', () => {
    expect(CURRENT_VERSION).toBe(3);
  });
});
