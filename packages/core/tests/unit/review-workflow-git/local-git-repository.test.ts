import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalGitRepository } from '../../../src/review-workflow-git/local-git-repository.js';

function git(repositoryRoot: string, arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFile(
  repositoryRoot: string,
  path: string,
  content: string,
  message: string,
): string {
  const absolutePath = join(repositoryRoot, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  git(repositoryRoot, ['add', '--', path]);
  git(repositoryRoot, ['commit', '-m', message]);
  return git(repositoryRoot, ['rev-parse', 'HEAD']);
}

describe('LocalGitRepository', () => {
  let repositoryRoot: string;
  let baseSha: string;

  beforeEach(() => {
    repositoryRoot = mkdtempSync(join(tmpdir(), 'codemoot-review-git-'));
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.name', 'CodeMoot Test']);
    git(repositoryRoot, ['config', 'user.email', 'codemoot@example.com']);
    baseSha = commitFile(repositoryRoot, 'src/example.txt', 'base\n', 'base');
  });

  afterEach(() => {
    rmSync(repositoryRoot, { recursive: true, force: true });
  });

  it('reads stable worktree and commit metadata from Git', () => {
    const repository = new LocalGitRepository(repositoryRoot);
    const worktree = repository.readWorktree();
    const commit = repository.readCommit(baseSha);

    expect(worktree).toMatchObject({
      headSha: baseSha,
      branch: 'main',
      clean: true,
      statusPorcelain: '',
    });
    expect(worktree.worktreeFingerprint).toBe(createHash('sha256').update('').digest('hex'));
    expect(commit).toMatchObject({
      sha: baseSha,
      parentShas: [],
      author: {
        name: 'CodeMoot Test',
        email: 'codemoot@example.com',
      },
      committer: {
        name: 'CodeMoot Test',
        email: 'codemoot@example.com',
      },
    });
    expect(commit.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(commit.author.timestamp).toBeDefined();
    expect(commit.committer.timestamp).toBeDefined();
  });

  it('uses canonical binary diff arguments and parses renames', () => {
    const changedSha = commitFile(repositoryRoot, 'src/example.txt', 'changed\n', 'change');
    git(repositoryRoot, ['mv', 'src/example.txt', 'src/renamed.txt']);
    appendFileSync(join(repositoryRoot, 'src/renamed.txt'), 'renamed\n');
    git(repositoryRoot, ['add', '--all']);
    git(repositoryRoot, ['commit', '-m', 'rename']);
    const renamedSha = git(repositoryRoot, ['rev-parse', 'HEAD']);
    const repository = new LocalGitRepository(repositoryRoot);

    const changedDiff = repository.readDiff(baseSha, changedSha);
    const renamedDiff = repository.readDiff(changedSha, renamedSha);

    expect(changedDiff.arguments).toEqual([
      'diff',
      '--binary',
      '--full-index',
      '--find-renames',
      baseSha,
      changedSha,
      '--',
    ]);
    expect(changedDiff.patchHash).toBe(
      createHash('sha256').update(changedDiff.patch).digest('hex'),
    );
    expect(changedDiff.changedFiles).toEqual([{ path: 'src/example.txt', status: 'M' }]);
    expect(renamedDiff.changedFiles).toEqual([
      {
        path: 'src/renamed.txt',
        previousPath: 'src/example.txt',
        status: 'R050',
      },
    ]);
  });

  it('reports dirty untracked content and ancestry without mutating it', () => {
    const descendantSha = commitFile(repositoryRoot, 'src/next.txt', 'next\n', 'next');
    const repository = new LocalGitRepository(repositoryRoot);
    writeFileSync(join(repositoryRoot, 'untracked.txt'), 'untracked\n');

    const worktree = repository.readWorktree();

    expect(worktree.clean).toBe(false);
    expect(worktree.statusPorcelain).toContain('untracked.txt');
    expect(repository.isAncestor(baseSha, descendantSha)).toBe(true);
    expect(repository.isAncestor(descendantSha, baseSha)).toBe(false);
    expect(repository.readHeadSha()).toBe(descendantSha);
    expect(worktree.statusPorcelain).toBe(repository.readWorktree().statusPorcelain);
  });
});
