import { createHash } from 'node:crypto';
import type { ReviewWorkflowCommandStore } from '../memory/review-workflow-command-store.js';
import type { ReviewWorkflowSideEffectKind } from '../memory/review-workflow-command-store.js';
import {
  type HandoffCaptureContext,
  type HandoffCaptureResult,
  type RefinementCaptureValue,
  type ReviewCaptureValue,
  type ReviewWorkflowContractService,
  parseRefinementResult,
} from '../review-workflow-contracts/index.js';
import type { RepositoryAuditRequest } from '../review-workflow-git/types.js';
import type { ReviewWorkflowConfigurationSnapshot } from '../review-workflow-identity/types.js';
import { transitionBatch } from '../review-workflow/state-machine.js';
import type {
  ActorExecutionIdentity,
  AllowedTransition,
  FindingSeverity,
  IdentityEvidence,
  RepositoryAudit,
  ReviewWorkflowBatch,
  RoleSeparationEvidence,
  StateChangingCommandRequest,
  TransitionCommand,
  WorkflowRun,
} from '../review-workflow/types.js';
import type { PreparedRoleInvocation, RoleInvocationService } from '../roles/role-invocation.js';
import { importGeneralPlan } from './importer.js';
import type { ReviewWorkflowPlanStore } from './store.js';

export const REVIEW_WORKFLOW_PLAN_ERROR_CODES = [
  'OWNER_AUTHORITY_REQUIRED',
  'CONFIGURATION_SCOPE_MISMATCH',
  'REPOSITORY_AUDIT_INVALID',
  'WORKFLOW_NOT_FOUND',
  'BATCH_NOT_FOUND',
  'REFINEMENT_INVALID',
  'REFINEMENT_COMMAND_MISMATCH',
  'ROLE_INVOCATION_SERVICE_REQUIRED',
  'PLAN_REVIEW_POLICY_MISMATCH',
  'TRANSITION_REJECTED',
] as const;

export type ReviewWorkflowPlanErrorCode = (typeof REVIEW_WORKFLOW_PLAN_ERROR_CODES)[number];

export class ReviewWorkflowPlanError extends Error {
  constructor(
    readonly code: ReviewWorkflowPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewWorkflowPlanError';
  }
}

export interface RepositoryAuditCollector {
  captureRepositoryAudit(request: RepositoryAuditRequest): RepositoryAudit;
}

export interface InitializeReviewWorkflowInput {
  readonly workflowId: string;
  readonly planContent: string;
  readonly sourceType: string;
  readonly sourceLocation?: string;
  readonly authorEvidence: readonly IdentityEvidence[];
  readonly owner: ActorExecutionIdentity;
  readonly configuration: ReviewWorkflowConfigurationSnapshot;
  readonly repositoryAuditId: string;
  readonly createdAt: string;
}

export interface InitializeReviewWorkflowResult {
  readonly workflow: WorkflowRun;
  readonly repositoryAudit: RepositoryAudit;
  readonly requirementIds: readonly string[];
}

export interface CapturePlanRefinementInput extends HandoffCaptureContext {
  readonly expectedFirstBatchId: string;
  readonly refinedPlanVersionId: string;
  readonly repositoryAuditId: string;
  readonly version: number;
  readonly actor: ActorExecutionIdentity;
  readonly preparedInvocation?: PreparedRoleInvocation;
}

export interface CapturePlanReviewInput extends HandoffCaptureContext {
  readonly batchId: string;
  readonly reviewRoundId: string;
  readonly reviewRoundNumber: number;
  readonly actor: ActorExecutionIdentity;
  readonly roleSeparation: RoleSeparationEvidence;
  readonly blockingSeverities: readonly FindingSeverity[];
  readonly preparedInvocation?: PreparedRoleInvocation;
}

export interface CapturePlanReviewResult {
  readonly capture: HandoffCaptureResult<ReviewCaptureValue>;
  readonly state: ReviewWorkflowBatch['persistedState'];
  readonly blockingFindingCount: number;
}

export interface ReviewWorkflowPlanStatus {
  readonly workflow: WorkflowRun;
  readonly batches: readonly ReviewWorkflowBatch[];
}

export class ReviewWorkflowPlanService {
  constructor(
    private readonly store: ReviewWorkflowPlanStore,
    private readonly commandStore: ReviewWorkflowCommandStore,
    private readonly contractService: ReviewWorkflowContractService,
    private readonly repositoryAuditCollector: RepositoryAuditCollector,
    private readonly roleInvocationService?: RoleInvocationService,
  ) {}

  initialize(input: InitializeReviewWorkflowInput): InitializeReviewWorkflowResult {
    if (
      input.owner.actorType !== 'HUMAN' ||
      !input.owner.authoritiesExercised.includes('WORKFLOW_OWNER')
    ) {
      throw new ReviewWorkflowPlanError(
        'OWNER_AUTHORITY_REQUIRED',
        'Workflow initialization requires a human WORKFLOW_OWNER execution',
      );
    }
    if (
      input.configuration.workflowId !== input.workflowId ||
      input.configuration.batchId !== undefined
    ) {
      throw new ReviewWorkflowPlanError(
        'CONFIGURATION_SCOPE_MISMATCH',
        'Workflow initialization requires a workflow-scoped configuration snapshot',
      );
    }
    const imported = importGeneralPlan({
      workflowId: input.workflowId,
      content: input.planContent,
      sourceType: input.sourceType,
      ...(input.sourceLocation === undefined ? {} : { sourceLocation: input.sourceLocation }),
      authorEvidence: input.authorEvidence,
      createdAt: input.createdAt,
    });
    const repositoryAudit = this.repositoryAuditCollector.captureRepositoryAudit({
      repositoryAuditId: input.repositoryAuditId,
      workflowId: input.workflowId,
      actorExecutionId: input.owner.actorExecutionId,
    });
    if (
      repositoryAudit.workflowId !== input.workflowId ||
      repositoryAudit.actorExecutionId !== input.owner.actorExecutionId ||
      repositoryAudit.dirty
    ) {
      throw new ReviewWorkflowPlanError(
        'REPOSITORY_AUDIT_INVALID',
        'Workflow initialization requires a clean, freshly captured repository audit',
      );
    }
    const workflow: WorkflowRun = {
      workflowId: input.workflowId,
      status: 'ACTIVE',
      generalPlanVersionId: imported.generalPlan.generalPlanVersionId,
      implementerAssignmentId: input.configuration.assignments.implementer.assignmentId,
      reviewerAssignmentId: input.configuration.assignments.reviewer.assignmentId,
      configurationHash: input.configuration.configurationHash,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.store.createWorkflowIntake({
      workflow,
      assignments: [
        input.configuration.assignments.implementer,
        input.configuration.assignments.reviewer,
      ],
      owner: input.owner,
      generalPlan: imported.generalPlan,
      requirements: imported.requirements,
      repositoryAudit,
    });
    return {
      workflow,
      repositoryAudit,
      requirementIds: imported.requirements.map((requirement) => requirement.requirementId),
    };
  }

  captureRefinement(
    input: CapturePlanRefinementInput,
  ): HandoffCaptureResult<RefinementCaptureValue> {
    const workflow = this.requireWorkflow(input.workflowId);
    const audit = this.verifyRepositoryContext(
      input.workflowId,
      input.repositoryAuditId,
      input.actor.actorExecutionId,
    );
    const requirements = this.store.listRequirements(workflow.generalPlanVersionId);
    let validationError: string | undefined;
    let contract: ReturnType<typeof parseRefinementResult> | undefined;
    try {
      contract = parseRefinementResult(input.rawTranscript);
      validationError = validateLifecycleRefinement(
        input.workflowId,
        contract,
        requirements.map((requirement) => requirement.requirementId),
        input.expectedFirstBatchId,
      );
    } catch {
      // The contract service records the precise parse failure below.
    }

    return this.store.runAtomically(() => {
      const firstCommandId = derivePlanCommandId(input.expectedFirstBatchId, 'create');
      this.reserveInvocationCommand(
        {
          commandId: firstCommandId,
          workflowId: input.workflowId,
          batchId: input.expectedFirstBatchId,
          expectedAggregateVersion: 0,
          requester: input.actor,
          authorityExercised: 'PLAN_REFINER',
          command: { type: 'CREATE_BATCH' },
        },
        input.preparedInvocation,
      );
      if (contract === undefined || validationError !== undefined) {
        const capture =
          validationError === undefined
            ? this.contractService.captureRefinement({
                ...input,
                generalPlanVersionId: workflow.generalPlanVersionId,
                repositoryContextSha: audit.headSha,
                expectedRequirementIds: requirements.map(
                  (requirement) => requirement.requirementId,
                ),
                requireMaterializedBatchPlans: true,
              })
            : this.contractService.captureRefinementRejection(input, validationError);
        if (capture.accepted) {
          throw new ReviewWorkflowPlanError(
            'REFINEMENT_INVALID',
            'An invalid lifecycle refinement was unexpectedly accepted',
          );
        }
        this.commandStore.recordOutcome({
          commandId: firstCommandId,
          status: 'FAILED_FINAL',
          errorCode: capture.error.code,
          resultHash: hashValue(capture.transcript),
          result: capture.error,
        });
        return capture;
      }

      for (const [index, draft] of contract.batchPlans?.entries() ?? []) {
        const commandId = derivePlanCommandId(draft.batchId, 'create');
        if (index > 0) {
          this.reserveCommand({
            commandId,
            workflowId: input.workflowId,
            batchId: draft.batchId,
            expectedAggregateVersion: 0,
            requester: input.actor,
            authorityExercised: 'PLAN_REFINER',
            command: { type: 'CREATE_BATCH' },
          });
        }
        const transition = requireAllowedTransition(null, { type: 'CREATE_BATCH' }, input.actor);
        const batch: ReviewWorkflowBatch = {
          batchId: draft.batchId,
          workflowId: input.workflowId,
          ordinal: draft.ordinal,
          persistedState: transition.nextState,
          aggregateVersion: 1,
          currentPlanVersionId: draft.batchPlanVersionId,
          implementerAssignmentId: workflow.implementerAssignmentId,
          reviewerAssignmentId: workflow.reviewerAssignmentId,
          originalBatchBaseSha: audit.headSha,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        };
        this.commandStore.succeedWithBatchCreation({
          commandId,
          transition,
          batch,
          eventType: 'BATCH_CREATED_FROM_REFINEMENT',
          eventPayload: {
            refinedPlanVersionId: input.refinedPlanVersionId,
            batchPlanVersionId: draft.batchPlanVersionId,
            ordinal: draft.ordinal,
          },
          resultHash: hashValue(batch),
          result: batch,
        });
      }
      const capture = this.contractService.captureRefinement({
        ...input,
        generalPlanVersionId: workflow.generalPlanVersionId,
        repositoryContextSha: audit.headSha,
        expectedRequirementIds: requirements.map((requirement) => requirement.requirementId),
        requireMaterializedBatchPlans: true,
      });
      if (!capture.accepted) {
        throw new ReviewWorkflowPlanError(
          'REFINEMENT_INVALID',
          `Prevalidated refinement was rejected: ${capture.error.message}`,
        );
      }
      this.store.updateRefinedPlanPointer(
        input.workflowId,
        capture.value.refinedPlan.refinedPlanVersionId,
        input.createdAt,
      );
      return capture;
    });
  }

  capturePlanReview(input: CapturePlanReviewInput): CapturePlanReviewResult {
    const batch = this.requireBatch(input.batchId);
    if (batch.workflowId !== input.workflowId) {
      throw new ReviewWorkflowPlanError(
        'BATCH_NOT_FOUND',
        `Batch ${input.batchId} does not belong to workflow ${input.workflowId}`,
      );
    }
    const plan = this.store.getBatchPlan(batch.currentPlanVersionId);
    if (plan === null) {
      throw new ReviewWorkflowPlanError(
        'BATCH_NOT_FOUND',
        `Current batch plan ${batch.currentPlanVersionId} does not exist`,
      );
    }
    const audit = this.store.getLatestRepositoryAudit(input.workflowId);
    if (audit === null || audit.headSha !== plan.repositoryContextSha) {
      throw new ReviewWorkflowPlanError(
        'REPOSITORY_AUDIT_INVALID',
        'Plan review target is not bound to the workflow repository audit',
      );
    }
    this.verifyRepositoryContext(
      input.workflowId,
      audit.repositoryAuditId,
      input.actor.actorExecutionId,
    );
    const startCommandId = derivePlanCommandId(input.batchId, `review-${input.reviewRoundNumber}`);
    return this.store.runAtomically(() => {
      const startCommand: TransitionCommand = {
        type: 'START_PLAN_REVIEW',
        roleSeparation: input.roleSeparation,
      };
      this.reserveInvocationCommand(
        {
          commandId: startCommandId,
          workflowId: input.workflowId,
          batchId: input.batchId,
          expectedAggregateVersion: batch.aggregateVersion,
          requester: input.actor,
          authorityExercised: 'REVIEWER',
          command: startCommand,
        },
        input.preparedInvocation,
      );
      const capture = this.contractService.captureReview({
        ...input,
        expectedTarget: {
          kind: 'PLAN',
          planVersionId: plan.batchPlanVersionId,
          planContentHash: plan.contentHash,
          repositoryContextSha: plan.repositoryContextSha,
        },
      });
      if (!capture.accepted) {
        this.commandStore.recordOutcome({
          commandId: startCommandId,
          status: 'FAILED_FINAL',
          errorCode: capture.error.code,
          resultHash: hashValue(capture.transcript),
          result: capture.error,
        });
        return {
          capture,
          state: batch.persistedState,
          blockingFindingCount: 0,
        };
      }
      const blockingFindingCount = capture.value.findings.filter(
        (finding) =>
          finding.status === 'OPEN' && input.blockingSeverities.includes(finding.severity),
      ).length;
      const policyVerdict = blockingFindingCount === 0 ? 'APPROVED' : 'NEEDS_REVISION';
      if (capture.value.contract.verdict !== policyVerdict) {
        this.commandStore.recordOutcome({
          commandId: startCommandId,
          status: 'FAILED_FINAL',
          errorCode: 'PLAN_REVIEW_POLICY_MISMATCH',
          resultHash: hashValue(capture.value.review),
          result: { expectedVerdict: policyVerdict },
        });
        return {
          capture,
          state: batch.persistedState,
          blockingFindingCount,
        };
      }
      const startTransition = requireAllowedTransition(
        batch.persistedState,
        startCommand,
        input.actor,
      );
      this.commandStore.succeedWithTransition({
        commandId: startCommandId,
        transition: startTransition,
        eventType: 'PLAN_REVIEW_STARTED',
        eventPayload: { reviewRoundId: input.reviewRoundId },
        resultHash: hashValue(capture.value.review),
        result: capture.value.review,
      });
      const current = this.requireBatch(input.batchId);
      const evidence = {
        reviewedPlanVersionId: plan.batchPlanVersionId,
        currentPlanVersionId: current.currentPlanVersionId,
        reviewedPlanContentHash: plan.contentHash,
        currentPlanContentHash: plan.contentHash,
        unresolvedFindingCount: blockingFindingCount,
        incompleteDispositionCount: 0,
        roleSeparation: input.roleSeparation,
      };
      const decisionCommand: TransitionCommand =
        blockingFindingCount === 0
          ? { type: 'APPROVE_PLAN', evidence }
          : { type: 'REJECT_PLAN', evidence };
      const decisionCommandId = derivePlanCommandId(
        input.batchId,
        `review-${input.reviewRoundNumber}-decision`,
      );
      this.reserveCommand({
        commandId: decisionCommandId,
        workflowId: input.workflowId,
        batchId: input.batchId,
        expectedAggregateVersion: current.aggregateVersion,
        requester: input.actor,
        authorityExercised: 'REVIEWER',
        command: decisionCommand,
      });
      const decisionTransition = requireAllowedTransition(
        current.persistedState,
        decisionCommand,
        input.actor,
      );
      this.commandStore.succeedWithTransition({
        commandId: decisionCommandId,
        transition: decisionTransition,
        eventType: blockingFindingCount === 0 ? 'BATCH_PLAN_APPROVED' : 'BATCH_PLAN_NEEDS_REVISION',
        eventPayload: {
          reviewRoundId: input.reviewRoundId,
          blockingFindingCount,
        },
        resultHash: hashValue({
          reviewRoundId: input.reviewRoundId,
          state: decisionTransition.nextState,
        }),
      });
      return {
        capture,
        state: decisionTransition.nextState,
        blockingFindingCount,
      };
    });
  }

  getStatus(workflowId: string): ReviewWorkflowPlanStatus {
    return {
      workflow: this.requireWorkflow(workflowId),
      batches: this.store.listBatches(workflowId),
    };
  }

  verifyRepositoryContext(
    workflowId: string,
    repositoryAuditId: string,
    actorExecutionId: string,
  ): RepositoryAudit {
    const persisted = this.store.getRepositoryAudit(repositoryAuditId);
    if (persisted === null || persisted.workflowId !== workflowId || persisted.dirty) {
      throw new ReviewWorkflowPlanError(
        'REPOSITORY_AUDIT_INVALID',
        'Plan work must bind to a clean persisted repository audit for this workflow',
      );
    }
    const fresh = this.repositoryAuditCollector.captureRepositoryAudit({
      repositoryAuditId: `${repositoryAuditId}:fresh-check`,
      workflowId,
      actorExecutionId,
    });
    if (
      fresh.dirty ||
      fresh.headSha !== persisted.headSha ||
      fresh.branch !== persisted.branch ||
      fresh.repositoryRoot !== persisted.repositoryRoot
    ) {
      throw new ReviewWorkflowPlanError(
        'REPOSITORY_AUDIT_INVALID',
        'Repository state changed after the persisted audit; capture a new workflow intake audit',
      );
    }
    return persisted;
  }

  private reserveInvocationCommand(
    request: Omit<StateChangingCommandRequest, 'canonicalRequestHash'>,
    preparedInvocation: PreparedRoleInvocation | undefined,
  ): void {
    if (
      preparedInvocation !== undefined &&
      preparedInvocation.invocation.commandId !== request.commandId
    ) {
      throw new ReviewWorkflowPlanError(
        'REFINEMENT_COMMAND_MISMATCH',
        'Prepared role invocation is not bound to the authoritative workflow command',
      );
    }
    const sideEffectKind: ReviewWorkflowSideEffectKind | undefined =
      preparedInvocation === undefined ? undefined : 'AGENT_INVOCATION';
    this.commandStore.reserve(withCanonicalHash(request), sideEffectKind);
    if (preparedInvocation !== undefined) {
      if (this.roleInvocationService === undefined) {
        throw new ReviewWorkflowPlanError(
          'ROLE_INVOCATION_SERVICE_REQUIRED',
          'Prepared role evidence requires a RoleInvocationService',
        );
      }
      this.commandStore.claimSideEffect(
        request.commandId,
        preparedInvocation.invocation.invocationId,
      );
      this.roleInvocationService.persistPrepared(preparedInvocation);
    }
  }

  private reserveCommand(request: Omit<StateChangingCommandRequest, 'canonicalRequestHash'>): void {
    this.commandStore.reserve(withCanonicalHash(request));
  }

  private requireWorkflow(workflowId: string): WorkflowRun {
    const workflow = this.store.getWorkflow(workflowId);
    if (workflow === null) {
      throw new ReviewWorkflowPlanError(
        'WORKFLOW_NOT_FOUND',
        `Workflow ${workflowId} does not exist`,
      );
    }
    return workflow;
  }

  private requireBatch(batchId: string): ReviewWorkflowBatch {
    const batch = this.store.getBatch(batchId);
    if (batch === null) {
      throw new ReviewWorkflowPlanError('BATCH_NOT_FOUND', `Batch ${batchId} does not exist`);
    }
    return batch;
  }
}

export function deriveWorkflowBatchId(workflowId: string, ordinal: number): string {
  return `${workflowId}:batch:${ordinal}`;
}

export function deriveBatchPlanVersionId(batchId: string, version = 1): string {
  return `${batchId}:plan:${version}`;
}

export function derivePlanCommandId(batchId: string, operation: string): string {
  return `${batchId}:${operation}`;
}

function validateLifecycleRefinement(
  workflowId: string,
  contract: ReturnType<typeof parseRefinementResult>,
  expectedRequirementIds: readonly string[],
  expectedFirstBatchId: string,
): string | undefined {
  const drafts = contract.batchPlans;
  if (drafts === undefined || drafts.length === 0) {
    return 'Plan-lifecycle refinement requires complete materialized batch plans';
  }
  const expectedRequirements = [...expectedRequirementIds].sort();
  const actualRequirements = contract.requirementCoverage
    .map((coverage) => coverage.requirementId)
    .sort();
  if (JSON.stringify(expectedRequirements) !== JSON.stringify(actualRequirements)) {
    return 'Requirement coverage must exactly match the imported general plan';
  }
  for (const [index, draft] of drafts.entries()) {
    const ordinal = index + 1;
    const expectedBatchId = deriveWorkflowBatchId(workflowId, ordinal);
    if (
      draft.ordinal !== ordinal ||
      draft.batchId !== expectedBatchId ||
      draft.batchPlanVersionId !== deriveBatchPlanVersionId(expectedBatchId)
    ) {
      return 'Batch and plan identifiers must follow the authoritative sequential ID vocabulary';
    }
    const earlierBatchIds = new Set(drafts.slice(0, index).map((candidate) => candidate.batchId));
    if (draft.dependencies.some((dependency) => !earlierBatchIds.has(dependency))) {
      return `Batch ${draft.batchId} may depend only on earlier batches in this refinement`;
    }
  }
  const expectedRequirementSet = new Set(expectedRequirementIds);
  const criteria = new Map(
    drafts.flatMap((draft) =>
      draft.acceptanceCriteria.map(
        (criterion) =>
          [
            criterion.acceptanceCriterionId,
            { planVersionId: draft.batchPlanVersionId, criterion },
          ] as const,
      ),
    ),
  );
  for (const { acceptanceCriteria } of drafts) {
    for (const criterion of acceptanceCriteria) {
      if (
        criterion.sourceRequirementIds.some(
          (requirementId) => !expectedRequirementSet.has(requirementId),
        )
      ) {
        return `Criterion ${criterion.acceptanceCriterionId} references an unknown requirement`;
      }
    }
  }
  for (const coverage of contract.requirementCoverage) {
    for (const criterionId of coverage.acceptanceCriterionIds) {
      const materialized = criteria.get(criterionId);
      if (
        materialized === undefined ||
        !materialized.criterion.sourceRequirementIds.includes(coverage.requirementId) ||
        !coverage.batchPlanVersionIds.includes(materialized.planVersionId)
      ) {
        return 'Requirement coverage must agree with each criterion source and owning batch plan';
      }
    }
  }
  const coveredCriterionIds = new Set(
    contract.requirementCoverage.flatMap((coverage) => coverage.acceptanceCriterionIds),
  );
  if ([...criteria.keys()].some((criterionId) => !coveredCriterionIds.has(criterionId))) {
    return 'Every acceptance criterion must be traceable through requirement coverage';
  }
  if (drafts[0]?.batchId !== expectedFirstBatchId) {
    return 'The first materialized batch does not match the authoritative intake batch';
  }
  return undefined;
}

function withCanonicalHash(
  request: Omit<StateChangingCommandRequest, 'canonicalRequestHash'>,
): StateChangingCommandRequest {
  return {
    ...request,
    canonicalRequestHash: hashValue(request),
  };
}

function requireAllowedTransition(
  currentState: ReviewWorkflowBatch['persistedState'] | null,
  command: TransitionCommand,
  actor: ActorExecutionIdentity,
): AllowedTransition {
  const transition = transitionBatch({ currentState, command, actor });
  if (!transition.allowed) {
    throw new ReviewWorkflowPlanError(
      'TRANSITION_REJECTED',
      `${command.type} rejected by the domain kernel: ${transition.code}`,
    );
  }
  return transition;
}

function hashValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ReviewWorkflowPlanError(
      'REFINEMENT_INVALID',
      'Workflow plan evidence is not serializable',
    );
  }
  return createHash('sha256').update(serialized).digest('hex');
}
