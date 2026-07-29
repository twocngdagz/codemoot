import { ControllerError } from './errors.mjs';
import { acquireLock } from './locking.mjs';
import { hashBytes, readBytes, validateWorkflowState, writeJsonAtomic } from './state.mjs';

export function now() {
  return new Date().toISOString();
}

export function actionRecord(state, action, status, extra = {}) {
  return {
    actionId: `${state.workflowId}:${state.activeBatch}:${state.actionCount ?? 0}:${Date.now()}`,
    action,
    phase: state.phase,
    status,
    recordedAt: now(),
    ...extra,
  };
}

export async function writeState(config, state) {
  validateWorkflowState(state);
  await writeJsonAtomic(config.stateFile, state);
}

export async function acquireControllerLock(config, stateBytes, state) {
  const expectedHash = hashBytes(stateBytes);
  const lock = await acquireLock(config.lockFile, {
    workflowId: state.workflowId,
    phase: state.phase,
    stateHash: expectedHash,
  });
  const currentHash = hashBytes(await readBytes(config.stateFile));
  if (currentHash !== expectedHash) {
    await lock.release();
    throw new ControllerError(
      'STATE_CHANGED_DURING_LOCK',
      'State changed while the controller lock was being acquired',
    );
  }
  return lock;
}
