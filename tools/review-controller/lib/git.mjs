import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { ControllerError, invariant } from './errors.mjs';

const execFileAsync = promisify(execFile);
const RUNTIME_PREFIX = '.cowork/';

async function git(root, arguments_, options = {}) {
  try {
    const result = await execFileAsync('git', arguments_, {
      cwd: root,
      encoding: options.encoding ?? 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    throw new ControllerError(
      'GIT_COMMAND_FAILED',
      `git ${arguments_.join(' ')} failed`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parseNullList(output) {
  return output.split('\0').filter(Boolean);
}

export function parsePorcelain(output) {
  const fields = output.split('\0');
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) {
      continue;
    }
    const status = field.slice(0, 2);
    const path = field.slice(3);
    const entry = { status, path };
    if (status.includes('R') || status.includes('C')) {
      entry.originalPath = fields[index + 1];
      index += 1;
    }
    entries.push(entry);
  }
  return entries;
}

export function isControllerRuntimePath(path) {
  return path.startsWith(RUNTIME_PREFIX);
}

async function hashWorkingPath(root, path) {
  const absolutePath = resolve(root, path);
  try {
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      return `symlink:${await readlink(absolutePath)}`;
    }
    if (!metadata.isFile()) {
      return `non-file:${metadata.mode}`;
    }
    const contents = await readFile(absolutePath);
    return createHash('sha256').update(contents).digest('hex');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return 'deleted';
    }
    throw error;
  }
}

export async function captureGitSnapshot(root, baseSha) {
  const [headOutput, statusOutput, committedOutput] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(root, ['diff', '--name-only', '-z', baseSha, 'HEAD', '--']),
  ]);
  const headSha = headOutput.trim();
  const statusEntries = parsePorcelain(statusOutput).filter(
    (entry) => !isControllerRuntimePath(entry.path),
  );
  const changedFiles = new Set(
    parseNullList(committedOutput).filter((path) => !isControllerRuntimePath(path)),
  );
  for (const entry of statusEntries) {
    changedFiles.add(entry.path);
    if (entry.originalPath && !isControllerRuntimePath(entry.originalPath)) {
      changedFiles.add(entry.originalPath);
    }
  }

  const sortedFiles = [...changedFiles].sort();
  const fileHashes = {};
  for (const path of sortedFiles) {
    fileHashes[path] = await hashWorkingPath(root, path);
  }
  const status = statusEntries
    .map((entry) => `${entry.status}:${entry.originalPath ?? ''}:${entry.path}`)
    .sort();
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ headSha, status, fileHashes }))
    .digest('hex');

  return {
    headSha,
    changedFiles: sortedFiles,
    status,
    fileHashes,
    fingerprint,
  };
}

export function assertSnapshotMatches(actual, expected, code = 'APPROVED_STATE_CHANGED') {
  invariant(
    actual.headSha === expected.headSha &&
      actual.fingerprint === expected.fingerprint &&
      JSON.stringify(actual.changedFiles) === JSON.stringify(expected.changedFiles),
    code,
    'Current Git state no longer matches the reviewed state',
    { actual, expected },
  );
}

export async function stagedFiles(root) {
  return parseNullList(await git(root, ['diff', '--cached', '--name-only', '-z', '--'])).sort();
}

export async function uncommittedFiles(root) {
  return parsePorcelain(
    await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  )
    .map((entry) => entry.path)
    .filter((path) => !isControllerRuntimePath(path))
    .sort();
}

export async function remoteHead(root, remote, branch) {
  try {
    return (await git(root, ['rev-parse', '--verify', `${remote}/${branch}`])).trim();
  } catch {
    return null;
  }
}

export async function commitApprovedSnapshot(root, snapshot, message) {
  invariant(
    typeof message === 'string' && message.trim().length > 0,
    'COMMIT_MESSAGE_REQUIRED',
    'An explicit commit message is required',
  );
  invariant(
    snapshot.changedFiles.length > 0,
    'NOTHING_TO_COMMIT',
    'The approved snapshot has no changed files',
  );
  invariant(
    snapshot.changedFiles.every((path) => !isControllerRuntimePath(path)),
    'RUNTIME_FILE_IN_COMMIT',
    'Controller runtime files may not be committed',
  );
  invariant(
    (await stagedFiles(root)).length === 0,
    'PREEXISTING_STAGED_CHANGES',
    'Refusing to mix pre-existing staged changes into the approved commit',
  );

  await git(root, ['add', '--', ...snapshot.changedFiles]);
  const actualStaged = await stagedFiles(root);
  invariant(
    JSON.stringify(actualStaged) === JSON.stringify([...snapshot.changedFiles].sort()),
    'COMMIT_SET_MISMATCH',
    'The staged file set does not match the reviewed file set',
    { expected: snapshot.changedFiles, actual: actualStaged },
  );
  await git(root, ['commit', '-m', message]);
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}

export async function verifyApprovedCommit(root, approvalSnapshot) {
  const previousHead = approvalSnapshot.headSha;
  const expectedFiles = approvalSnapshot.changedFiles;
  const currentHead = (await git(root, ['rev-parse', 'HEAD'])).trim();
  if (currentHead === previousHead) {
    return { verified: false, reason: 'HEAD has not advanced' };
  }
  const parent = (await git(root, ['rev-parse', `${currentHead}^`])).trim();
  if (parent !== previousHead) {
    return { verified: false, reason: 'Current commit is not based directly on reviewed HEAD' };
  }
  const files = parseNullList(
    await git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', currentHead]),
  ).sort();
  if (JSON.stringify(files) !== JSON.stringify([...expectedFiles].sort())) {
    return { verified: false, reason: 'Committed files do not match reviewed files', files };
  }
  const currentStatus = parsePorcelain(
    await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  );
  const approvedStillChanged = currentStatus
    .map((entry) => entry.path)
    .filter((path) => expectedFiles.includes(path));
  if (approvedStillChanged.length > 0) {
    return {
      verified: false,
      reason: 'Reviewed files still have uncommitted changes',
      files: approvedStillChanged,
    };
  }
  if (
    !approvalSnapshot.fileHashes ||
    expectedFiles.some((path) => !(path in approvalSnapshot.fileHashes))
  ) {
    return { verified: false, reason: 'Reviewed content hashes are unavailable' };
  }
  const contentMismatches = [];
  for (const path of expectedFiles) {
    const actualHash = await hashWorkingPath(root, path);
    const expectedHash = approvalSnapshot.fileHashes[path];
    if (actualHash !== expectedHash) {
      contentMismatches.push({ path, expectedHash, actualHash });
    }
  }
  if (contentMismatches.length > 0) {
    return {
      verified: false,
      reason: 'Committed content does not match reviewed content',
      contentMismatches,
    };
  }
  return { verified: true, commitSha: currentHead };
}

export async function pushBranch(root, remote, branch) {
  invariant(
    typeof remote === 'string' && remote.length > 0,
    'PUSH_CONFIG_INVALID',
    'remote missing',
  );
  invariant(
    typeof branch === 'string' && branch.length > 0,
    'PUSH_CONFIG_INVALID',
    'branch missing',
  );
  await git(root, ['push', remote, branch]);
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}

export async function verifyPushed(root, remote, branch, expectedHead) {
  try {
    const remoteHead = (await git(root, ['rev-parse', `${remote}/${branch}`])).trim();
    return { verified: remoteHead === expectedHead, remoteHead };
  } catch {
    return { verified: false, remoteHead: null };
  }
}
