// Honest evidence assembly from fresh repository reads.

import {
  actorExecutionIdentitySchema,
  agentAssignmentSchema,
  approvalValidityInputSchema,
  contentHashSchema,
  gitShaSchema,
  implementationAttemptSchema,
  implementationCommitSchema,
  implementationReadyEvidenceSchema,
  repositoryAuditSchema,
  reviewRangeEvidenceSchema,
} from '../review-workflow/schemas.js';
import { calculateEffectiveBatchState } from '../review-workflow/state-machine.js';
import type {
  ActorExecutionIdentity,
  AgentAssignment,
  GitReviewRange,
  GitSha,
  ImplementationCommit,
  ReviewRangeEvidence,
} from '../review-workflow/types.js';
import {
  type CapturedReviewRange,
  type EffectiveApprovalRequest,
  type EffectiveApprovalSnapshot,
  type GitDiffSnapshot,
  type GitPatchArtifactKind,
  type GitPatchArtifactSink,
  type GitRepository,
  type GitWorktreeSnapshot,
  type ImplementationCommitValidationRequest,
  type RepositoryAuditRequest,
  type ReviewRangeCaptureRequest,
  ReviewWorkflowGitError,
  type ValidatedImplementationCommit,
} from './types.js';

type Clock = () => Date;

function requireCommitCreatorAuthority(actor: ActorExecutionIdentity): void {
  if (!actor.authoritiesExercised.includes('COMMIT_CREATOR')) {
    throw new ReviewWorkflowGitError(
      'ACTOR_NOT_ALLOWED',
      `Actor ${actor.actorExecutionId} does not exercise COMMIT_CREATOR authority`,
    );
  }
}

function ensureCommitPermission(
  creator: ActorExecutionIdentity,
  implementerAssignment: AgentAssignment,
  request: ImplementationCommitValidationRequest,
): void {
  requireCommitCreatorAuthority(creator);

  if (request.creationMode === 'AGENT_AUTHORIZED') {
    if (
      creator.actorType !== 'AGENT' ||
      creator.assignmentId !== implementerAssignment.assignmentId ||
      creator.actorExecutionId !== request.attempt.implementerActorExecutionId ||
      implementerAssignment.assignedRole !== 'IMPLEMENTER'
    ) {
      throw new ReviewWorkflowGitError(
        'ACTOR_NOT_ALLOWED',
        'An agent-created commit must come from the assigned implementer execution',
      );
    }
    if (
      request.commitPolicy === 'HUMAN_REQUIRED' ||
      implementerAssignment.commitPermission !== 'AUTHORIZED'
    ) {
      throw new ReviewWorkflowGitError(
        'COMMIT_POLICY_DENIED',
        'The assigned implementer agent is not authorized to create this commit',
      );
    }
    return;
  }

  if (creator.actorType !== 'HUMAN') {
    throw new ReviewWorkflowGitError(
      'ACTOR_NOT_ALLOWED',
      'A human-created commit requires a human COMMIT_CREATOR',
    );
  }
  if (request.commitPolicy === 'AGENT_AUTHORIZED') {
    throw new ReviewWorkflowGitError(
      'COMMIT_POLICY_DENIED',
      'Workflow commit policy does not allow a human-created commit',
    );
  }
}

function assertStableWorktree(before: GitWorktreeSnapshot, after: GitWorktreeSnapshot): void {
  if (
    before.headSha !== after.headSha ||
    before.worktreeFingerprint !== after.worktreeFingerprint ||
    before.clean !== after.clean
  ) {
    throw new ReviewWorkflowGitError(
      'REPOSITORY_CHANGED_DURING_READ',
      'Repository HEAD or worktree changed while review evidence was being assembled',
    );
  }
}

function requireCleanHead(snapshot: GitWorktreeSnapshot, expectedHeadSha: GitSha): void {
  if (snapshot.headSha !== expectedHeadSha) {
    throw new ReviewWorkflowGitError(
      'HEAD_MISMATCH',
      `Expected repository HEAD ${expectedHeadSha}, observed ${snapshot.headSha}`,
    );
  }
  if (!snapshot.clean) {
    throw new ReviewWorkflowGitError(
      'DIRTY_WORKTREE',
      'Review workflow Git evidence requires a clean worktree and index',
    );
  }
}

function requireAncestry(
  repository: GitRepository,
  ancestorSha: GitSha,
  descendantSha: GitSha,
  description: string,
): void {
  if (!repository.isAncestor(ancestorSha, descendantSha)) {
    throw new ReviewWorkflowGitError(
      'ANCESTRY_INVALID',
      `${description}: ${ancestorSha} is not an ancestor of ${descendantSha}`,
    );
  }
}

function storePatch(
  sink: GitPatchArtifactSink,
  kind: GitPatchArtifactKind,
  snapshot: GitDiffSnapshot,
): string {
  const location = sink.storePatch({
    kind,
    fromSha: snapshot.fromSha,
    toSha: snapshot.toSha,
    arguments: snapshot.arguments,
    patch: snapshot.patch,
    patchHash: snapshot.patchHash,
  });
  if (location.length === 0) {
    throw new ReviewWorkflowGitError(
      'PATCH_ARTIFACT_INVALID',
      `Patch artifact sink returned an empty location for ${kind}`,
    );
  }
  return location;
}

export class ReviewWorkflowGitService {
  constructor(
    private readonly repository: GitRepository,
    private readonly patchArtifactSink: GitPatchArtifactSink,
    private readonly clock: Clock = () => new Date(),
  ) {}

  captureRepositoryAudit(request: RepositoryAuditRequest) {
    const snapshot = this.repository.readWorktree();
    return repositoryAuditSchema.parse({
      repositoryAuditId: request.repositoryAuditId,
      workflowId: request.workflowId,
      repositoryRoot: this.repository.repositoryRoot,
      branch: snapshot.branch,
      headSha: snapshot.headSha,
      dirty: !snapshot.clean,
      evidence: [
        {
          kind: 'COMMAND',
          location: this.repository.repositoryRoot,
          description: 'Fresh Git HEAD and branch read from the repository',
        },
        {
          kind: 'COMMAND',
          location: this.repository.repositoryRoot,
          description: 'Git porcelain status including untracked files',
          contentHash: snapshot.worktreeFingerprint,
        },
      ],
      actorExecutionId: request.actorExecutionId,
      observedAt: this.timestamp(),
    });
  }

  validateImplementationCommit(
    input: ImplementationCommitValidationRequest,
  ): ValidatedImplementationCommit {
    const attempt = implementationAttemptSchema.parse(input.attempt);
    const readyEvidence = implementationReadyEvidenceSchema.parse(
      input.implementationReadyEvidence,
    );
    const creator = actorExecutionIdentitySchema.parse(input.creator);
    const implementerAssignment = agentAssignmentSchema.parse(input.implementerAssignment);
    const providedCommitSha = gitShaSchema.parse(input.providedCommitSha);

    if (
      readyEvidence.implementationAttemptId !== attempt.implementationAttemptId ||
      readyEvidence.actorExecutionId !== attempt.implementerActorExecutionId ||
      implementerAssignment.assignmentId !== attempt.implementerAssignmentId ||
      implementerAssignment.workflowId !== attempt.workflowId ||
      (implementerAssignment.batchId !== undefined &&
        implementerAssignment.batchId !== attempt.batchId)
    ) {
      throw new ReviewWorkflowGitError(
        'ATTEMPT_MISMATCH',
        'Implementation attempt, ready evidence, and implementer assignment do not match',
      );
    }

    ensureCommitPermission(creator, implementerAssignment, {
      ...input,
      attempt,
      implementationReadyEvidence: readyEvidence,
      creator,
      implementerAssignment,
      providedCommitSha,
    });

    const before = this.repository.readWorktree();
    requireCleanHead(before, providedCommitSha);
    const commit = this.repository.readCommit(providedCommitSha);
    if (commit.sha !== providedCommitSha) {
      throw new ReviewWorkflowGitError(
        'HEAD_MISMATCH',
        `Provided commit ${providedCommitSha} resolved to ${commit.sha}`,
      );
    }
    if (commit.parentShas.length === 0) {
      throw new ReviewWorkflowGitError(
        'ANCESTRY_INVALID',
        'An implementation commit must have at least one parent',
      );
    }

    requireAncestry(
      this.repository,
      attempt.originalBatchBaseSha,
      commit.sha,
      'Original batch base ancestry is invalid',
    );
    requireAncestry(
      this.repository,
      attempt.startingHeadSha,
      commit.sha,
      'Implementation attempt lineage is invalid',
    );
    if (commit.sha === attempt.originalBatchBaseSha) {
      throw new ReviewWorkflowGitError(
        'NO_IMPLEMENTATION_CHANGE',
        'Implementation completion requires a commit after the original batch base',
      );
    }

    const after = this.repository.readWorktree();
    assertStableWorktree(before, after);
    const validatedAt = this.timestamp();
    const implementationCommit: ImplementationCommit = implementationCommitSchema.parse({
      implementationAttemptId: attempt.implementationAttemptId,
      implementationReadyEvidenceId: readyEvidence.implementationReadyEvidenceId,
      resultingCommitSha: commit.sha,
      parentShas: commit.parentShas,
      treeSha: commit.treeSha,
      creatorActorExecutionId: creator.actorExecutionId,
      creationMode: input.creationMode,
      gitAuthor: commit.author,
      gitCommitter: commit.committer,
      cleanWorktreeValidation: {
        valid: true,
        evidence: [
          `git status --porcelain=v1 -z --untracked-files=all -- was clean at ${commit.sha}`,
        ],
      },
      ancestryValidation: {
        valid: true,
        evidence: [
          `${attempt.originalBatchBaseSha} is an ancestor of ${commit.sha}`,
          `${attempt.startingHeadSha} is an ancestor of ${commit.sha}`,
        ],
      },
      validatedAt,
    });

    return {
      implementationCommit,
      transitionEvidence: {
        commitPolicy: input.commitPolicy,
        creationMode: input.creationMode,
        implementerAssignment,
        providedCommitSha,
        resultingCommitSha: commit.sha,
        currentHeadSha: after.headSha,
        cleanWorktree: after.clean,
        ancestryValid: true,
      },
    };
  }

  captureReviewRange(input: ReviewRangeCaptureRequest): CapturedReviewRange {
    const originalBatchBaseSha = gitShaSchema.parse(input.originalBatchBaseSha);
    const currentImplementationSha = gitShaSchema.parse(input.currentImplementationSha);
    const acceptedCumulativePatchHash =
      input.kind === 'FINAL_GATE'
        ? contentHashSchema.parse(input.acceptedCumulativePatchHash)
        : undefined;
    const previousReviewedImplementationSha =
      input.kind === 'INITIAL'
        ? originalBatchBaseSha
        : gitShaSchema.parse(input.previousReviewedImplementationSha);

    const before = this.repository.readWorktree();
    requireCleanHead(before, currentImplementationSha);
    requireAncestry(
      this.repository,
      originalBatchBaseSha,
      currentImplementationSha,
      'Cumulative review range is invalid',
    );
    requireAncestry(
      this.repository,
      previousReviewedImplementationSha,
      currentImplementationSha,
      'Incremental review range is invalid',
    );

    const cumulativePatch = this.repository.readDiff(
      originalBatchBaseSha,
      currentImplementationSha,
    );
    let incrementalPatch: GitDiffSnapshot | undefined;
    let ranges: readonly GitReviewRange[];

    if (input.kind === 'INITIAL') {
      ranges = [
        {
          kind: 'INITIAL',
          fromSha: originalBatchBaseSha,
          toSha: currentImplementationSha,
        },
      ];
    } else if (input.kind === 'CORRECTION') {
      incrementalPatch = this.repository.readDiff(
        previousReviewedImplementationSha,
        currentImplementationSha,
      );
      ranges = [
        {
          kind: 'CUMULATIVE',
          fromSha: originalBatchBaseSha,
          toSha: currentImplementationSha,
        },
        {
          kind: 'INCREMENTAL_CORRECTION',
          fromSha: previousReviewedImplementationSha,
          toSha: currentImplementationSha,
        },
      ];
    } else {
      incrementalPatch = this.repository.readDiff(currentImplementationSha, before.headSha);
      if (
        incrementalPatch.patch.length !== 0 ||
        incrementalPatch.changedFiles.length !== 0 ||
        currentImplementationSha !== before.headSha
      ) {
        throw new ReviewWorkflowGitError(
          'HEAD_MISMATCH',
          'Final gate requires the implementation commit to equal HEAD with an empty I..H diff',
        );
      }
      if (cumulativePatch.patchHash !== acceptedCumulativePatchHash) {
        throw new ReviewWorkflowGitError(
          'PATCH_HASH_MISMATCH',
          'Final cumulative patch hash differs from the latest accepted code-review hash',
        );
      }
      ranges = [
        {
          kind: 'FINAL_GATE',
          fromSha: originalBatchBaseSha,
          toSha: before.headSha,
          implementationToHeadIsEmpty: true,
        },
      ];
    }

    const after = this.repository.readWorktree();
    assertStableWorktree(before, after);

    const cumulativePatchLocation = storePatch(
      this.patchArtifactSink,
      'CUMULATIVE',
      cumulativePatch,
    );
    const incrementalPatchLocation =
      incrementalPatch === undefined
        ? cumulativePatchLocation
        : storePatch(
            this.patchArtifactSink,
            input.kind === 'FINAL_GATE' ? 'IMPLEMENTATION_TO_HEAD' : 'INCREMENTAL_CORRECTION',
            incrementalPatch,
          );

    const evidence: ReviewRangeEvidence = reviewRangeEvidenceSchema.parse({
      vocabulary: {
        originalBatchBaseSha,
        previousReviewedImplementationSha,
        currentImplementationSha,
        currentBranchHeadSha: after.headSha,
      },
      ranges,
      patchHash: cumulativePatch.patchHash,
      changedFiles: cumulativePatch.changedFiles,
      cumulativePatchLocation,
      incrementalPatchLocation,
      capturedAt: this.timestamp(),
    });

    return {
      evidence,
      cumulativePatch,
      ...(incrementalPatch === undefined ? {} : { incrementalPatch }),
    };
  }

  readEffectiveApproval(input: EffectiveApprovalRequest): EffectiveApprovalSnapshot {
    const startingHeadSha = this.repository.readHeadSha();
    const effective = calculateEffectiveBatchState(
      approvalValidityInputSchema.parse({
        persistedState: input.persistedState,
        ...(input.persistedApprovalSha === undefined
          ? {}
          : { persistedApprovalSha: input.persistedApprovalSha }),
        currentHeadSha: startingHeadSha,
        invalidationPersisted: input.invalidationPersisted,
      }),
    );
    const endingHeadSha = this.repository.readHeadSha();
    if (startingHeadSha !== endingHeadSha) {
      throw new ReviewWorkflowGitError(
        'REPOSITORY_CHANGED_DURING_READ',
        `Repository HEAD changed from ${startingHeadSha} to ${endingHeadSha} during approval read`,
      );
    }
    return {
      ...effective,
      ...(input.persistedApprovalSha === undefined
        ? {}
        : { persistedApprovalSha: input.persistedApprovalSha }),
      currentHeadSha: endingHeadSha,
      invalidationPersisted: input.invalidationPersisted,
      observedAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.clock().toISOString();
  }
}
