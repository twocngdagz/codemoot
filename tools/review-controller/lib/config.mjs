import { access, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { ControllerError, invariant } from './errors.mjs';
import { readJson } from './state.mjs';

const DEFAULTS = Object.freeze({
  schemaVersion: 1,
  repositoryRoot: '.',
  stateFile: '.cowork/workflow-state.json',
  artifactDirectory: '.cowork/reviews',
  reportDirectory: '.cowork/reports',
  rawOutputDirectory: '.cowork/raw',
  runtimeDirectory: '.cowork/runtime',
  lockFile: '.cowork/controller.lock',
  invalidOutputRetryCount: 1,
  autoCommit: false,
  autoPush: false,
  autoAdvance: true,
  pushRequired: true,
  branch: 'master',
  remote: 'origin',
  environmentVariableAllowlist: ['PATH', 'HOME', 'CODEX_HOME'],
  maximumControllerActions: 20,
  commitMessage: null,
  approvedBatches: [],
});

function absolute(root, path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

export function normalizeConfig(input, invocationRoot) {
  const merged = { ...DEFAULTS, ...input };
  invariant(merged.schemaVersion === 1, 'CONFIG_INVALID', 'Unsupported config schema version');
  const repositoryRoot = absolute(invocationRoot, merged.repositoryRoot);

  invariant(
    Number.isInteger(merged.invalidOutputRetryCount) &&
      merged.invalidOutputRetryCount >= 0 &&
      merged.invalidOutputRetryCount <= 1,
    'CONFIG_INVALID',
    'invalidOutputRetryCount must be 0 or 1',
  );
  invariant(
    Number.isInteger(merged.maximumControllerActions) && merged.maximumControllerActions > 0,
    'CONFIG_INVALID',
    'maximumControllerActions must be a positive integer',
  );
  invariant(
    Array.isArray(merged.environmentVariableAllowlist) &&
      merged.environmentVariableAllowlist.every((name) => typeof name === 'string'),
    'CONFIG_INVALID',
    'environmentVariableAllowlist must be an array of names',
  );
  invariant(
    Array.isArray(merged.approvedBatches),
    'CONFIG_INVALID',
    'approvedBatches must be an array',
  );

  return {
    ...merged,
    repositoryRoot,
    stateFile: absolute(repositoryRoot, merged.stateFile),
    artifactDirectory: absolute(repositoryRoot, merged.artifactDirectory),
    reportDirectory: absolute(repositoryRoot, merged.reportDirectory),
    rawOutputDirectory: absolute(repositoryRoot, merged.rawOutputDirectory),
    runtimeDirectory: absolute(repositoryRoot, merged.runtimeDirectory),
    lockFile: absolute(repositoryRoot, merged.lockFile),
  };
}

export async function loadConfig(options = {}) {
  const invocationRoot = resolve(options.root ?? process.cwd());
  const configPath = absolute(
    invocationRoot,
    options.configPath ?? '.cowork/controller-config.json',
  );
  let input = {};

  try {
    await access(configPath);
    input = await readJson(configPath);
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
      if (error instanceof ControllerError && error.code === 'FILE_NOT_FOUND') {
        input = {};
      } else {
        throw error;
      }
    }
  }

  const config = normalizeConfig(input, invocationRoot);
  if (options.stateFile) {
    config.stateFile = absolute(config.repositoryRoot, options.stateFile);
  }
  return config;
}

export async function ensureRuntimeDirectories(config) {
  await Promise.all([
    mkdir(dirname(config.stateFile), { recursive: true }),
    mkdir(config.artifactDirectory, { recursive: true }),
    mkdir(config.reportDirectory, { recursive: true }),
    mkdir(config.rawOutputDirectory, { recursive: true }),
    mkdir(config.runtimeDirectory, { recursive: true }),
    mkdir(dirname(config.lockFile), { recursive: true }),
  ]);
}

export function validateExecutorConfig(config, role) {
  const executor = role === 'IMPLEMENTER' ? config.implementer : config.reviewer;
  invariant(executor && typeof executor === 'object', 'CONFIG_INVALID', `${role} executor missing`);
  invariant(
    typeof executor.command === 'string' && executor.command.length > 0,
    'CONFIG_INVALID',
    `${role} executor command missing`,
  );
  invariant(
    Array.isArray(executor.args) && executor.args.every((value) => typeof value === 'string'),
    'CONFIG_INVALID',
    `${role} executor args must be an array`,
  );
  invariant(
    executor.promptDelivery === 'stdin' || executor.promptDelivery === 'file',
    'CONFIG_INVALID',
    `${role} promptDelivery must be stdin or file`,
  );
  invariant(
    Number.isInteger(executor.timeoutMs) && executor.timeoutMs > 0,
    'CONFIG_INVALID',
    `${role} timeoutMs must be a positive integer`,
  );
  return executor;
}
