import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { ControllerError, invariant } from './errors.mjs';

export function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function readBytes(path) {
  return readFile(path);
}

export async function readJson(path) {
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new ControllerError('FILE_NOT_FOUND', `File does not exist: ${path}`);
    }
    throw error;
  }

  try {
    return JSON.parse(source);
  } catch {
    throw new ControllerError('INVALID_JSON', `File is not valid JSON: ${path}`);
  }
}

export async function writeJsonAtomic(path, value, options = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const source = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await writeFile(temporaryPath, source, { encoding: 'utf8', flag: 'wx' });
    await options.beforeRename?.(temporaryPath);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function restoreBytesAtomic(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.restore`,
  );
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export function validateWorkflowState(state) {
  invariant(state && typeof state === 'object', 'STATE_INVALID', 'State must be an object');
  invariant(state.schemaVersion === 1, 'STATE_INVALID', 'Unsupported state schema version');
  invariant(
    typeof state.workflowId === 'string' && state.workflowId.length > 0,
    'STATE_INVALID',
    'workflowId is required',
  );
  invariant(
    Number.isInteger(state.activeBatch) && state.activeBatch > 0,
    'STATE_INVALID',
    'activeBatch must be a positive integer',
  );
  invariant(typeof state.phase === 'string', 'STATE_INVALID', 'phase is required');
  invariant(
    typeof state.implementer === 'string' && typeof state.reviewer === 'string',
    'STATE_INVALID',
    'implementer and reviewer are required',
  );
  invariant(
    state.implementer !== state.reviewer,
    'ROLE_SEPARATION_REQUIRED',
    'Implementer and reviewer must be different configured agents',
  );
  return state;
}

export async function loadState(path) {
  return validateWorkflowState(await readJson(path));
}
