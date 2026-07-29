import { open, readFile, unlink } from 'node:fs/promises';

import { ControllerError } from './errors.mjs';

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && error.code === 'EPERM');
  }
}

export async function inspectLock(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { exists: false, stale: false, data: null };
    }
    throw error;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { exists: true, stale: true, data: null, reason: 'invalid lock JSON' };
  }
  return {
    exists: true,
    stale: !processExists(data.pid),
    data,
    reason: processExists(data.pid) ? 'owner process is alive' : 'owner process is absent',
  };
}

export async function acquireLock(path, details) {
  let handle;
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      const lock = await inspectLock(path);
      const code = lock.stale ? 'STALE_CONTROLLER_LOCK' : 'CONTROLLER_LOCKED';
      throw new ControllerError(
        code,
        lock.stale
          ? 'A stale controller lock exists; run reconcile before continuing'
          : 'Another controller process holds the lock',
        lock,
      );
    }
    throw error;
  }

  const data = {
    schemaVersion: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ...details,
  };
  await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await handle.close();

  let released = false;
  return {
    data,
    async release() {
      if (released) {
        return;
      }
      released = true;
      await unlink(path).catch((error) => {
        if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
          throw error;
        }
      });
    },
  };
}

export async function removeStaleLock(path) {
  const lock = await inspectLock(path);
  if (!lock.exists) {
    return false;
  }
  if (!lock.stale) {
    throw new ControllerError('CONTROLLER_LOCKED', 'Cannot remove a live controller lock');
  }
  await unlink(path);
  return true;
}
