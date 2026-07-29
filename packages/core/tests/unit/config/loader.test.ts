import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { loadConfig, writeConfig } from '../../../src/config/loader.js';

const TEST_DIR = join(tmpdir(), `codemoot-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const config = loadConfig({ projectDir: TEST_DIR });
    expect(config.configVersion).toBe(3);
    expect(config.mode).toBe('autonomous');
    expect(config.workflow).toBe('plan-review-implement');
    expect(config.advanced.logLevel).toBe('info');
    expect(config.reviewGated?.identity.minimumAssurance).toBe('config_only');
  });

  it('merges .cowork.yml over defaults', () => {
    writeFileSync(
      join(TEST_DIR, '.cowork.yml'),
      'mode: interactive\nadvanced:\n  logLevel: debug\n',
      'utf-8',
    );
    const config = loadConfig({ projectDir: TEST_DIR });
    expect(config.mode).toBe('interactive');
    expect(config.advanced.logLevel).toBe('debug');
    // Defaults still present for unspecified fields
    expect(config.budget.perSession).toBe(DEFAULT_CONFIG.budget.perSession);
  });

  it('applies overrides on top of file config', () => {
    writeFileSync(join(TEST_DIR, '.cowork.yml'), 'mode: interactive\n', 'utf-8');
    const config = loadConfig({
      projectDir: TEST_DIR,
      overrides: { mode: 'dashboard' },
    });
    expect(config.mode).toBe('dashboard');
  });

  it('respects precedence: overrides > file > defaults', () => {
    writeFileSync(
      join(TEST_DIR, '.cowork.yml'),
      'advanced:\n  logLevel: debug\n  stream: false\n',
      'utf-8',
    );
    const config = loadConfig({
      projectDir: TEST_DIR,
      overrides: { advanced: { retryAttempts: 5, stream: true, logLevel: 'warn' } },
    });
    // Override wins
    expect(config.advanced.logLevel).toBe('warn');
    expect(config.advanced.stream).toBe(true);
    expect(config.advanced.retryAttempts).toBe(5);
  });

  it('throws ConfigError for invalid YAML', () => {
    writeFileSync(join(TEST_DIR, '.cowork.yml'), '{{invalid yaml', 'utf-8');
    expect(() => loadConfig({ projectDir: TEST_DIR })).toThrow();
  });

  it('validates the merged config', () => {
    writeFileSync(join(TEST_DIR, '.cowork.yml'), 'mode: turbo_invalid\n', 'utf-8');
    expect(() => loadConfig({ projectDir: TEST_DIR })).toThrow('Invalid configuration');
  });

  it('migrates a v2 project file before merging and writes a backup', () => {
    const configPath = join(TEST_DIR, '.cowork.yml');
    writeFileSync(
      configPath,
      [
        'configVersion: 2',
        'mode: interactive',
        'debate:',
        '  defaultPattern: proposal-critique',
        '  maxRounds: 3',
        '  consensusThreshold: 0.7',
      ].join('\n'),
      'utf-8',
    );

    const config = loadConfig({ projectDir: TEST_DIR });

    expect(config.configVersion).toBe(3);
    expect(config.mode).toBe('interactive');
    expect(config.debate.enabled).toBe(true);
    expect(config.reviewGated?.commit).toEqual({
      mode: 'human_required',
      agentMayCommit: false,
    });
    expect(existsSync(`${configPath}.bak`)).toBe(true);
    expect(readFileSync(configPath, 'utf-8')).toContain('configVersion: 3');
  });

  it('does not rewrite an already-current v3 project file', () => {
    const configPath = join(TEST_DIR, '.cowork.yml');
    const content = 'configVersion: 3\nmode: interactive\n';
    writeFileSync(configPath, content, 'utf-8');

    const config = loadConfig({ projectDir: TEST_DIR });

    expect(config.configVersion).toBe(3);
    expect(readFileSync(configPath, 'utf-8')).toBe(content);
    expect(existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('reports a precise error for a future config version', () => {
    writeFileSync(join(TEST_DIR, '.cowork.yml'), 'configVersion: 99\n', 'utf-8');

    expect(() => loadConfig({ projectDir: TEST_DIR })).toThrow(
      'Config version 99 requires a newer version of CodeMoot',
    );
  });
});

describe('writeConfig', () => {
  it('writes .cowork.yml and creates directories', () => {
    writeConfig(DEFAULT_CONFIG, TEST_DIR);
    expect(existsSync(join(TEST_DIR, '.cowork.yml'))).toBe(true);
    expect(existsSync(join(TEST_DIR, '.cowork', 'db'))).toBe(true);
    expect(existsSync(join(TEST_DIR, '.cowork', 'transcripts'))).toBe(true);
  });

  it('creates .gitignore with .cowork/ entry', () => {
    writeConfig(DEFAULT_CONFIG, TEST_DIR);
    const gitignore = readFileSync(join(TEST_DIR, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.cowork/');
  });

  it('appends to existing .gitignore without duplicating', () => {
    writeFileSync(join(TEST_DIR, '.gitignore'), 'node_modules/\n', 'utf-8');
    writeConfig(DEFAULT_CONFIG, TEST_DIR);
    writeConfig(DEFAULT_CONFIG, TEST_DIR); // write twice
    const gitignore = readFileSync(join(TEST_DIR, '.gitignore'), 'utf-8');
    const matches = gitignore.match(/\.cowork\//g);
    expect(matches).toHaveLength(1);
  });

  it('written config can be loaded back', () => {
    writeConfig(DEFAULT_CONFIG, TEST_DIR);
    const loaded = loadConfig({ projectDir: TEST_DIR });
    expect(loaded.mode).toBe(DEFAULT_CONFIG.mode);
    expect(loaded.workflow).toBe(DEFAULT_CONFIG.workflow);
  });
});
