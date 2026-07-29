import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalGitRepository } from '../../../src/review-workflow-git/local-git-repository.js';
import { ReviewWorkflowGitService } from '../../../src/review-workflow-git/service.js';
import {
  type GitPatchArtifact,
  type GitPatchArtifactSink,
  ReviewWorkflowGitError,
} from '../../../src/review-workflow-git/types.js';
import { transitionBatch } from '../../../src/review-workflow/state-machine.js';
import type {
  ActorExecutionIdentity,
  AgentAssignment,
  ImplementationAttempt,
  ImplementationReadyEvidence,
} from '../../../src/review-workflow/types.js';

const NOW = new Date('2026-07-29T00:00:00.000Z');

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

class MemoryPatchSink implements GitPatchArtifactSink {
  readonly artifacts: GitPatchArtifact[] = [];

  storePatch(artifact: GitPatchArtifact): string {
    this.artifacts.push(artifact);
    return `memory://patch/${this.artifacts.length}/${artifact.patchHash}`;
  }
}

function expectGitError(operation: () => unknown, expectedCode: string): void {
  try {
    operation();
    throw new Error(`Expected ${expectedCode}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewWorkflowGitError);
    if (!(error instanceof ReviewWorkflowGitError)) throw error;
    expect(error.code).toBe(expectedCode);
  }
}

describe('ReviewWorkflowGitService', () => {
  let repositoryRoot: string;
  let baseSha: string;
  let implementationSha: string;
  let repository: LocalGitRepository;
  let patchSink: MemoryPatchSink;
  let service: ReviewWorkflowGitService;
  let implementerAssignment: AgentAssignment;
  let implementer: ActorExecutionIdentity;
  let humanCommitCreator: ActorExecutionIdentity;
  let attempt: ImplementationAttempt;
  let readyEvidence: ImplementationReadyEvidence;

  beforeEach(() => {
    repositoryRoot = mkdtempSync(join(tmpdir(), 'codemoot-review-service-'));
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.name', 'CodeMoot Test']);
    git(repositoryRoot, ['config', 'user.email', 'codemoot@example.com']);
    baseSha = commitFile(repositoryRoot, 'src/example.txt', 'base\n', 'base');
    implementationSha = commitFile(
      repositoryRoot,
      'src/example.txt',
      'implementation\n',
      'implementation',
    );
    repository = new LocalGitRepository(repositoryRoot);
    patchSink = new MemoryPatchSink();
    service = new ReviewWorkflowGitService(repository, patchSink, () => NOW);

    implementerAssignment = {
      assignmentId: 'assignment-implementer',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      assignedRole: 'IMPLEMENTER',
      configuredAgentKey: 'implementer',
      configuredModelAlias: 'codex',
      expectedAdapterKind: 'CODEX',
      provider: 'openai',
      configuredModel: 'gpt-5',
      commitPermission: 'AUTHORIZED',
      configurationHash: 'configuration-hash',
      assignedAt: NOW.toISOString(),
    };
    implementer = {
      actorExecutionId: 'actor-implementer',
      actorType: 'AGENT',
      assignmentId: implementerAssignment.assignmentId,
      authoritiesExercised: ['IMPLEMENTER', 'COMMIT_CREATOR'],
      identityAssurance: 'CLI_ASSERTED',
      observedEvidence: [],
      startedAt: NOW.toISOString(),
    };
    humanCommitCreator = {
      actorExecutionId: 'actor-human-commit-creator',
      actorType: 'HUMAN',
      authoritiesExercised: ['COMMIT_CREATOR'],
      identityAssurance: 'CLI_ASSERTED',
      observedEvidence: [],
      startedAt: NOW.toISOString(),
    };
    attempt = {
      implementationAttemptId: 'attempt-1',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      attemptNumber: 1,
      approvedPlanVersionId: 'batch-plan-1',
      approvedPlanContentHash: 'batch-plan-hash',
      originalBatchBaseSha: baseSha,
      startingHeadSha: baseSha,
      implementerAssignmentId: implementerAssignment.assignmentId,
      implementerActorExecutionId: implementer.actorExecutionId,
      summary: 'Implement the approved batch.',
      claimedChangedFiles: ['src/example.txt'],
      claimedVerificationRecordIds: [],
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
    };
    readyEvidence = {
      implementationReadyEvidenceId: 'ready-1',
      implementationAttemptId: attempt.implementationAttemptId,
      actorExecutionId: implementer.actorExecutionId,
      worktreeFingerprint: 'ready-worktree-fingerprint',
      changedFiles: ['src/example.txt'],
      summary: 'Implementation is committed and ready for validation.',
      capturedAt: NOW.toISOString(),
    };
  });

  afterEach(() => {
    rmSync(repositoryRoot, { recursive: true, force: true });
  });

  it('assembles an honest repository audit from fresh Git reads', () => {
    writeFileSync(join(repositoryRoot, 'untracked.txt'), 'untracked\n');

    const audit = service.captureRepositoryAudit({
      repositoryAuditId: 'audit-1',
      workflowId: 'workflow-1',
      actorExecutionId: humanCommitCreator.actorExecutionId,
    });

    expect(audit).toMatchObject({
      repositoryRoot,
      branch: 'main',
      headSha: implementationSha,
      dirty: true,
      actorExecutionId: humanCommitCreator.actorExecutionId,
      observedAt: NOW.toISOString(),
    });
    expect(audit.evidence).toHaveLength(2);
    expect(audit.evidence[1]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validates an agent-authorized implementation commit from repository facts', () => {
    const result = service.validateImplementationCommit({
      attempt,
      implementationReadyEvidence: readyEvidence,
      providedCommitSha: implementationSha,
      creator: implementer,
      implementerAssignment,
      commitPolicy: 'AGENT_AUTHORIZED',
      creationMode: 'AGENT_AUTHORIZED',
    });

    expect(result.implementationCommit).toMatchObject({
      implementationAttemptId: attempt.implementationAttemptId,
      implementationReadyEvidenceId: readyEvidence.implementationReadyEvidenceId,
      resultingCommitSha: implementationSha,
      creatorActorExecutionId: implementer.actorExecutionId,
      creationMode: 'AGENT_AUTHORIZED',
      cleanWorktreeValidation: { valid: true },
      ancestryValidation: { valid: true },
      validatedAt: NOW.toISOString(),
    });
    expect(result.implementationCommit.parentShas).toContain(baseSha);
    expect(result.transitionEvidence).toMatchObject({
      providedCommitSha: implementationSha,
      resultingCommitSha: implementationSha,
      currentHeadSha: implementationSha,
      cleanWorktree: true,
      ancestryValid: true,
    });
    expect(
      transitionBatch({
        currentState: 'AWAITING_COMMIT',
        command: { type: 'COMPLETE_IMPLEMENTATION', evidence: result.transitionEvidence },
        actor: implementer,
      }),
    ).toMatchObject({
      allowed: true,
      previousState: 'AWAITING_COMMIT',
      nextState: 'IMPLEMENTATION_COMPLETE',
    });
  });

  it('supports a distinct human commit creator without changing the implementer', () => {
    const result = service.validateImplementationCommit({
      attempt,
      implementationReadyEvidence: readyEvidence,
      providedCommitSha: implementationSha,
      creator: humanCommitCreator,
      implementerAssignment,
      commitPolicy: 'EITHER',
      creationMode: 'HUMAN_CREATED',
    });

    expect(result.implementationCommit.creatorActorExecutionId).toBe(
      humanCommitCreator.actorExecutionId,
    );
    expect(result.implementationCommit.creationMode).toBe('HUMAN_CREATED');
    expect(result.implementationCommit.implementationAttemptId).toBe(
      attempt.implementationAttemptId,
    );
  });

  it('rejects unauthorized, dirty, stale, and mismatched commit validation', () => {
    expectGitError(
      () =>
        service.validateImplementationCommit({
          attempt,
          implementationReadyEvidence: readyEvidence,
          providedCommitSha: implementationSha,
          creator: implementer,
          implementerAssignment,
          commitPolicy: 'HUMAN_REQUIRED',
          creationMode: 'AGENT_AUTHORIZED',
        }),
      'COMMIT_POLICY_DENIED',
    );

    expectGitError(
      () =>
        service.validateImplementationCommit({
          attempt,
          implementationReadyEvidence: {
            ...readyEvidence,
            implementationAttemptId: 'different-attempt',
          },
          providedCommitSha: implementationSha,
          creator: implementer,
          implementerAssignment,
          commitPolicy: 'AGENT_AUTHORIZED',
          creationMode: 'AGENT_AUTHORIZED',
        }),
      'ATTEMPT_MISMATCH',
    );

    const noChangeAttempt: ImplementationAttempt = {
      ...attempt,
      originalBatchBaseSha: implementationSha,
      startingHeadSha: implementationSha,
    };
    expectGitError(
      () =>
        service.validateImplementationCommit({
          attempt: noChangeAttempt,
          implementationReadyEvidence: readyEvidence,
          providedCommitSha: implementationSha,
          creator: implementer,
          implementerAssignment,
          commitPolicy: 'AGENT_AUTHORIZED',
          creationMode: 'AGENT_AUTHORIZED',
        }),
      'NO_IMPLEMENTATION_CHANGE',
    );

    const implementationTreeSha = git(repositoryRoot, ['rev-parse', `${implementationSha}^{tree}`]);
    const unrelatedSha = git(repositoryRoot, [
      'commit-tree',
      implementationTreeSha,
      '-m',
      'unrelated',
    ]);
    expectGitError(
      () =>
        service.validateImplementationCommit({
          attempt: { ...attempt, startingHeadSha: unrelatedSha },
          implementationReadyEvidence: readyEvidence,
          providedCommitSha: implementationSha,
          creator: implementer,
          implementerAssignment,
          commitPolicy: 'AGENT_AUTHORIZED',
          creationMode: 'AGENT_AUTHORIZED',
        }),
      'ANCESTRY_INVALID',
    );

    writeFileSync(join(repositoryRoot, 'dirty.txt'), 'dirty\n');
    expectGitError(
      () =>
        service.validateImplementationCommit({
          attempt,
          implementationReadyEvidence: readyEvidence,
          providedCommitSha: implementationSha,
          creator: implementer,
          implementerAssignment,
          commitPolicy: 'AGENT_AUTHORIZED',
          creationMode: 'AGENT_AUTHORIZED',
        }),
      'DIRTY_WORKTREE',
    );
    rmSync(join(repositoryRoot, 'dirty.txt'));

    const laterSha = commitFile(repositoryRoot, 'src/later.txt', 'later\n', 'later');
    expect(laterSha).not.toBe(implementationSha);
    expectGitError(
      () =>
        service.validateImplementationCommit({
          attempt,
          implementationReadyEvidence: readyEvidence,
          providedCommitSha: implementationSha,
          creator: implementer,
          implementerAssignment,
          commitPolicy: 'AGENT_AUTHORIZED',
          creationMode: 'AGENT_AUTHORIZED',
        }),
      'HEAD_MISMATCH',
    );
  });

  it('captures exact initial and correction review ranges', () => {
    const initial = service.captureReviewRange({
      kind: 'INITIAL',
      originalBatchBaseSha: baseSha,
      currentImplementationSha: implementationSha,
    });

    expect(initial.evidence.vocabulary).toEqual({
      originalBatchBaseSha: baseSha,
      previousReviewedImplementationSha: baseSha,
      currentImplementationSha: implementationSha,
      currentBranchHeadSha: implementationSha,
    });
    expect(initial.evidence.ranges).toEqual([
      { kind: 'INITIAL', fromSha: baseSha, toSha: implementationSha },
    ]);
    expect(initial.cumulativePatch.arguments).toEqual([
      'diff',
      '--binary',
      '--full-index',
      '--find-renames',
      baseSha,
      implementationSha,
      '--',
    ]);
    expect(initial.evidence.incrementalPatchLocation).toBe(
      initial.evidence.cumulativePatchLocation,
    );

    const correctionSha = commitFile(
      repositoryRoot,
      'src/example.txt',
      'corrected\n',
      'correction',
    );
    const correction = service.captureReviewRange({
      kind: 'CORRECTION',
      originalBatchBaseSha: baseSha,
      previousReviewedImplementationSha: implementationSha,
      currentImplementationSha: correctionSha,
    });

    expect(correction.evidence.ranges).toEqual([
      { kind: 'CUMULATIVE', fromSha: baseSha, toSha: correctionSha },
      {
        kind: 'INCREMENTAL_CORRECTION',
        fromSha: implementationSha,
        toSha: correctionSha,
      },
    ]);
    expect(correction.incrementalPatch?.arguments).toEqual([
      'diff',
      '--binary',
      '--full-index',
      '--find-renames',
      implementationSha,
      correctionSha,
      '--',
    ]);
    expect(patchSink.artifacts.map((artifact) => artifact.kind)).toEqual([
      'CUMULATIVE',
      'CUMULATIVE',
      'INCREMENTAL_CORRECTION',
    ]);
  });

  it('recomputes and binds the final gate to HEAD and the accepted cumulative hash', () => {
    const accepted = service.captureReviewRange({
      kind: 'INITIAL',
      originalBatchBaseSha: baseSha,
      currentImplementationSha: implementationSha,
    });
    const finalGate = service.captureReviewRange({
      kind: 'FINAL_GATE',
      originalBatchBaseSha: baseSha,
      previousReviewedImplementationSha: implementationSha,
      currentImplementationSha: implementationSha,
      acceptedCumulativePatchHash: accepted.evidence.patchHash,
    });

    expect(finalGate.evidence.ranges).toEqual([
      {
        kind: 'FINAL_GATE',
        fromSha: baseSha,
        toSha: implementationSha,
        implementationToHeadIsEmpty: true,
      },
    ]);
    expect(finalGate.incrementalPatch).toMatchObject({
      fromSha: implementationSha,
      toSha: implementationSha,
      patch: '',
      changedFiles: [],
    });

    expectGitError(
      () =>
        service.captureReviewRange({
          kind: 'FINAL_GATE',
          originalBatchBaseSha: baseSha,
          previousReviewedImplementationSha: implementationSha,
          currentImplementationSha: implementationSha,
          acceptedCumulativePatchHash: 'different-patch-hash',
        }),
      'PATCH_HASH_MISMATCH',
    );

    commitFile(repositoryRoot, 'src/after-review.txt', 'changed\n', 'after review');
    const artifactCount = patchSink.artifacts.length;
    expectGitError(
      () =>
        service.captureReviewRange({
          kind: 'FINAL_GATE',
          originalBatchBaseSha: baseSha,
          previousReviewedImplementationSha: implementationSha,
          currentImplementationSha: implementationSha,
          acceptedCumulativePatchHash: accepted.evidence.patchHash,
        }),
      'HEAD_MISMATCH',
    );
    expect(patchSink.artifacts).toHaveLength(artifactCount);
  });

  it('blocks dirty review evidence before writing any patch artifact', () => {
    writeFileSync(join(repositoryRoot, 'dirty.txt'), 'dirty\n');

    expectGitError(
      () =>
        service.captureReviewRange({
          kind: 'INITIAL',
          originalBatchBaseSha: baseSha,
          currentImplementationSha: implementationSha,
        }),
      'DIRTY_WORKTREE',
    );
    expect(patchSink.artifacts).toEqual([]);
  });

  it('calculates effective approval from a fresh repository HEAD', () => {
    expect(
      service.readEffectiveApproval({
        persistedState: 'APPROVED_FOR_MERGE',
        persistedApprovalSha: implementationSha,
        invalidationPersisted: false,
      }),
    ).toMatchObject({
      persistedState: 'APPROVED_FOR_MERGE',
      effectiveState: 'APPROVED_FOR_MERGE',
      approvalValid: true,
      currentHeadSha: implementationSha,
      observedAt: NOW.toISOString(),
    });

    const changedHeadSha = commitFile(repositoryRoot, 'src/new-head.txt', 'new head\n', 'new head');
    expect(
      service.readEffectiveApproval({
        persistedState: 'APPROVED_FOR_MERGE',
        persistedApprovalSha: implementationSha,
        invalidationPersisted: false,
      }),
    ).toMatchObject({
      persistedState: 'APPROVED_FOR_MERGE',
      effectiveState: 'APPROVAL_STALE',
      approvalValid: false,
      persistedApprovalSha: implementationSha,
      currentHeadSha: changedHeadSha,
      invalidationPersisted: false,
    });
  });
});
