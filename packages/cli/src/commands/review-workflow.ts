import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  reviewWorkflowImplementation,
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

interface BatchImplementOptions extends WorkflowInvocationOptions {
  readonly commitMode?: 'agent' | 'human';
}

interface BatchCompleteImplementationOptions {
  readonly commit: string;
  readonly commitMode: 'agent' | 'human';
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
      batches: status.batches.map((batch) => {
        const implementer = runtime.store.getAssignment(batch.implementerAssignmentId);
        const reviewer = runtime.store.getAssignment(batch.reviewerAssignmentId);
        const attempts = runtime.implementationStore.listImplementationAttempts(batch.batchId);
        const latestAttempt = attempts.at(-1);
        const implementerExecution =
          latestAttempt === undefined
            ? null
            : runtime.implementationStore.getActorExecution(
                latestAttempt.implementerActorExecutionId,
              );
        const commitEvent =
          latestAttempt === undefined
            ? undefined
            : runtime.implementationStore
                .getEvents(batch.batchId)
                .filter((event) => event.eventType === 'IMPLEMENTATION_COMMIT_VALIDATED')
                .at(-1);
        const commitSha =
          typeof commitEvent?.payload.resultingCommitSha === 'string'
            ? commitEvent.payload.resultingCommitSha
            : undefined;
        const implementationCommit =
          commitSha === undefined
            ? null
            : runtime.store.workflowStore.getEntity('IMPLEMENTATION_COMMIT', commitSha);
        const commitCreator =
          implementationCommit?.kind === 'IMPLEMENTATION_COMMIT'
            ? {
                resultingCommitSha: implementationCommit.value.resultingCommitSha,
                creationMode: implementationCommit.value.creationMode,
                creatorActorExecutionId: implementationCommit.value.creatorActorExecutionId,
                creatorActorType:
                  runtime.implementationStore.getActorExecution(
                    implementationCommit.value.creatorActorExecutionId,
                  )?.actorType ?? null,
              }
            : null;
        const latestReview = runtime.implementationStore.listCodeReviews(batch.batchId).at(-1);
        const reviewerExecution =
          latestReview === undefined
            ? null
            : runtime.implementationStore.getActorExecution(latestReview.reviewerActorExecutionId);
        return {
          batchId: batch.batchId,
          ordinal: batch.ordinal,
          state: batch.persistedState,
          planVersionId: batch.currentPlanVersionId,
          aggregateVersion: batch.aggregateVersion,
          implementer:
            implementer === null
              ? null
              : {
                  assignmentId: implementer.assignmentId,
                  configuredAgentKey: implementer.configuredAgentKey,
                  adapterKind: implementer.expectedAdapterKind,
                  identityAssurance: implementerExecution?.identityAssurance ?? 'CONFIG_ONLY',
                },
          reviewer:
            reviewer === null
              ? null
              : {
                  assignmentId: reviewer.assignmentId,
                  configuredAgentKey: reviewer.configuredAgentKey,
                  adapterKind: reviewer.expectedAdapterKind,
                  identityAssurance: reviewerExecution?.identityAssurance ?? 'CONFIG_ONLY',
                },
          commitCreator,
          codeReviewRounds: runtime.implementationStore
            .getEvents(batch.batchId)
            .filter((event) => event.eventType === 'CODE_REVIEW_STARTED').length,
        };
      }),
    });
  });
}

export async function reviewWorkflowBatchFindingsCommand(
  workflowId: string,
  ordinalValue: string,
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const ordinal = parsePositiveInteger(ordinalValue, 'batch ordinal');
    const runtime = createRuntime(db, projectDir);
    resolveRuntimeContext(runtime.store, workflowId, projectDir);
    const batch = runtime.store
      .listBatches(workflowId)
      .find((candidate) => candidate.ordinal === ordinal);
    if (batch === undefined) throw new Error(`Workflow ${workflowId} has no batch ${ordinal}`);
    const reviews = runtime.implementationStore.listCodeReviews(batch.batchId);
    printJson({
      workflowId,
      batchId: batch.batchId,
      rounds: reviews.map((review) => ({
        reviewRoundId: review.reviewRoundId,
        round: review.reviewRoundNumber,
        verdict: review.verdict,
        findings: review.findingIds.map((findingId) => {
          const finding = runtime.implementationStore.getFinding(findingId);
          const dispositions = runtime.implementationStore.listDispositionsForFinding(findingId);
          return finding === null
            ? { findingId, missing: true }
            : {
                findingId,
                severity: finding.severity,
                category: finding.category,
                title: finding.title,
                status: finding.status,
                acceptanceCriterionId: finding.acceptanceCriterionId ?? null,
                dispositions: dispositions.map((disposition) => ({
                  dispositionId: disposition.dispositionId,
                  disposition: disposition.disposition,
                  reviewerDecision: disposition.reviewerDecision.decision,
                })),
              };
        }),
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

export async function reviewWorkflowBatchImplementCommand(
  workflowId: string,
  ordinalValue: string,
  options: BatchImplementOptions,
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
    const plan = runtime.store.getBatchPlan(batch.currentPlanVersionId);
    if (plan === null) throw new Error(`Batch ${batch.batchId} has no current plan`);
    const acceptanceCriteria = runtime.store.listAcceptanceCriteria(plan.batchPlanVersionId);
    const creationMode = resolveImplementationCommitMode(
      options.commitMode,
      context.snapshot.commitPolicy,
    );
    const implementerSessionIdentityId =
      batch.persistedState === 'IMPLEMENTING'
        ? requireImplementationSessionIdentityId(runtime.implementationStore, batch.batchId)
        : (
            await runtime.implementationService.start({
              workflowId,
              batchId: batch.batchId,
              configuration: context.snapshot,
              resolution: context.roles.implementer,
              commandId: `${batch.batchId}:start-implementation`,
              actorExecutionId: `${batch.batchId}:implementer-preflight:${generateId('execution')}`,
              invocationId: `${batch.batchId}:implementer-preflight:${generateId('invocation')}`,
              sessionIdentityId: `${batch.batchId}:implementer:${generateId('session')}`,
              prompt: buildImplementationPreflightPrompt({
                workflowId,
                batchId: batch.batchId,
                planVersionId: plan.batchPlanVersionId,
              }),
              options: { timeout: options.timeout * 1000 },
            })
          ).implementerSessionIdentityId;
    const implementationBatch = runtime.implementationStore.getBatch(batch.batchId);
    if (implementationBatch?.originalBatchBaseSha === undefined) {
      throw new Error(`Batch ${batch.batchId} has no established implementation base`);
    }
    const attemptNumber =
      runtime.implementationStore.listImplementationAttempts(batch.batchId).length + 1;
    const commandId = `${batch.batchId}:implementation:${attemptNumber}:ready`;
    const result = await runtime.implementationService.execute({
      workflowId,
      batchId: batch.batchId,
      configuration: context.snapshot,
      resolution: context.roles.implementer,
      commandId,
      actorExecutionId: `${batch.batchId}:implementer:${generateId('execution')}`,
      invocationId: `${batch.batchId}:implementer:${generateId('invocation')}`,
      sessionIdentityId: implementerSessionIdentityId,
      previousSessionIdentityId: implementerSessionIdentityId,
      transcriptId: `${batch.batchId}:implementation:${attemptNumber}:transcript`,
      implementationAttemptId: reviewWorkflowImplementation.deriveImplementationAttemptId(
        batch.batchId,
        attemptNumber,
      ),
      implementationReadyEvidenceId:
        reviewWorkflowImplementation.deriveImplementationReadyEvidenceId(
          reviewWorkflowImplementation.deriveImplementationAttemptId(batch.batchId, attemptNumber),
        ),
      attemptNumber,
      creationMode,
      prompt: buildImplementationPrompt({
        workflowId,
        batchPlan: plan,
        acceptanceCriteria,
        originalBatchBaseSha: implementationBatch.originalBatchBaseSha,
        creationMode,
      }),
      options: { timeout: options.timeout * 1000 },
    });
    printJson(
      result.status === 'AWAITING_COMMIT'
        ? {
            status: result.status,
            workflowId,
            batchId: batch.batchId,
            implementationAttemptId: result.attempt.implementationAttemptId,
            implementationReadyEvidenceId:
              result.implementationReadyEvidence.implementationReadyEvidenceId,
            creationMode,
            nextCommand: `codemoot batch complete-implementation ${workflowId} ${ordinal} --commit <sha> --commit-mode ${creationMode === 'AGENT_AUTHORIZED' ? 'agent' : 'human'}`,
          }
        : result.status === 'BLOCKED'
          ? {
              status: result.status,
              workflowId,
              batchId: batch.batchId,
              implementationAttemptId: result.attempt.implementationAttemptId,
            }
          : {
              status: result.status,
              workflowId,
              batchId: batch.batchId,
              errorCode: result.errorCode,
              message: result.message,
            },
    );
  });
}

export async function reviewWorkflowBatchCompleteImplementationCommand(
  workflowId: string,
  ordinalValue: string,
  options: BatchCompleteImplementationOptions,
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
    const attempts = runtime.implementationStore.listImplementationAttempts(batch.batchId);
    const attempt = attempts.at(-1);
    if (attempt === undefined) throw new Error(`Batch ${batch.batchId} has no implementation`);
    const readyEvidence = runtime.implementationStore
      .listImplementationReadyEvidence(attempt.implementationAttemptId)
      .at(-1);
    if (readyEvidence === undefined) {
      throw new Error(`Implementation ${attempt.implementationAttemptId} is not ready`);
    }
    const creationMode = options.commitMode === 'agent' ? 'AGENT_AUTHORIZED' : 'HUMAN_CREATED';
    const now = new Date().toISOString();
    const humanCreator: reviewWorkflowImplementation.CompleteImplementationInput['humanCreator'] =
      creationMode === 'HUMAN_CREATED'
        ? {
            actorExecutionId: `${batch.batchId}:human-commit:${generateId('execution')}`,
            actorType: 'HUMAN',
            authoritiesExercised: ['COMMIT_CREATOR'],
            identityAssurance: 'CLI_ASSERTED',
            observedEvidence: [
              {
                kind: 'LOCAL_CLI',
                source: 'codemoot batch complete-implementation',
                observedAt: now,
              },
            ],
            startedAt: now,
            finishedAt: now,
          }
        : undefined;
    const result = runtime.implementationService.complete({
      workflowId,
      batchId: batch.batchId,
      configuration: context.snapshot,
      implementationAttemptId: attempt.implementationAttemptId,
      implementationReadyEvidenceId: readyEvidence.implementationReadyEvidenceId,
      providedCommitSha: options.commit,
      creationMode,
      ...(humanCreator === undefined ? {} : { humanCreator }),
      commandId: `${batch.batchId}:complete-implementation:${options.commit}`,
    });
    printJson({
      status: result.batch.persistedState,
      workflowId,
      batchId: batch.batchId,
      resultingCommitSha: result.implementationCommit.resultingCommitSha,
      creationMode: result.implementationCommit.creationMode,
    });
  });
}

export async function reviewWorkflowBatchResumeImplementationCommand(
  workflowId: string,
  ordinalValue: string,
  options: WorkflowInvocationOptions,
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
    const previousSessionIdentityId = requireImplementationSessionIdentityId(
      runtime.implementationStore,
      batch.batchId,
    );
    const result = await runtime.implementationService.resume({
      workflowId,
      batchId: batch.batchId,
      configuration: context.snapshot,
      resolution: context.roles.implementer,
      commandId: `${batch.batchId}:resume-implementation:${batch.aggregateVersion}`,
      actorExecutionId: `${batch.batchId}:implementer-resume:${generateId('execution')}`,
      invocationId: `${batch.batchId}:implementer-resume:${generateId('invocation')}`,
      sessionIdentityId: previousSessionIdentityId,
      previousSessionIdentityId,
      prompt: buildImplementationResumePrompt({
        workflowId,
        batchId: batch.batchId,
      }),
      options: { timeout: options.timeout * 1000 },
    });
    printJson({
      status: result.batch.persistedState,
      workflowId,
      batchId: batch.batchId,
      implementerSessionIdentityId: result.implementerSessionIdentityId,
    });
  });
}

interface BatchReviewCodeOptions extends WorkflowInvocationOptions {}

export async function reviewWorkflowBatchReviewCodeCommand(
  workflowId: string,
  ordinalValue: string,
  options: BatchReviewCodeOptions,
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
    const round =
      runtime.implementationStore
        .getEvents(batch.batchId)
        .filter((event) => event.eventType === 'CODE_REVIEW_STARTED').length + 1;
    const reviewRoundId = reviewWorkflowImplementation.deriveCodeReviewRoundId(
      batch.batchId,
      round,
    );
    const plan = runtime.store.getBatchPlan(batch.currentPlanVersionId);
    if (plan === null) throw new Error(`Batch ${batch.batchId} has no current plan`);
    const result = await runtime.codeReviewService.review({
      workflowId,
      batchId: batch.batchId,
      configuration: context.snapshot,
      resolution: context.roles.reviewer,
      commandId: `${batch.batchId}:code-review-${round}`,
      actorExecutionId: `${batch.batchId}:reviewer:${generateId('execution')}`,
      invocationId: `${batch.batchId}:reviewer:${generateId('invocation')}`,
      sessionIdentityId: `${batch.batchId}:reviewer:${generateId('session')}`,
      transcriptId: `${batch.batchId}:code-review-${round}:${generateId('transcript')}`,
      reviewRoundId,
      buildPrompt: (evidence) =>
        buildCodeReviewPrompt({
          workflowId,
          batchId: batch.batchId,
          batchPlan: plan,
          evidence,
        }),
      options: { timeout: options.timeout * 1000 },
    });
    printJson(
      result.status === 'REJECTED'
        ? {
            status: result.status,
            workflowId,
            batchId: batch.batchId,
            round: result.round,
            errorCode: result.errorCode,
            message: result.message,
          }
        : {
            status: result.status,
            workflowId,
            batchId: batch.batchId,
            round: result.round,
            state: result.batch.persistedState,
            blockingFindingCount: result.blockingFindingCount,
            ...(result.status === 'VERIFYING'
              ? {}
              : { blockingFindingIds: result.blockingFindingIds }),
            deferredFindingIds: result.deferredFindingIds,
          },
    );
  });
}

interface BatchRespondOptions {
  readonly file: string;
}

export async function reviewWorkflowBatchRespondCommand(
  workflowId: string,
  ordinalValue: string,
  options: BatchRespondOptions,
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
    const rawTranscript = readFileSync(resolve(projectDir, options.file), 'utf8');
    const attempts = runtime.implementationStore.listImplementationAttempts(batch.batchId);
    const latestAttempt = attempts.at(-1);
    if (latestAttempt === undefined) {
      throw new Error(`Batch ${batch.batchId} has no implementation attempt to respond from`);
    }
    const capture = runtime.codeReviewService.submitDispositions({
      workflowId,
      batchId: batch.batchId,
      configuration: context.snapshot,
      transcriptId: `${batch.batchId}:dispositions:${generateId('transcript')}`,
      rawTranscript,
      createdAt: new Date().toISOString(),
    });
    printJson(
      capture.accepted
        ? {
            status: 'CAPTURED_PENDING_REVIEW',
            workflowId,
            batchId: batch.batchId,
            dispositionIds: capture.value.dispositions.map(
              (disposition) => disposition.dispositionId,
            ),
            note: 'Dispositions await the bounded final review; nothing is accepted yet.',
          }
        : {
            status: 'REJECTED',
            workflowId,
            batchId: batch.batchId,
            errorCode: capture.error.code,
            message: capture.error.message,
          },
    );
  });
}

export function buildCodeReviewPrompt(input: {
  readonly workflowId: string;
  readonly batchId: string;
  readonly batchPlan: unknown;
  readonly evidence: reviewWorkflowImplementation.CodeReviewPromptEvidence;
}): string {
  const { evidence } = input;
  const scope =
    evidence.round === 1
      ? 'Perform the one complete initial code review of this batch. Inspect the entire cumulative diff below, every changed file, relevant surrounding code, tests, and the approved plan. Collect every finding and return them together in one artifact.'
      : 'Perform the single bounded final review. Verify each previously blocking finding below against its disposition and the incremental diff. New findings are permitted only for critical or high regressions introduced by the correction. Do not add medium or low findings, suggestions, or preferences.';
  const roundTwoEvidence =
    evidence.round === 1
      ? ''
      : `

Previously blocking findings to verify:
${JSON.stringify(evidence.previousBlockingFindings, null, 2)}

Submitted dispositions:
${JSON.stringify(evidence.previousDispositions, null, 2)}

Incremental correction diff (${evidence.vocabulary.previousReviewedImplementationSha} → ${evidence.vocabulary.currentImplementationSha}):
${evidence.incrementalPatch ?? '(empty)'}`;
  return `Review batch ${input.batchId} of workflow ${input.workflowId} as the independent code reviewer (round ${evidence.round}).

${scope}

Never modify repository files, the Git index, or HEAD. Severity policy: critical/high findings block; a medium finding blocks only when its acceptanceCriterionId is one of the merge-blocking criteria listed below; low/suggestion findings are recorded and deferred, never blocking. Your verdict must be APPROVED exactly when no blocking finding exists, otherwise NEEDS_REVISION.

Output exactly one JSON object and nothing else, satisfying the strict REVIEW_RESULT schemaVersion 1 contract. Echo this authoritative target verbatim as your target field:
${JSON.stringify(evidence.target, null, 2)}

Git range vocabulary (B0/P/I/H):
${JSON.stringify(evidence.vocabulary, null, 2)}

Merge-blocking acceptance criterion IDs:
${JSON.stringify(evidence.mergeBlockingCriterionIds)}

Approved batch plan:
${JSON.stringify(input.batchPlan, null, 2)}

Cumulative diff (${evidence.vocabulary.originalBatchBaseSha} → ${evidence.vocabulary.currentImplementationSha}), stored at ${evidence.cumulativePatchLocation}:
${evidence.cumulativePatch}${roundTwoEvidence}`;
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

export function buildImplementationPreflightPrompt(input: {
  readonly workflowId: string;
  readonly batchId: string;
  readonly planVersionId: string;
}): string {
  return `You are the assigned implementer for workflow ${input.workflowId}, batch ${input.batchId}, plan ${input.planVersionId}.

This is an identity and readiness preflight. Do not inspect files, run commands, use tools, edit the repository, or create a commit. Output exactly READY and nothing else.`;
}

export function buildImplementationResumePrompt(input: {
  readonly workflowId: string;
  readonly batchId: string;
}): string {
  return `You are the assigned implementer resuming workflow ${input.workflowId}, batch ${input.batchId}.

This invocation only authorizes the state return from AWAITING_COMMIT to IMPLEMENTING. Do not inspect files, run commands, use tools, edit the repository, or create a commit. Output exactly READY and nothing else.`;
}

export function buildImplementationPrompt(input: {
  readonly workflowId: string;
  readonly batchPlan: unknown;
  readonly acceptanceCriteria: readonly unknown[];
  readonly originalBatchBaseSha: string;
  readonly creationMode: 'AGENT_AUTHORIZED' | 'HUMAN_CREATED';
}): string {
  const commitInstruction =
    input.creationMode === 'AGENT_AUTHORIZED'
      ? 'You are authorized to create the implementation commit. Complete the entire batch, run its checks, create one commit, and leave the worktree clean.'
      : 'You are not authorized to commit. Complete the entire batch and its checks, then leave all intended changes uncommitted for the human commit creator.';
  return `Implement the complete approved batch as one atomic unit for workflow ${input.workflowId}.

Do not stop after individual fixes, tests, or files. Resolve correctable failures within this pass. Do not perform code review, merge gating, later-batch work, or unrelated refactoring.

${commitInstruction}

Output exactly one JSON object and nothing else. It must satisfy the strict IMPLEMENTATION_RESULT schemaVersion 1 contract. Use outcome COMPLETE only after the whole batch is implemented. changedFiles must exactly list the repository paths actually changed relative to ${input.originalBatchBaseSha}. verificationRecordIds may contain only already-persisted CodeMoot verification records; ordinary command output is not a verification record. Use BLOCKED only for a genuine external blocker and include blockerReason.

Approved batch plan:
${JSON.stringify(input.batchPlan, null, 2)}

Acceptance criteria:
${JSON.stringify(input.acceptanceCriteria, null, 2)}`;
}

function createRuntime(db: ReturnType<typeof openDatabase>, projectDir: string) {
  const store = new reviewWorkflowPlan.ReviewWorkflowPlanStore(db);
  const implementationStore = new reviewWorkflowImplementation.ReviewWorkflowImplementationStore(
    db,
  );
  const commandStore = new reviewWorkflowPersistence.ReviewWorkflowCommandStore(db);
  const contractService = new reviewWorkflowContracts.ReviewWorkflowContractService(
    store.workflowStore,
  );
  const roleInvocation = new RoleInvocationService(store.workflowStore);
  const repository = new reviewWorkflowGit.LocalGitRepository(projectDir);
  const gitService = new reviewWorkflowGit.ReviewWorkflowGitService(repository, {
    storePatch: () => {
      throw new Error('Plan lifecycle does not capture Git patch artifacts');
    },
  });
  return {
    store,
    implementationStore,
    roleInvocation,
    service: new reviewWorkflowPlan.ReviewWorkflowPlanService(
      store,
      commandStore,
      contractService,
      gitService,
      roleInvocation,
    ),
    implementationService: new reviewWorkflowImplementation.ReviewWorkflowImplementationService(
      implementationStore,
      commandStore,
      contractService,
      gitService,
      repository,
      roleInvocation,
    ),
    codeReviewService: new reviewWorkflowImplementation.ReviewWorkflowCodeReviewService(
      implementationStore,
      commandStore,
      contractService,
      new reviewWorkflowGit.ReviewWorkflowGitService(
        repository,
        createFilePatchArtifactSink(projectDir),
      ),
      repository,
      roleInvocation,
    ),
  };
}

function createFilePatchArtifactSink(projectDir: string): reviewWorkflowGit.GitPatchArtifactSink {
  return {
    storePatch(artifact) {
      const directory = resolve(projectDir, '.codemoot', 'review-workflow', 'patches');
      mkdirSync(directory, { recursive: true });
      const location = resolve(
        directory,
        `${artifact.kind.toLowerCase()}-${artifact.patchHash.slice(0, 16)}.patch`,
      );
      writeFileSync(location, artifact.patch, 'utf8');
      return location;
    },
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

function resolveImplementationCommitMode(
  requested: BatchImplementOptions['commitMode'],
  policy: reviewWorkflowImplementation.StartImplementationInput['configuration']['commitPolicy'],
): reviewWorkflowImplementation.ExecuteImplementationInput['creationMode'] {
  if (requested === 'agent') {
    if (policy === 'HUMAN_REQUIRED') {
      throw new Error('Active workflow policy requires a human-created implementation commit');
    }
    return 'AGENT_AUTHORIZED';
  }
  if (requested === 'human') {
    if (policy === 'AGENT_AUTHORIZED') {
      throw new Error('Active workflow policy requires an agent-authorized implementation commit');
    }
    return 'HUMAN_CREATED';
  }
  return policy === 'AGENT_AUTHORIZED' ? 'AGENT_AUTHORIZED' : 'HUMAN_CREATED';
}

function requireImplementationSessionIdentityId(
  store: reviewWorkflowImplementation.ReviewWorkflowImplementationStore,
  batchId: string,
): string {
  const events = store.getEvents(batchId);
  let sessionIdentityId: unknown;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.eventType === 'IMPLEMENTATION_STARTED' ||
      event?.eventType === 'IMPLEMENTATION_RESUMED'
    ) {
      sessionIdentityId = event.payload.implementerSessionIdentityId;
      break;
    }
  }
  if (
    typeof sessionIdentityId !== 'string' ||
    store.getSessionIdentity(sessionIdentityId) === null
  ) {
    throw new Error(`Batch ${batchId} has no persisted implementer session to resume`);
  }
  return sessionIdentityId;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
