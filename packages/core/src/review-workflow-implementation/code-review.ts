// Bounded code-review rounds, dispositions, and pacing enforcement for one batch.

import { createHash } from 'node:crypto';
import type { ReviewWorkflowCommandStore } from '../memory/review-workflow-command-store.js';
import type {
  DispositionCaptureValue,
  HandoffCaptureContext,
  HandoffCaptureResult,
  ReviewCaptureValue,
  ReviewWorkflowContractService,
  StructuredReview,
} from '../review-workflow-contracts/index.js';
import type { GitRepository, ReviewWorkflowGitService } from '../review-workflow-git/index.js';
import {
  type ReviewWorkflowConfigurationSnapshot,
  reviewWorkflowConfigurationSnapshotSchema,
} from '../review-workflow-identity/index.js';
import { transitionBatch } from '../review-workflow/state-machine.js';
import type {
  ActorExecutionIdentity,
  AllowedTransition,
  Finding,
  ReviewWorkflowBatch,
  RoleSeparationEvidence,
  StateChangingCommandRequest,
  TransitionCommand,
} from '../review-workflow/types.js';
import { type RoleInvocationError, isSessionContinuityError } from '../roles/role-invocation.js';
import type {
  PreparedRoleInvocation,
  RoleInvocationInput,
  RoleInvocationService,
} from '../roles/role-invocation.js';
import type { ResolvedRoleAdapter } from '../roles/role-manager.js';
import type { ReviewWorkflowImplementationStore } from './store.js';
import { ReviewWorkflowImplementationError } from './types.js';

interface RoleInvoker {
  prepare(input: RoleInvocationInput): Promise<PreparedRoleInvocation>;
  persistPrepared(prepared: PreparedRoleInvocation): void;
}

type Clock = () => Date;

export interface CodeReviewPromptEvidence {
  readonly round: number;
  readonly target: {
    readonly kind: 'CODE';
    readonly reviewedCommitSha: string;
    readonly repositoryContextSha: string;
    readonly reviewRangeEvidenceId: string;
    readonly patchHash: string;
  };
  readonly vocabulary: {
    readonly originalBatchBaseSha: string;
    readonly previousReviewedImplementationSha: string;
    readonly currentImplementationSha: string;
    readonly currentBranchHeadSha: string;
  };
  readonly cumulativePatch: string;
  readonly cumulativePatchLocation: string;
  readonly incrementalPatch?: string;
  readonly incrementalPatchLocation?: string;
  readonly mergeBlockingCriterionIds: readonly string[];
  readonly previousBlockingFindings: readonly Finding[];
  readonly previousDispositions: readonly {
    readonly findingId: string;
    readonly disposition: string;
    readonly explanation: string;
    readonly filesChanged: readonly string[];
  }[];
}

export interface ReviewCodeInput {
  readonly workflowId: string;
  readonly batchId: string;
  readonly configuration: ReviewWorkflowConfigurationSnapshot;
  readonly resolution: ResolvedRoleAdapter;
  readonly commandId: string;
  readonly actorExecutionId: string;
  readonly invocationId: string;
  readonly sessionIdentityId: string;
  readonly previousSessionIdentityId?: string;
  readonly transcriptId: string;
  readonly reviewRoundId: string;
  readonly buildPrompt: (evidence: CodeReviewPromptEvidence) => string;
  readonly options?: RoleInvocationInput['options'];
}

export type ReviewCodeResult =
  | {
      readonly status: 'VERIFYING';
      readonly batch: ReviewWorkflowBatch;
      readonly round: number;
      readonly capture: HandoffCaptureResult<ReviewCaptureValue>;
      readonly blockingFindingCount: 0;
      readonly deferredFindingIds: readonly string[];
    }
  | {
      readonly status: 'NEEDS_REVISION';
      readonly batch: ReviewWorkflowBatch;
      readonly round: number;
      readonly capture: HandoffCaptureResult<ReviewCaptureValue>;
      readonly blockingFindingCount: number;
      readonly blockingFindingIds: readonly string[];
      readonly deferredFindingIds: readonly string[];
    }
  | {
      readonly status: 'HUMAN_DECISION_REQUIRED';
      readonly batch: ReviewWorkflowBatch;
      readonly round: number;
      readonly capture: HandoffCaptureResult<ReviewCaptureValue>;
      readonly blockingFindingCount: number;
      readonly blockingFindingIds: readonly string[];
      readonly deferredFindingIds: readonly string[];
    }
  | {
      readonly status: 'REJECTED';
      readonly batch: ReviewWorkflowBatch;
      readonly round: number;
      readonly capture: HandoffCaptureResult<ReviewCaptureValue>;
      readonly errorCode: string;
      readonly message: string;
    };

export interface SubmitDispositionsInput extends Omit<HandoffCaptureContext, 'actorExecutionId'> {
  readonly batchId: string;
  readonly configuration: ReviewWorkflowConfigurationSnapshot;
}

export function deriveReviewRangeEvidenceId(batchId: string, round: number): string {
  return `${batchId}:range:${round}`;
}

export function deriveCodeReviewRoundId(batchId: string, round: number): string {
  return `${batchId}:code-review:${round}`;
}

export class ReviewWorkflowCodeReviewService {
  constructor(
    private readonly store: ReviewWorkflowImplementationStore,
    private readonly commandStore: ReviewWorkflowCommandStore,
    private readonly contractService: ReviewWorkflowContractService,
    private readonly gitService: ReviewWorkflowGitService,
    private readonly repository: GitRepository,
    private readonly roleInvoker: RoleInvoker | RoleInvocationService,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /**
   * Runs one bounded code-review round.
   *
   * Round 1 is the complete initial review. Round 2 is the single bounded final review after
   * the one permitted correction pass; its blocking set is restricted to critical/high.
   * There is never a third round: an unresolved round-2 blocker escalates to a blocked batch
   * that only the human workflow owner may resume.
   */
  async review(input: ReviewCodeInput): Promise<ReviewCodeResult> {
    const context = this.requireContext(input.workflowId, input.batchId, input.configuration);
    this.requireReviewerResolution(input.resolution, context.configuration);
    this.requireState(context.batch, 'IMPLEMENTATION_COMPLETE');
    this.requireCommandAvailable(input.commandId);

    const priorRounds = this.store.listCodeReviews(input.batchId);
    const startedRounds = this.store
      .getEvents(input.batchId)
      .filter((event) => event.eventType === 'CODE_REVIEW_STARTED').length;
    const round = startedRounds + 1;
    const pacing = context.configuration.pacing;
    if (round > pacing.maxCodeReviewRounds) {
      throw new ReviewWorkflowImplementationError(
        'PACING_EXHAUSTED',
        `Batch ${input.batchId} has used all ${pacing.maxCodeReviewRounds} code-review rounds`,
      );
    }
    if (input.reviewRoundId !== deriveCodeReviewRoundId(input.batchId, round)) {
      throw new ReviewWorkflowImplementationError(
        'IMPLEMENTATION_EVIDENCE_MISMATCH',
        'Code-review round IDs must use the authoritative vocabulary',
      );
    }
    if (context.batch.originalBatchBaseSha === undefined) {
      throw new ReviewWorkflowImplementationError(
        'REPOSITORY_STATE_INVALID',
        'Code review cannot run before the original batch base SHA is established',
      );
    }
    const originalBatchBaseSha = context.batch.originalBatchBaseSha;
    const before = this.repository.readWorktree();
    const currentImplementationSha = before.headSha;
    const previousReview = priorRounds.find(
      (candidate) => candidate.reviewRoundNumber === startedRounds,
    );
    const previousBlockers =
      previousReview === undefined
        ? []
        : this.blockingFindingIdsOf(previousReview.findingIds, context, 1);
    if (round > 1) {
      this.requireDispositionsFor(previousBlockers, currentImplementationSha);
    }

    const captured = this.gitService.captureReviewRange(
      round === 1
        ? {
            kind: 'INITIAL',
            originalBatchBaseSha,
            currentImplementationSha,
          }
        : {
            kind: 'CORRECTION',
            originalBatchBaseSha,
            currentImplementationSha,
            previousReviewedImplementationSha: this.previousReviewedSha(
              previousReview,
              originalBatchBaseSha,
            ),
          },
    );
    const reviewRangeEvidenceId = deriveReviewRangeEvidenceId(input.batchId, round);
    const mergeBlockingCriterionIds = this.mergeBlockingCriterionIds(context);
    const promptEvidence: CodeReviewPromptEvidence = {
      round,
      target: {
        kind: 'CODE',
        reviewedCommitSha: currentImplementationSha,
        repositoryContextSha: currentImplementationSha,
        reviewRangeEvidenceId,
        patchHash: captured.evidence.patchHash,
      },
      vocabulary: captured.evidence.vocabulary,
      cumulativePatch: captured.cumulativePatch.patch,
      cumulativePatchLocation: captured.evidence.cumulativePatchLocation,
      ...(captured.incrementalPatch === undefined
        ? {}
        : {
            incrementalPatch: captured.incrementalPatch.patch,
            ...(captured.evidence.incrementalPatchLocation === undefined
              ? {}
              : { incrementalPatchLocation: captured.evidence.incrementalPatchLocation }),
          }),
      mergeBlockingCriterionIds,
      previousBlockingFindings: previousBlockers
        .map((findingId) => this.store.getFinding(findingId))
        .filter((finding): finding is Finding => finding !== null),
      previousDispositions: previousBlockers.flatMap((findingId) =>
        this.store.listDispositionsForFinding(findingId).map((disposition) => ({
          findingId: disposition.findingId,
          disposition: disposition.disposition,
          explanation: disposition.explanation,
          filesChanged: disposition.filesChanged,
        })),
      ),
    };

    // The batch role-session registry is authoritative for the reviewer session identity:
    // once bound, kernel evidence must name the bound session, never a caller-fresh one.
    const boundReviewerSession = this.store.workflowStore.getBatchRoleSession(
      input.batchId,
      'REVIEWER',
    );
    const roleSeparation = this.roleSeparation(
      context.configuration,
      boundReviewerSession?.sessionIdentityId ??
        input.previousSessionIdentityId ??
        input.sessionIdentityId,
    );
    const startCommand: TransitionCommand = {
      type: 'START_CODE_REVIEW',
      evidence: {
        reviewedCommitSha: currentImplementationSha,
        currentHeadSha: before.headSha,
        cleanWorktree: before.clean,
        unresolvedFindingCount: 0,
        incompleteDispositionCount: 0,
        roleSeparation,
      },
    };
    const request = this.commandRequest({
      commandId: input.commandId,
      workflowId: input.workflowId,
      batch: context.batch,
      requester: this.preInvocationRequester(input, boundReviewerSession?.sessionIdentityId),
      authorityExercised: 'REVIEWER',
      targetCommitSha: currentImplementationSha,
      command: startCommand,
    });
    this.commandStore.reserve(request, 'AGENT_INVOCATION');
    this.commandStore.claimSideEffect(input.commandId, input.invocationId);
    let prepared: PreparedRoleInvocation;
    try {
      prepared = await this.roleInvoker.prepare({
        resolution: input.resolution,
        workflowId: input.workflowId,
        commandId: input.commandId,
        actorExecutionId: input.actorExecutionId,
        invocationId: input.invocationId,
        sessionIdentityId: input.sessionIdentityId,
        prompt: input.buildPrompt(promptEvidence),
        ...(input.previousSessionIdentityId === undefined
          ? {}
          : { previousSessionIdentityId: input.previousSessionIdentityId }),
        sessionBinding: {
          batchId: input.batchId,
          role: 'REVIEWER',
          // Every round after the first must resume the initial reviewer session.
          expectExisting: round > 1,
        },
        ...(input.options === undefined ? {} : { options: input.options }),
      });
    } catch (error) {
      this.failInvocationCommand(input.commandId, 'AGENT_INVOCATION_FAILED', {
        message: error instanceof Error ? error.message : 'Reviewer invocation failed',
      });
      if (isSessionContinuityError(error)) {
        // Fail closed: broken reviewer-session continuity stops the batch for a human
        // decision — never a silent fallback to a fresh session. The escalation is
        // best-effort: it must never mask the typed continuity error.
        try {
          this.blockBatchForContinuityFailure(input.workflowId, input.batchId, error);
        } catch {
          // The typed error below remains the authoritative failure.
        }
      }
      throw error;
    }
    if (prepared.invocation.commandId !== input.commandId) {
      const failure = {
        code: 'INVOCATION_MISMATCH',
        message: 'Prepared invocation is not bound to the authoritative code-review command',
      };
      this.failInvocationCommand(input.commandId, failure.code, failure);
      throw new ReviewWorkflowImplementationError('INVOCATION_MISMATCH', failure.message);
    }
    this.roleInvoker.persistPrepared(prepared);
    const after = this.repository.readWorktree();
    const reviewerMutation =
      after.headSha !== before.headSha || after.worktreeFingerprint !== before.worktreeFingerprint;

    return this.store.runAtomically(() => {
      if (reviewerMutation) {
        const failure = {
          code: 'REVIEWER_MODIFIED_WORKTREE',
          message: 'The reviewer changed repository state during a read-only code review',
        };
        this.failInvocationCommand(input.commandId, failure.code, failure);
        return {
          status: 'REJECTED',
          batch: context.batch,
          round,
          capture: this.contractService.captureReviewRejection(
            this.captureContext(input, prepared),
            failure.message,
          ),
          errorCode: failure.code,
          message: failure.message,
        };
      }

      const existingRange = this.store.workflowStore.getEntity(
        'REVIEW_RANGE_EVIDENCE',
        reviewRangeEvidenceId,
      );
      if (existingRange === null) {
        this.store.workflowStore.saveEntity({
          kind: 'REVIEW_RANGE_EVIDENCE',
          reviewRangeEvidenceId,
          workflowId: input.workflowId,
          batchId: input.batchId,
          value: captured.evidence,
        });
      } else if (
        existingRange.kind !== 'REVIEW_RANGE_EVIDENCE' ||
        existingRange.value.patchHash !== captured.evidence.patchHash
      ) {
        throw new ReviewWorkflowImplementationError(
          'REPOSITORY_STATE_INVALID',
          `Review range ${reviewRangeEvidenceId} no longer matches its previously captured patch`,
        );
      }
      const isBlockingDraft = (draft: {
        readonly severity: Finding['severity'];
        readonly acceptanceCriterionId?: string;
      }): boolean =>
        this.isBlockingSeverity(draft.severity, draft.acceptanceCriterionId, {
          round,
          maxRounds: pacing.maxCodeReviewRounds,
          mergeBlockingCriterionIds,
        });
      const capture = this.contractService.captureReview({
        ...this.captureContext(input, prepared),
        batchId: input.batchId,
        reviewRoundId: input.reviewRoundId,
        reviewRoundNumber: round,
        expectedTarget: {
          kind: 'CODE',
          reviewedCommitSha: currentImplementationSha,
          repositoryContextSha: currentImplementationSha,
          reviewRangeEvidenceId,
          patchHash: captured.evidence.patchHash,
        },
        requiredVerdict: (contract) =>
          contract.findings.some((draft) => isBlockingDraft(draft)) ? 'NEEDS_REVISION' : 'APPROVED',
      });
      if (!capture.accepted) {
        this.failInvocationCommand(input.commandId, capture.error.code, capture.error);
        return {
          status: 'REJECTED',
          batch: context.batch,
          round,
          capture,
          errorCode: capture.error.code,
          message: capture.error.message,
        };
      }

      const blockingFindings = capture.value.findings.filter(
        (finding) => finding.status === 'OPEN' && isBlockingDraft(finding),
      );
      const deferredFindingIds = capture.value.findings
        .filter((finding) => !isBlockingDraft(finding))
        .map((finding) => finding.findingId);

      const startTransition = requireAllowedTransition(
        context.batch.persistedState,
        startCommand,
        prepared.execution,
      );
      this.commandStore.succeedWithTransition({
        commandId: input.commandId,
        transition: startTransition,
        transitionActorExecutionId: prepared.execution.actorExecutionId,
        eventType: 'CODE_REVIEW_STARTED',
        eventPayload: {
          reviewRoundId: input.reviewRoundId,
          round,
          reviewRangeEvidenceId,
          patchHash: captured.evidence.patchHash,
        },
        resultHash: hashValue(capture.value.review),
        result: capture.value.review,
      });

      const current = this.requireBatch(input.batchId);
      if (round > 1) {
        this.decidePreviousDispositions({
          previousBlockers,
          approved: blockingFindings.length === 0,
          reviewerActorExecutionId: prepared.execution.actorExecutionId,
          reviewRoundId: input.reviewRoundId,
          currentImplementationSha,
        });
      }
      const incompleteDispositionCount =
        round > 1 && blockingFindings.length === 0
          ? this.pendingDispositionCount(previousBlockers, currentImplementationSha)
          : 0;
      const decisionEvidence = {
        reviewedCommitSha: currentImplementationSha,
        currentHeadSha: after.headSha,
        cleanWorktree: after.clean,
        unresolvedFindingCount: blockingFindings.length,
        incompleteDispositionCount,
        roleSeparation,
      };
      const decisionCommand: TransitionCommand =
        blockingFindings.length === 0
          ? { type: 'APPROVE_CODE_REVIEW', evidence: decisionEvidence }
          : { type: 'REJECT_CODE_REVIEW', evidence: decisionEvidence };
      const decisionCommandId = `${input.commandId}:decision`;
      this.commandStore.reserve(
        this.commandRequest({
          commandId: decisionCommandId,
          workflowId: input.workflowId,
          batch: current,
          requester: prepared.execution,
          authorityExercised: 'REVIEWER',
          targetCommitSha: currentImplementationSha,
          command: decisionCommand,
        }),
      );
      const decisionTransition = requireAllowedTransition(
        current.persistedState,
        decisionCommand,
        prepared.execution,
      );
      this.commandStore.succeedWithTransition({
        commandId: decisionCommandId,
        transition: decisionTransition,
        eventType:
          blockingFindings.length === 0 ? 'CODE_REVIEW_APPROVED' : 'CODE_REVIEW_NEEDS_REVISION',
        eventPayload: {
          reviewRoundId: input.reviewRoundId,
          round,
          blockingFindingCount: blockingFindings.length,
          deferredFindingIds,
        },
        resultHash: hashValue({
          reviewRoundId: input.reviewRoundId,
          state: decisionTransition.nextState,
        }),
      });

      if (blockingFindings.length === 0) {
        return {
          status: 'VERIFYING',
          batch: this.requireBatch(input.batchId),
          round,
          capture,
          blockingFindingCount: 0,
          deferredFindingIds,
        };
      }

      const blockingFindingIds = blockingFindings.map((finding) => finding.findingId);
      const successfulAttempts = this.store
        .getEvents(input.batchId)
        .filter((event) => event.eventType === 'IMPLEMENTATION_READY').length;
      const correctionAvailable =
        round < pacing.maxCodeReviewRounds && successfulAttempts < 1 + pacing.maxCorrectionPasses;
      if (correctionAvailable) {
        return {
          status: 'NEEDS_REVISION',
          batch: this.requireBatch(input.batchId),
          round,
          capture,
          blockingFindingCount: blockingFindings.length,
          blockingFindingIds,
          deferredFindingIds,
        };
      }

      const blockCommand: TransitionCommand = {
        type: 'BLOCK_BATCH',
        reason: 'REVIEW_ROUNDS_EXHAUSTED_HUMAN_DECISION_REQUIRED',
      };
      const blockCommandId = `${input.commandId}:human-decision`;
      const blocked = this.requireBatch(input.batchId);
      this.commandStore.reserve(
        this.commandRequest({
          commandId: blockCommandId,
          workflowId: input.workflowId,
          batch: blocked,
          requester: prepared.execution,
          authorityExercised: 'REVIEWER',
          command: blockCommand,
        }),
      );
      const blockTransition = requireAllowedTransition(
        blocked.persistedState,
        blockCommand,
        prepared.execution,
      );
      this.commandStore.succeedWithTransition({
        commandId: blockCommandId,
        transition: blockTransition,
        eventType: 'REVIEW_ROUNDS_EXHAUSTED',
        eventPayload: {
          reviewRoundId: input.reviewRoundId,
          round,
          blockingFindingIds,
        },
        resultHash: hashValue({ reviewRoundId: input.reviewRoundId, blockingFindingIds }),
      });
      return {
        status: 'HUMAN_DECISION_REQUIRED',
        batch: this.requireBatch(input.batchId),
        round,
        capture,
        blockingFindingCount: blockingFindings.length,
        blockingFindingIds,
        deferredFindingIds,
      };
    });
  }

  /**
   * Captures the implementer's one consolidated disposition result for the correction pass.
   * Coverage of every open blocking finding is enforced by the contract service; the result
   * target must be the corrected implementation commit.
   */
  submitDispositions(
    input: SubmitDispositionsInput,
  ): HandoffCaptureResult<DispositionCaptureValue> {
    const context = this.requireContext(input.workflowId, input.batchId, input.configuration);
    this.requireState(context.batch, 'IMPLEMENTATION_COMPLETE');
    const rounds = this.store.listCodeReviews(input.batchId);
    const lastReview = rounds.at(-1);
    if (lastReview === undefined) {
      throw new ReviewWorkflowImplementationError(
        'DISPOSITIONS_REQUIRED',
        'Dispositions can only respond to an existing code review',
      );
    }
    const expectedFindingIds = this.blockingFindingIdsOf(lastReview.findingIds, context, 1);
    if (expectedFindingIds.length === 0) {
      throw new ReviewWorkflowImplementationError(
        'DISPOSITIONS_REQUIRED',
        'The previous code review has no open blocking findings to disposition',
      );
    }
    const latestAttempt = this.store.listImplementationAttempts(input.batchId).at(-1);
    if (latestAttempt === undefined) {
      throw new ReviewWorkflowImplementationError(
        'DISPOSITIONS_REQUIRED',
        'Dispositions require a persisted implementation attempt to attribute',
      );
    }
    const head = this.repository.readHeadSha();
    // The author is always the persisted implementer execution of the latest attempt;
    // callers cannot attribute a response to anyone else.
    return this.contractService.captureDispositions({
      ...input,
      actorExecutionId: latestAttempt.implementerActorExecutionId,
      expectedTarget: { kind: 'CODE', resultingCommitSha: head },
      expectedFindingIds,
    });
  }

  private requireDispositionsFor(
    blockingFindingIds: readonly string[],
    currentImplementationSha: string,
  ): void {
    if (blockingFindingIds.length === 0) return;
    const missing = blockingFindingIds.filter(
      (findingId) =>
        !this.store
          .listDispositionsForFinding(findingId)
          .some(
            (disposition) =>
              disposition.resultTarget.kind === 'CODE' &&
              disposition.resultTarget.resultingCommitSha === currentImplementationSha,
          ),
    );
    if (missing.length > 0) {
      throw new ReviewWorkflowImplementationError(
        'DISPOSITIONS_REQUIRED',
        `The final review requires dispositions targeting the corrected commit for: ${missing.join(', ')}`,
      );
    }
  }

  private blockingFindingIdsOf(
    findingIds: readonly string[],
    context: {
      readonly configuration: ReviewWorkflowConfigurationSnapshot;
      readonly batch: ReviewWorkflowBatch;
    },
    round: number,
  ): readonly string[] {
    const mergeBlockingCriterionIds = this.mergeBlockingCriterionIds(context);
    return findingIds.filter((findingId) => {
      const finding = this.store.getFinding(findingId);
      return (
        finding !== null &&
        finding.status === 'OPEN' &&
        this.isBlockingSeverity(finding.severity, finding.acceptanceCriterionId, {
          round,
          maxRounds: context.configuration.pacing.maxCodeReviewRounds,
          mergeBlockingCriterionIds,
        })
      );
    });
  }

  /**
   * The pacing policy: critical/high always block; medium blocks only when it cites a
   * merge-blocking (required) criterion of the current approved plan; low/suggestion never
   * block. The bounded final round blocks on critical/high only.
   */
  private isBlockingSeverity(
    severity: Finding['severity'],
    acceptanceCriterionId: string | undefined,
    policy: {
      readonly round: number;
      readonly maxRounds: number;
      readonly mergeBlockingCriterionIds: readonly string[];
    },
  ): boolean {
    if (severity === 'critical' || severity === 'high') return true;
    if (policy.round >= policy.maxRounds) return false;
    return (
      severity === 'medium' &&
      acceptanceCriterionId !== undefined &&
      policy.mergeBlockingCriterionIds.includes(acceptanceCriterionId)
    );
  }

  private mergeBlockingCriterionIds(context: {
    readonly batch: ReviewWorkflowBatch;
  }): readonly string[] {
    return this.store
      .listAcceptanceCriteria(context.batch.currentPlanVersionId)
      .filter((criterion) => criterion.required)
      .map((criterion) => criterion.acceptanceCriterionId);
  }

  private decidePreviousDispositions(input: {
    readonly previousBlockers: readonly string[];
    readonly approved: boolean;
    readonly reviewerActorExecutionId: string;
    readonly reviewRoundId: string;
    readonly currentImplementationSha: string;
  }): void {
    for (const findingId of input.previousBlockers) {
      for (const disposition of this.store.listDispositionsForFinding(findingId)) {
        if (disposition.reviewerDecision.decision !== 'PENDING') continue;
        if (
          disposition.resultTarget.kind !== 'CODE' ||
          disposition.resultTarget.resultingCommitSha !== input.currentImplementationSha
        ) {
          continue;
        }
        this.store.workflowStore.decideDisposition({
          dispositionId: disposition.dispositionId,
          decision: input.approved ? 'ACCEPTED' : 'REJECTED',
          reviewerActorExecutionId: input.reviewerActorExecutionId,
          rationale: input.approved
            ? `Verified in bounded final review ${input.reviewRoundId}`
            : `Rejected by bounded final review ${input.reviewRoundId}`,
          decidedAt: this.timestamp(),
        });
      }
    }
  }

  private pendingDispositionCount(
    previousBlockers: readonly string[],
    currentImplementationSha: string,
  ): number {
    return previousBlockers.filter(
      (findingId) =>
        !this.store
          .listDispositionsForFinding(findingId)
          .some(
            (disposition) =>
              disposition.resultTarget.kind === 'CODE' &&
              disposition.resultTarget.resultingCommitSha === currentImplementationSha &&
              disposition.reviewerDecision.decision === 'ACCEPTED',
          ),
    ).length;
  }

  private preInvocationRequester(
    input: ReviewCodeInput,
    boundReviewerSessionIdentityId: string | undefined,
  ): ActorExecutionIdentity {
    return {
      actorExecutionId: `${input.commandId}:requester`,
      actorType: 'AGENT',
      assignmentId: input.configuration.assignments.reviewer.assignmentId,
      invocationIdentityId: input.invocationId,
      sessionIdentityId:
        boundReviewerSessionIdentityId ??
        input.previousSessionIdentityId ??
        input.sessionIdentityId,
      authoritiesExercised: ['REVIEWER'],
      identityAssurance: 'CONFIG_ONLY',
      observedEvidence: [],
      startedAt: this.timestamp(),
    };
  }

  private previousReviewedSha(
    previousReview: StructuredReview | undefined,
    fallback: string,
  ): string {
    if (previousReview !== undefined && previousReview.target.kind === 'CODE') {
      return previousReview.target.reviewedCommitSha;
    }
    return fallback;
  }

  private captureContext(
    input: ReviewCodeInput,
    prepared: PreparedRoleInvocation,
  ): HandoffCaptureContext {
    return {
      transcriptId: input.transcriptId,
      workflowId: input.workflowId,
      batchId: input.batchId,
      actorExecutionId: prepared.execution.actorExecutionId,
      invocationId: prepared.invocation.invocationId,
      sessionIdentityId: prepared.session.sessionIdentityId,
      rawTranscript: prepared.call.text,
      createdAt: prepared.invocation.finishedAt ?? this.timestamp(),
    };
  }

  private requireContext(
    workflowId: string,
    batchId: string,
    configurationInput: ReviewWorkflowConfigurationSnapshot,
  ) {
    const configuration = reviewWorkflowConfigurationSnapshotSchema.parse(configurationInput);
    const workflow = this.store.getWorkflow(workflowId);
    if (workflow === null) {
      throw new ReviewWorkflowImplementationError(
        'WORKFLOW_NOT_FOUND',
        `Workflow ${workflowId} does not exist`,
      );
    }
    const batch = this.store.getBatch(batchId);
    if (batch === null || batch.workflowId !== workflowId) {
      throw new ReviewWorkflowImplementationError(
        'BATCH_NOT_FOUND',
        `Batch ${batchId} does not belong to workflow ${workflowId}`,
      );
    }
    if (
      configuration.workflowId !== workflowId ||
      (configuration.batchId !== undefined && configuration.batchId !== batchId) ||
      configuration.configurationHash !== workflow.configurationHash ||
      configuration.assignments.implementer.assignmentId !== batch.implementerAssignmentId ||
      configuration.assignments.reviewer.assignmentId !== batch.reviewerAssignmentId
    ) {
      throw new ReviewWorkflowImplementationError(
        'CONFIGURATION_SCOPE_MISMATCH',
        'Active review-workflow configuration does not match the persisted workflow and batch',
      );
    }
    return { workflow, batch, configuration };
  }

  private requireReviewerResolution(
    resolution: ResolvedRoleAdapter,
    configuration: ReviewWorkflowConfigurationSnapshot,
  ): void {
    const expected = configuration.assignments.reviewer;
    const actual = resolution.assignment;
    if (
      resolution.role !== 'reviewer' ||
      actual.assignmentId !== expected.assignmentId ||
      actual.workflowId !== expected.workflowId ||
      actual.assignedRole !== expected.assignedRole ||
      actual.configuredAgentKey !== expected.configuredAgentKey ||
      actual.expectedAdapterKind !== expected.expectedAdapterKind ||
      actual.configuredModel !== expected.configuredModel ||
      actual.configurationHash !== expected.configurationHash
    ) {
      throw new ReviewWorkflowImplementationError(
        'CONFIGURATION_SCOPE_MISMATCH',
        'Runtime reviewer resolution does not match the immutable assignment',
      );
    }
  }

  private roleSeparation(
    configuration: ReviewWorkflowConfigurationSnapshot,
    reviewerSessionIdentityId: string,
  ): RoleSeparationEvidence {
    return {
      implementerAssignment: configuration.assignments.implementer,
      reviewerAssignment: configuration.assignments.reviewer,
      reviewerSessionIdentityId,
      minimumIdentityAssurance: configuration.identityPolicy.minimumAssurance,
    };
  }

  private requireState(
    batch: ReviewWorkflowBatch,
    expected: ReviewWorkflowBatch['persistedState'],
  ) {
    if (batch.persistedState !== expected) {
      throw new ReviewWorkflowImplementationError(
        'INVALID_STATE',
        `Batch ${batch.batchId} must be ${expected}, observed ${batch.persistedState}`,
      );
    }
  }

  private requireCommandAvailable(commandId: string): void {
    if (this.commandStore.get(commandId) !== null) {
      throw new ReviewWorkflowImplementationError(
        'COMMAND_ALREADY_RESERVED',
        `Command ${commandId} has already reserved its external side effect`,
      );
    }
  }

  /**
   * Fail-closed continuity escalation: block the batch with the exact machine-readable
   * failure reason so only a human decision can move it forward. Best-effort — a batch in a
   * non-blockable state still stops via the thrown continuity error.
   */
  private blockBatchForContinuityFailure(
    workflowId: string,
    batchId: string,
    error: RoleInvocationError,
  ): void {
    const batch = this.store.getBatch(batchId);
    if (batch === null) return;
    const reason = `SESSION_CONTINUITY_FAILURE:${error.code}: ${error.message}`;
    const command: TransitionCommand = { type: 'BLOCK_BATCH', reason };
    const commandId = `${batchId}:session-continuity-block:${batch.aggregateVersion + 1}`;
    const reconciler: ActorExecutionIdentity = {
      actorExecutionId: `${commandId}:system-reconciler`,
      actorType: 'SYSTEM',
      authoritiesExercised: ['SYSTEM_RECONCILER'],
      identityAssurance: 'PROCESS_ATTESTED',
      observedEvidence: [],
      startedAt: this.clock().toISOString(),
    };
    const transition = transitionBatch({
      currentState: batch.persistedState,
      command,
      actor: reconciler,
    });
    if (!transition.allowed) return;
    const request = {
      commandId,
      workflowId,
      batchId,
      expectedAggregateVersion: batch.aggregateVersion,
      requester: reconciler,
      authorityExercised: 'SYSTEM_RECONCILER' as const,
      command,
    };
    this.commandStore.reserve({ ...request, canonicalRequestHash: hashValue(request) });
    this.commandStore.succeedWithTransition({
      commandId,
      transition,
      eventType: 'BATCH_BLOCKED',
      eventPayload: { reason },
      resultHash: hashValue({ reason }),
    });
  }

  private failInvocationCommand(commandId: string, errorCode: string, result: unknown): void {
    this.commandStore.recordOutcome({
      commandId,
      status: 'FAILED_FINAL',
      errorCode,
      resultHash: hashValue(result),
      result,
    });
  }

  private commandRequest(input: {
    readonly commandId: string;
    readonly workflowId: string;
    readonly batch: ReviewWorkflowBatch;
    readonly requester: ActorExecutionIdentity;
    readonly authorityExercised: StateChangingCommandRequest['authorityExercised'];
    readonly targetCommitSha?: string;
    readonly command: TransitionCommand;
  }): StateChangingCommandRequest {
    const request = {
      commandId: input.commandId,
      workflowId: input.workflowId,
      batchId: input.batch.batchId,
      expectedAggregateVersion: input.batch.aggregateVersion,
      ...(input.targetCommitSha === undefined ? {} : { targetCommitSha: input.targetCommitSha }),
      requester: input.requester,
      authorityExercised: input.authorityExercised,
      command: input.command,
    };
    return { ...request, canonicalRequestHash: hashValue(request) };
  }

  private requireBatch(batchId: string): ReviewWorkflowBatch {
    const batch = this.store.getBatch(batchId);
    if (batch === null) {
      throw new ReviewWorkflowImplementationError(
        'BATCH_NOT_FOUND',
        `Batch ${batchId} does not exist`,
      );
    }
    return batch;
  }

  private timestamp(): string {
    return this.clock().toISOString();
  }
}

function requireAllowedTransition(
  currentState: ReviewWorkflowBatch['persistedState'],
  command: TransitionCommand,
  actor: ActorExecutionIdentity,
): AllowedTransition {
  const transition = transitionBatch({ currentState, command, actor });
  if (!transition.allowed) {
    throw new ReviewWorkflowImplementationError(
      'TRANSITION_REJECTED',
      `${command.type} rejected by the domain kernel: ${transition.code}`,
    );
  }
  return transition;
}

function hashValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ReviewWorkflowImplementationError(
      'IMPLEMENTATION_EVIDENCE_MISMATCH',
      'Code-review lifecycle evidence is not serializable',
    );
  }
  return createHash('sha256').update(serialized).digest('hex');
}
