import { copyFileSync, renameSync, writeFileSync } from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { ProjectConfig } from '../types/config.js';
import { ConfigError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { COMPATIBILITY_REVIEW_GATED_CONFIG } from './review-gated.js';

const log = createLogger('info');
const CURRENT_VERSION = 3;

const migrationDocumentSchema = z
  .object({
    configVersion: z.number().int().positive().optional(),
    models: z.record(z.unknown()).optional(),
    debate: z.unknown().optional(),
    reviewGated: z.unknown().optional(),
  })
  .passthrough();

type ConfigDocument = z.infer<typeof migrationDocumentSchema>;

export function migrateConfig(config: ProjectConfig, configPath?: string): ProjectConfig;
export function migrateConfig(
  config: Record<string, unknown>,
  configPath?: string,
): Record<string, unknown>;

/**
 * Migrate a configuration document to the current version.
 *
 * The input may be a complete ProjectConfig or a partial document read from
 * `.cowork.yml`. When a path is supplied, the original is backed up and the
 * migrated partial document is written atomically.
 */
export function migrateConfig(
  config: ProjectConfig | Record<string, unknown>,
  configPath?: string,
): ProjectConfig | Record<string, unknown> {
  const parsed = migrationDocumentSchema.safeParse(config);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid configuration for migration: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  const fromVersion = parsed.data.configVersion ?? 1;
  if (fromVersion > CURRENT_VERSION) {
    throw new ConfigError(
      `Config version ${fromVersion} requires a newer version of CodeMoot. Please upgrade.`,
      'configVersion',
    );
  }
  if (fromVersion === CURRENT_VERSION) return config;

  if (configPath !== undefined) createBackup(configPath);

  let migrated: ConfigDocument = structuredClone(parsed.data);
  if (fromVersion < 2) migrated = migrateV1ToV2(migrated);
  if (fromVersion < 3) migrated = migrateV2ToV3(migrated);

  if (configPath !== undefined) writeMigratedConfig(migrated, configPath, fromVersion);
  return migrated;
}

function migrateV1ToV2(config: ConfigDocument): ConfigDocument {
  return { ...config, configVersion: 2 };
}

function migrateV2ToV3(config: ConfigDocument): ConfigDocument {
  return {
    ...config,
    configVersion: 3,
    ...(config.models === undefined ? {} : { models: migrateModels(config.models) }),
    debate: mergeMissing(config.debate, { enabled: true }),
    reviewGated: mergeMissing(
      config.reviewGated,
      Object.fromEntries(Object.entries(COMPATIBILITY_REVIEW_GATED_CONFIG)),
    ),
  };
}

function migrateModels(models: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(models).map(([alias, modelValue]) => {
      if (!isRecord(modelValue)) return [alias, modelValue];
      const cliAdapter = modelValue.cliAdapter;
      if (!isRecord(cliAdapter) || typeof cliAdapter.kind === 'string') {
        return [alias, modelValue];
      }
      const inferredKind = modelValue.provider === 'anthropic' ? 'claude' : 'codex';
      return [alias, { ...modelValue, cliAdapter: { ...cliAdapter, kind: inferredKind } }];
    }),
  );
}

function mergeMissing(value: unknown, defaults: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value)) return structuredClone(defaults);
  const result: Record<string, unknown> = { ...value };
  for (const [key, defaultValue] of Object.entries(defaults)) {
    const existing = result[key];
    if (existing === undefined) {
      result[key] = structuredClone(defaultValue);
    } else if (isRecord(existing) && isRecord(defaultValue)) {
      result[key] = mergeMissing(existing, defaultValue);
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createBackup(configPath: string): void {
  const backupPath = `${configPath}.bak`;
  try {
    copyFileSync(configPath, backupPath);
    log.info(`Config backup created at ${backupPath}`);
  } catch {
    log.warn('Failed to create config backup');
  }
}

function writeMigratedConfig(
  migrated: ConfigDocument,
  configPath: string,
  fromVersion: number,
): void {
  const temporaryPath = `${configPath}.tmp`;
  try {
    const content = stringifyYaml(migrated, { lineWidth: 100 });
    writeFileSync(temporaryPath, content, 'utf-8');
    renameSync(temporaryPath, configPath);
    log.info(`Config migrated from v${fromVersion} to v${CURRENT_VERSION}`);
  } catch (error) {
    log.warn(
      `Failed to write migrated config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export { CURRENT_VERSION };
