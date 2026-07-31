import { createHash } from 'node:crypto';
import type { ReviewWorkflowCommandStore } from '../memory/review-workflow-command-store.js';
import { parseImplementationResult } from '../review-workflow-contracts/parser.js';
import type { ReviewWorkflowContractService } from '../review-workflow-contracts/service.js';
import type {
  GitRepository,
  GitWorktreeSnapshot,
  ReviewWorkflowGitService,
} from '../review-workflow-git/index.js';
import {
  type ReviewWorkflowConfigurationSnapshot,
  reviewWorkflowConfigurationSnapshotSchema,
} from '../review-workflow-identity/index.js';
import { transitionBatch } from '../review-workflow/state-machine.js';
import type {
  ActorExecutionIdentity,
  AllowedTransition,
  ImplementationAttempt,
  ImplementationCommitMode,
  ImplementationReadyEvidence,
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
import type { ReviewWorkflowImplementationStore } from './store.js';
import {
  type CompleteImplementationInput,
  type CompleteImplementationResult,
  type ExecuteImplementationInput,
  type ExecuteImplementationResult,
  type ResumeImplementationInput,
  type ResumeImplementationResult,
  ReviewWorkflowImplementationError,
  type StartImplementationInput,
  type StartImplementationResult,
} from './types.js';

interface RoleInvoker {
  prepare(input: RoleInvocationInput): Promise<PreparedRoleInvocation>;
  persistPrepared(prepared: PreparedRoleInvocation): void;
}

interface EvidenceMismatch {
  readonly code: string;
  readonly message: string;
}

type Clock = () => Date;

export class ReviewWorkflowImplementationService {
  constructor(
    private readonly store: ReviewWorkflowImplementationStore,
    private readonly commandStore: ReviewWorkflowCommandStore,
    private readonly contractService: ReviewWorkflowContractService,
    private readonly gitService: ReviewWorkflowGitService,
    private readonly repository: GitRepository,
    private readonly roleInvoker: RoleInvoker | RoleInvocationService,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async start(input: StartImplementationInput): Promise<StartImplementationResult> {
    const context = this.requireContext(input.workflowId, input.batchId, input.configuration);
    this.requireImplementerResolution(input.resolution, input.configuration);
    this.requireState(context.batch, 'APPROVED_FOR_IMPLEMENTATION');
    this.requireCommandAvailable(input.commandId);
    const before = this.repository.readWorktree();
    this.requireCleanImplementationBase(context.batch, before);

    const roleSeparation = this.staticRoleSeparation(input.configuration, input.sessionIdentityId);
    const command: TransitionCommand = {
      type: 'START_IMPLEMENTATION',
      evidence: {
        approvedPlanVersionId: context.plan.batchPlanVersionId,
        currentPlanVersionId: context.batch.currentPlanVersionId,
        roleSeparation,
      },
    };
    const request = this.commandRequest({
      commandId: input.commandId,
      workflowId: input.workflowId,
      batch: context.batch,
      requester: this.preInvocationRequester({
        commandId: input.commandId,
        assignmentId: input.configuration.assignments.implementer.assignmentId,
        sessionIdentityId: input.sessionIdentityId,
        invocationId: input.invocationId,
        authorities: ['IMPLEMENTER'],
      }),
      authorityExercised: 'IMPLEMENTER',
      targetCommitSha: before.headSha,
      command,
    });
    const prepared = await this.reserveAndInvoke(request, input.invocationId, () =>
      this.roleInvoker.prepare({
        resolution: input.resolution,
        workflowId: input.workflowId,
        commandId: input.commandId,
        actorExecutionId: input.actorExecutionId,
        invocationId: input.invocationId,
        sessionIdentityId: input.sessionIdentityId,
        prompt: input.prompt,
        sessionBinding: { batchId: input.batchId, role: 'IMPLEMENTER' },
        auditPhase: 'IMPLEMENTATION',
        ...(input.options === undefined ? {} : { options: input.options }),
      }),
    );
    const postInvocation = this.readPostInvocationWorktree(before);
    const after = postInvocation.snapshot;
    const failure =
      postInvocation.failure ?? this.preflightFailure(before, after, prepared.call.text);

    if (failure !== undefined) {
      this.failInvocationCommand(input.commandId, failure.code, failure);
      throw new ReviewWorkflowImplementationError('PREFLIGHT_INVALID', failure.message);
    }

    const transition = requireAllowedTransition(
      context.batch.persistedState,
      command,
      prepared.execution,
    );
    this.store.runAtomically(() => {
      this.commandStore.succeedWithTransition({
        commandId: input.commandId,
        transition,
        transitionActorExecutionId: prepared.execution.actorExecutionId,
        eventType: 'IMPLEMENTATION_STARTED',
        eventPayload: {
          planVersionId: context.plan.batchPlanVersionId,
          originalBatchBaseSha: before.headSha,
          implementerSessionIdentityId: prepared.session.sessionIdentityId,
        },
        resultHash: hashValue({
          state: transition.nextState,
          originalBatchBaseSha: before.headSha,
          implementerSessionIdentityId: prepared.session.sessionIdentityId,
        }),
      });
    });

    return {
      batch: this.requireBatch(input.batchId),
      repository: after,
      implementerSessionIdentityId: prepared.session.sessionIdentityId,
    };
  }

  async resume(input: ResumeImplementationInput): Promise<ResumeImplementationResult> {
    const context = this.requireContext(input.workflowId, input.batchId, input.configuration);
    this.requireImplementerResolution(input.resolution, input.configuration);
    this.requireAnyState(context.batch, ['AWAITING_COMMIT', 'NEEDS_REVISION']);
    if (context.batch.persistedState === 'NEEDS_REVISION') {
      this.requireCorrectionPassAvailable(context.batch, context.configuration);
    }
    this.requireCommandAvailable(input.commandId);
    const before = this.repository.readWorktree();
    const sessionForEvidence = input.previousSessionIdentityId ?? input.sessionIdentityId;
    const command: TransitionCommand = {
      type: 'RESUME_IMPLEMENTATION',
      roleSeparation: this.staticRoleSeparation(input.configuration, sessionForEvidence),
    };
    const request = this.commandRequest({
      commandId: input.commandId,
      workflowId: input.workflowId,
      batch: context.batch,
      requester: this.preInvocationRequester({
        commandId: input.commandId,
        assignmentId: input.configuration.assignments.implementer.assignmentId,
        sessionIdentityId: sessionForEvidence,
        invocationId: input.invocationId,
        authorities: ['IMPLEMENTER'],
      }),
      authorityExercised: 'IMPLEMENTER',
      targetCommitSha: before.headSha,
      command,
    });
    const prepared = await this.reserveAndInvoke(request, input.invocationId, () =>
      this.roleInvoker.prepare({
        resolution: input.resolution,
        workflowId: input.workflowId,
        commandId: input.commandId,
        actorExecutionId: input.actorExecutionId,
        invocationId: input.invocationId,
        sessionIdentityId: input.sessionIdentityId,
        prompt: input.prompt,
        previousSessionIdentityId: input.previousSessionIdentityId,
        sessionBinding: { batchId: input.batchId, role: 'IMPLEMENTER', expectExisting: true },
        auditPhase: 'IMPLEMENTATION',
        ...(input.options === undefined ? {} : { options: input.options }),
      }),
    );
    const postInvocation = this.readPostInvocationWorktree(before);
    const after = postInvocation.snapshot;
    const failure =
      postInvocation.failure ?? this.preflightFailure(before, after, prepared.call.text);
    if (failure !== undefined) {
      this.failInvocationCommand(input.commandId, failure.code, failure);
      throw new ReviewWorkflowImplementationError('PREFLIGHT_INVALID', failure.message);
    }
    const transition = requireAllowedTransition(
      context.batch.persistedState,
      command,
      prepared.execution,
    );
    this.store.runAtomically(() => {
      this.commandStore.succeedWithTransition({
        commandId: input.commandId,
        transition,
        transitionActorExecutionId: prepared.execution.actorExecutionId,
        eventType: 'IMPLEMENTATION_RESUMED',
        eventPayload: {
          implementerSessionIdentityId: prepared.session.sessionIdentityId,
          repositoryHeadSha: before.headSha,
          worktreeFingerprint: before.worktreeFingerprint,
        },
        resultHash: hashValue({
          state: transition.nextState,
          implementerSessionIdentityId: prepared.session.sessionIdentityId,
        }),
      });
    });
    return {
      batch: this.requireBatch(input.batchId),
      repository: after,
      implementerSessionIdentityId: prepared.session.sessionIdentityId,
    };
  }

  async execute(input: ExecuteImplementationInput): Promise<ExecuteImplementationResult> {
    const context = this.requireContext(input.workflowId, input.batchId, input.configuration);
    this.requireImplementerResolution(input.resolution, input.configuration);
    this.requireState(context.batch, 'IMPLEMENTING');
    this.requireCommandAvailable(input.commandId);
    this.validateAttemptNumber(context.batch, input.attemptNumber);
    if (
      this.successfulAttemptCount(input.batchId) >=
      1 + context.configuration.pacing.maxCorrectionPasses
    ) {
      throw new ReviewWorkflowImplementationError(
        'PACING_EXHAUSTED',
        `Attempt ${input.attemptNumber} exceeds the single permitted correction pass`,
      );
    }
    if (
      input.implementationAttemptId !==
        deriveImplementationAttemptId(input.batchId, input.attemptNumber) ||
      input.implementationReadyEvidenceId !==
        deriveImplementationReadyEvidenceId(input.implementationAttemptId)
    ) {
      throw new ReviewWorkflowImplementationError(
        'IMPLEMENTATION_EVIDENCE_MISMATCH',
        'Implementation attempt and ready-evidence IDs must use the authoritative vocabulary',
      );
    }
    this.validateCommitMode(input.creationMode, input.configuration);
    if (context.batch.originalBatchBaseSha === undefined) {
      throw new ReviewWorkflowImplementationError(
        'REPOSITORY_STATE_INVALID',
        'Implementation cannot run before the original batch base SHA is established',
      );
    }
    const originalBatchBaseSha = context.batch.originalBatchBaseSha;

    const before = this.repository.readWorktree();
    const baseIsValid =
      input.creationMode === 'HUMAN_CREATED'
        ? before.headSha === originalBatchBaseSha
        : this.repository.isAncestor(originalBatchBaseSha, before.headSha);
    if (!baseIsValid) {
      throw new ReviewWorkflowImplementationError(
        'REPOSITORY_STATE_INVALID',
        'Implementation retry state is not descended from the established batch base',
      );
    }

    const sessionForEvidence = input.previousSessionIdentityId ?? input.sessionIdentityId;
    const invocationRequest = this.commandRequest({
      commandId: input.commandId,
      workflowId: input.workflowId,
      batch: context.batch,
      requester: this.preInvocationRequester({
        commandId: input.commandId,
        assignmentId: input.configuration.assignments.implementer.assignmentId,
        sessionIdentityId: sessionForEvidence,
        invocationId: input.invocationId,
        authorities:
          input.creationMode === 'AGENT_AUTHORIZED'
            ? ['IMPLEMENTER', 'COMMIT_CREATOR']
            : ['IMPLEMENTER'],
      }),
      authorityExercised: 'IMPLEMENTER',
      targetCommitSha: before.headSha,
      command: {
        type: 'RESUME_IMPLEMENTATION',
        roleSeparation: this.staticRoleSeparation(input.configuration, sessionForEvidence),
      },
    });
    const prepared = await this.reserveAndInvoke(invocationRequest, input.invocationId, () =>
      this.roleInvoker.prepare({
        resolution: input.resolution,
        workflowId: input.workflowId,
        commandId: input.commandId,
        actorExecutionId: input.actorExecutionId,
        invocationId: input.invocationId,
        sessionIdentityId: input.sessionIdentityId,
        prompt: input.prompt,
        previousSessionIdentityId: input.previousSessionIdentityId,
        sessionBinding: { batchId: input.batchId, role: 'IMPLEMENTER', expectExisting: true },
        auditPhase: 'IMPLEMENTATION',
        ...(input.creationMode === 'AGENT_AUTHORIZED'
          ? { additionalAuthorities: ['COMMIT_CREATOR'] }
          : {}),
        ...(input.options === undefined ? {} : { options: input.options }),
      }),
    );
    let after: GitWorktreeSnapshot;
    try {
      after = this.repository.readWorktree();
    } catch (error) {
      return this.persistPostInvocationFailure(input, context, prepared, before, before, error);
    }
    const parsed = safeParseImplementation(prepared.call.text);
    let changedPaths: readonly string[];
    try {
      changedPaths =
        parsed?.outcome === 'COMPLETE' ? this.deriveChangedPaths(originalBatchBaseSha, after) : [];
    } catch (error) {
      return this.persistPostInvocationFailure(input, context, prepared, before, after, error);
    }
    const evidenceMismatch =
      parsed?.outcome === 'COMPLETE'
        ? this.validateCompletedEvidence(input, before, after, changedPaths, parsed.changedFiles)
        : undefined;
    const roleSeparation = this.roleSeparation(input.configuration, prepared);
    const implementationReadyEvidence: ImplementationReadyEvidence = {
      implementationReadyEvidenceId: input.implementationReadyEvidenceId,
      implementationAttemptId: input.implementationAttemptId,
      actorExecutionId: prepared.execution.actorExecutionId,
      worktreeFingerprint: after.worktreeFingerprint,
      changedFiles: changedPaths,
      summary: parsed?.summary ?? 'Implementation handoff was rejected.',
      capturedAt: this.timestamp(),
    };
    const markCommand: TransitionCommand = {
      type: 'MARK_IMPLEMENTATION_READY',
      evidence: {
        implementationReady: implementationReadyEvidence,
        roleSeparation,
      },
    };
    const transitionCommandId = `${input.commandId}:transition`;

    return this.store.runAtomically(() => {
      const capture = this.contractService.captureImplementation({
        transcriptId: input.transcriptId,
        workflowId: input.workflowId,
        batchId: input.batchId,
        actorExecutionId: prepared.execution.actorExecutionId,
        invocationId: prepared.invocation.invocationId,
        sessionIdentityId: prepared.session.sessionIdentityId,
        rawTranscript: prepared.call.text,
        createdAt: prepared.invocation.finishedAt ?? this.timestamp(),
        implementationAttemptId: input.implementationAttemptId,
        attemptNumber: input.attemptNumber,
        approvedPlanVersionId: context.plan.batchPlanVersionId,
        approvedPlanContentHash: context.plan.contentHash,
        originalBatchBaseSha,
        startingHeadSha: before.headSha,
        implementerAssignmentId: input.configuration.assignments.implementer.assignmentId,
        startedAt: prepared.invocation.startedAt,
      });

      if (!capture.accepted) {
        this.failInvocationCommand(input.commandId, capture.error.code, capture.error);
        return {
          status: 'REJECTED',
          batch: context.batch,
          capture,
          errorCode: capture.error.code,
          message: capture.error.message,
        };
      }
      if (evidenceMismatch !== undefined) {
        this.failInvocationCommand(input.commandId, evidenceMismatch.code, evidenceMismatch);
        return {
          status: 'REJECTED',
          batch: context.batch,
          capture,
          errorCode: evidenceMismatch.code,
          message: evidenceMismatch.message,
        };
      }
      if (capture.value.contract.outcome === 'BLOCKED') {
        this.failInvocationCommand(input.commandId, 'IMPLEMENTATION_BLOCKED', {
          blockerReason: capture.value.contract.blockerReason,
        });
        const blockCommand: TransitionCommand = {
          type: 'BLOCK_BATCH',
          reason: capture.value.contract.blockerReason ?? 'Implementation reported a blocker',
        };
        const blockCommandId = `${input.commandId}:block`;
        const blockRequest = this.commandRequest({
          commandId: blockCommandId,
          workflowId: input.workflowId,
          batch: context.batch,
          requester: prepared.execution,
          authorityExercised: 'IMPLEMENTER',
          command: blockCommand,
        });
        this.commandStore.reserve(blockRequest);
        const blockTransition = requireAllowedTransition(
          context.batch.persistedState,
          blockCommand,
          prepared.execution,
        );
        this.commandStore.succeedWithTransition({
          commandId: blockCommandId,
          transition: blockTransition,
          eventType: 'IMPLEMENTATION_BLOCKED',
          eventPayload: {
            implementationAttemptId: capture.value.implementationAttempt.implementationAttemptId,
            reason: blockCommand.reason,
          },
          resultHash: hashValue(capture.value.implementationAttempt),
          result: capture.value.implementationAttempt,
        });
        return {
          status: 'BLOCKED',
          batch: this.requireBatch(input.batchId),
          capture,
          attempt: capture.value.implementationAttempt,
        };
      }

      this.store.workflowStore.saveEntity({
        kind: 'IMPLEMENTATION_READY_EVIDENCE',
        value: implementationReadyEvidence,
      });
      this.commandStore.succeedWithoutTransition({
        commandId: input.commandId,
        resultHash: hashValue(capture.value.implementationAttempt),
        result: capture.value.implementationAttempt,
      });
      this.commandStore.reserve(
        this.commandRequest({
          commandId: transitionCommandId,
          workflowId: input.workflowId,
          batch: context.batch,
          requester: prepared.execution,
          authorityExercised: 'IMPLEMENTER',
          command: markCommand,
        }),
      );
      const transition = requireAllowedTransition(
        context.batch.persistedState,
        markCommand,
        prepared.execution,
      );
      this.commandStore.succeedWithTransition({
        commandId: transitionCommandId,
        transition,
        eventType: 'IMPLEMENTATION_READY',
        eventPayload: {
          implementationAttemptId: capture.value.implementationAttempt.implementationAttemptId,
          implementationReadyEvidenceId: implementationReadyEvidence.implementationReadyEvidenceId,
          creationMode: input.creationMode,
        },
        resultHash: hashValue({
          attempt: capture.value.implementationAttempt,
          implementationReadyEvidence,
        }),
      });
      return {
        status: 'AWAITING_COMMIT',
        batch: this.requireBatch(input.batchId),
        capture,
        attempt: capture.value.implementationAttempt,
        implementationReadyEvidence,
      };
    });
  }

  complete(input: CompleteImplementationInput): CompleteImplementationResult {
    const context = this.requireContext(input.workflowId, input.batchId, input.configuration);
    this.requireState(context.batch, 'AWAITING_COMMIT');
    this.validateCommitMode(input.creationMode, input.configuration);
    const attempt = this.store.getImplementationAttempt(input.implementationAttemptId);
    if (attempt === null || attempt.batchId !== input.batchId) {
      throw new ReviewWorkflowImplementationError(
        'ATTEMPT_NOT_FOUND',
        `Implementation attempt ${input.implementationAttemptId} does not belong to this batch`,
      );
    }
    const readyEvidence = this.store.getImplementationReadyEvidence(
      input.implementationReadyEvidenceId,
    );
    if (
      readyEvidence === null ||
      readyEvidence.implementationAttemptId !== attempt.implementationAttemptId
    ) {
      throw new ReviewWorkflowImplementationError(
        'READY_EVIDENCE_NOT_FOUND',
        `Implementation-ready evidence ${input.implementationReadyEvidenceId} is invalid`,
      );
    }
    const cleanFingerprint = createHash('sha256').update('').digest('hex');
    const evidencedMode: ImplementationCommitMode =
      readyEvidence.worktreeFingerprint === cleanFingerprint ? 'AGENT_AUTHORIZED' : 'HUMAN_CREATED';
    if (input.creationMode !== evidencedMode) {
      throw new ReviewWorkflowImplementationError(
        'CREATION_MODE_MISMATCH',
        `Completion claims ${input.creationMode} but the durable ready evidence records a ${evidencedMode} implementation`,
      );
    }
    const implementerAssignment = this.store.getAssignment(context.batch.implementerAssignmentId);
    if (implementerAssignment === null) {
      throw new ReviewWorkflowImplementationError(
        'CONFIGURATION_SCOPE_MISMATCH',
        'The persisted implementer assignment is missing',
      );
    }
    const creator = this.resolveCommitCreator(input, attempt);
    const validated = this.gitService.validateImplementationCommit({
      attempt,
      implementationReadyEvidence: readyEvidence,
      providedCommitSha: input.providedCommitSha,
      creator,
      implementerAssignment,
      commitPolicy: input.configuration.commitPolicy,
      creationMode: input.creationMode,
    });
    const command: TransitionCommand = {
      type: 'COMPLETE_IMPLEMENTATION',
      evidence: validated.transitionEvidence,
    };
    const request = this.commandRequest({
      commandId: input.commandId,
      workflowId: input.workflowId,
      batch: context.batch,
      requester: creator,
      authorityExercised: 'COMMIT_CREATOR',
      targetCommitSha: input.providedCommitSha,
      command,
    });
    const transition = requireAllowedTransition(context.batch.persistedState, command, creator);

    this.store.runAtomically(() => {
      this.commandStore.reserve(request);
      this.store.workflowStore.saveEntity({
        kind: 'IMPLEMENTATION_COMMIT',
        value: validated.implementationCommit,
      });
      this.commandStore.succeedWithTransition({
        commandId: input.commandId,
        transition,
        eventType: 'IMPLEMENTATION_COMMIT_VALIDATED',
        eventPayload: {
          implementationAttemptId: attempt.implementationAttemptId,
          implementationReadyEvidenceId: readyEvidence.implementationReadyEvidenceId,
          resultingCommitSha: validated.implementationCommit.resultingCommitSha,
          creationMode: input.creationMode,
        },
        resultHash: hashValue(validated.implementationCommit),
        result: validated.implementationCommit,
      });
    });

    return {
      batch: this.requireBatch(input.batchId),
      implementationCommit: validated.implementationCommit,
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
    const plan = this.store.getBatchPlan(batch.currentPlanVersionId);
    if (plan === null || plan.batchId !== batchId || plan.workflowId !== workflowId) {
      throw new ReviewWorkflowImplementationError(
        'PLAN_NOT_FOUND',
        `Current plan ${batch.currentPlanVersionId} does not belong to this batch`,
      );
    }
    return { workflow, batch, plan, configuration };
  }

  private persistPostInvocationFailure(
    input: ExecuteImplementationInput,
    context: ReturnType<ReviewWorkflowImplementationService['requireContext']>,
    prepared: PreparedRoleInvocation,
    before: GitWorktreeSnapshot,
    observed: GitWorktreeSnapshot,
    error: unknown,
  ): ExecuteImplementationResult {
    if (context.batch.originalBatchBaseSha === undefined) {
      throw new ReviewWorkflowImplementationError(
        'REPOSITORY_STATE_INVALID',
        'Implementation base disappeared while invocation evidence was recorded',
      );
    }
    const originalBatchBaseSha = context.batch.originalBatchBaseSha;
    const message = error instanceof Error ? error.message : 'Repository evidence assembly failed';
    const failure = {
      code: 'REPOSITORY_EVIDENCE_FAILED',
      message,
    };
    void observed;
    return this.store.runAtomically(() => {
      const capture = this.contractService.captureImplementation({
        transcriptId: input.transcriptId,
        workflowId: input.workflowId,
        batchId: input.batchId,
        actorExecutionId: prepared.execution.actorExecutionId,
        invocationId: prepared.invocation.invocationId,
        sessionIdentityId: prepared.session.sessionIdentityId,
        rawTranscript: prepared.call.text,
        createdAt: prepared.invocation.finishedAt ?? this.timestamp(),
        implementationAttemptId: input.implementationAttemptId,
        attemptNumber: input.attemptNumber,
        approvedPlanVersionId: context.plan.batchPlanVersionId,
        approvedPlanContentHash: context.plan.contentHash,
        originalBatchBaseSha,
        startingHeadSha: before.headSha,
        implementerAssignmentId: input.configuration.assignments.implementer.assignmentId,
        startedAt: prepared.invocation.startedAt,
      });
      this.failInvocationCommand(input.commandId, failure.code, failure);
      return {
        status: 'REJECTED',
        batch: context.batch,
        capture,
        errorCode: failure.code,
        message: failure.message,
      };
    });
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

  private requireImplementerResolution(
    resolution: StartImplementationInput['resolution'],
    configuration: ReviewWorkflowConfigurationSnapshot,
  ): void {
    const expected = configuration.assignments.implementer;
    const actual = resolution.assignment;
    if (
      resolution.role !== 'implementer' ||
      actual.assignmentId !== expected.assignmentId ||
      actual.workflowId !== expected.workflowId ||
      actual.assignedRole !== expected.assignedRole ||
      actual.configuredAgentKey !== expected.configuredAgentKey ||
      actual.expectedAdapterKind !== expected.expectedAdapterKind ||
      actual.configuredModel !== expected.configuredModel ||
      actual.configurationHash !== expected.configurationHash ||
      actual.commitPermission !== expected.commitPermission
    ) {
      throw new ReviewWorkflowImplementationError(
        'CONFIGURATION_SCOPE_MISMATCH',
        'Runtime implementer resolution does not match the immutable assignment',
      );
    }
  }

  private requireCleanImplementationBase(
    batch: ReviewWorkflowBatch,
    snapshot: GitWorktreeSnapshot,
  ): void {
    if (!snapshot.clean || snapshot.changedPaths.length > 0) {
      throw new ReviewWorkflowImplementationError(
        'REPOSITORY_STATE_INVALID',
        'Implementation start requires a clean repository worktree and index',
      );
    }
    if (
      batch.originalBatchBaseSha !== undefined &&
      batch.originalBatchBaseSha !== snapshot.headSha
    ) {
      throw new ReviewWorkflowImplementationError(
        'REPOSITORY_STATE_INVALID',
        'Repository HEAD does not match the already established batch base',
      );
    }
  }

  private preflightFailure(
    before: GitWorktreeSnapshot,
    after: GitWorktreeSnapshot,
    response: string,
  ): EvidenceMismatch | undefined {
    if (
      before.headSha !== after.headSha ||
      before.branch !== after.branch ||
      before.worktreeFingerprint !== after.worktreeFingerprint ||
      before.clean !== after.clean
    ) {
      return {
        code: 'PREFLIGHT_REPOSITORY_CHANGED',
        message: 'Implementer preflight changed repository state before implementation started',
      };
    }
    if (response !== 'READY') {
      return {
        code: 'PREFLIGHT_RESPONSE_INVALID',
        message: 'Implementer preflight must return exactly READY',
      };
    }
    return undefined;
  }

  private readPostInvocationWorktree(before: GitWorktreeSnapshot): {
    readonly snapshot: GitWorktreeSnapshot;
    readonly failure?: EvidenceMismatch;
  } {
    try {
      return { snapshot: this.repository.readWorktree() };
    } catch (error) {
      return {
        snapshot: before,
        failure: {
          code: 'PREFLIGHT_REPOSITORY_READ_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Repository evidence could not be read after preflight',
        },
      };
    }
  }

  private deriveChangedPaths(
    originalBatchBaseSha: string,
    after: GitWorktreeSnapshot,
  ): readonly string[] {
    const committed =
      originalBatchBaseSha === after.headSha
        ? []
        : this.repository
            .readDiff(originalBatchBaseSha, after.headSha)
            .changedFiles.map((file) => file.path);
    const finalSnapshot = this.repository.readWorktree();
    if (
      finalSnapshot.headSha !== after.headSha ||
      finalSnapshot.worktreeFingerprint !== after.worktreeFingerprint
    ) {
      throw new ReviewWorkflowImplementationError(
        'REPOSITORY_STATE_INVALID',
        'Repository state changed while implementation evidence was assembled',
      );
    }
    return [...new Set([...committed, ...after.changedPaths])].sort();
  }

  private validateCompletedEvidence(
    input: ExecuteImplementationInput,
    before: GitWorktreeSnapshot,
    after: GitWorktreeSnapshot,
    actualChangedPaths: readonly string[],
    claimedChangedPaths: readonly string[],
  ): EvidenceMismatch | undefined {
    if (actualChangedPaths.length === 0) {
      return {
        code: 'NO_IMPLEMENTATION_CHANGE',
        message: 'A complete implementation must produce repository changes',
      };
    }
    if (JSON.stringify([...claimedChangedPaths].sort()) !== JSON.stringify(actualChangedPaths)) {
      return {
        code: 'CHANGED_FILES_MISMATCH',
        message: 'Implementation handoff changedFiles do not match fresh repository evidence',
      };
    }
    if (input.creationMode === 'AGENT_AUTHORIZED') {
      if (!after.clean || after.headSha === before.headSha) {
        return {
          code: 'AGENT_COMMIT_REQUIRED',
          message: 'Agent-authorized mode requires a new committed HEAD and clean worktree',
        };
      }
      return undefined;
    }
    if (after.headSha !== before.headSha || after.clean) {
      return {
        code: 'HUMAN_COMMIT_REQUIRED',
        message: 'Human-created mode requires uncommitted changes and an unchanged HEAD',
      };
    }
    return undefined;
  }

  private validateCommitMode(
    mode: ImplementationCommitMode,
    configuration: ReviewWorkflowConfigurationSnapshot,
  ): void {
    const denied =
      (mode === 'AGENT_AUTHORIZED' && configuration.commitPolicy === 'HUMAN_REQUIRED') ||
      (mode === 'HUMAN_CREATED' && configuration.commitPolicy === 'AGENT_AUTHORIZED');
    if (denied) {
      throw new ReviewWorkflowImplementationError(
        'COMMIT_MODE_DENIED',
        `Commit mode ${mode} is not allowed by policy ${configuration.commitPolicy}`,
      );
    }
  }

  private validateAttemptNumber(batch: ReviewWorkflowBatch, attemptNumber: number): void {
    const expected = this.store.listImplementationAttempts(batch.batchId).length + 1;
    if (attemptNumber !== expected) {
      throw new ReviewWorkflowImplementationError(
        'IMPLEMENTATION_EVIDENCE_MISMATCH',
        `Expected implementation attempt ${expected}, received ${attemptNumber}`,
      );
    }
  }

  private requireAnyState(
    batch: ReviewWorkflowBatch,
    expected: readonly ReviewWorkflowBatch['persistedState'][],
  ): void {
    if (!expected.includes(batch.persistedState)) {
      throw new ReviewWorkflowImplementationError(
        'INVALID_STATE',
        `Batch ${batch.batchId} must be one of ${expected.join(', ')}, observed ${batch.persistedState}`,
      );
    }
  }

  private requireCorrectionPassAvailable(
    batch: ReviewWorkflowBatch,
    configuration: ReviewWorkflowConfigurationSnapshot,
  ): void {
    const grantedPasses = this.store
      .getEvents(batch.batchId)
      .filter(
        (event) =>
          event.eventType === 'BATCH_RESUMED' && event.payload.grantsCorrectionPass === true,
      ).length;
    if (
      this.successfulAttemptCount(batch.batchId) >=
      1 + configuration.pacing.maxCorrectionPasses + grantedPasses
    ) {
      throw new ReviewWorkflowImplementationError(
        'PACING_EXHAUSTED',
        `Batch ${batch.batchId} has used its ${configuration.pacing.maxCorrectionPasses} permitted correction pass(es)`,
      );
    }
  }

  /** Rejected handoffs never consume the correction budget; only completed ready transitions do. */
  private successfulAttemptCount(batchId: string): number {
    return this.store
      .getEvents(batchId)
      .filter((event) => event.eventType === 'IMPLEMENTATION_READY').length;
  }

  private roleSeparation(
    configuration: ReviewWorkflowConfigurationSnapshot,
    prepared: PreparedRoleInvocation,
  ): RoleSeparationEvidence {
    return this.staticRoleSeparation(configuration, prepared.session.sessionIdentityId);
  }

  private staticRoleSeparation(
    configuration: ReviewWorkflowConfigurationSnapshot,
    implementerSessionIdentityId: string,
  ): RoleSeparationEvidence {
    return {
      implementerAssignment: configuration.assignments.implementer,
      reviewerAssignment: configuration.assignments.reviewer,
      implementerSessionIdentityId,
      minimumIdentityAssurance: configuration.identityPolicy.minimumAssurance,
    };
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

  /**
   * The durable pre-invocation requester: records who asked for the command before any side
   * effect ran. Its assurance is honestly CONFIG_ONLY; the richer process-attested execution
   * is persisted after the invocation and named for kernel re-derivation.
   */
  private preInvocationRequester(input: {
    readonly commandId: string;
    readonly assignmentId: string;
    readonly sessionIdentityId: string;
    readonly invocationId: string;
    readonly authorities: readonly ActorExecutionIdentity['authoritiesExercised'][number][];
  }): ActorExecutionIdentity {
    return {
      actorExecutionId: `${input.commandId}:requester`,
      actorType: 'AGENT',
      assignmentId: input.assignmentId,
      invocationIdentityId: input.invocationId,
      sessionIdentityId: input.sessionIdentityId,
      authoritiesExercised: [...input.authorities],
      identityAssurance: 'CONFIG_ONLY',
      observedEvidence: [],
      startedAt: this.timestamp(),
    };
  }

  /**
   * Durably reserves the command and claims its agent side effect BEFORE the external CLI
   * runs, then invokes the bridge. A crash or retry in the invocation window finds the
   * RUNNING receipt with its claimed side effect and never re-invokes the agent.
   */
  private async reserveAndInvoke(
    request: StateChangingCommandRequest,
    invocationId: string,
    invoke: () => Promise<PreparedRoleInvocation>,
  ): Promise<PreparedRoleInvocation> {
    this.commandStore.reserve(request, 'AGENT_INVOCATION');
    this.commandStore.claimSideEffect(request.commandId, invocationId);
    let prepared: PreparedRoleInvocation;
    try {
      prepared = await invoke();
    } catch (error) {
      this.failInvocationCommand(request.commandId, 'AGENT_INVOCATION_FAILED', {
        message: error instanceof Error ? error.message : 'Agent invocation failed',
      });
      if (isSessionContinuityError(error)) {
        // Fail closed: a broken role-session continuity stops the batch for a human
        // decision — never a silent fallback to a fresh session. The escalation is
        // best-effort: it must never mask the typed continuity error.
        try {
          this.blockBatchForContinuityFailure(request.workflowId, request.batchId, error);
        } catch {
          // The typed error below remains the authoritative failure.
        }
      }
      throw error;
    }
    if (prepared.invocation.commandId !== request.commandId) {
      const failure = {
        code: 'INVOCATION_MISMATCH',
        message: 'Prepared invocation is not bound to the authoritative command',
      };
      this.failInvocationCommand(request.commandId, failure.code, failure);
      throw new ReviewWorkflowImplementationError('INVOCATION_MISMATCH', failure.message);
    }
    this.roleInvoker.persistPrepared(prepared);
    return prepared;
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

  private resolveCommitCreator(
    input: CompleteImplementationInput,
    attempt: ImplementationAttempt,
  ): ActorExecutionIdentity {
    if (input.creationMode === 'HUMAN_CREATED') {
      if (input.humanCreator?.actorType !== 'HUMAN') {
        throw new ReviewWorkflowImplementationError(
          'CREATOR_NOT_FOUND',
          'Human-created completion requires a human COMMIT_CREATOR identity',
        );
      }
      return input.humanCreator;
    }
    const actor = this.store.getActorExecution(attempt.implementerActorExecutionId);
    if (actor === null || actor.actorType !== 'AGENT') {
      throw new ReviewWorkflowImplementationError(
        'CREATOR_NOT_FOUND',
        'Agent-authorized completion requires the persisted implementing actor execution',
      );
    }
    return actor;
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

export function deriveImplementationAttemptId(batchId: string, attemptNumber: number): string {
  return `${batchId}:implementation:${attemptNumber}`;
}

export function deriveImplementationReadyEvidenceId(implementationAttemptId: string): string {
  return `${implementationAttemptId}:ready`;
}

function safeParseImplementation(rawTranscript: string) {
  try {
    return parseImplementationResult(rawTranscript);
  } catch {
    return undefined;
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
      'Implementation lifecycle evidence is not serializable',
    );
  }
  return createHash('sha256').update(serialized).digest('hex');
}
