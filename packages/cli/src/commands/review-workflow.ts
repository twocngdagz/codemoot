import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ModelRegistry,
  RoleInvocationService,
  RoleManager,
  generateId,
  loadConfig,
  type openDatabase,
  reviewWorkflowContracts,
  reviewWorkflowGit,
  reviewWorkflowIdentity,
  reviewWorkflowPersistence,
  reviewWorkflowPlan,
} from '@codemoot/core';
import { withDatabase } from '../utils.js';

interface WorkflowStartOptions {
  readonly id?: string;
}

interface WorkflowInvocationOptions {
  readonly timeout: number;
}

interface BatchReviewPlanOptions extends WorkflowInvocationOptions {
  readonly round: number;
}

export async function reviewWorkflowStartCommand(
  planFile: string,
  options: WorkflowStartOptions,
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const config = loadConfig({ projectDir });
    const workflowId = options.id ?? generateId('review-workflow');
    const now = new Date().toISOString();
    const configuration = reviewWorkflowIdentity.createReviewWorkflowConfigurationSnapshot(config, {
      workflowId,
      implementerAssignmentId: `${workflowId}:assignment:implementer`,
      reviewerAssignmentId: `${workflowId}:assignment:reviewer`,
      assignedAt: now,
    });
    const planPath = resolve(projectDir, planFile);
    const owner: reviewWorkflowPlan.InitializeReviewWorkflowInput['owner'] = {
      actorExecutionId: `${workflowId}:owner:${generateId('execution')}`,
      actorType: 'HUMAN',
      authoritiesExercised: ['WORKFLOW_OWNER'],
      identityAssurance: 'CLI_ASSERTED',
      observedEvidence: [
        {
          kind: 'LOCAL_CLI',
          source: 'codemoot workflow start',
          observedAt: now,
        },
      ],
      startedAt: now,
      finishedAt: now,
    };
    const runtime = createRuntime(db, projectDir);
    const result = runtime.service.initialize({
      workflowId,
      planContent: readFileSync(planPath, 'utf8'),
      sourceType: 'MARKDOWN_FILE',
      sourceLocation: planPath,
      authorEvidence: owner.observedEvidence,
      owner,
      configuration,
      repositoryAuditId: `${workflowId}:repository-audit:1`,
      createdAt: now,
    });
    printJson({
      workflowId,
      status: result.workflow.status,
      generalPlanVersionId: result.workflow.generalPlanVersionId,
      repositoryAuditId: result.repositoryAudit.repositoryAuditId,
      repositoryContextSha: result.repositoryAudit.headSha,
      requirementCount: result.requirementIds.length,
    });
  });
}

export async function reviewWorkflowStatusCommand(workflowId: string): Promise<void> {
  await withDatabase(async (db) => {
    const runtime = createRuntime(db, process.cwd());
    const status = runtime.service.getStatus(workflowId);
    printJson({
      workflow: status.workflow,
      batches: status.batches.map((batch) => ({
        batchId: batch.batchId,
        ordinal: batch.ordinal,
        state: batch.persistedState,
        planVersionId: batch.currentPlanVersionId,
        aggregateVersion: batch.aggregateVersion,
      })),
    });
  });
}

export async function reviewWorkflowRefineCommand(
  workflowId: string,
  options: WorkflowInvocationOptions,
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const runtime = createRuntime(db, projectDir);
    const context = resolveRuntimeContext(runtime.store, workflowId, projectDir);
    if (
      context.workflow.refinedPlanVersionId !== undefined ||
      runtime.store.listBatches(workflowId).length > 0
    ) {
      throw new Error(`Workflow ${workflowId} already has an initial materialized refinement`);
    }
    const requirements = runtime.store.listRequirements(context.workflow.generalPlanVersionId);
    const generalPlan = runtime.store.getGeneralPlan(context.workflow.generalPlanVersionId);
    const audit = runtime.store.getLatestRepositoryAudit(workflowId);
    if (generalPlan === null || audit === null) {
      throw new Error(`Workflow ${workflowId} is missing its plan or repository audit`);
    }
    const firstBatchId = reviewWorkflowPlan.deriveWorkflowBatchId(workflowId, 1);
    const commandId = reviewWorkflowPlan.derivePlanCommandId(firstBatchId, 'create');
    const actorExecutionId = `${workflowId}:refiner:${generateId('execution')}`;
    const invocationId = `${workflowId}:refiner:${generateId('invocation')}`;
    const sessionIdentityId = `${workflowId}:refiner:${generateId('session')}`;
    runtime.service.verifyRepositoryContext(workflowId, audit.repositoryAuditId, actorExecutionId);
    const prepared = await runtime.roleInvocation.prepare({
      resolution: context.roles.implementer,
      workflowId,
      commandId,
      actorExecutionId,
      invocationId,
      sessionIdentityId,
      prompt: buildRefinementPrompt({
        workflowId,
        repositoryAudit: audit,
        generalPlanContent: generalPlan.content,
        requirements: requirements.map((requirement) => ({
          requirementId: requirement.requirementId,
          sourceReference: requirement.sourceReference,
          statement: requirement.statement,
        })),
      }),
      options: { timeout: options.timeout * 1000 },
      additionalAuthorities: ['PLAN_REFINER'],
    });
    const createdAt = prepared.invocation.finishedAt ?? new Date().toISOString();
    const result = runtime.service.captureRefinement({
      transcriptId: `${workflowId}:refinement:${generateId('transcript')}`,
      workflowId,
      actorExecutionId,
      invocationId,
      sessionIdentityId: prepared.session.sessionIdentityId,
      rawTranscript: prepared.call.text,
      createdAt,
      expectedFirstBatchId: firstBatchId,
      refinedPlanVersionId: `${workflowId}:refined-plan:1`,
      repositoryAuditId: audit.repositoryAuditId,
      version: 1,
      actor: prepared.execution,
      preparedInvocation: prepared,
    });
    printJson(
      result.accepted
        ? {
            accepted: true,
            workflowId,
            refinedPlanVersionId: result.value.refinedPlan.refinedPlanVersionId,
            batches: result.value.batchPlans.map((plan) => ({
              batchId: plan.batchId,
              batchPlanVersionId: plan.batchPlanVersionId,
            })),
          }
        : {
            accepted: false,
            workflowId,
            error: result.error,
            transcriptId: result.transcript.transcriptId,
          },
    );
  });
}

export async function reviewWorkflowBatchListCommand(workflowId: string): Promise<void> {
  await withDatabase(async (db) => {
    const store = new reviewWorkflowPlan.ReviewWorkflowPlanStore(db);
    const workflow = store.getWorkflow(workflowId);
    if (workflow === null) throw new Error(`Workflow ${workflowId} does not exist`);
    printJson(
      store.listBatches(workflowId).map((batch) => ({
        batchId: batch.batchId,
        ordinal: batch.ordinal,
        state: batch.persistedState,
        planVersionId: batch.currentPlanVersionId,
      })),
    );
  });
}

export async function reviewWorkflowBatchShowCommand(
  workflowId: string,
  ordinalValue: string,
): Promise<void> {
  await withDatabase(async (db) => {
    const ordinal = parsePositiveInteger(ordinalValue, 'batch ordinal');
    const store = new reviewWorkflowPlan.ReviewWorkflowPlanStore(db);
    const batch = store.listBatches(workflowId).find((candidate) => candidate.ordinal === ordinal);
    if (batch === undefined) {
      throw new Error(`Workflow ${workflowId} has no batch ${ordinal}`);
    }
    const plan = store.getBatchPlan(batch.currentPlanVersionId);
    if (plan === null) throw new Error(`Batch ${batch.batchId} has no current plan`);
    printJson({
      batch,
      plan,
      acceptanceCriteria: store.listAcceptanceCriteria(plan.batchPlanVersionId),
      planFindings: store.listPlanFindings(batch.batchId),
    });
  });
}

export async function reviewWorkflowBatchReviewPlanCommand(
  workflowId: string,
  ordinalValue: string,
  options: BatchReviewPlanOptions,
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const ordinal = parsePositiveInteger(ordinalValue, 'batch ordinal');
    const runtime = createRuntime(db, projectDir);
    const context = resolveRuntimeContext(runtime.store, workflowId, projectDir);
    const batch = runtime.store
      .listBatches(workflowId)
      .find((candidate) => candidate.ordinal === ordinal);
    if (batch === undefined) throw new Error(`Workflow ${workflowId} has no batch ${ordinal}`);
    if (batch.persistedState !== 'DRAFT') {
      throw new Error(
        `Batch ${batch.batchId} cannot start an initial plan review from ${batch.persistedState}`,
      );
    }
    const plan = runtime.store.getBatchPlan(batch.currentPlanVersionId);
    if (plan === null) throw new Error(`Batch ${batch.batchId} has no current plan`);
    const commandId = reviewWorkflowPlan.derivePlanCommandId(
      batch.batchId,
      `review-${options.round}`,
    );
    const actorExecutionId = `${batch.batchId}:reviewer:${generateId('execution')}`;
    const invocationId = `${batch.batchId}:reviewer:${generateId('invocation')}`;
    const sessionIdentityId = `${batch.batchId}:reviewer:${generateId('session')}`;
    const audit = runtime.store.getLatestRepositoryAudit(workflowId);
    if (audit === null) throw new Error(`Workflow ${workflowId} has no repository audit`);
    runtime.service.verifyRepositoryContext(workflowId, audit.repositoryAuditId, actorExecutionId);
    const prepared = await runtime.roleInvocation.prepare({
      resolution: context.roles.reviewer,
      workflowId,
      commandId,
      actorExecutionId,
      invocationId,
      sessionIdentityId,
      prompt: buildPlanReviewPrompt({
        workflowId,
        batchPlan: plan,
        acceptanceCriteria: runtime.store.listAcceptanceCriteria(plan.batchPlanVersionId),
      }),
      options: { timeout: options.timeout * 1000 },
    });
    const roleSeparation = {
      implementerAssignment: context.snapshot.assignments.implementer,
      reviewerAssignment: context.snapshot.assignments.reviewer,
      reviewerSessionIdentityId: prepared.session.sessionIdentityId,
      minimumIdentityAssurance: context.snapshot.identityPolicy.minimumAssurance,
    };
    const result = runtime.service.capturePlanReview({
      transcriptId: `${batch.batchId}:plan-review:${generateId('transcript')}`,
      workflowId,
      batchId: batch.batchId,
      actorExecutionId,
      invocationId,
      sessionIdentityId: prepared.session.sessionIdentityId,
      rawTranscript: prepared.call.text,
      createdAt: prepared.invocation.finishedAt ?? new Date().toISOString(),
      reviewRoundId: `${batch.batchId}:plan-review:${options.round}`,
      reviewRoundNumber: options.round,
      actor: prepared.execution,
      roleSeparation,
      blockingSeverities: context.snapshot.gates.blockingSeverities,
      preparedInvocation: prepared,
    });
    printJson({
      accepted: result.capture.accepted,
      workflowId,
      batchId: batch.batchId,
      state: result.state,
      blockingFindingCount: result.blockingFindingCount,
      ...(result.capture.accepted ? {} : { error: result.capture.error }),
    });
  });
}

export function buildRefinementPrompt(input: {
  readonly workflowId: string;
  readonly repositoryAudit: unknown;
  readonly generalPlanContent: string;
  readonly requirements: readonly {
    readonly requirementId: string;
    readonly sourceReference: string;
    readonly statement: string;
  }[];
}): string {
  return `Act as the assigned plan refiner. Audit the supplied repository evidence against the external plan, then return one complete refined batch plan.

Output exactly one JSON object and nothing else. It must satisfy the strict REFINEMENT_RESULT schemaVersion 1 contract. Include batchPlans with every field required by the CodeMoot batch-plan contract. Use sequential ordinals starting at 1. For ordinal N use:
- batchId: ${input.workflowId}:batch:N
- batchPlanVersionId: ${input.workflowId}:batch:N:plan:1

Every imported requirement must appear exactly once in requirementCoverage and must map to at least one declared batch plan and acceptance criterion. Dependencies may reference only earlier batch IDs. Do not include implementation work in this response.

Repository audit:
${JSON.stringify(input.repositoryAudit, null, 2)}

Imported requirements:
${JSON.stringify(input.requirements, null, 2)}

External general plan:
${input.generalPlanContent}`;
}

export function buildPlanReviewPrompt(input: {
  readonly workflowId: string;
  readonly batchPlan: {
    readonly batchPlanVersionId: string;
    readonly contentHash: string;
    readonly repositoryContextSha: string;
  };
  readonly acceptanceCriteria: readonly unknown[];
}): string {
  return `Act as the independent plan reviewer for workflow ${input.workflowId}. Inspect the complete batch plan for correctness, repository grounding, dependencies, user journey, verification, documentation, rollback, and scope.

Output exactly one JSON object and nothing else. It must satisfy the strict REVIEW_RESULT schemaVersion 1 contract. Echo this authoritative PLAN target exactly:
${JSON.stringify(
  {
    kind: 'PLAN',
    planVersionId: input.batchPlan.batchPlanVersionId,
    planContentHash: input.batchPlan.contentHash,
    repositoryContextSha: input.batchPlan.repositoryContextSha,
  },
  null,
  2,
)}

Return APPROVED only when there are no blocking findings. Otherwise return NEEDS_REVISION with one consolidated finding list. Do not implement or modify code.

Batch plan:
${JSON.stringify(input.batchPlan, null, 2)}

Acceptance criteria:
${JSON.stringify(input.acceptanceCriteria, null, 2)}`;
}

function createRuntime(db: ReturnType<typeof openDatabase>, projectDir: string) {
  const store = new reviewWorkflowPlan.ReviewWorkflowPlanStore(db);
  const roleInvocation = new RoleInvocationService(store.workflowStore);
  const repository = new reviewWorkflowGit.LocalGitRepository(projectDir);
  const gitService = new reviewWorkflowGit.ReviewWorkflowGitService(repository, {
    storePatch: () => {
      throw new Error('Plan lifecycle does not capture Git patch artifacts');
    },
  });
  return {
    store,
    roleInvocation,
    service: new reviewWorkflowPlan.ReviewWorkflowPlanService(
      store,
      new reviewWorkflowPersistence.ReviewWorkflowCommandStore(db),
      new reviewWorkflowContracts.ReviewWorkflowContractService(store.workflowStore),
      gitService,
      roleInvocation,
    ),
  };
}

function resolveRuntimeContext(
  store: reviewWorkflowPlan.ReviewWorkflowPlanStore,
  workflowId: string,
  projectDir: string,
) {
  const workflow = store.getWorkflow(workflowId);
  if (workflow === null) throw new Error(`Workflow ${workflowId} does not exist`);
  const implementer = store.getAssignment(workflow.implementerAssignmentId);
  const reviewer = store.getAssignment(workflow.reviewerAssignmentId);
  if (implementer === null || reviewer === null) {
    throw new Error(`Workflow ${workflowId} is missing its immutable role assignments`);
  }
  const config = loadConfig({ projectDir });
  const fresh = reviewWorkflowIdentity.createReviewWorkflowConfigurationSnapshot(config, {
    workflowId,
    implementerAssignmentId: implementer.assignmentId,
    reviewerAssignmentId: reviewer.assignmentId,
    assignedAt: implementer.assignedAt,
  });
  const snapshot = reviewWorkflowIdentity.reviewWorkflowConfigurationSnapshotSchema.parse({
    ...fresh,
    assignments: { implementer, reviewer },
  });
  const registry = ModelRegistry.fromConfig(config, projectDir);
  const roles = new RoleManager(config).resolveReviewWorkflowRoles(snapshot, registry);
  return { workflow, snapshot, roles };
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  return Number.parseInt(value, 10);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
