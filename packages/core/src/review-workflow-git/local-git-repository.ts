// Read-only local Git adapter with canonical argument forms.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  changedFileSchema,
  gitIdentityMetadataSchema,
  gitShaSchema,
} from '../review-workflow/schemas.js';
import type { ChangedFile, GitIdentityMetadata, GitSha } from '../review-workflow/types.js';
import {
  type GitCommitSnapshot,
  type GitDiffSnapshot,
  type GitRepository,
  type GitWorktreeSnapshot,
  ReviewWorkflowGitError,
} from './types.js';

interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function parseIdentity(
  name: string | undefined,
  email: string | undefined,
  timestamp: string | undefined,
): GitIdentityMetadata {
  return gitIdentityMetadataSchema.parse({
    ...(nonEmpty(name) === undefined ? {} : { name }),
    ...(nonEmpty(email) === undefined ? {} : { email }),
    ...(nonEmpty(timestamp) === undefined ? {} : { timestamp }),
  });
}

function parseChangedFiles(output: string): readonly ChangedFile[] {
  if (output.length === 0) return [];

  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changedFiles: ChangedFile[] = [];

  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    if (status === undefined) {
      throw new ReviewWorkflowGitError(
        'GIT_COMMAND_FAILED',
        'Git name-status output ended before a status field',
      );
    }
    index += 1;

    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = fields[index];
      const path = fields[index + 1];
      if (previousPath === undefined || path === undefined) {
        throw new ReviewWorkflowGitError(
          'GIT_COMMAND_FAILED',
          `Git name-status output for ${status} is incomplete`,
        );
      }
      changedFiles.push(changedFileSchema.parse({ path, status, previousPath }));
      index += 2;
      continue;
    }

    const path = fields[index];
    if (path === undefined) {
      throw new ReviewWorkflowGitError(
        'GIT_COMMAND_FAILED',
        `Git name-status output for ${status} is missing a path`,
      );
    }
    changedFiles.push(changedFileSchema.parse({ path, status }));
    index += 1;
  }

  return changedFiles;
}

export class LocalGitRepository implements GitRepository {
  readonly repositoryRoot: string;

  constructor(
    repositoryRoot: string,
    private readonly executable = 'git',
  ) {
    this.repositoryRoot = resolve(repositoryRoot);
    const detectedRoot = this.run(['rev-parse', '--show-toplevel']).stdout.trim();
    if (detectedRoot.length === 0) {
      throw new ReviewWorkflowGitError(
        'GIT_COMMAND_FAILED',
        `${this.repositoryRoot} is not a Git repository`,
      );
    }
  }

  readHeadSha(): GitSha {
    return this.parseSha(
      this.run(['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim(),
      'repository HEAD',
    );
  }

  readWorktree(): GitWorktreeSnapshot {
    const startingHeadSha = this.readHeadSha();
    const startingBranch = this.readBranch();
    const startingStatus = this.readStatus();
    const endingStatus = this.readStatus();
    const endingBranch = this.readBranch();
    const endingHeadSha = this.readHeadSha();
    if (
      startingHeadSha !== endingHeadSha ||
      startingBranch !== endingBranch ||
      startingStatus !== endingStatus
    ) {
      throw new ReviewWorkflowGitError(
        'REPOSITORY_CHANGED_DURING_READ',
        'Repository HEAD, branch, or worktree status changed while reading repository state',
      );
    }

    return {
      headSha: endingHeadSha,
      branch: endingBranch.length === 0 ? 'HEAD' : endingBranch,
      clean: endingStatus.length === 0,
      statusPorcelain: endingStatus,
      worktreeFingerprint: sha256(endingStatus),
    };
  }

  readCommit(sha: GitSha): GitCommitSnapshot {
    const parsedSha = gitShaSchema.parse(sha);
    const output = this.run([
      'show',
      '--no-patch',
      '--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI',
      parsedSha,
      '--',
    ]).stdout;
    const fields = output.trimEnd().split('\0');
    const [
      resultingCommitSha,
      treeSha,
      parentShaList,
      authorName,
      authorEmail,
      authorTimestamp,
      committerName,
      committerEmail,
      committerTimestamp,
    ] = fields;

    if (resultingCommitSha === undefined || treeSha === undefined || parentShaList === undefined) {
      throw new ReviewWorkflowGitError(
        'GIT_COMMAND_FAILED',
        `Git did not return complete metadata for commit ${parsedSha}`,
      );
    }

    return {
      sha: this.parseSha(resultingCommitSha, 'resolved commit'),
      treeSha: this.parseSha(treeSha, 'commit tree'),
      parentShas:
        parentShaList.length === 0
          ? []
          : parentShaList.split(' ').map((parentSha) => this.parseSha(parentSha, 'commit parent')),
      author: parseIdentity(authorName, authorEmail, authorTimestamp),
      committer: parseIdentity(committerName, committerEmail, committerTimestamp),
    };
  }

  isAncestor(ancestorSha: GitSha, descendantSha: GitSha): boolean {
    const ancestor = gitShaSchema.parse(ancestorSha);
    const descendant = gitShaSchema.parse(descendantSha);
    const result = this.run(['merge-base', '--is-ancestor', ancestor, descendant], [0, 1]);
    return result.exitCode === 0;
  }

  readDiff(fromSha: GitSha, toSha: GitSha): GitDiffSnapshot {
    const from = gitShaSchema.parse(fromSha);
    const to = gitShaSchema.parse(toSha);
    const arguments_ = ['diff', '--binary', '--full-index', '--find-renames', from, to, '--'];
    const patch = this.run(arguments_).stdout;
    const changedFiles = parseChangedFiles(
      this.run(['diff', '--name-status', '-z', '--find-renames', from, to, '--']).stdout,
    );

    return {
      fromSha: from,
      toSha: to,
      arguments: arguments_,
      patch,
      patchHash: sha256(patch),
      changedFiles,
    };
  }

  private readBranch(): string {
    return this.run(['branch', '--show-current']).stdout.trim();
  }

  private readStatus(): string {
    return this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--']).stdout;
  }

  private parseSha(value: string, description: string): GitSha {
    const parsed = gitShaSchema.safeParse(value);
    if (!parsed.success) {
      throw new ReviewWorkflowGitError(
        'GIT_REFERENCE_INVALID',
        `Git returned an invalid ${description} SHA`,
      );
    }
    return parsed.data;
  }

  private run(
    arguments_: readonly string[],
    allowedExitCodes: readonly number[] = [0],
  ): GitCommandResult {
    const result = spawnSync(this.executable, arguments_, {
      cwd: this.repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error !== undefined) {
      throw new ReviewWorkflowGitError(
        'GIT_COMMAND_FAILED',
        `Failed to execute Git: ${result.error.message}`,
      );
    }
    if (result.status === null || !allowedExitCodes.includes(result.status)) {
      const detail = result.stderr.trim();
      throw new ReviewWorkflowGitError(
        'GIT_COMMAND_FAILED',
        `Git ${arguments_.join(' ')} failed${detail.length === 0 ? '' : `: ${detail}`}`,
      );
    }
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.status,
    };
  }
}
