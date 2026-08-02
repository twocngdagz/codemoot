import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  ModelRegistry,
  RoleInvocationService,
  RoleManager,
  generateId,
  loadConfig,
  type openDatabase,
  reviewWorkflow,
  reviewWorkflowContracts,
  reviewWorkflowGate,
  reviewWorkflowGit,
  reviewWorkflowIdentity,
  reviewWorkflowImplementation,
  reviewWorkflowJobs,
  reviewWorkflowPersistence,
  reviewWorkflowPlan,
  reviewWorkflowRunner,
  reviewWorkflowVerification,
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
    // Autonomous-runner status: persist WORKER_HEARTBEAT_EXPIRED when both the heartbeat
    // and the worker lease expired, then report the durable state.
    let runner: Record<string, unknown> | null = null;
    const runnerState = runtime.runnerStore.get(workflowId);
    if (runnerState !== null) {
      const config = loadConfig({ projectDir: process.cwd() });
      const expiry = config.reviewGated?.autonomous.heartbeatExpirySeconds ?? 120;
      const reconciled = buildRunner(
        runtime,
        process.cwd(),
        workflowId,
        resolveInvocationTimeoutSeconds(process.cwd()),
      ).reconcileStalled(workflowId);
      const observed = reviewWorkflowRunner.deriveObservedStatus(reconciled, expiry, new Date());
      const statusGit = createRunnerGit(process.cwd());
      const lastInvocation = runtime.store.workflowStore.listInvocationAudit(workflowId).at(-1);
      const now = Date.now();
      runner = {
        status: reconciled.status,
        observedStatus: observed.status,
        currentHeadSha: statusGit.headSha(),
        remoteHeadSha: statusGit.remoteHeadSha(reconciled.branch),
        heartbeatAgeSeconds:
          reconciled.lastHeartbeatAt === undefined
            ? null
            : Math.round((now - Date.parse(reconciled.lastHeartbeatAt)) / 1000),
        phaseElapsedSeconds:
          reconciled.phaseStartedAt === undefined
            ? null
            : Math.round((now - Date.parse(reconciled.phaseStartedAt)) / 1000),
        activeInvocation: reconciled.activeInvocation ?? null,
        lastInvocation:
          lastInvocation === undefined
            ? null
            : {
                invocationId: lastInvocation.invocationId,
                phase: lastInvocation.phase ?? null,
                role: lastInvocation.role ?? null,
                adapterKind: lastInvocation.adapterKind,
                model: lastInvocation.reportedModel ?? lastInvocation.configuredModel,
                resultStatus: lastInvocation.resultStatus,
                finishedAt: lastInvocation.finishedAt,
              },
        branch: reconciled.branch,
        baseBranch: reconciled.baseBranch,
        baseSha: reconciled.baseSha,
        phase: reconciled.phase ?? null,
        reviewRound: reconciled.reviewRound ?? null,
        correctionPass: reconciled.correctionPass ?? null,
        currentOrdinal: reconciled.currentOrdinal ?? null,
        totalBatches: reconciled.totalBatches,
        completedOrdinals: reconciled.counters.completedOrdinals,
        lastHeartbeatAt: reconciled.lastHeartbeatAt ?? null,
        workerId: reconciled.workerId ?? null,
        leaseExpiresAt: reconciled.leaseExpiresAt ?? null,
        stopReason: reconciled.stopReason ?? null,
        stopDetails: reconciled.stopDetails ?? null,
        pendingDecision: reconciled.counters.pendingDecision ?? null,
        budgetGrants: reconciled.counters.budgetGrants,
        lastCheckpoint: reconciled.lastCheckpoint ?? null,
        nextAction:
          // A decision is consumed by the resume it authorises, so HUMAN_DECISION_REQUIRED
          // means "decide" only when none is already pending. Reading the status alone, the
          // two are indistinguishable without this — which is how a stop that had already
          // been decided was told to decide again.
          reconciled.status === 'HUMAN_DECISION_REQUIRED'
            ? reconciled.counters.pendingDecision === undefined
              ? `codemoot workflow decide ${workflowId} --action <fix_again|accept_risk|cancel> --rationale "..."`
              : `codemoot workflow run-resume ${workflowId} --background   (a ${reconciled.counters.pendingDecision} decision is pending and unconsumed)`
            : reconciled.status === 'PAUSED_BY_USER' || reconciled.status === 'PAUSE_REQUESTED'
              ? `codemoot workflow resume ${workflowId} --background`
              : reconciled.status === 'RUNNING'
                ? `codemoot workflow watch ${workflowId}`
                : null,
        limits: reconciled.limits ?? config.reviewGated?.autonomous ?? null,
        contractPacing: (() => {
          try {
            const pacing = resolveRuntimeContext(runtime.store, workflowId, process.cwd()).snapshot
              .pacing;
            return {
              maxCodeReviewRounds: pacing.maxCodeReviewRounds,
              maxCorrectionPasses: pacing.maxCorrectionPasses,
            };
          } catch {
            return null;
          }
        })(),
        auditTotals: runtime.runnerStore.auditTotals(workflowId),
      };
    }
    printJson({
      runner,
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
        const effective = runtime.gateService.effectiveState(batch.batchId);
        return {
          batchId: batch.batchId,
          ordinal: batch.ordinal,
          state: batch.persistedState,
          effectiveState: effective.effectiveState,
          approvalValid: effective.approvalValid,
          ...(effective.persistedApprovalSha === undefined
            ? {}
            : { approvedCommitSha: effective.persistedApprovalSha }),
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

/**
 * Plan refinement, ONE invocation per batch.
 *
 * Refinement used to demand every batch plan in a single response. A 43-minute run then
 * produced nothing: the response exceeded the model's output ceiling, so batch 1 was lost
 * because batch 9 made the answer too long, and there was nothing to resume from because
 * nothing had been stored. Every other phase — implementation, review, verification — is
 * already per batch; this makes refinement behave the same way.
 *
 * Invocation 0 produces the OUTLINE (plan content, batch objectives, requirement coverage).
 * Invocations 1..N each produce exactly ONE batch plan, staged durably the moment it
 * completes. A failure at batch N preserves 1..N-1 and the next run resumes at N.
 */
async function performRefinement(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
  workflowId: string,
  timeoutSeconds: number,
) {
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
  const requirementSummaries = requirements.map((requirement) => ({
    requirementId: requirement.requirementId,
    sourceReference: requirement.sourceReference,
    statement: requirement.statement,
  }));
  const actorExecutionId = `${workflowId}:refiner:${generateId('execution')}`;
  runtime.service.verifyRepositoryContext(workflowId, audit.repositoryAuditId, actorExecutionId);

  // --- Invocation 0: the outline. Small by construction — no batch bodies.
  //
  // PINNED once accepted. The outline decides which work each ordinal contains, and staged
  // drafts are keyed by ordinal — so re-asking a non-deterministic model on every resume
  // let the decomposition move underneath drafts authored against the previous one. A real
  // resume returned eleven batches for a ten-batch plan, correctly reused ten byte-identical
  // drafts, and authored a near-duplicate of batch 10 as batch 11 that then depended on
  // batch 10. Reusing the pinned outline also stops a resume re-paying for it.
  const pinnedOutline = runtime.store.workflowStore.getRefinementOutline(workflowId);
  let outlinePrepared: Awaited<ReturnType<typeof runtime.roleInvocation.prepare>> | undefined;
  let outline: ReturnType<typeof reviewWorkflowContracts.parseRefinementOutline>;
  if (pinnedOutline !== null) {
    outline = reviewWorkflowContracts.parseRefinementOutline(JSON.stringify(pinnedOutline));
  } else {
    outlinePrepared = await runtime.roleInvocation.prepare({
      resolution: context.roles.implementer,
      workflowId,
      commandId: reviewWorkflowPlan.derivePlanCommandId(firstBatchId, 'create'),
      actorExecutionId,
      invocationId: `${workflowId}:refiner-outline:${generateId('invocation')}`,
      sessionIdentityId: `${workflowId}:refiner:${generateId('session')}`,
      prompt: buildRefinementOutlinePrompt({
        workflowId,
        repositoryAudit: audit,
        generalPlanContent: generalPlan.content,
        requirements: requirementSummaries,
      }),
      options: agentInvocationOptions(timeoutSeconds),
      additionalAuthorities: ['PLAN_REFINER'],
      auditPhase: 'PLAN_REFINEMENT',
    });
    // Audited the MOMENT it returns, not when capture succeeds. Bound to `persistPrepared`,
    // a refinement that failed validation lost its outline from the cost ledger entirely.
    runtime.store.workflowStore.recordInvocationAudit(outlinePrepared.audit);
    const authored = reviewWorkflowContracts.parseRefinementOutline(outlinePrepared.call.text);
    // Once batch plans exist, THE STAGED DRAFTS ARE THE DECOMPOSITION. They were authored
    // against a partition and validated under it; a fresh outline call is not a second
    // opinion on how many batches there are, it is a different question being asked twice.
    //
    // Asking it twice does not give the same answer: three calls on an unchanged ten-batch
    // plan returned 10, then 11, then 11 — the model splitting one migration batch in two
    // and inventing a dependency between the halves. Refusing the mismatch protected the
    // staged work but deadlocked, because the outline wanted an ELEVENTH batch and no draft
    // can be discarded to supply one.
    //
    // So the outline is asked only for what the drafts cannot carry — the plan prose — and
    // the batch set is adopted from the drafts. This is then pinned, so the question is
    // never asked again for this workflow.
    const stagedDrafts = runtime.store.workflowStore.listRefinementDrafts(workflowId);
    if (stagedDrafts.length > 0) {
      const adopted = stagedDrafts
        .map((entry) => reviewWorkflowContracts.parseStoredBatchPlanDraft(entry.draft))
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((draft) => ({
          batchId: draft.batchId,
          batchPlanVersionId: draft.batchPlanVersionId,
          ordinal: draft.ordinal,
          objective: draft.objective,
        }));
      // Re-parsed rather than trusted: this must satisfy the same outline contract as an
      // authored one, so non-sequential ordinals left by an earlier discard fail loudly.
      outline = reviewWorkflowContracts.parseRefinementOutline(
        JSON.stringify({ ...authored, batches: adopted }),
      );
      runtime.runnerStore.appendLog({
        workflowId,
        entryType: 'CHECKPOINT',
        phase: 'PLAN_REFINEMENT',
        message: `Adopted the staged ${adopted.length}-batch decomposition; the outline supplied plan content only (it proposed ${authored.batches.length})`,
      });
    } else {
      outline = authored;
    }
    // Pinned the moment it is accepted — BEFORE any batch is authored against it, so the
    // decomposition the drafts belong to is durable even if the run dies mid-refinement.
    runtime.store.workflowStore.saveRefinementOutline({
      workflowId,
      outline,
      createdAt: outlinePrepared.invocation.finishedAt ?? new Date().toISOString(),
    });
  }

  // Drafts from a decomposition that was never accepted — e.g. an eleventh batch authored
  // by a resume for a ten-batch plan — are staging residue, not evidence: the invocation
  // audit keeps the full record of what was asked, answered and spent.
  const discarded = runtime.store.workflowStore.discardRefinementDraftsOutside(
    workflowId,
    outline.batches.map((batch) => batch.ordinal),
  );
  if (discarded > 0) {
    runtime.runnerStore.appendLog({
      workflowId,
      entryType: 'CHECKPOINT',
      phase: 'PLAN_REFINEMENT',
      message: `Discarded ${discarded} staged batch plan(s) outside the pinned decomposition`,
    });
  }

  // --- Invocations 1..N: one batch plan each, staged the moment it completes.
  // Staged drafts are re-validated on reuse rather than trusted: a resumed run replays data
  // written by an earlier run, possibly under an earlier schema.
  const staged = new Map(
    runtime.store.workflowStore
      .listRefinementDrafts(workflowId)
      .map((entry) => [
        entry.ordinal,
        reviewWorkflowContracts.parseStoredBatchPlanDraft(entry.draft),
      ]),
  );
  for (const batch of outline.batches) {
    const alreadyStaged = staged.get(batch.ordinal);
    if (alreadyStaged !== undefined) {
      // The outline is re-authored on every resume, so a reused draft must still belong to
      // the batch this outline assigns to that ordinal — otherwise a regenerated outline
      // could silently pair batch 3's plan with batch 3's new, different objective.
      if (alreadyStaged.batchId !== batch.batchId) {
        throw new Error(
          `Staged batch plan for ordinal ${batch.ordinal} targets ${alreadyStaged.batchId}, but this outline expects ${batch.batchId}`,
        );
      }
      continue; // already authored in an earlier run
    }
    const batchPrepared = await runtime.roleInvocation.prepare({
      resolution: context.roles.implementer,
      workflowId,
      commandId: reviewWorkflowPlan.derivePlanCommandId(batch.batchId, 'create'),
      actorExecutionId: `${workflowId}:refiner-batch-${batch.ordinal}:${generateId('execution')}`,
      invocationId: `${workflowId}:refiner-batch-${batch.ordinal}:${generateId('invocation')}`,
      // Each batch authoring call stands alone: the outline's session is not durable until
      // the refinement is captured, and every batch prompt carries its own full context.
      sessionIdentityId: `${workflowId}:refiner-batch-${batch.ordinal}:${generateId('session')}`,
      prompt: buildBatchPlanPrompt({
        workflowId,
        batch,
        outlineSummary: outline.summary,
        requirements: requirementSummaries,
        earlierBatchIds: outline.batches
          .filter((candidate) => candidate.ordinal < batch.ordinal)
          .map((candidate) => candidate.batchId),
      }),
      options: agentInvocationOptions(timeoutSeconds),
      additionalAuthorities: ['PLAN_REFINER'],
      auditPhase: 'PLAN_REFINEMENT',
    });
    // Each batch authoring call is a real agent invocation: audit it immediately so the
    // evidence trail is complete and it counts against the invocation and token budgets.
    // (The refinement COMMAND itself carries the outline invocation's identity; these are
    // authoring steps feeding that one command.)
    runtime.store.workflowStore.recordInvocationAudit(batchPrepared.audit);
    const parsed = reviewWorkflowContracts.parseBatchPlanResult(batchPrepared.call.text);
    if (parsed.batchPlan.batchId !== batch.batchId) {
      throw new Error(
        `Batch plan ${batch.ordinal} targets ${parsed.batchPlan.batchId}, expected ${batch.batchId}`,
      );
    }
    // Durable the instant it lands: a later batch failing can no longer discard this one.
    runtime.store.workflowStore.saveRefinementDraft({
      workflowId,
      ordinal: batch.ordinal,
      batchId: batch.batchId,
      draft: parsed.batchPlan,
      createdAt: batchPrepared.invocation.finishedAt ?? new Date().toISOString(),
    });
    staged.set(batch.ordinal, parsed.batchPlan);
  }

  // --- Assemble the complete refinement locally and capture it exactly as before, so the
  // kernel, identity, and validation paths are unchanged. Every CROSS-BATCH invariant is
  // established here by construction, because no single batch call can know them: criterion
  // IDs are namespaced by batch, and coverage is derived from what the plans actually
  // declare rather than from a guess the outline had to make before they existed.
  const assembled = reviewWorkflowContracts.assembleRefinement({
    summary: outline.summary,
    refinedPlanContent: outline.refinedPlanContent,
    batchPlans: outline.batches.map((batch) => {
      const draft = staged.get(batch.ordinal);
      if (draft === undefined) {
        throw new Error(`Refinement is missing the batch plan for ordinal ${batch.ordinal}`);
      }
      return draft;
    }),
  });
  // An earlier attempt that failed VALIDATION left this command terminally failed. Its
  // canonical hash covers the requester's actor execution, which is honestly new on every
  // run, so a retry can never hash identically and idempotency would reject it — making
  // `fix_again` unable to retry the very thing it exists to fix. Releasing is refused
  // unless nothing was created, and the failed receipt is preserved.
  const firstCommandId = reviewWorkflowPlan.derivePlanCommandId(firstBatchId, 'create');
  runtime.commandStore.releaseFailedFinalReservation(
    firstCommandId,
    'Human-authorised refinement retry',
  );

  return runtime.service.captureRefinement({
    transcriptId: `${workflowId}:refinement:${generateId('transcript')}`,
    workflowId,
    actorExecutionId,
    rawTranscript: JSON.stringify(assembled),
    createdAt: new Date().toISOString(),
    expectedFirstBatchId: firstBatchId,
    refinedPlanVersionId: `${workflowId}:refined-plan:1`,
    repositoryAuditId: audit.repositoryAuditId,
    version: 1,
    // On a resume from the pinned outline NO agent call was made, so there is no invocation
    // to bind and no side effect to claim: the command materializes evidence that is already
    // durable. Claiming a side effect here would be exactly the fabrication the receipt
    // machinery exists to prevent.
    ...(outlinePrepared === undefined
      ? {
          actor: persistCliActor(runtime.store, {
            actorExecutionId,
            actorType: 'SYSTEM',
            authorities: ['PLAN_REFINER'],
            assurance: 'PROCESS_ATTESTED',
          }),
        }
      : {
          invocationId: outlinePrepared.invocation.invocationId,
          sessionIdentityId: outlinePrepared.session.sessionIdentityId,
          actor: outlinePrepared.execution,
          preparedInvocation: outlinePrepared,
        }),
  });
}

export async function reviewWorkflowRefineCommand(
  workflowId: string,
  options: WorkflowInvocationOptions,
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const runtime = createRuntime(db, projectDir);
    const result = await performRefinement(runtime, projectDir, workflowId, options.timeout);
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
      // Plan review is the batch's first reviewer contact: it creates the one reviewer
      // role session, which every later reviewer invocation (revision rounds, code review,
      // final audit) must resume.
      sessionBinding: {
        batchId: batch.batchId,
        role: 'REVIEWER',
        expectExisting: options.round > 1,
      },
      prompt: buildPlanReviewPrompt({
        workflowId,
        batchPlan: plan,
        acceptanceCriteria: runtime.store.listAcceptanceCriteria(plan.batchPlanVersionId),
      }),
      options: agentInvocationOptions(options.timeout),
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
              options: agentInvocationOptions(options.timeout),
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
      options: agentInvocationOptions(options.timeout),
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
      options: agentInvocationOptions(options.timeout),
    });
    printJson({
      status: result.batch.persistedState,
      workflowId,
      batchId: batch.batchId,
      implementerSessionIdentityId: result.implementerSessionIdentityId,
    });
  });
}

interface BatchReviewCodeOptions extends WorkflowInvocationOptions {
  readonly background?: boolean;
}

export interface CodeReviewJobPayload {
  readonly ordinal: number;
  readonly round: number;
  readonly timeout: number;
}

export function parseCodeReviewJobPayload(
  payload: Readonly<Record<string, unknown>>,
): CodeReviewJobPayload {
  return {
    ordinal: requirePositiveIntegerField(payload, 'ordinal'),
    round: requirePositiveIntegerField(payload, 'round'),
    timeout: requirePositiveIntegerField(payload, 'timeout'),
  };
}

async function performCodeReview(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
  workflowId: string,
  commandId: string,
  expectedBatchId: string | null,
  payload: CodeReviewJobPayload,
): Promise<Record<string, unknown>> {
  const context = resolveRuntimeContext(runtime.store, workflowId, projectDir);
  const batch =
    expectedBatchId === null
      ? requireBatchByOrdinal(runtime.store, workflowId, payload.ordinal)
      : requireBatchMatchingJob(runtime.store, workflowId, payload.ordinal, expectedBatchId);
  const plan = runtime.store.getBatchPlan(batch.currentPlanVersionId);
  if (plan === null) throw new Error(`Batch ${batch.batchId} has no current plan`);
  const result = await runtime.codeReviewService.review({
    workflowId,
    batchId: batch.batchId,
    configuration: context.snapshot,
    resolution: context.roles.reviewer,
    commandId,
    actorExecutionId: `${batch.batchId}:reviewer:${generateId('execution')}`,
    // The claimed side-effect identity IS the invocation ID (transition-actor binding), so
    // it is derived from the command ID to give code review a durable receipt identity.
    invocationId: `${commandId}:code-review-invocation`,
    sessionIdentityId: `${batch.batchId}:reviewer:${generateId('session')}`,
    transcriptId: `${batch.batchId}:code-review-${payload.round}:${generateId('transcript')}`,
    reviewRoundId: reviewWorkflowImplementation.deriveCodeReviewRoundId(
      batch.batchId,
      payload.round,
    ),
    buildPrompt: (evidence) =>
      buildCodeReviewPrompt({
        workflowId,
        batchId: batch.batchId,
        batchPlan: plan,
        evidence,
      }),
    options: agentInvocationOptions(payload.timeout),
  });
  return result.status === 'REJECTED'
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
        ...(result.status === 'VERIFYING' ? {} : { blockingFindingIds: result.blockingFindingIds }),
        deferredFindingIds: result.deferredFindingIds,
      };
}

export async function reviewWorkflowBatchReviewCodeCommand(
  workflowId: string,
  ordinalValue: string,
  options: BatchReviewCodeOptions,
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const ordinal = parsePositiveInteger(ordinalValue, 'batch ordinal');
    const runtime = createRuntime(db, projectDir);
    resolveRuntimeContext(runtime.store, workflowId, projectDir);
    const batch = requireBatchByOrdinal(runtime.store, workflowId, ordinal);
    const round =
      runtime.implementationStore
        .getEvents(batch.batchId)
        .filter((event) => event.eventType === 'CODE_REVIEW_STARTED').length + 1;
    const commandId = `${batch.batchId}:code-review-${round}`;
    const payload: CodeReviewJobPayload = { ordinal, round, timeout: options.timeout };
    if (options.background === true) {
      const job = runtime.jobService.enqueue({
        jobId: `${commandId}:job`,
        workflowId,
        batchId: batch.batchId,
        jobType: 'CODE_REVIEW',
        commandId,
        payload: { ...payload },
      });
      printJson({ status: 'QUEUED', jobId: job.jobId, commandId: job.commandId });
      return;
    }
    printJson(await performCodeReview(runtime, projectDir, workflowId, commandId, null, payload));
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

${reviewWorkflowContracts.buildContractInstruction(
  reviewWorkflowContracts.reviewResultContractSchema,
  'REVIEW_RESULT',
)}
Echo this authoritative target verbatim as your target field:
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

interface BatchVerifyOptions {
  readonly command: number;
  readonly timeout: number;
  readonly toolVersion?: string;
  readonly id?: string;
  readonly expectedVersion?: number;
  readonly background?: boolean;
}

export interface VerificationJobPayload {
  readonly ordinal: number;
  readonly command: number;
  readonly timeout: number;
  readonly toolVersion?: string;
  readonly expectedVersion?: number;
}

/** Background job payloads are plain persisted JSON; parse them strictly on the way back in. */
export function parseVerificationJobPayload(
  payload: Readonly<Record<string, unknown>>,
): VerificationJobPayload {
  const ordinal = requirePositiveIntegerField(payload, 'ordinal');
  const command = requirePositiveIntegerField(payload, 'command');
  const timeout = requirePositiveIntegerField(payload, 'timeout');
  const toolVersion = optionalStringField(payload, 'toolVersion');
  const expectedVersion = optionalPositiveIntegerField(payload, 'expectedVersion');
  return {
    ordinal,
    command,
    timeout,
    ...(toolVersion === undefined ? {} : { toolVersion }),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

/** Stable default command identity so a same-ID retry replays instead of re-executing. */
export function deriveVerifyCommandId(batchId: string, commandIndex: number): string {
  return `${batchId}:verify:${commandIndex}`;
}

export function resolvePlanVerificationCommand(
  plan: reviewWorkflow.BatchPlanVersion,
  commandIndex: number,
): reviewWorkflow.BatchPlanVersion['verificationCommands'][number] {
  const command = plan.verificationCommands[commandIndex - 1];
  if (command === undefined) {
    throw new Error(`Plan ${plan.batchPlanVersionId} has no verification command ${commandIndex}`);
  }
  return command;
}

async function performBatchVerification(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
  workflowId: string,
  commandId: string,
  expectedBatchId: string | null,
  payload: VerificationJobPayload,
): Promise<Record<string, unknown>> {
  const context = resolveRuntimeContext(runtime.store, workflowId, projectDir);
  const batch =
    expectedBatchId === null
      ? requireBatchByOrdinal(runtime.store, workflowId, payload.ordinal)
      : requireBatchMatchingJob(runtime.store, workflowId, payload.ordinal, expectedBatchId);
  const plan = runtime.store.getBatchPlan(batch.currentPlanVersionId);
  if (plan === null) throw new Error(`Batch ${batch.batchId} has no current plan`);
  const command = resolvePlanVerificationCommand(plan, payload.command);
  const verificationRecordId = `${commandId}:record`;
  const result = await runtime.gateService.executeVerification({
    workflowId,
    batchId: batch.batchId,
    configuration: context.snapshot,
    commandId,
    verificationRecordId,
    ...(payload.expectedVersion === undefined
      ? {}
      : { expectedBatchVersion: payload.expectedVersion }),
    run: async () => {
      // The executor actor is persisted only when the operation actually runs — a replayed
      // command never re-persists identity records.
      const executor = persistCliActor(runtime.store, {
        actorExecutionId: `${commandId}:executor:${generateId('execution')}`,
        actorType: 'HUMAN',
        authorities: ['VERIFICATION_EXECUTOR'],
      });
      const executed = await runtime.verificationService.execute({
        verificationRecordId,
        workflowId,
        batchId: batch.batchId,
        executorActorExecutionId: executor.actorExecutionId,
        relatedFindingIds: [],
        configurationHash: context.snapshot.configurationHash,
        ...(payload.toolVersion === undefined ? {} : { toolVersion: payload.toolVersion }),
        command,
        expectedCommitSha: new reviewWorkflowGit.LocalGitRepository(projectDir).readHeadSha(),
        timeoutMs: payload.timeout * 1000,
      });
      return executed.record;
    },
  });
  return {
    workflowId,
    batchId: batch.batchId,
    commandId,
    replayed: result.replayed,
    verificationRecordId: result.record.verificationRecordId,
    observedStatus: result.record.observedStatus,
    commitSha: result.record.commitSha,
    fullLogLocation: result.record.fullLogLocation,
    note: 'A successful record is evidence only; acceptance requires attestation.',
  };
}

export async function reviewWorkflowBatchVerifyCommand(
  workflowId: string,
  ordinalValue: string,
  options: BatchVerifyOptions,
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const ordinal = parsePositiveInteger(ordinalValue, 'batch ordinal');
    const runtime = createRuntime(db, projectDir);
    resolveRuntimeContext(runtime.store, workflowId, projectDir);
    const batch = requireBatchByOrdinal(runtime.store, workflowId, ordinal);
    const commandId = options.id ?? deriveVerifyCommandId(batch.batchId, options.command);
    const payload: VerificationJobPayload = {
      ordinal,
      command: options.command,
      timeout: options.timeout,
      ...(options.toolVersion === undefined ? {} : { toolVersion: options.toolVersion }),
      ...(options.expectedVersion === undefined
        ? {}
        : { expectedVersion: options.expectedVersion }),
    };
    if (options.background === true) {
      const job = runtime.jobService.enqueue({
        jobId: `${commandId}:job`,
        workflowId,
        batchId: batch.batchId,
        jobType: 'VERIFICATION',
        commandId,
        payload: { ...payload },
      });
      printJson({ status: 'QUEUED', jobId: job.jobId, commandId: job.commandId });
      return;
    }
    printJson(
      await performBatchVerification(runtime, projectDir, workflowId, commandId, null, payload),
    );
  });
}

interface BatchAttestOptions {
  readonly record: string;
  readonly mode: 'automatic' | 'human';
  readonly decision: 'accepted' | 'rejected';
  readonly rationale: string;
}

/**
 * Derives the attestation policy from authoritative sources only: the approved plan's
 * verification commands, the plan's acceptance criteria, the approved code review's
 * reviewed commit, and the freshly derived configuration hash. Nothing is echoed from the
 * record under attestation, and nothing is operator-asserted.
 *
 * Facts without a durable evidence source are treated as UNPROVEN and deny automatic
 * acceptance: the record's toolVersion is operator-supplied at execution time (the local
 * runner does not capture tool versions), so no expected tool version can be proven and
 * parser confidence cannot be established — both force independent judgment. Baseline
 * comparison derives from the approved command's verification type: lint and
 * static-analysis evidence in this repository is baseline-relative and requires the
 * assigned reviewer's acceptance.
 */
export function deriveVerificationAttestationPolicy(input: {
  readonly plan: reviewWorkflow.BatchPlanVersion;
  readonly criteria: readonly reviewWorkflow.AcceptanceCriterion[];
  readonly record: reviewWorkflow.VerificationRecord;
  readonly approvedReviewedCommitSha: string;
  readonly configurationHash: string;
}): reviewWorkflowVerification.VerificationAttestationPolicy {
  const approvedCommand = input.plan.verificationCommands.find(
    (candidate) =>
      candidate.executable === input.record.command &&
      JSON.stringify(candidate.arguments) === JSON.stringify(input.record.arguments) &&
      candidate.workingDirectory === input.record.workingDirectory &&
      candidate.verificationType === input.record.verificationType,
  );
  if (approvedCommand === undefined) {
    throw new Error(
      `Verification record ${input.record.verificationRecordId} does not match any approved plan verification command`,
    );
  }
  return {
    policyConfigurationHash: input.configurationHash,
    expectedVerificationConfigurationHash: input.configurationHash,
    expectedCommitSha: input.approvedReviewedCommitSha,
    approvedCommand,
    expectedToolVersion: 'UNPROVEN:tool-version-has-no-durable-evidence-source',
    criterionPolicies: approvedCommand.relatedCriterionIds.map((criterionId) => {
      const criterion = input.criteria.find(
        (candidate) => candidate.acceptanceCriterionId === criterionId,
      );
      const judgment =
        criterion === undefined ||
        criterion.kind === 'MANUAL' ||
        criterion.kind === 'BROWSER' ||
        criterion.kind === 'USER_FACING';
      return {
        criterionId,
        allowsAutomaticAcceptance: !judgment,
        requiresIndependentAttestation: judgment,
      };
    }),
    parserAmbiguityRequiresJudgment: true,
    baselineComparison:
      approvedCommand.verificationType === 'lint' ||
      approvedCommand.verificationType === 'static_analysis',
  };
}

export async function reviewWorkflowBatchAttestVerificationCommand(
  workflowId: string,
  ordinalValue: string,
  options: BatchAttestOptions,
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const ordinal = parsePositiveInteger(ordinalValue, 'batch ordinal');
    const runtime = createRuntime(db, projectDir);
    const context = resolveRuntimeContext(runtime.store, workflowId, projectDir);
    const batch = requireBatchByOrdinal(runtime.store, workflowId, ordinal);
    const recordEntity = runtime.gateStore.workflowStore.getEntity(
      'VERIFICATION_RECORD',
      options.record,
    );
    if (recordEntity === null || recordEntity.kind !== 'VERIFICATION_RECORD') {
      throw new Error(`Verification record ${options.record} does not exist`);
    }
    const record = recordEntity.value;
    const plan = runtime.store.getBatchPlan(batch.currentPlanVersionId);
    if (plan === null) throw new Error(`Batch ${batch.batchId} has no current plan`);
    const criteria = runtime.store.listAcceptanceCriteria(plan.batchPlanVersionId);
    const approvedReview = runtime.gateStore
      .listCodeReviews(batch.batchId)
      .filter((candidate) => candidate.verdict === 'APPROVED')
      .at(-1);
    if (approvedReview === undefined || approvedReview.target.kind !== 'CODE') {
      throw new Error(`Batch ${batch.batchId} has no approved code review to attest against`);
    }
    const attestor = persistCliActor(runtime.store, {
      actorExecutionId: `${batch.batchId}:verification-attestor:${generateId('execution')}`,
      actorType: options.mode === 'automatic' ? 'SYSTEM' : 'HUMAN',
      authorities: ['VERIFICATION_ATTESTOR'],
      ...(options.mode === 'automatic' ? { assurance: 'PROCESS_ATTESTED' as const } : {}),
    });
    const attestation = runtime.verificationService.attest({
      verificationAttestationId: `${record.verificationRecordId}:attestation:${options.mode}`,
      verificationRecordId: record.verificationRecordId,
      workflowId,
      batchId: batch.batchId,
      decision: options.decision === 'accepted' ? 'ACCEPTED' : 'REJECTED',
      acceptanceMode: options.mode === 'automatic' ? 'AUTOMATIC_POLICY' : 'HUMAN',
      rationale: options.rationale,
      attestorActorExecutionId: attestor.actorExecutionId,
      currentHeadSha: new reviewWorkflowGit.LocalGitRepository(projectDir).readHeadSha(),
      policy: deriveVerificationAttestationPolicy({
        plan,
        criteria,
        record,
        approvedReviewedCommitSha: approvedReview.target.reviewedCommitSha,
        configurationHash: context.snapshot.configurationHash,
      }),
      createdAt: new Date().toISOString(),
    });
    printJson({
      workflowId,
      batchId: batch.batchId,
      verificationAttestationId: attestation.verificationAttestationId,
      decision: attestation.decision,
      acceptanceMode: attestation.acceptanceMode,
    });
  });
}

interface BatchFinalAuditOptions extends WorkflowInvocationOptions {
  readonly id?: string;
  readonly expectedVersion?: number;
  readonly background?: boolean;
}

export interface FinalAuditJobPayload {
  readonly ordinal: number;
  readonly timeout: number;
  readonly expectedVersion?: number;
}

export function parseFinalAuditJobPayload(
  payload: Readonly<Record<string, unknown>>,
): FinalAuditJobPayload {
  const ordinal = requirePositiveIntegerField(payload, 'ordinal');
  const timeout = requirePositiveIntegerField(payload, 'timeout');
  const expectedVersion = optionalPositiveIntegerField(payload, 'expectedVersion');
  return {
    ordinal,
    timeout,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

async function performFinalAudit(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
  workflowId: string,
  commandId: string,
  expectedBatchId: string | null,
  payload: FinalAuditJobPayload,
): Promise<Record<string, unknown>> {
  const context = resolveRuntimeContext(runtime.store, workflowId, projectDir);
  const batch =
    expectedBatchId === null
      ? requireBatchByOrdinal(runtime.store, workflowId, payload.ordinal)
      : requireBatchMatchingJob(runtime.store, workflowId, payload.ordinal, expectedBatchId);
  const plan = runtime.store.getBatchPlan(batch.currentPlanVersionId);
  if (plan === null) throw new Error(`Batch ${batch.batchId} has no current plan`);
  const result = await runtime.gateService.finalAudit({
    workflowId,
    batchId: batch.batchId,
    configuration: context.snapshot,
    resolution: context.roles.reviewer,
    commandId,
    actorExecutionId: `${batch.batchId}:final-auditor:${generateId('execution')}`,
    invocationId: `${batch.batchId}:final-auditor:${generateId('invocation')}`,
    sessionIdentityId: `${batch.batchId}:final-auditor:${generateId('session')}`,
    transcriptId: `${batch.batchId}:final-audit:${generateId('transcript')}`,
    ...(payload.expectedVersion === undefined
      ? {}
      : { expectedBatchVersion: payload.expectedVersion }),
    buildPrompt: (evidence) => buildFinalAuditPrompt({ workflowId, batchPlan: plan, evidence }),
    options: agentInvocationOptions(payload.timeout),
  });
  return result.capture.accepted
    ? {
        status: result.replayed ? 'REPLAYED' : 'CAPTURED',
        workflowId,
        batchId: batch.batchId,
        batchState: result.batch.persistedState,
        verdict: result.capture.value.review.verdict,
        scopeComplete: result.capture.value.review.scopeComplete,
        documentationComplete: result.capture.value.review.documentationComplete,
      }
    : {
        status: 'REJECTED',
        workflowId,
        batchId: batch.batchId,
        errorCode: result.capture.error.code,
        message: result.capture.error.message,
      };
}

export async function reviewWorkflowBatchFinalAuditCommand(
  workflowId: string,
  ordinalValue: string,
  options: BatchFinalAuditOptions,
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const ordinal = parsePositiveInteger(ordinalValue, 'batch ordinal');
    const runtime = createRuntime(db, projectDir);
    resolveRuntimeContext(runtime.store, workflowId, projectDir);
    const batch = requireBatchByOrdinal(runtime.store, workflowId, ordinal);
    const commandId = options.id ?? `${batch.batchId}:final-audit`;
    const payload: FinalAuditJobPayload = {
      ordinal,
      timeout: options.timeout,
      ...(options.expectedVersion === undefined
        ? {}
        : { expectedVersion: options.expectedVersion }),
    };
    if (options.background === true) {
      const job = runtime.jobService.enqueue({
        jobId: `${commandId}:job`,
        workflowId,
        batchId: batch.batchId,
        jobType: 'FINAL_AUDIT',
        commandId,
        payload: { ...payload },
      });
      printJson({ status: 'QUEUED', jobId: job.jobId, commandId: job.commandId });
      return;
    }
    printJson(await performFinalAudit(runtime, projectDir, workflowId, commandId, null, payload));
  });
}

interface BatchGateOptions {
  readonly id?: string;
  readonly expectedVersion?: number;
}

export async function reviewWorkflowBatchGateCommand(
  workflowId: string,
  ordinalValue: string,
  options: BatchGateOptions,
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const ordinal = parsePositiveInteger(ordinalValue, 'batch ordinal');
    const runtime = createRuntime(db, projectDir);
    const context = resolveRuntimeContext(runtime.store, workflowId, projectDir);
    const batch = requireBatchByOrdinal(runtime.store, workflowId, ordinal);
    const result = runtime.gateService.evaluateGate({
      workflowId,
      batchId: batch.batchId,
      configuration: context.snapshot,
      commandId: options.id ?? `${batch.batchId}:gate`,
      ...(options.expectedVersion === undefined
        ? {}
        : { expectedBatchVersion: options.expectedVersion }),
      createdAt: new Date().toISOString(),
    });
    printJson(
      result.approved
        ? {
            status: 'APPROVED_FOR_MERGE',
            workflowId,
            batchId: batch.batchId,
            approvedCommitSha: result.conditions.reviewedCommitSha,
            conditions: result.conditions,
          }
        : {
            status: 'NOT_APPROVED',
            workflowId,
            batchId: batch.batchId,
            failedConditions: result.failedConditions,
            conditions: result.conditions,
          },
    );
  });
}

interface BatchMarkMergedOptions {
  readonly mergeSha: string;
  readonly id?: string;
  readonly expectedVersion?: number;
}

export async function reviewWorkflowBatchMarkMergedCommand(
  workflowId: string,
  ordinalValue: string,
  options: BatchMarkMergedOptions,
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const ordinal = parsePositiveInteger(ordinalValue, 'batch ordinal');
    const runtime = createRuntime(db, projectDir);
    resolveRuntimeContext(runtime.store, workflowId, projectDir);
    const batch = requireBatchByOrdinal(runtime.store, workflowId, ordinal);
    // The recorder identity is persisted by the coordinator when the command is reserved —
    // pre-persisting a variant here would conflict with that immutable record.
    const merged = runtime.gateService.markMerged({
      workflowId,
      batchId: batch.batchId,
      mergeCommitSha: options.mergeSha,
      recorder: {
        actorExecutionId: `${options.id ?? `${batch.batchId}:mark-merged`}:recorder`,
        actorType: 'HUMAN',
      },
      commandId: options.id ?? `${batch.batchId}:mark-merged`,
      ...(options.expectedVersion === undefined
        ? {}
        : { expectedBatchVersion: options.expectedVersion }),
      createdAt: new Date().toISOString(),
    });
    printJson({
      status: merged.persistedState,
      workflowId,
      batchId: batch.batchId,
      mergeCommitSha: options.mergeSha,
      note: 'External merge recorded; CodeMoot never executes merges.',
    });
  });
}

interface BatchReconcileStaleOptions {
  readonly id?: string;
  readonly expectedVersion?: number;
}

export async function reviewWorkflowBatchReconcileStaleCommand(
  workflowId: string,
  ordinalValue: string,
  options: BatchReconcileStaleOptions,
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const ordinal = parsePositiveInteger(ordinalValue, 'batch ordinal');
    const runtime = createRuntime(db, projectDir);
    resolveRuntimeContext(runtime.store, workflowId, projectDir);
    const batch = requireBatchByOrdinal(runtime.store, workflowId, ordinal);
    const reconciled = runtime.gateService.reconcileStaleApproval({
      workflowId,
      batchId: batch.batchId,
      commandId: options.id ?? `${batch.batchId}:reconcile-stale`,
      ...(options.expectedVersion === undefined
        ? {}
        : { expectedBatchVersion: options.expectedVersion }),
      createdAt: new Date().toISOString(),
    });
    printJson({
      status: reconciled.persistedState,
      workflowId,
      batchId: batch.batchId,
      note: 'Stale approval persisted; the batch must be re-verified through a new gate cycle.',
    });
  });
}

type ReviewWorkflowRuntime = ReturnType<typeof createRuntime>;

function requirePositiveIntegerField(
  payload: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Job payload field ${field} must be a positive integer`);
  }
  return value;
}

function optionalPositiveIntegerField(
  payload: Readonly<Record<string, unknown>>,
  field: string,
): number | undefined {
  return payload[field] === undefined ? undefined : requirePositiveIntegerField(payload, field);
}

function optionalStringField(
  payload: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = payload[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Job payload field ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * The executor table used by the background worker. Every executor passes the job's
 * ORIGINAL command ID through to the underlying workflow service, so a retried job replays
 * the durable receipt instead of repeating any agent or verification invocation.
 */
function buildJobExecutors(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
): Record<reviewWorkflowJobs.ReviewWorkflowJobType, reviewWorkflowJobs.ReviewWorkflowJobExecutor> {
  return {
    VERIFICATION: (job) =>
      performBatchVerification(
        runtime,
        projectDir,
        job.workflowId,
        job.commandId,
        job.batchId,
        parseVerificationJobPayload(job.payload),
      ),
    FINAL_AUDIT: (job) =>
      performFinalAudit(
        runtime,
        projectDir,
        job.workflowId,
        job.commandId,
        job.batchId,
        parseFinalAuditJobPayload(job.payload),
      ),
    CODE_REVIEW: (job) =>
      performCodeReview(
        runtime,
        projectDir,
        job.workflowId,
        job.commandId,
        job.batchId,
        parseCodeReviewJobPayload(job.payload),
      ),
  };
}

interface JobsRunOptions {
  readonly worker?: string;
  readonly maxJobs: number;
  readonly lease: number;
}

export async function reviewWorkflowJobsRunCommand(options: JobsRunOptions): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const runtime = createRuntime(db, projectDir);
    const workerId = options.worker ?? `worker:${generateId('worker')}`;
    const executors = buildJobExecutors(runtime, projectDir);
    const processed: Record<string, unknown>[] = [];
    for (let index = 0; index < options.maxJobs; index += 1) {
      const outcome = await runtime.jobService.runNext({
        workerId,
        leaseSeconds: options.lease,
        executors,
      });
      if (outcome.outcome === 'IDLE') break;
      processed.push({
        jobId: outcome.job.jobId,
        commandId: outcome.job.commandId,
        jobType: outcome.job.jobType,
        outcome: outcome.outcome,
        status: outcome.job.status,
        attemptCount: outcome.job.attemptCount,
        ...(outcome.job.errorCode === undefined ? {} : { errorCode: outcome.job.errorCode }),
      });
    }
    printJson({ workerId, processed });
  });
}

export async function reviewWorkflowJobsListCommand(workflowId: string): Promise<void> {
  await withDatabase(async (db) => {
    const runtime = createRuntime(db, process.cwd());
    printJson({
      workflowId,
      jobs: runtime.jobStore.list(workflowId).map((job) => ({
        jobId: job.jobId,
        batchId: job.batchId,
        jobType: job.jobType,
        commandId: job.commandId,
        status: job.status,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        ...(job.errorCode === undefined ? {} : { errorCode: job.errorCode }),
        ...(job.errorMessage === undefined ? {} : { errorMessage: job.errorMessage }),
      })),
    });
  });
}

export async function reviewWorkflowJobsShowCommand(jobId: string): Promise<void> {
  await withDatabase(async (db) => {
    const runtime = createRuntime(db, process.cwd());
    const job = runtime.jobStore.require(jobId);
    printJson({ ...job });
  });
}

export async function reviewWorkflowJobsCancelCommand(jobId: string): Promise<void> {
  await withDatabase(async (db) => {
    const runtime = createRuntime(db, process.cwd());
    const job = runtime.jobService.cancel(jobId);
    printJson({ jobId: job.jobId, status: job.status });
  });
}

interface EventsOptions {
  readonly after: number;
  readonly limit: number;
  readonly cursor?: string;
  readonly ack?: boolean;
  readonly tail?: number;
}

export async function reviewWorkflowEventsCommand(
  workflowId: string,
  options: EventsOptions,
): Promise<void> {
  await withDatabase(async (db) => {
    const runtime = createRuntime(db, process.cwd());
    const cursor = options.cursor === undefined ? null : runtime.jobStore.getCursor(options.cursor);
    if (cursor !== null && cursor.workflowId !== workflowId) {
      throw new Error(`Cursor ${options.cursor} belongs to workflow ${cursor.workflowId}`);
    }
    const afterEventId = cursor === null ? options.after : cursor.lastEventId;
    const events =
      options.tail === undefined
        ? runtime.jobStore.listWorkflowEvents(workflowId, afterEventId, options.limit)
        : runtime.jobStore.listWorkflowEvents(workflowId, 0, 100_000).slice(-options.tail);
    const lastEventId = events.at(-1)?.eventId ?? afterEventId;
    if (options.cursor !== undefined && options.ack === true && events.length > 0) {
      runtime.jobStore.advanceCursor({ cursorId: options.cursor, workflowId, lastEventId });
    }
    printJson({
      workflowId,
      afterEventId,
      lastEventId,
      ...(options.cursor === undefined
        ? {}
        : { cursorId: options.cursor, acknowledged: options.ack === true && events.length > 0 }),
      events: events.map((event) => ({
        eventId: event.eventId,
        batchId: event.batchId,
        sequence: event.sequence,
        eventType: event.eventType,
        commandId: event.commandId,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
    });
  });
}

export function buildFinalAuditPrompt(input: {
  readonly workflowId: string;
  readonly batchPlan: unknown;
  readonly evidence: reviewWorkflowGate.FinalAuditPromptEvidence;
}): string {
  const { evidence } = input;
  return `Perform the single bounded final completeness audit for workflow ${input.workflowId}.

Verify requirement coverage, every acceptance criterion, scope fidelity to the approved plan,
and documentation completeness against the final-gate diff below. Never modify repository
files, the Git index, or HEAD. New findings are permitted only for critical or high defects.

${reviewWorkflowContracts.buildContractInstruction(
  reviewWorkflowContracts.finalAuditResultContractSchema,
  'FINAL_AUDIT_RESULT',
)}
Echo this authoritative target verbatim:
${JSON.stringify(evidence.target, null, 2)}

Provide one requirementChecks entry per requirement ID (exactly these):
${JSON.stringify(evidence.requirementIds)}

Provide one acceptanceCriterionChecks entry per criterion ID (exactly these):
${JSON.stringify(evidence.acceptanceCriterionIds)}

Deferred (non-blocking) findings recorded earlier, for completeness context:
${JSON.stringify(evidence.deferredFindings.map((finding) => finding.title))}

Approved batch plan:
${JSON.stringify(input.batchPlan, null, 2)}

Final cumulative diff:
${evidence.cumulativePatch}`;
}

/**
 * Resolves a batch by ordinal and requires it to be the job's authoritative batch — a
 * payload whose ordinal points at a different batch must never reach the operation.
 */
export function requireBatchMatchingJob(
  store: reviewWorkflowPlan.ReviewWorkflowPlanStore,
  workflowId: string,
  ordinal: number,
  expectedBatchId: string,
) {
  const batch = requireBatchByOrdinal(store, workflowId, ordinal);
  if (batch.batchId !== expectedBatchId) {
    throw new Error(
      `Job payload ordinal ${ordinal} resolves to batch ${batch.batchId}, not the job's batch ${expectedBatchId}`,
    );
  }
  return batch;
}

function requireBatchByOrdinal(
  store: reviewWorkflowPlan.ReviewWorkflowPlanStore,
  workflowId: string,
  ordinal: number,
) {
  const batch = store.listBatches(workflowId).find((candidate) => candidate.ordinal === ordinal);
  if (batch === undefined) throw new Error(`Workflow ${workflowId} has no batch ${ordinal}`);
  return batch;
}

function persistCliActor(
  store: reviewWorkflowPlan.ReviewWorkflowPlanStore,
  input: {
    readonly actorExecutionId: string;
    readonly actorType: 'HUMAN' | 'SYSTEM' | 'CI';
    readonly authorities: readonly reviewWorkflow.Authority[];
    readonly assurance?: 'PROCESS_ATTESTED';
  },
): reviewWorkflow.ActorExecutionIdentity {
  const now = new Date().toISOString();
  const actor: reviewWorkflow.ActorExecutionIdentity = {
    actorExecutionId: input.actorExecutionId,
    actorType: input.actorType,
    authoritiesExercised: [...input.authorities],
    identityAssurance: input.assurance ?? 'CLI_ASSERTED',
    observedEvidence: [{ kind: 'LOCAL_CLI', source: 'codemoot batch', observedAt: now }],
    startedAt: now,
  };
  store.workflowStore.saveEntity({ kind: 'ACTOR_EXECUTION', value: actor });
  return actor;
}

/** Invocation 0 of refinement: the whole plan's SHAPE, with no batch bodies. */
export function buildRefinementOutlinePrompt(input: {
  readonly workflowId: string;
  readonly repositoryAudit: unknown;
  readonly generalPlanContent: string;
  readonly requirements: readonly {
    readonly requirementId: string;
    readonly sourceReference: string;
    readonly statement: string;
  }[];
}): string {
  return `Act as the assigned plan refiner. Audit the supplied repository evidence against the external plan, then return the refinement OUTLINE only.

${reviewWorkflowContracts.buildContractInstruction(
  reviewWorkflowContracts.refinementOutlineContractSchema,
  'REFINEMENT_OUTLINE_RESULT',
)}

Do NOT write the batch plans here — each batch is authored in its own separate response
afterwards, so this outline stays small. For ordinal N use:
- batchId: ${input.workflowId}:batch:N
- batchPlanVersionId: ${input.workflowId}:batch:N:plan:1

Ordinals must be sequential starting at 1.

Do NOT map requirements to acceptance criteria here. The criteria do not exist yet, so any
mapping made now would be a guess; each batch declares the requirements its criteria serve,
and the coverage map is derived from those declarations. Make sure the batch objectives
between them account for every imported requirement — that is what makes the derived
coverage complete.

Repository audit:
${JSON.stringify(input.repositoryAudit, null, 2)}

Imported requirements:
${JSON.stringify(input.requirements, null, 2)}

External general plan:
${input.generalPlanContent}`;
}

/** One batch plan per invocation — stored the moment it completes. */
export function buildBatchPlanPrompt(input: {
  readonly workflowId: string;
  readonly batch: {
    readonly batchId: string;
    readonly batchPlanVersionId: string;
    readonly ordinal: number;
    readonly objective: string;
  };
  readonly outlineSummary: string;
  readonly requirements: readonly {
    readonly requirementId: string;
    readonly sourceReference: string;
    readonly statement: string;
  }[];
  readonly earlierBatchIds: readonly string[];
}): string {
  return `Author the COMPLETE batch plan for batch ${input.batch.ordinal} only. You already produced the outline; this response covers exactly one batch.

${reviewWorkflowContracts.buildContractInstruction(
  reviewWorkflowContracts.batchPlanContractSchema,
  'BATCH_PLAN_RESULT',
)}

Use exactly these identifiers:
- batchId: ${input.batch.batchId}
- batchPlanVersionId: ${input.batch.batchPlanVersionId}
- ordinal: ${input.batch.ordinal}
- acceptanceCriterionId: ${input.batch.batchId}:criterion:N for the Nth criterion, numbered
  from 1. Every batch is authored in a SEPARATE call that cannot see the others, so an
  unnamespaced ID like "criterion-01" collides with another batch's. Use this exact form in
  acceptanceCriteria and in every list that references a criterion.

Each criterion's sourceRequirementIds must name the imported requirements it actually
serves: the plan-wide requirement coverage map is derived from those declarations, so a
requirement no criterion claims counts as uncovered.

Objective agreed in the outline: ${input.batch.objective}
Refinement summary: ${input.outlineSummary}

dependencies may reference ONLY these earlier batch IDs: ${
    input.earlierBatchIds.length === 0
      ? '(none — this is the first batch)'
      : input.earlierBatchIds.join(', ')
  }
Every acceptance criterion's sourceRequirementIds must reference imported requirement IDs.
Do not describe any other batch.

Imported requirements:
${JSON.stringify(input.requirements, null, 2)}`;
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

${reviewWorkflowContracts.buildContractInstruction(
  reviewWorkflowContracts.refinementResultContractSchema,
  'REFINEMENT_RESULT',
)}
Include batchPlans with every field required by the CodeMoot batch-plan contract. Use sequential ordinals starting at 1. For ordinal N use:
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

${reviewWorkflowContracts.buildContractInstruction(
  reviewWorkflowContracts.reviewResultContractSchema,
  'REVIEW_RESULT',
)}
Echo this authoritative PLAN target exactly:
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

${reviewWorkflowContracts.buildContractInstruction(
  reviewWorkflowContracts.implementationResultContractSchema,
  'IMPLEMENTATION_RESULT',
)}
Use outcome COMPLETE only after the whole batch is implemented. changedFiles must exactly list the repository paths actually changed relative to ${input.originalBatchBaseSha}. verificationRecordIds may contain only already-persisted CodeMoot verification records; ordinary command output is not a verification record. Use BLOCKED only for a genuine external blocker and include blockerReason.

Approved batch plan:
${JSON.stringify(input.batchPlan, null, 2)}

Acceptance criteria:
${JSON.stringify(input.acceptanceCriteria, null, 2)}`;
}

function createRuntime(db: ReturnType<typeof openDatabase>, projectDir: string) {
  const store = new reviewWorkflowPlan.ReviewWorkflowPlanStore(db);
  const gateStore = new reviewWorkflowGate.ReviewWorkflowGateStore(db);
  const implementationStore = new reviewWorkflowImplementation.ReviewWorkflowImplementationStore(
    db,
  );
  const commandStore = new reviewWorkflowPersistence.ReviewWorkflowCommandStore(db);
  const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);
  const jobStore = new reviewWorkflowJobs.ReviewWorkflowJobStore(db);
  const contractService = new reviewWorkflowContracts.ReviewWorkflowContractService(
    store.workflowStore,
  );
  const runnerGitOps = createRunnerGit(projectDir);
  const runnerStoreForObserver = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);
  const roleInvocation = new RoleInvocationService(
    store.workflowStore,
    {
      collect: () => runnerGitOps.collectState(),
      changedBetween: (beforeSha, afterSha) => runnerGitOps.changedBetween(beforeSha, afterSha),
    },
    {
      // Durable live monitoring: the ACTIVE invocation identity is persisted in the runner
      // state for the whole time the agent is in flight.
      onStart: (info) => {
        if (runnerStoreForObserver.get(info.workflowId) === null) return;
        runnerStoreForObserver.update(info.workflowId, {
          activeInvocation: {
            invocationId: info.invocationId,
            role: info.role ?? null,
            adapterKind: info.adapterKind,
            model: info.model,
            phase: info.phase ?? null,
            startedAt: info.startedAt,
            // Nothing external has run yet: a crash here restarts safely.
            stage: 'PREPARING',
          },
        });
      },
      onAgentSpawned: (workflowId, invocationId) => {
        const current = runnerStoreForObserver.get(workflowId);
        if (current?.activeInvocation?.invocationId !== invocationId) return;
        runnerStoreForObserver.update(workflowId, {
          // The agent process exists: its outcome is uncertain until durably settled.
          activeInvocation: { ...current.activeInvocation, stage: 'AGENT_RUNNING' },
        });
      },
      onSettle: (workflowId) => {
        if (runnerStoreForObserver.get(workflowId) === null) return;
        runnerStoreForObserver.update(workflowId, { activeInvocation: null });
      },
    },
  );
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
    commandStore,
    runnerStore,
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
    jobStore,
    jobService: new reviewWorkflowJobs.ReviewWorkflowJobService(jobStore, commandStore),
    gateStore,
    gateService: new reviewWorkflowGate.ReviewWorkflowGateService(
      gateStore,
      commandStore,
      contractService,
      new reviewWorkflowGit.ReviewWorkflowGitService(
        repository,
        createFilePatchArtifactSink(projectDir),
      ),
      repository,
      roleInvocation,
    ),
    verificationService: new reviewWorkflowVerification.ReviewWorkflowVerificationService(
      store.workflowStore,
      { readHeadSha: () => repository.readHeadSha() },
      new reviewWorkflowVerification.LocalVerificationCommandRunner(),
      new reviewWorkflowVerification.LocalVerificationLogStore(
        resolve(projectDir, '.codemoot', 'review-workflow', 'verification-logs'),
      ),
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

// ---------------------------------------------------------------------------
// Autonomous workflow runner (codemoot workflow run / watch / logs / export)
// ---------------------------------------------------------------------------

interface RunnerGitOps extends reviewWorkflowRunner.RunnerGit {
  status(): string;
  collectState(): {
    branch: string;
    headSha: string;
    clean: boolean;
    changedFiles: readonly string[];
  };
  changedBetween(beforeSha: string, afterSha: string): readonly string[];
}

let cachedRealGitPath: string | undefined;

/** The absolute real git binary, resolved BEFORE the guard shim joins PATH. */
function resolveRealGit(): string {
  if (cachedRealGitPath === undefined) {
    cachedRealGitPath = execFileSync('/bin/sh', ['-lc', 'command -v git'], { encoding: 'utf8' })
      .trim()
      .split('\n')[0] as string;
  }
  return cachedRealGitPath;
}

/** Deny-by-default: ONLY these read/commit subcommands are permitted for agent shells. */
const ALLOWED_GIT_SUBCOMMANDS = [
  'status',
  'diff',
  'log',
  'show',
  'add',
  'commit',
  'rev-parse',
  'ls-files',
  'grep',
  'blame',
  'describe',
  'cat-file',
  'shortlog',
  'count-objects',
  'version',
  'help',
  'mv',
] as const;

/**
 * Installs the git execution boundary for agent subprocesses: a PATH-first `git` wrapper
 * that refuses every forbidden subcommand outright. CodeMoot's own git operations bypass it
 * via the absolute real-git path.
 */
export function installGitGuard(projectDir: string): string {
  const realGit = resolveRealGit();
  const guardDir = resolve(projectDir, '.cowork', 'git-guard');
  mkdirSync(guardDir, { recursive: true });
  const guardPath = resolve(guardDir, 'git');
  // Deny-by-default: the wrapper resolves the ACTUAL subcommand (skipping every global git
  // option, including `-C <path>` and `-c k=v`) and refuses anything not on the read/commit
  // allowlist. Only an explicitly allowed subcommand ever reaches the real binary.
  const script = [
    '#!/bin/sh',
    '# CodeMoot git guard: deny-by-default; only read/commit subcommands may execute.',
    'sub=""',
    'skip=0',
    'for arg in "$@"; do',
    '  if [ "$skip" = "1" ]; then skip=0; continue; fi',
    '  case "$arg" in',
    '    -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env) skip=1 ;;',
    '    -*) ;;',
    '    *) sub="$arg"; break ;;',
    '  esac',
    'done',
    'case "$sub" in',
    `  ${ALLOWED_GIT_SUBCOMMANDS.join('|')}|"")`,
    `    exec "${realGit}" "$@"`,
    '    ;;',
    'esac',
    'echo "codemoot git-guard: git $sub is forbidden during autonomous execution" >&2',
    'exit 128',
    '',
  ].join('\n');
  writeFileSync(guardPath, script, { mode: 0o755 });
  // Second layer: pushes to origin are blocked at the git-config level for EVERY git
  // binary (absolute paths included); the gated push honours the preserved ORIGINAL push
  // URL, and uninstallGitGuard restores it when the run ends.
  const originalFile = resolve(guardDir, 'original-pushurl');
  let original = PUSH_URL_NONE;
  try {
    original = execFileSync(realGit, ['config', '--get', 'remote.origin.pushurl'], {
      cwd: projectDir,
      encoding: 'utf8',
    }).trim();
  } catch {
    // no custom push URL configured
  }
  if (original !== PUSH_URL_SENTINEL) {
    writeFileSync(originalFile, original.length === 0 ? PUSH_URL_NONE : original);
  }
  execFileSync(realGit, ['config', 'remote.origin.pushurl', PUSH_URL_SENTINEL], {
    cwd: projectDir,
  });
  // The guarded PATH is injected ONLY into agent CLI subprocesses (via invocation options);
  // CodeMoot's own git/verification subprocesses keep the unguarded environment.
  guardedAgentPath = `${guardDir}:${process.env.PATH ?? ''}`;
  return guardPath;
}

const PUSH_URL_SENTINEL = 'file:///codemoot-push-blocked';
const PUSH_URL_NONE = '<none>';

/** Restores the user's original push URL; called whenever a runner invocation ends. */
export function uninstallGitGuard(projectDir: string): void {
  const realGit = resolveRealGit();
  const originalFile = resolve(projectDir, '.cowork', 'git-guard', 'original-pushurl');
  let original = PUSH_URL_NONE;
  try {
    original = readFileSync(originalFile, 'utf8').trim();
  } catch {
    return; // guard was never installed
  }
  if (original === PUSH_URL_NONE || original.length === 0) {
    try {
      execFileSync(realGit, ['config', '--unset', 'remote.origin.pushurl'], { cwd: projectDir });
    } catch {
      // already unset
    }
  } else {
    execFileSync(realGit, ['config', 'remote.origin.pushurl', original], { cwd: projectDir });
  }
}

/** Reads the preserved original push URL (or null) for the gated push. */
function preservedPushUrl(projectDir: string): string | null {
  try {
    const original = readFileSync(
      resolve(projectDir, '.cowork', 'git-guard', 'original-pushurl'),
      'utf8',
    ).trim();
    return original === PUSH_URL_NONE || original.length === 0 ? null : original;
  } catch {
    return null;
  }
}

let guardedAgentPath: string | undefined;

/** Invocation options for agent CLIs: timeout plus the git-guarded PATH when active. */
function agentInvocationOptions(timeoutSeconds: number): {
  timeout: number;
  env?: Readonly<Record<string, string>>;
} {
  return {
    timeout: timeoutSeconds * 1000,
    ...(guardedAgentPath === undefined
      ? {}
      : {
          env: {
            PATH: guardedAgentPath,
            // Credential-less git for agent shells: no global/system config (credential
            // helpers), no prompts, no askpass — authenticated pushes fail even through an
            // absolute git binary. SSH agents are excluded by the adapter env allowlist.
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: '/usr/bin/false',
            // HOME stays visible (the model CLIs need it), so SSH itself is disabled:
            // key discovery under ~/.ssh is useless when every ssh invocation fails.
            GIT_SSH_COMMAND: '/usr/bin/false',
          },
        }),
  };
}

function createRunnerGit(projectDir: string): RunnerGitOps {
  const run = (args: readonly string[]): string =>
    execFileSync(resolveRealGit(), [...args], { cwd: projectDir, encoding: 'utf8' }).trim();
  return {
    currentBranch: () => run(['rev-parse', '--abbrev-ref', 'HEAD']),
    headSha: () => run(['rev-parse', 'HEAD']),
    isClean: () => run(['status', '--porcelain']) === '',
    createBranch: (name) => {
      run(['checkout', '-b', name]);
    },
    push: (branch) => {
      // The gated push honours the user's ORIGINAL push URL (preserved at guard install)
      // and restores the config-level block afterwards.
      const original = preservedPushUrl(projectDir);
      if (original === null) {
        try {
          run(['config', '--unset', 'remote.origin.pushurl']);
        } catch {
          // not set — fine
        }
      } else {
        run(['config', 'remote.origin.pushurl', original]);
      }
      try {
        run(['push', '-u', 'origin', branch]);
      } finally {
        run(['config', 'remote.origin.pushurl', PUSH_URL_SENTINEL]);
      }
    },
    collectState: () => ({
      branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
      headSha: run(['rev-parse', 'HEAD']),
      clean: run(['status', '--porcelain']) === '',
      changedFiles: run(['status', '--porcelain'])
        .split('\n')
        .filter((line) => line.length > 3)
        .map((line) => line.slice(3)),
    }),
    changedBetween: (beforeSha, afterSha) =>
      run(['diff', '--name-only', `${beforeSha}..${afterSha}`])
        .split('\n')
        .filter((line) => line.length > 0),
    remoteHeadSha: (branch) => {
      const output = run(['ls-remote', 'origin', `refs/heads/${branch}`]);
      const sha = output.split('\t')[0];
      return sha === undefined || sha.length === 0 ? null : sha;
    },
    refSha: (ref) => run(['rev-parse', ref]),
    statusFingerprint: () =>
      createHash('sha256')
        .update(run(['status', '--porcelain']))
        .digest('hex'),
    status: () => run(['status', '--porcelain']),
  };
}

/** Appended to every autonomous implementer prompt: the agent may only commit in place. */
const GIT_PROHIBITIONS =
  '\n\nSTRICT REPOSITORY RULES (violations stop the workflow): stay on the current branch at all times. ' +
  'Never switch or create branches, never push, never pull or fetch, never merge, never rebase, ' +
  'never reset, never stash, never force-push, never delete branches, and never modify any other ' +
  'branch. Only create ordinary commits on the current branch exactly as instructed.';

function isAncestorOfHead(projectDir: string, sha: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: projectDir });
    return true;
  } catch {
    return false;
  }
}

function formatFindingsForPrompt(findings: readonly reviewWorkflow.Finding[]): string {
  return findings
    .map(
      (finding) =>
        `- ${finding.findingId} [${finding.severity.toUpperCase()}/${finding.category}] ${finding.title}\n` +
        `  Description: ${finding.description}\n` +
        `  Affected files: ${finding.affectedFiles.join(', ') || 'unspecified'}\n` +
        `  Expected: ${finding.expectedResult}\n` +
        `  Observed: ${finding.observedResult}\n` +
        `  Required action: ${finding.requiredAction}\n` +
        `  Evidence: ${finding.repositoryEvidence
          .map((evidence) => `${evidence.kind} ${evidence.location} (${evidence.description})`)
          .join('; ')}`,
    )
    .join('\n');
}

const FALLBACK_INVOCATION_TIMEOUT_SECONDS = 1800;

/**
 * The per-invocation timeout ceiling, resolved ONCE from the same sources everywhere:
 * an explicit --timeout wins, otherwise the implementer's `cliAdapter.timeout` from
 * `.cowork.yml`. Before this, the runner always passed an explicit value, so the
 * configured ceiling was dead configuration — it validated, was documented, and silently
 * did nothing while three runs were killed at the 30-minute default.
 */
export function resolveInvocationTimeoutSeconds(
  projectDir: string,
  explicitSeconds?: number,
): number {
  if (explicitSeconds !== undefined) return explicitSeconds;
  try {
    const config = loadConfig({ projectDir });
    const implementerAlias = config.roles.implementer?.model;
    const configured =
      implementerAlias === undefined
        ? undefined
        : config.models[implementerAlias]?.cliAdapter?.timeout;
    return configured ?? FALLBACK_INVOCATION_TIMEOUT_SECONDS;
  } catch {
    return FALLBACK_INVOCATION_TIMEOUT_SECONDS;
  }
}

function planSlug(planFile: string): string {
  return (
    basename(planFile)
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'plan'
  );
}

async function performAutonomousPlanReview(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
  workflowId: string,
  batch: reviewWorkflowRunner.RunnerBatchDescriptor,
  round: number,
  timeoutSeconds: number,
): Promise<{ approved: boolean }> {
  const context = resolveRuntimeContext(runtime.store, workflowId, projectDir);
  const stored = runtime.store
    .listBatches(workflowId)
    .find((candidate) => candidate.ordinal === batch.ordinal);
  if (stored === undefined) throw new Error(`Workflow ${workflowId} has no batch ${batch.ordinal}`);
  if (stored.persistedState === 'APPROVED_FOR_IMPLEMENTATION') return { approved: true };
  const plan = runtime.store.getBatchPlan(stored.currentPlanVersionId);
  if (plan === null) throw new Error(`Batch ${stored.batchId} has no current plan`);
  const commandId = reviewWorkflowPlan.derivePlanCommandId(stored.batchId, `review-${round}`);
  const actorExecutionId = `${stored.batchId}:reviewer:${generateId('execution')}`;
  const audit = runtime.store.getLatestRepositoryAudit(workflowId);
  if (audit === null) throw new Error(`Workflow ${workflowId} has no repository audit`);
  runtime.service.verifyRepositoryContext(workflowId, audit.repositoryAuditId, actorExecutionId);
  const prepared = await runtime.roleInvocation.prepare({
    resolution: context.roles.reviewer,
    workflowId,
    commandId,
    actorExecutionId,
    invocationId: `${stored.batchId}:reviewer:${generateId('invocation')}`,
    sessionIdentityId: `${stored.batchId}:reviewer:${generateId('session')}`,
    sessionBinding: { batchId: stored.batchId, role: 'REVIEWER', expectExisting: round > 1 },
    auditPhase: 'PLAN_REVIEW',
    prompt: buildPlanReviewPrompt({
      workflowId,
      batchPlan: plan,
      acceptanceCriteria: runtime.store.listAcceptanceCriteria(plan.batchPlanVersionId),
    }),
    options: agentInvocationOptions(timeoutSeconds),
  });
  const result = runtime.service.capturePlanReview({
    transcriptId: `${stored.batchId}:plan-review:${generateId('transcript')}`,
    workflowId,
    batchId: stored.batchId,
    actorExecutionId,
    invocationId: prepared.invocation.invocationId,
    sessionIdentityId: prepared.session.sessionIdentityId,
    rawTranscript: prepared.call.text,
    createdAt: prepared.invocation.finishedAt ?? new Date().toISOString(),
    reviewRoundId: `${stored.batchId}:plan-review:${round}`,
    reviewRoundNumber: round,
    actor: prepared.execution,
    roleSeparation: {
      implementerAssignment: context.snapshot.assignments.implementer,
      reviewerAssignment: context.snapshot.assignments.reviewer,
      reviewerSessionIdentityId: prepared.session.sessionIdentityId,
      minimumIdentityAssurance: context.snapshot.identityPolicy.minimumAssurance,
    },
    blockingSeverities: context.snapshot.gates.blockingSeverities,
    preparedInvocation: prepared,
  });
  return { approved: result.capture.accepted && result.state === 'APPROVED_FOR_IMPLEMENTATION' };
}

async function performAutonomousPlanRevision(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
  workflowId: string,
  batch: reviewWorkflowRunner.RunnerBatchDescriptor,
  round: number,
  timeoutSeconds: number,
): Promise<void> {
  const context = resolveRuntimeContext(runtime.store, workflowId, projectDir);
  const stored = requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal);
  if (stored.persistedState !== 'PLAN_NEEDS_REVISION') {
    throw new Error(
      `Batch ${stored.batchId} cannot submit a plan revision from ${stored.persistedState}`,
    );
  }
  const plan = runtime.store.getBatchPlan(stored.currentPlanVersionId);
  if (plan === null) throw new Error(`Batch ${stored.batchId} has no current plan`);
  const openFindings = runtime.store
    .listPlanFindings(stored.batchId)
    .filter((finding) => finding.status === 'OPEN');
  const criteria = runtime.store.listAcceptanceCriteria(plan.batchPlanVersionId);
  const revisedPlanVersionId = reviewWorkflowPlan.deriveBatchPlanVersionId(
    stored.batchId,
    plan.version + 1,
  );
  const commandId = reviewWorkflowPlan.derivePlanCommandId(stored.batchId, `revise-${round}`);
  const draftTemplate = {
    batchPlanVersionId: revisedPlanVersionId,
    batchId: stored.batchId,
    ordinal: stored.ordinal,
    objective: plan.objective,
    currentRepositoryEvidence: plan.currentRepositoryEvidence,
    dependencies: plan.dependencies,
    candidateFiles: plan.candidateFiles,
    technicalImplementation: plan.technicalImplementation,
    userJourney: plan.userJourney,
    expectedBehaviour: plan.expectedBehaviour,
    acceptanceCriteria: criteria.map((criterion) => ({
      acceptanceCriterionId: criterion.acceptanceCriterionId,
      kind: criterion.kind,
      statement: criterion.statement,
      required: criterion.required,
      passCondition: criterion.passCondition,
      sourceRequirementIds: criterion.sourceRequirementIds,
    })),
    technicalAcceptanceCriteria: plan.technicalAcceptanceCriteria,
    userFacingAcceptanceCriteria: plan.userFacingAcceptanceCriteria,
    cliAcceptanceCriteria: plan.cliAcceptanceCriteria,
    browserAcceptanceCriteria: plan.browserAcceptanceCriteria,
    verificationCommands: plan.verificationCommands,
    manualVerification: plan.manualVerification,
    documentationChanges: plan.documentationChanges,
    outOfScope: plan.outOfScope,
    rollbackBoundary: plan.rollbackBoundary,
  };
  const prepared = await runtime.roleInvocation.prepare({
    resolution: context.roles.implementer,
    workflowId,
    commandId,
    actorExecutionId: `${stored.batchId}:plan-revision:${generateId('execution')}`,
    invocationId: `${stored.batchId}:plan-revision:${generateId('invocation')}`,
    sessionIdentityId: `${stored.batchId}:implementer:${generateId('session')}`,
    sessionBinding: { batchId: stored.batchId, role: 'IMPLEMENTER' },
    auditPhase: 'PLAN_REVISION',
    prompt: `The plan review for batch ${stored.ordinal} returned NEEDS_REVISION. Revise the batch plan so every finding is resolved. Reply with EXACTLY one JSON object and nothing else, in this exact contract shape:\n{"schemaVersion": 1, "contractKind": "PLAN_REVISION_RESULT", "batchId": "${stored.batchId}", "previousPlanVersionId": "${plan.batchPlanVersionId}", "summary": "<what changed and why>", "revisedPlan": <the COMPLETE revised batch plan object>, "findingResponses": [{"findingId": "<id>", "response": "REVISED" | "NO_CHANGE_WITH_EVIDENCE", "explanation": "<how the revision resolves it>"}]}\nThe revisedPlan object must keep this exact structure (update the content, keep batchPlanVersionId "${revisedPlanVersionId}"):\n${JSON.stringify(draftTemplate, null, 2)}\nEvery open finding below must appear exactly once in findingResponses:\n${formatFindingsForPrompt(openFindings)}`,
    options: agentInvocationOptions(timeoutSeconds),
  });
  const result = runtime.service.capturePlanRevision({
    workflowId,
    batchId: stored.batchId,
    revisionRound: round,
    actor: prepared.execution,
    rawTranscript: prepared.call.text,
    createdAt: prepared.invocation.finishedAt ?? new Date().toISOString(),
    preparedInvocation: prepared,
  });
  if (result.batch.persistedState !== 'DRAFT') {
    throw new Error(`Plan revision left batch ${stored.batchId} in ${result.batch.persistedState}`);
  }
}

async function performAutonomousImplementation(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
  workflowId: string,
  batch: reviewWorkflowRunner.RunnerBatchDescriptor,
  timeoutSeconds: number,
  correction?: { readonly pass: number; readonly blockingFindingIds: readonly string[] },
): Promise<{ commitSha: string }> {
  const context = resolveRuntimeContext(runtime.store, workflowId, projectDir);
  const stored = requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal);
  const plan = runtime.store.getBatchPlan(stored.currentPlanVersionId);
  if (plan === null) throw new Error(`Batch ${stored.batchId} has no current plan`);
  const acceptanceCriteria = runtime.store.listAcceptanceCriteria(plan.batchPlanVersionId);
  // Autonomous mode always creates agent-authorized commits; only HUMAN_REQUIRED denies it.
  if (context.snapshot.commitPolicy === 'HUMAN_REQUIRED') {
    throw new Error(
      'Autonomous execution requires a commit policy that authorizes agent commits (AGENT_AUTHORIZED or EITHER)',
    );
  }
  const creationMode = 'AGENT_AUTHORIZED' as const;
  // Crash recovery: an AWAITING_COMMIT batch already has an executed, evidence-complete
  // implementation attempt — only the completion step remains.
  if (stored.persistedState === 'AWAITING_COMMIT') {
    const attempt = runtime.implementationStore.listImplementationAttempts(stored.batchId).at(-1);
    if (attempt === undefined) {
      throw new Error(`Batch ${stored.batchId} is AWAITING_COMMIT without a persisted attempt`);
    }
    const recoveredHead = createRunnerGit(projectDir).headSha();
    const recovered = runtime.implementationService.complete({
      workflowId,
      batchId: stored.batchId,
      configuration: context.snapshot,
      implementationAttemptId: attempt.implementationAttemptId,
      implementationReadyEvidenceId:
        reviewWorkflowImplementation.deriveImplementationReadyEvidenceId(
          attempt.implementationAttemptId,
        ),
      providedCommitSha: recoveredHead,
      creationMode,
      commandId: `${attempt.implementationAttemptId}:complete`,
    });
    if (recovered.batch.persistedState !== 'IMPLEMENTATION_COMPLETE') {
      throw new Error(`Implementation completion left batch in ${recovered.batch.persistedState}`);
    }
    return { commitSha: recoveredHead };
  }
  const bound = runtime.store.workflowStore.getBatchRoleSession(stored.batchId, 'IMPLEMENTER');
  let implementerSessionIdentityId: string;
  if (correction !== undefined) {
    if (bound === null) throw new Error(`Batch ${stored.batchId} has no implementer session`);
    await runtime.implementationService.resume({
      workflowId,
      batchId: stored.batchId,
      configuration: context.snapshot,
      resolution: context.roles.implementer,
      commandId: `${stored.batchId}:resume-implementation-auto-${correction.pass}`,
      actorExecutionId: `${stored.batchId}:implementer:${generateId('execution')}`,
      invocationId: `${stored.batchId}:implementer:${generateId('invocation')}`,
      sessionIdentityId: bound.sessionIdentityId,
      previousSessionIdentityId: bound.sessionIdentityId,
      prompt: buildImplementationResumePrompt({ workflowId, batchId: stored.batchId }),
      options: agentInvocationOptions(timeoutSeconds),
    });
    implementerSessionIdentityId = bound.sessionIdentityId;
  } else if (stored.persistedState === 'IMPLEMENTING') {
    implementerSessionIdentityId = requireImplementationSessionIdentityId(
      runtime.implementationStore,
      stored.batchId,
    );
  } else {
    implementerSessionIdentityId = (
      await runtime.implementationService.start({
        workflowId,
        batchId: stored.batchId,
        configuration: context.snapshot,
        resolution: context.roles.implementer,
        commandId: `${stored.batchId}:start-implementation`,
        actorExecutionId: `${stored.batchId}:implementer-preflight:${generateId('execution')}`,
        invocationId: `${stored.batchId}:implementer-preflight:${generateId('invocation')}`,
        sessionIdentityId: `${stored.batchId}:implementer:${generateId('session')}`,
        prompt: buildImplementationPreflightPrompt({
          workflowId,
          batchId: stored.batchId,
          planVersionId: plan.batchPlanVersionId,
        }),
        options: agentInvocationOptions(timeoutSeconds),
      })
    ).implementerSessionIdentityId;
  }
  const implementationBatch = runtime.implementationStore.getBatch(stored.batchId);
  if (implementationBatch?.originalBatchBaseSha === undefined) {
    throw new Error(`Batch ${stored.batchId} has no established implementation base`);
  }
  const attemptNumber =
    runtime.implementationStore.listImplementationAttempts(stored.batchId).length + 1;
  const attemptId = reviewWorkflowImplementation.deriveImplementationAttemptId(
    stored.batchId,
    attemptNumber,
  );
  const basePrompt = buildImplementationPrompt({
    workflowId,
    batchPlan: plan,
    acceptanceCriteria,
    originalBatchBaseSha: implementationBatch.originalBatchBaseSha,
    creationMode,
  });
  const correctionFindings =
    correction === undefined
      ? []
      : runtime.gateStore
          .listBatchFindings(stored.batchId)
          .filter((finding) => correction.blockingFindingIds.includes(finding.findingId));
  if (
    correction !== undefined &&
    correctionFindings.length !== correction.blockingFindingIds.length
  ) {
    const found = correctionFindings.map((finding) => finding.findingId);
    const missing = correction.blockingFindingIds.filter((id) => !found.includes(id));
    throw new Error(`Blocking findings are not persisted: ${missing.join(', ')}`);
  }
  const prompt =
    correction === undefined
      ? `${basePrompt}${GIT_PROHIBITIONS}`
      : `${basePrompt}\n\nThis is correction pass ${correction.pass}. Fix EVERY blocking finding below completely, run the verification commands, and commit the corrected work on the current branch:\n${formatFindingsForPrompt(correctionFindings)}${GIT_PROHIBITIONS}`;
  const result = await runtime.implementationService.execute({
    workflowId,
    batchId: stored.batchId,
    configuration: context.snapshot,
    resolution: context.roles.implementer,
    commandId: `${stored.batchId}:implementation:${attemptNumber}:ready`,
    actorExecutionId: `${stored.batchId}:implementer:${generateId('execution')}`,
    invocationId: `${stored.batchId}:implementer:${generateId('invocation')}`,
    sessionIdentityId: implementerSessionIdentityId,
    previousSessionIdentityId: implementerSessionIdentityId,
    transcriptId: `${stored.batchId}:implementation:${attemptNumber}:transcript`,
    implementationAttemptId: attemptId,
    implementationReadyEvidenceId:
      reviewWorkflowImplementation.deriveImplementationReadyEvidenceId(attemptId),
    attemptNumber,
    creationMode,
    prompt,
    options: agentInvocationOptions(timeoutSeconds),
  });
  if (result.status !== 'AWAITING_COMMIT') {
    throw new Error(
      `Implementation attempt ${attemptNumber} did not reach AWAITING_COMMIT (${result.status})`,
    );
  }
  const head = createRunnerGit(projectDir).headSha();
  const completed = runtime.implementationService.complete({
    workflowId,
    batchId: stored.batchId,
    configuration: context.snapshot,
    implementationAttemptId: attemptId,
    implementationReadyEvidenceId:
      reviewWorkflowImplementation.deriveImplementationReadyEvidenceId(attemptId),
    providedCommitSha: head,
    creationMode,
    commandId: `${attemptId}:complete`,
  });
  if (completed.batch.persistedState !== 'IMPLEMENTATION_COMPLETE') {
    throw new Error(`Implementation completion left batch in ${completed.batch.persistedState}`);
  }
  if (correction !== undefined) {
    // The implementer AUTHORS its own DISPOSITION_RESULT in a dedicated resumed invocation;
    // nothing is synthesized. The capture validates schema, commit target, and exact
    // per-finding coverage, and the bounded final review still judges every claim.
    const dispositionCommandId = `${stored.batchId}:dispositions:${correction.pass}:invoke`;
    const dispositionInvocationId = `${dispositionCommandId}:invocation`;
    const dispositionRequester: reviewWorkflow.ActorExecutionIdentity = {
      actorExecutionId: `${dispositionCommandId}:requester`,
      actorType: 'AGENT',
      assignmentId: context.snapshot.assignments.implementer.assignmentId,
      invocationIdentityId: dispositionInvocationId,
      sessionIdentityId: implementerSessionIdentityId,
      authoritiesExercised: ['IMPLEMENTER'],
      identityAssurance: 'CONFIG_ONLY',
      observedEvidence: [],
      startedAt: new Date().toISOString(),
    };
    const dispositionGuard: reviewWorkflow.TransitionCommand = {
      type: 'BLOCK_BATCH',
      reason: `DISPOSITION_AUTHORING_GUARD:${correction.pass}`,
    };
    const dispositionRequest = {
      commandId: dispositionCommandId,
      workflowId,
      batchId: stored.batchId,
      expectedAggregateVersion: requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal)
        .aggregateVersion,
      requester: dispositionRequester,
      authorityExercised: 'IMPLEMENTER' as const,
      command: dispositionGuard,
    };
    runtime.commandStore.reserve(
      { ...dispositionRequest, canonicalRequestHash: hashRunnerValue(dispositionRequest) },
      'AGENT_INVOCATION',
    );
    runtime.commandStore.claimSideEffect(dispositionCommandId, dispositionInvocationId);
    const dispositionPrepared = await runtime.roleInvocation.prepare({
      resolution: context.roles.implementer,
      workflowId,
      commandId: dispositionCommandId,
      actorExecutionId: `${dispositionCommandId}:execution`,
      invocationId: dispositionInvocationId,
      sessionIdentityId: `${dispositionCommandId}:session`,
      sessionBinding: { batchId: stored.batchId, role: 'IMPLEMENTER', expectExisting: true },
      auditPhase: 'CORRECTION',
      prompt: `You just committed correction pass ${correction.pass} as commit ${head}. Author your consolidated disposition result for the blocking findings below. Reply with EXACTLY one JSON object and nothing else, in this exact contract shape:\n{"schemaVersion": 1, "contractKind": "DISPOSITION_RESULT", "target": {"kind": "CODE", "resultingCommitSha": "${head}"}, "summary": "<one-paragraph summary>", "dispositions": [{"findingId": "<id>", "disposition": "FIXED" | "NO_CHANGE_WITH_EVIDENCE" | "BLOCKED", "explanation": "<what you actually changed and why it resolves the finding>", "filesChanged": ["<each file you actually changed for this finding>"], "verificationRecordIds": [], "evidence": [{"kind": "DIFF", "location": "<file or commit path>", "description": "<what the evidence shows>"}]}]}\nEvery finding below must appear exactly once. Report only what you actually did — an honest BLOCKED is acceptable; a false FIXED is not.\nFindings:\n${formatFindingsForPrompt(correctionFindings)}`,
      options: agentInvocationOptions(timeoutSeconds),
    });
    runtime.roleInvocation.persistPrepared(dispositionPrepared);
    runtime.commandStore.succeedWithoutTransition({
      commandId: dispositionCommandId,
      resultHash: hashRunnerValue(dispositionPrepared.call.text),
      result: { dispositionsAuthored: true },
    });
    const capture = runtime.codeReviewService.submitDispositions({
      workflowId,
      batchId: stored.batchId,
      configuration: context.snapshot,
      transcriptId: `${stored.batchId}:dispositions:${correction.pass}:${generateId('transcript')}`,
      invocationId: dispositionInvocationId,
      rawTranscript: dispositionPrepared.call.text,
      createdAt: new Date().toISOString(),
    });
    if (!capture.accepted) {
      throw new Error(
        `Implementer disposition result rejected (${capture.error.code}): ${capture.error.message}`,
      );
    }
  }
  return { commitSha: head };
}

async function performAutonomousVerification(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
  workflowId: string,
  batch: reviewWorkflowRunner.RunnerBatchDescriptor,
  commandIndex: number,
  attempt: number,
  timeoutSeconds: number,
): Promise<{ accepted: boolean; resultFingerprint: string }> {
  const context = resolveRuntimeContext(runtime.store, workflowId, projectDir);
  const stored = requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal);
  const commandId = `${stored.batchId}:verify:${commandIndex}:auto-${attempt}`;
  const outcome = await performBatchVerification(runtime, projectDir, workflowId, commandId, null, {
    ordinal: batch.ordinal,
    command: commandIndex,
    timeout: timeoutSeconds,
  });
  const recordId = String(outcome.verificationRecordId);
  const recordEntity = runtime.gateStore.workflowStore.getEntity('VERIFICATION_RECORD', recordId);
  if (recordEntity === null || recordEntity.kind !== 'VERIFICATION_RECORD') {
    throw new Error(`Verification record ${recordId} was not persisted`);
  }
  const record = recordEntity.value;
  if (record.observedStatus !== 'SUCCEEDED') {
    return { accepted: false, resultFingerprint: record.fullLogHash };
  }
  // Reviewer-judged acceptance: a dedicated reviewer assessment invocation (resumed
  // reviewer session) carries VERIFICATION_ATTESTOR authority and independently attests.
  const assessCommandId = `${commandId}:assess`;
  const invocationId = `${assessCommandId}:invocation`;
  const requester: reviewWorkflow.ActorExecutionIdentity = {
    actorExecutionId: `${assessCommandId}:requester`,
    actorType: 'AGENT',
    assignmentId: context.snapshot.assignments.reviewer.assignmentId,
    invocationIdentityId: invocationId,
    sessionIdentityId:
      runtime.store.workflowStore.getBatchRoleSession(stored.batchId, 'REVIEWER')
        ?.sessionIdentityId ?? `${assessCommandId}:session`,
    authoritiesExercised: ['REVIEWER'],
    identityAssurance: 'CONFIG_ONLY',
    observedEvidence: [],
    startedAt: new Date().toISOString(),
  };
  const guard: reviewWorkflow.TransitionCommand = {
    type: 'START_CODE_REVIEW',
    evidence: {
      reviewedCommitSha: record.commitSha,
      currentHeadSha: record.commitSha,
      cleanWorktree: true,
      unresolvedFindingCount: 0,
      incompleteDispositionCount: 0,
      roleSeparation: {
        implementerAssignment: context.snapshot.assignments.implementer,
        reviewerAssignment: context.snapshot.assignments.reviewer,
        minimumIdentityAssurance: context.snapshot.identityPolicy.minimumAssurance,
      },
    },
  };
  const request = {
    commandId: assessCommandId,
    workflowId,
    batchId: stored.batchId,
    expectedAggregateVersion: requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal)
      .aggregateVersion,
    requester,
    authorityExercised: 'REVIEWER' as const,
    command: guard,
  };
  runtime.commandStore.reserve(
    { ...request, canonicalRequestHash: hashRunnerValue(request) },
    'AGENT_INVOCATION',
  );
  runtime.commandStore.claimSideEffect(assessCommandId, invocationId);
  const prepared = await runtime.roleInvocation.prepare({
    resolution: context.roles.reviewer,
    workflowId,
    commandId: assessCommandId,
    actorExecutionId: `${assessCommandId}:execution`,
    invocationId,
    sessionIdentityId: `${assessCommandId}:session`,
    sessionBinding: { batchId: stored.batchId, role: 'REVIEWER', expectExisting: true },
    additionalAuthorities: ['VERIFICATION_ATTESTOR'],
    auditPhase: 'VERIFICATION',
    prompt: `Independently assess this verification evidence. Reply with EXACTLY one JSON object {"accept": boolean, "rationale": string}.\nCommand: ${record.command} ${record.arguments.join(' ')}\nExit: ${JSON.stringify(record.outcome)}\nObserved status: ${record.observedStatus}\nOutput summary:\n${record.outputSummary}`,
    options: agentInvocationOptions(timeoutSeconds),
  });
  runtime.roleInvocation.persistPrepared(prepared);
  runtime.commandStore.succeedWithoutTransition({
    commandId: assessCommandId,
    resultHash: hashRunnerValue(prepared.call.text),
    result: { assessed: true },
  });
  let assessment: { accept?: boolean; rationale?: string };
  try {
    const parsed: unknown = JSON.parse(prepared.call.text.trim());
    assessment =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { accept?: boolean; rationale?: string })
        : {};
  } catch {
    assessment = {};
  }
  if (assessment.accept !== true) {
    return { accepted: false, resultFingerprint: record.fullLogHash };
  }
  const plan = runtime.store.getBatchPlan(stored.currentPlanVersionId);
  if (plan === null) throw new Error(`Batch ${stored.batchId} has no current plan`);
  const criteria = runtime.store.listAcceptanceCriteria(plan.batchPlanVersionId);
  const approvedReview = runtime.gateStore
    .listCodeReviews(stored.batchId)
    .filter((candidate) => candidate.verdict === 'APPROVED')
    .at(-1);
  if (approvedReview === undefined || approvedReview.target.kind !== 'CODE') {
    throw new Error(`Batch ${stored.batchId} has no approved code review to attest against`);
  }
  runtime.verificationService.attest({
    verificationAttestationId: `${recordId}:attestation:reviewer`,
    verificationRecordId: recordId,
    workflowId,
    batchId: stored.batchId,
    decision: 'ACCEPTED',
    acceptanceMode: 'REVIEWER',
    rationale: assessment.rationale ?? 'Reviewer assessment accepted the verification evidence.',
    attestorActorExecutionId: prepared.execution.actorExecutionId,
    currentHeadSha: createRunnerGit(projectDir).headSha(),
    policy: deriveVerificationAttestationPolicy({
      plan,
      criteria,
      record,
      approvedReviewedCommitSha: approvedReview.target.reviewedCommitSha,
      configurationHash: context.snapshot.configurationHash,
    }),
    createdAt: new Date().toISOString(),
  });
  return { accepted: true, resultFingerprint: record.fullLogHash };
}

/** True only when the durable log exists and its bytes still match the recorded hash. */
function verificationLogMatches(location: string, expectedHash: string): boolean {
  try {
    const serialized = readFileSync(location, 'utf8');
    return createHash('sha256').update(serialized).digest('hex') === expectedHash;
  } catch {
    return false;
  }
}

function hashRunnerValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildRunnerPhases(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
  workflowId: string,
  timeoutSeconds: number,
): reviewWorkflowRunner.RunnerPhases {
  return {
    refinePlan: async () => {
      const existing = runtime.store.listBatches(workflowId);
      if (existing.length > 0) {
        return existing.map((batch) => ({ ordinal: batch.ordinal, batchId: batch.batchId }));
      }
      const result = await performRefinement(runtime, projectDir, workflowId, timeoutSeconds);
      if (!result.accepted) {
        throw new Error(`Plan refinement rejected: ${result.error.message}`);
      }
      return runtime.store
        .listBatches(workflowId)
        .map((batch) => ({ ordinal: batch.ordinal, batchId: batch.batchId }));
    },
    reviewPlan: async (batch, round) => {
      // Crash-safe re-entry: a batch resumed in PLAN_NEEDS_REVISION submits its pending
      // revision before the next review round starts.
      const stored = requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal);
      if (stored.persistedState === 'PLAN_NEEDS_REVISION') {
        await performAutonomousPlanRevision(
          runtime,
          projectDir,
          workflowId,
          batch,
          Math.max(1, round - 1),
          timeoutSeconds,
        );
      }
      return performAutonomousPlanReview(
        runtime,
        projectDir,
        workflowId,
        batch,
        round,
        timeoutSeconds,
      );
    },
    revisePlan: (batch, round) =>
      performAutonomousPlanRevision(runtime, projectDir, workflowId, batch, round, timeoutSeconds),
    implement: (batch) =>
      performAutonomousImplementation(runtime, projectDir, workflowId, batch, timeoutSeconds),
    reviewCode: async (batch, round) => {
      const result = await performCodeReview(
        runtime,
        projectDir,
        workflowId,
        `${batch.batchId}:code-review-${round}`,
        null,
        {
          ordinal: batch.ordinal,
          round,
          timeout: timeoutSeconds,
        },
      );
      const approved = result.status === 'VERIFYING';
      const blocking = Array.isArray(result.blockingFindingIds)
        ? result.blockingFindingIds.map(String)
        : [];
      if (result.status === 'REJECTED') {
        throw new Error(`Code review artifact rejected: ${String(result.message)}`);
      }
      return { approved, blockingFindingIds: blocking };
    },
    correct: (batch, pass, blockingFindingIds) =>
      performAutonomousImplementation(runtime, projectDir, workflowId, batch, timeoutSeconds, {
        pass,
        blockingFindingIds,
      }),
    verificationCommandCount: (batch) => {
      const stored = requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal);
      const plan = runtime.store.getBatchPlan(stored.currentPlanVersionId);
      return plan?.verificationCommands.length ?? 0;
    },
    verify: async (batch, commandIndex, attempt) => {
      // A restarted worker never re-runs an already reviewer-accepted verification command.
      const stored = requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal);
      const existing = runtime.gateStore
        .listVerificationRecords(stored.batchId)
        .filter((record) => record.verificationRecordId.includes(`:verify:${commandIndex}:auto-`))
        .find((record) =>
          runtime.gateStore
            .listAttestationsForRecord(record.verificationRecordId)
            .some((attestation) => attestation.decision === 'ACCEPTED'),
        );
      if (existing !== undefined) {
        return { accepted: true, resultFingerprint: existing.fullLogHash };
      }
      return performAutonomousVerification(
        runtime,
        projectDir,
        workflowId,
        batch,
        commandIndex,
        attempt,
        timeoutSeconds,
      );
    },
    finalAudit: async (batch) => {
      const stored = requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal);
      const existing = runtime.gateStore.listFinalAudits(stored.batchId).at(-1);
      if (existing !== undefined) {
        // A restarted worker never re-runs the single final audit; the persisted verdict rules.
        return { approved: existing.verdict === 'APPROVED' };
      }
      const outcome = await performFinalAudit(
        runtime,
        projectDir,
        workflowId,
        `${batch.batchId}:final-audit`,
        null,
        {
          ordinal: batch.ordinal,
          timeout: timeoutSeconds,
        },
      );
      return { approved: outcome.verdict === 'APPROVED' };
    },
    gate: async (batch) => {
      const stored = requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal);
      const result = runtime.gateService.evaluateGate({
        workflowId,
        batchId: stored.batchId,
        configuration: resolveRuntimeContext(runtime.store, workflowId, projectDir).snapshot,
        commandId: `${stored.batchId}:gate`,
        createdAt: new Date().toISOString(),
      });
      return result.approved
        ? { approved: true, failedConditions: [] }
        : { approved: false, failedConditions: result.failedConditions };
    },
    usedPacing: async (batch) => {
      const stored = requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal);
      const events = runtime.implementationStore.getEvents(stored.batchId);
      const count = (predicate: (event: (typeof events)[number]) => boolean) =>
        events.filter(predicate).length;
      const successfulAttempts = count((event) => event.eventType === 'IMPLEMENTATION_READY');
      return {
        planReviewRounds: count((event) => event.eventType === 'PLAN_REVIEW_STARTED'),
        codeReviewRounds: count((event) => event.eventType === 'CODE_REVIEW_STARTED'),
        correctionPasses: Math.max(0, successfulAttempts - 1),
        grantedReviewRounds: count(
          (event) =>
            event.eventType === 'BATCH_RESUMED' && event.payload.grantsReviewRound === true,
        ),
        grantedCorrectionPasses: count(
          (event) =>
            event.eventType === 'BATCH_RESUMED' && event.payload.grantsCorrectionPass === true,
        ),
      };
    },
    applyDecision: async (batch, action, decision) => {
      if (action === 'CANCEL_WORKFLOW') return;
      let stored = requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal);
      // A DISTINCT execution from the decide command's recorder (immutable records
      // cannot be re-persisted with new timestamps).
      const owner = persistCliActor(runtime.store, {
        actorExecutionId: `${decision.decisionId}:apply-owner`,
        actorType: 'HUMAN',
        authorities: ['WORKFLOW_OWNER'],
      });
      const issueTransition = (
        command: reviewWorkflow.TransitionCommand,
        commandId: string,
        eventType: string,
        eventPayload: Record<string, unknown>,
      ): void => {
        const request = {
          commandId,
          workflowId,
          batchId: stored.batchId,
          expectedAggregateVersion: stored.aggregateVersion,
          requester: owner,
          authorityExercised: 'WORKFLOW_OWNER' as const,
          command,
        };
        runtime.commandStore.reserve({
          ...request,
          canonicalRequestHash: hashRunnerValue(request),
        });
        const transition = reviewWorkflow.transitionBatch({
          currentState: stored.persistedState,
          command,
          actor: owner,
          ...(stored.blockedFromState === undefined
            ? {}
            : { blockedFromState: stored.blockedFromState }),
          ...(stored.blockedResumeState === undefined
            ? {}
            : { blockedResumeState: stored.blockedResumeState }),
        });
        if (!transition.allowed) {
          throw new Error(
            `${command.type} rejected by the domain kernel: ${transition.code ?? 'unknown'}`,
          );
        }
        runtime.commandStore.succeedWithTransition({
          commandId,
          transition,
          eventType,
          eventPayload,
          resultHash: hashRunnerValue(eventPayload),
          result: eventPayload,
        });
        stored = requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal);
      };
      if (stored.persistedState === 'BLOCKED') {
        // The human decision resumes the blocked batch; FIX_AGAIN explicitly grants one
        // additional review round and correction pass in the coordinator contract.
        issueTransition(
          { type: 'RESUME_BATCH' },
          `${decision.decisionId}:resume`,
          'BATCH_RESUMED',
          {
            decisionId: decision.decisionId,
            grantsReviewRound: action === 'FIX_AGAIN',
            grantsCorrectionPass: action === 'FIX_AGAIN',
          },
        );
      }
      if (action === 'ACCEPT_RISK_AND_CONTINUE') {
        if (
          stored.persistedState !== 'NEEDS_REVISION' &&
          stored.persistedState !== 'IMPLEMENTATION_COMPLETE'
        ) {
          throw new Error(`ACCEPT_RISK_AND_CONTINUE cannot apply from ${stored.persistedState}`);
        }
        issueTransition(
          {
            type: 'ACCEPT_FINDINGS_RISK',
            evidence: {
              decisionId: decision.decisionId,
              findingIds: [...decision.findingIds],
              acceptedCommitSha: decision.commitSha,
            },
          },
          `${decision.decisionId}:accept-risk`,
          'BATCH_FINDINGS_RISK_ACCEPTED',
          {
            decisionId: decision.decisionId,
            findingIds: [...decision.findingIds],
            acceptedCommitSha: decision.commitSha,
          },
        );
      }
    },
    resumeStage: async (batch) => {
      const stored = requireBatchByOrdinal(runtime.store, workflowId, batch.ordinal);
      switch (stored.persistedState) {
        case 'DRAFT':
        case 'PLAN_REVIEW':
        case 'PLAN_NEEDS_REVISION':
          return 'PLAN_REVIEW';
        case 'APPROVED_FOR_IMPLEMENTATION':
        case 'IMPLEMENTING':
        case 'AWAITING_COMMIT':
          return 'IMPLEMENTATION';
        case 'IMPLEMENTATION_COMPLETE':
        case 'CODE_REVIEW':
        case 'NEEDS_REVISION':
          return 'CODE_REVIEW';
        case 'VERIFYING':
          return 'VERIFICATION';
        case 'APPROVED_FOR_MERGE':
          return 'PUSH';
        case 'MERGED':
          return 'COMPLETE';
        default:
          return 'BLOCKED';
      }
    },
    workflowAudit: async () => {
      const issues: string[] = [];
      const batches = runtime.store.listBatches(workflowId);
      const runnerState = runtime.runnerStore.require(workflowId);
      // Workflow-level verification: re-run every batch's verification commands at the
      // FINAL HEAD through the ESTABLISHED verification service — the same runner
      // (process-tree handling, separate stdout/stderr), immutable log store, persisted
      // SYSTEM executor, and record vocabulary the batch flow uses. Each command records
      // against ITS OWN batch (whose plan approved it), deduplicated across batches.
      const finalHead = createRunnerGit(projectDir).headSha();
      const configurationHash = resolveRuntimeContext(runtime.store, workflowId, projectDir)
        .snapshot.configurationHash;
      const seenCommands = new Set<string>();
      const verification: { command: string; ok: boolean; exitCode: number | null }[] = [];
      let workflowVerificationIndex = 0;
      for (const stored of batches) {
        const plan = runtime.store.getBatchPlan(stored.currentPlanVersionId);
        const batchRecords = runtime.gateStore.listVerificationRecords(stored.batchId);
        for (const spec of plan?.verificationCommands ?? []) {
          const label = `${spec.executable} ${spec.arguments.join(' ')} @ ${spec.workingDirectory}`;
          if (seenCommands.has(label)) continue;
          seenCommands.add(label);
          workflowVerificationIndex += 1;
          const matchesSpec = (record: reviewWorkflow.VerificationRecord): boolean =>
            record.verificationRecordId.includes(':workflow-final:') &&
            record.command === spec.executable &&
            record.arguments.join('\u0000') === spec.arguments.join('\u0000') &&
            record.workingDirectory === spec.workingDirectory;
          // Restart safety: a SUCCEEDED record at this exact final HEAD is reused ONLY when
          // its durable log still exists and matches its recorded hash — deleted or
          // corrupted evidence forces re-execution.
          const alreadyRecorded = batchRecords.find(
            (record) =>
              matchesSpec(record) &&
              record.commitSha === finalHead &&
              record.observedStatus === 'SUCCEEDED' &&
              verificationLogMatches(record.fullLogLocation, record.fullLogHash),
          );
          if (alreadyRecorded !== undefined) {
            verification.push({ command: label, ok: true, exitCode: 0 });
            continue;
          }
          const executor = persistCliActor(runtime.store, {
            actorExecutionId: `${workflowId}:workflow-verification:executor:${workflowVerificationIndex}:${generateId('execution')}`,
            actorType: 'SYSTEM',
            authorities: ['VERIFICATION_EXECUTOR'],
          });
          // Crash recovery across the log/record write boundary: an orphaned log from a
          // crash between writes surfaces as LOG_IMMUTABILITY_CONFLICT; the next attempt
          // number gets a fresh record ID and log file. Nothing is overwritten.
          let attempt = batchRecords.filter(matchesSpec).length + 1;
          let capture: reviewWorkflowVerification.VerificationCaptureResult | undefined;
          for (let tries = 0; tries < 3 && capture === undefined; tries += 1) {
            const verificationRecordId = `${stored.batchId}:workflow-final:${workflowVerificationIndex}:${finalHead.slice(0, 12)}:attempt-${attempt}`;
            try {
              capture = await runtime.verificationService.execute({
                verificationRecordId,
                workflowId,
                batchId: stored.batchId,
                executorActorExecutionId: executor.actorExecutionId,
                relatedFindingIds: [],
                configurationHash,
                command: spec,
                expectedCommitSha: finalHead,
                timeoutMs: 10 * 60 * 1000,
              });
            } catch (error) {
              const conflicted =
                error instanceof Error &&
                'code' in error &&
                (error.code === 'LOG_IMMUTABILITY_CONFLICT' ||
                  error.code === 'IMMUTABLE_ENTITY_CONFLICT');
              if (!conflicted) throw error;
              attempt += 1;
            }
          }
          if (capture === undefined) {
            issues.push(`workflow-level verification could not persist a record for: ${label}`);
            verification.push({ command: label, ok: false, exitCode: null });
            continue;
          }
          runtime.runnerStore.appendLog({
            workflowId,
            entryType: 'CHECKPOINT',
            phase: 'FINAL_AUDIT',
            message: `workflow-verification ${label}: ${capture.record.observedStatus}`,
            payload: {
              command: label,
              verificationRecordId: capture.record.verificationRecordId,
              observedStatus: capture.record.observedStatus,
              fullLogLocation: capture.record.fullLogLocation,
              fullLogHash: capture.record.fullLogHash,
            },
          });
          // A verification command may never move HEAD — a moved HEAD is an audit failure
          // even when the command exited zero.
          if (capture.headUnchanged === false) {
            issues.push(`workflow-level verification moved HEAD: ${label}`);
          }
          const commandOk =
            capture.record.observedStatus === 'SUCCEEDED' && capture.headUnchanged !== false;
          const exitCode =
            capture.record.outcome.kind === 'EXITED' ? capture.record.outcome.exitCode : null;
          verification.push({ command: label, ok: commandOk, exitCode });
          if (!commandOk) {
            issues.push(`workflow-level verification failed at final HEAD: ${label}`);
          }
        }
      }
      // Zero-exit commands can still WRITE files: the tree must be exactly as committed
      // after workflow-level verification. Unexpected changes are preserved, never cleaned.
      if (!createRunnerGit(projectDir).isClean()) {
        issues.push(
          'workflow-level verification left uncommitted changes in the worktree; they were preserved for inspection (nothing was cleaned or reset)',
        );
      }
      const acceptedRisk = new Set([
        ...runnerState.counters.completedBatches.flatMap(
          (summary) => summary.acceptedRiskFindingIds,
        ),
        ...(runnerState.counters.batch?.acceptedRiskFindingIds ?? []),
      ]);
      for (const stored of batches) {
        if (stored.persistedState !== 'APPROVED_FOR_MERGE' && stored.persistedState !== 'MERGED') {
          issues.push(`batch ${stored.ordinal} is ${stored.persistedState}, not gate-approved`);
          continue;
        }
        const effective = runtime.gateService.effectiveState(stored.batchId);
        const approvalSha = effective.persistedApprovalSha;
        const isFinalBatch = stored.ordinal === Math.max(...batches.map((b) => b.ordinal));
        if (approvalSha === undefined) {
          issues.push(`batch ${stored.ordinal} has no persisted gate-approval SHA`);
        } else if (isFinalBatch && !effective.approvalValid) {
          // The FINAL batch's approval must still be effective at the final HEAD.
          issues.push(
            `batch ${stored.ordinal} approval is stale: approved ${approvalSha}, HEAD ${effective.currentHeadSha}`,
          );
        } else if (!isAncestorOfHead(projectDir, approvalSha)) {
          // Earlier approvals are legitimately superseded by later batches, but their
          // approved commits must remain in the final branch history AND the whole is
          // re-verified above at the final HEAD.
          issues.push(
            `batch ${stored.ordinal} approved commit ${approvalSha} is not in the final branch history`,
          );
        }
        // Mirrors the merge gate's resolution rule: a reviewer-ACCEPTED disposition or an
        // explicit SHA-bound risk acceptance resolves a blocking finding.
        const openBlockers = runtime.gateStore
          .listBatchFindings(stored.batchId)
          .filter(
            (finding) =>
              finding.status === 'OPEN' &&
              (finding.severity === 'critical' || finding.severity === 'high') &&
              !acceptedRisk.has(finding.findingId) &&
              !runtime.gateStore
                .listDispositionsForFinding(finding.findingId)
                .some((disposition) => disposition.reviewerDecision.decision === 'ACCEPTED'),
          );
        if (openBlockers.length > 0) {
          issues.push(
            `batch ${stored.ordinal} has unresolved blocking findings: ${openBlockers
              .map((finding) => finding.findingId)
              .join(', ')}`,
          );
        }
        const auditRows = runtime.store.workflowStore.listInvocationAudit(workflowId, {
          batchId: stored.batchId,
        });
        if (auditRows.length === 0) {
          issues.push(`batch ${stored.ordinal} has no invocation audit records`);
        }
      }
      if (batches.length !== runnerState.totalBatches) {
        issues.push(
          `plan declared ${runnerState.totalBatches} batches but ${batches.length} exist`,
        );
      }
      return { approved: issues.length === 0, issues, verification };
    },
  };
}

function buildRunner(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
  workflowId: string,
  timeoutSeconds: number,
): reviewWorkflowRunner.AutonomousWorkflowRunner {
  const config = loadConfig({ projectDir });
  const autonomous = config.reviewGated?.autonomous;
  if (autonomous === undefined) {
    throw new Error('Autonomous execution requires the reviewGated configuration');
  }
  const contract = (() => {
    try {
      const pacing = resolveRuntimeContext(runtime.store, workflowId, projectDir).snapshot.pacing;
      return {
        maxCodeReviewRounds: pacing.maxCodeReviewRounds,
        maxCorrectionPasses: 1 + pacing.maxCorrectionPasses,
      };
    } catch {
      return undefined; // the workflow may not be initialized yet (decide/status paths)
    }
  })();
  return new reviewWorkflowRunner.AutonomousWorkflowRunner(
    runtime.runnerStore,
    autonomous,
    createRunnerGit(projectDir),
    buildRunnerPhases(runtime, projectDir, workflowId, timeoutSeconds),
    // Stops are already durable (NOTIFICATION runner-log entries); stderr is best-effort
    // transport for a foreground worker.
    { notify: (message) => console.error(`\n[codemoot] ${message}\n`) },
    undefined,
    undefined,
    {
      ...(contract === undefined ? {} : { contract }),
      workerId: `${process.pid}:${workflowId.slice(-8)}`,
      leaseSeconds: autonomous.heartbeatExpirySeconds,
    },
  );
}

interface WorkflowRunOptions {
  readonly plan: string;
  readonly background?: boolean;
  /** Omitted means: take the ceiling from `cliAdapter.timeout` in .cowork.yml. */
  readonly timeout?: number;
  readonly id?: string;
}

export async function reviewWorkflowRunCommand(options: WorkflowRunOptions): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const timeoutSeconds = resolveInvocationTimeoutSeconds(projectDir, options.timeout);
    const git = createRunnerGit(projectDir);
    if (!git.isClean()) {
      throw new Error('Autonomous execution requires a clean worktree and index');
    }
    const baseBranch = git.currentBranch();
    const baseSha = git.headSha();
    const config = loadConfig({ projectDir });
    const workflowId = options.id ?? generateId('review-workflow');
    const now = new Date().toISOString();
    const configuration = reviewWorkflowIdentity.createReviewWorkflowConfigurationSnapshot(config, {
      workflowId,
      implementerAssignmentId: `${workflowId}:assignment:implementer`,
      reviewerAssignmentId: `${workflowId}:assignment:reviewer`,
      assignedAt: now,
    });
    const planPath = resolve(projectDir, options.plan);
    const runtime = createRuntime(db, projectDir);
    // `run --plan` ALWAYS creates a new workflow; an existing ID must go through
    // `workflow resume` (or run-resume) so nothing is ever silently resumed.
    if (
      runtime.runnerStore.get(workflowId) !== null ||
      runtime.store.getWorkflow(workflowId) !== null
    ) {
      throw new Error(
        `Workflow ${workflowId} already exists; use \`codemoot workflow resume ${workflowId}\` to continue it`,
      );
    }
    // The workflow branch exists BEFORE the repository audit is captured, so refinement's
    // audit verification sees the branch it will actually run on. The base branch and its
    // immutable SHA were recorded above, before the branch switch.
    const branch = `codemoot/${planSlug(options.plan)}-${workflowId.slice(-8)}`;
    git.createBranch(branch);
    runtime.service.initialize({
      workflowId,
      planContent: readFileSync(planPath, 'utf8'),
      sourceType: 'MARKDOWN_FILE',
      sourceLocation: planPath,
      authorEvidence: [{ kind: 'LOCAL_CLI', source: 'codemoot workflow run', observedAt: now }],
      owner: {
        actorExecutionId: `${workflowId}:owner:${generateId('execution')}`,
        actorType: 'HUMAN',
        authoritiesExercised: ['WORKFLOW_OWNER'],
        identityAssurance: 'CLI_ASSERTED',
        observedEvidence: [{ kind: 'LOCAL_CLI', source: 'codemoot workflow run', observedAt: now }],
        startedAt: now,
        finishedAt: now,
      },
      configuration,
      repositoryAuditId: `${workflowId}:repository-audit:1`,
      createdAt: now,
    });
    const autonomousLimits = config.reviewGated?.autonomous;
    if (autonomousLimits === undefined) {
      throw new Error('Autonomous execution requires the reviewGated configuration');
    }
    // Freeze the limits into the runner state: config edits between workers never change
    // enforcement mid-workflow.
    runtime.runnerStore.initState({
      workflowId,
      branch,
      baseBranch,
      baseSha,
      limits: autonomousLimits,
    });
    runtime.runnerStore.appendLog({
      workflowId,
      entryType: 'CHECKPOINT',
      message: `Workflow started on branch ${branch} (base ${baseBranch}@${baseSha.slice(0, 8)})`,
    });
    if (options.background === true) {
      const entry = process.argv[1];
      if (entry === undefined) throw new Error('Cannot resolve the CLI entry point');
      // The detached worker must inherit the SAME ceiling: without forwarding it, the
      // child fell back to commander's 1800 default and `--timeout N --background` was
      // accepted, reported success, and still ran with a 30-minute cap.
      const child = spawn(
        process.execPath,
        [entry, 'workflow', 'run-resume', workflowId, '--timeout', String(timeoutSeconds)],
        { cwd: projectDir, detached: true, stdio: 'ignore' },
      );
      child.unref();
      printJson({
        status: 'RUNNING',
        workflowId,
        branch,
        baseBranch,
        baseSha,
        workerPid: child.pid ?? null,
        timeoutSeconds,
        watch: `codemoot workflow watch ${workflowId}`,
      });
      return;
    }
    printJson({ status: 'RUNNING', workflowId, branch, baseBranch, baseSha, timeoutSeconds });
    await runResumeInProcess(runtime, projectDir, workflowId, timeoutSeconds);
  });
}

async function runResumeInProcess(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
  workflowId: string,
  timeoutSeconds: number,
): Promise<void> {
  // First interrupt signal = graceful pause request: the durable status flips to
  // PAUSE_REQUESTED, the current atomic action finishes and persists, and the runner
  // settles to PAUSED_BY_USER. A second signal falls through to the default hard kill.
  const requestPause = () => {
    try {
      if (runtime.runnerStore.requestPause(workflowId)) {
        runtime.runnerStore.appendLog({
          workflowId,
          entryType: 'CHECKPOINT',
          message: 'Pause requested by interrupt signal; finishing the current action',
        });
        console.error(
          '\n[codemoot] pause requested — finishing the current action (interrupt again to kill)\n',
        );
      }
    } catch {
      // signal handling must never crash the worker
    }
  };
  process.once('SIGINT', requestPause);
  process.once('SIGTERM', requestPause);
  // ONE try/finally owns the guard: even a partial installation failure is restored, and
  // no validation, initialization, or spawn failure can leave the sentinel behind.
  try {
    installGitGuard(projectDir);
    await runResumeGuarded(runtime, projectDir, workflowId, timeoutSeconds);
  } finally {
    process.removeListener('SIGINT', requestPause);
    process.removeListener('SIGTERM', requestPause);
    uninstallGitGuard(projectDir);
  }
}

async function runResumeGuarded(
  runtime: ReviewWorkflowRuntime,
  projectDir: string,
  workflowId: string,
  timeoutSeconds: number,
): Promise<void> {
  const runner = buildRunner(runtime, projectDir, workflowId, timeoutSeconds);
  const result = await runner.run(workflowId);
  const state = runtime.runnerStore.require(workflowId);
  if (result.status === 'READY_FOR_HUMAN_VERIFICATION') {
    const git = createRunnerGit(projectDir);
    const totals = runtime.runnerStore.auditTotals(workflowId);
    printJson({
      status: result.status,
      workflowId,
      branch: state.branch,
      baseBranch: state.baseBranch,
      baseSha: state.baseSha,
      finalCommitSha: git.headSha(),
      remoteBranchSha: git.remoteHeadSha(state.branch),
      batchesCompleted: state.counters.completedOrdinals.length,
      totalBatches: state.totalBatches,
      batchSummaries: state.counters.completedBatches,
      workflowVerificationAtFinalHead: runtime.runnerStore
        .listLog(workflowId, { types: ['CHECKPOINT'], limit: 100_000 })
        .filter((entry) => entry.message.startsWith('workflow-verification '))
        .map((entry) => ({
          message: entry.message,
          ...(entry.payload === undefined ? {} : { detail: entry.payload }),
        })),
      verificationResults: runtime.store.listBatches(workflowId).map((batch) => ({
        batchId: batch.batchId,
        records: runtime.gateStore.listVerificationRecords(batch.batchId).map((record) => ({
          verificationRecordId: record.verificationRecordId,
          command: `${record.command} ${record.arguments.join(' ')}`.trim(),
          observedStatus: record.observedStatus,
          commitSha: record.commitSha,
        })),
      })),
      deferredFindings: state.counters.completedBatches.flatMap(
        (summary) => summary.deferredFindingIds,
      ),
      acceptedRiskFindings: state.counters.completedBatches.flatMap(
        (summary) => summary.acceptedRiskFindingIds,
      ),
      acceptedRiskOverrides: runtime.runnerStore.listDecisions(workflowId),
      tokenTotals: totals,
      auditExport: `codemoot workflow export ${workflowId} --output workflow-audit.json`,
      recommendedPrTitle: `feat: ${state.branch
        .replace(/^codemoot\//, '')
        .replace(/-[^-]*$/, '')
        .replace(/-/g, ' ')}`,
      recommendedPrSummary: `Review-gated workflow ${workflowId}: ${state.counters.completedOrdinals.length}/${state.totalBatches} batches implemented, reviewed, verified, audited, and gated on branch ${state.branch}. CodeMoot never merges: verify and merge this branch manually.`,
    });
  } else {
    printJson({
      status: result.status,
      workflowId,
      ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
      ...(result.stopDetails === undefined ? {} : { stopDetails: result.stopDetails }),
      decide: `codemoot workflow decide ${workflowId} --action <fix_again|accept_risk|cancel> --rationale "..."`,
    });
  }
}

export async function reviewWorkflowRunResumeCommand(
  workflowId: string,
  options: { readonly timeout?: number; readonly background?: boolean },
): Promise<void> {
  if (options.background === true) {
    const entry = process.argv[1];
    if (entry === undefined) throw new Error('Cannot resolve the CLI entry point');
    const child = spawn(
      process.execPath,
      [
        entry,
        'workflow',
        'run-resume',
        workflowId,
        '--timeout',
        String(resolveInvocationTimeoutSeconds(process.cwd(), options.timeout)),
      ],
      { cwd: process.cwd(), detached: true, stdio: 'ignore' },
    );
    child.unref();
    printJson({
      status: 'RESUMING',
      workflowId,
      workerPid: child.pid ?? null,
      watch: `codemoot workflow watch ${workflowId}`,
    });
    return;
  }
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const runtime = createRuntime(db, projectDir);
    await runResumeInProcess(
      runtime,
      projectDir,
      workflowId,
      resolveInvocationTimeoutSeconds(projectDir, options.timeout),
    );
  });
}

export async function reviewWorkflowPauseCommand(workflowId: string): Promise<void> {
  await withDatabase(async (db) => {
    const runtime = createRuntime(db, process.cwd());
    if (runtime.runnerStore.get(workflowId) === null) {
      throw new Error(`Workflow ${workflowId} has no runner state`);
    }
    // No read-then-decide: the request is one conditional write (only RUNNING can enter
    // PAUSE_REQUESTED), then settlement is ATTEMPTED with the dead-lease condition — it
    // succeeds exactly when no live worker exists to finish an action, and a worker that
    // acquired concurrently keeps ownership and settles the pause itself.
    if (!runtime.runnerStore.requestPause(workflowId)) {
      const current = runtime.runnerStore.require(workflowId);
      if (current.status === 'PAUSED_BY_USER' || current.status === 'PAUSE_REQUESTED') {
        printJson({ workflowId, status: current.status, note: 'already pausing or paused' });
        return;
      }
      printJson({ workflowId, status: current.status, note: 'not running; nothing to pause' });
      return;
    }
    const pauseGit = createRunnerGit(process.cwd());
    const settled = runtime.runnerStore.settleRequestedPause(
      workflowId,
      {
        headSha: pauseGit.headSha(),
        clean: pauseGit.isClean(),
        statusFingerprint: pauseGit.statusFingerprint(),
      },
      { requireDeadLease: true },
    );
    runtime.runnerStore.appendLog({
      workflowId,
      entryType: 'CHECKPOINT',
      message: settled
        ? 'Workflow paused by user (no live worker held the lease)'
        : 'Pause requested by user; the worker will finish its current action and pause',
    });
    // Report the DURABLE state, not a prediction.
    const durable = runtime.runnerStore.require(workflowId);
    printJson({
      workflowId,
      status: durable.status,
      observed: reviewWorkflowRunner.deriveObservedStatus(durable, 120, new Date()).status,
    });
  });
}

export async function reviewWorkflowResumeCommand(
  workflowId: string,
  options: { readonly timeout?: number; readonly background?: boolean },
): Promise<void> {
  await withDatabase(async (db) => {
    const runtime = createRuntime(db, process.cwd());
    const state = runtime.runnerStore.get(workflowId);
    if (state === null) throw new Error(`Workflow ${workflowId} has no runner state`);
    if (state.status === 'PAUSE_REQUESTED') {
      // A pause request whose worker died before settling: settle it here — capturing the
      // repository state exactly like the worker would have — before claiming. The settle
      // is conditional on the dead lease, so an in-flight graceful pause is untouched.
      const settleGit = createRunnerGit(process.cwd());
      runtime.runnerStore.settleRequestedPause(
        workflowId,
        {
          headSha: settleGit.headSha(),
          clean: settleGit.isClean(),
          statusFingerprint: settleGit.statusFingerprint(),
        },
        { requireDeadLease: true },
      );
    }
    // ONE atomic claim covers both resumable shapes (a settled pause, or a STRANDED
    // RUNNING workflow whose worker/launcher died): exactly one concurrent resume wins —
    // the winner holds a short launch lease until the real worker takes over — and an
    // in-flight graceful pause (live lease) is never cancelled.
    if (!runtime.runnerStore.claimResume(workflowId)) {
      const current = runtime.runnerStore.require(workflowId);
      const leaseLive =
        current.leaseExpiresAt !== undefined && Date.parse(current.leaseExpiresAt) > Date.now();
      if (current.status === 'PAUSE_REQUESTED' && leaseLive) {
        throw new Error(
          `Workflow ${workflowId} is still pausing (a live worker is finishing its current action); retry once it reports PAUSED_BY_USER`,
        );
      }
      if (current.status === 'RUNNING') {
        throw new Error(
          `Workflow ${workflowId} is RUNNING (already claimed by another resume or worker); resume only continues a paused workflow`,
        );
      }
      throw new Error(
        `Workflow ${workflowId} is ${current.status}; resume only continues a paused workflow (use workflow decide for stopped ones)`,
      );
    }
    runtime.runnerStore.appendLog({
      workflowId,
      entryType: 'CHECKPOINT',
      message: 'Resume requested by user; continuing from the next unfinished action',
    });
  });
  try {
    await reviewWorkflowRunResumeCommand(workflowId, options);
  } catch (error) {
    // A launch that never produced a worker must not strand the workflow in a
    // publicly-unresumable RUNNING state: the claim is reverted (only when no live
    // worker exists) and the failure surfaces.
    await withDatabase(async (db) => {
      createRuntime(db, process.cwd()).runnerStore.revertResumeClaim(workflowId);
    });
    throw error;
  }
}

/**
 * Terminally cancels a workflow from ANY non-terminal state, so a dead workflow never
 * requires deleting rows from the durable store by hand. The append-only runner log is
 * immutable by design and is preserved as evidence.
 */
export async function reviewWorkflowCancelCommand(
  workflowId: string,
  options: { readonly rationale: string; readonly actor?: string },
): Promise<void> {
  await withDatabase(async (db) => {
    const runtime = createRuntime(db, process.cwd());
    const state = runtime.runnerStore.get(workflowId);
    if (state === null) throw new Error(`Workflow ${workflowId} has no runner state`);
    if (state.status === 'CANCELLED') {
      printJson({ workflowId, status: 'CANCELLED', note: 'already cancelled' });
      return;
    }
    if (state.status === 'READY_FOR_HUMAN_VERIFICATION') {
      throw new Error(
        `Workflow ${workflowId} already completed; nothing to cancel (its branch is ready for verification)`,
      );
    }
    const leaseLive =
      state.leaseExpiresAt !== undefined && Date.parse(state.leaseExpiresAt) > Date.now();
    if (leaseLive) {
      throw new Error(
        `Workflow ${workflowId} has a live worker; run \`codemoot workflow pause ${workflowId}\` first, then cancel`,
      );
    }
    const owner = persistCliActor(runtime.store, {
      actorExecutionId: `${workflowId}:cancel:${generateId('execution')}`,
      actorType: 'HUMAN',
      authorities: ['WORKFLOW_OWNER'],
    });
    runtime.runnerStore.update(workflowId, {
      status: 'CANCELLED',
      phase: null,
      stopReason: 'CANCELLED_BY_USER',
      stopDetails: options.rationale,
      workerId: null,
      leaseExpiresAt: null,
    });
    runtime.runnerStore.appendLog({
      workflowId,
      entryType: 'STOP',
      message: `Workflow cancelled by ${options.actor ?? 'human-owner'}: ${options.rationale}`,
      payload: { actorExecutionId: owner.actorExecutionId, rationale: options.rationale },
    });
    printJson({
      workflowId,
      status: 'CANCELLED',
      branch: state.branch,
      note: 'The workflow branch and all durable evidence are preserved; delete the branch yourself if you no longer need it.',
    });
  });
}

export async function reviewWorkflowWatchCommand(workflowId: string): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const runtime = createRuntime(db, projectDir);
    const config = loadConfig({ projectDir });
    const expiry = config.reviewGated?.autonomous.heartbeatExpirySeconds ?? 120;
    const runner = buildRunner(
      runtime,
      projectDir,
      workflowId,
      resolveInvocationTimeoutSeconds(projectDir),
    );
    let lastLogId = 0;
    for (;;) {
      if (runtime.runnerStore.get(workflowId) === null) {
        throw new Error(`Workflow ${workflowId} has no runner state`);
      }
      const state = runner.reconcileStalled(workflowId);
      const entries = runtime.runnerStore.listLog(workflowId, { afterLogId: lastLogId });
      for (const entry of entries) {
        const time = entry.createdAt.slice(11, 19);
        console.log(`${time}  ${entry.entryType.padEnd(11)} ${entry.phase ?? ''} ${entry.message}`);
        lastLogId = entry.logId;
      }
      const observed = reviewWorkflowRunner.deriveObservedStatus(state, expiry, new Date());
      if (observed.status !== 'RUNNING') {
        console.log(
          `${new Date().toISOString().slice(11, 19)}  ${observed.status}${observed.reason === undefined ? '' : `  ${observed.reason}`}${state.stopReason === undefined ? '' : `  ${state.stopReason}`}`,
        );
        return;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 2000));
    }
  });
}

export async function reviewWorkflowLogsCommand(
  workflowId: string,
  options: { readonly batch?: string; readonly phase?: string; readonly invocation?: string },
): Promise<void> {
  await withDatabase(async (db) => {
    const runtime = createRuntime(db, process.cwd());
    const audit = runtime.store.workflowStore.listInvocationAudit(workflowId, {
      ...(options.batch === undefined ? {} : { batchId: options.batch }),
      ...(options.phase === undefined ? {} : { phase: options.phase }),
      ...(options.invocation === undefined ? {} : { invocationId: options.invocation }),
    });
    printJson({ workflowId, invocations: audit });
  });
}

export async function reviewWorkflowExportCommand(
  workflowId: string,
  options: { readonly output: string },
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const runtime = createRuntime(db, projectDir);
    const state = runtime.runnerStore.get(workflowId);
    const batches = runtime.store.listBatches(workflowId);
    const output = {
      workflowId,
      exportedAt: new Date().toISOString(),
      workflow: runtime.store.getWorkflow(workflowId),
      runnerState: state,
      runnerLog: runtime.runnerStore.listLog(workflowId, { limit: 100_000 }),
      decisions: runtime.runnerStore.listDecisions(workflowId),
      events: runtime.jobStore.listWorkflowEvents(workflowId, 0, 100_000),
      invocationAudit: runtime.store.workflowStore.listInvocationAudit(workflowId),
      sessionContinuity: batches.flatMap((batch) =>
        runtime.store.workflowStore.listSessionContinuity(batch.batchId),
      ),
      handoffTranscripts: runtime.store.workflowStore.listHandoffTranscripts(workflowId),
      batches: batches.map((batch) => {
        const plan = runtime.store.getBatchPlan(batch.currentPlanVersionId);
        const findings = runtime.gateStore.listBatchFindings(batch.batchId);
        const verificationRecords = runtime.gateStore.listVerificationRecords(batch.batchId);
        return {
          batch,
          plan,
          acceptanceCriteria:
            plan === null ? [] : runtime.store.listAcceptanceCriteria(plan.batchPlanVersionId),
          findings,
          dispositions: findings.flatMap((finding) =>
            runtime.gateStore.listDispositionsForFinding(finding.findingId),
          ),
          codeReviews: runtime.gateStore.listCodeReviews(batch.batchId),
          finalAudits: runtime.gateStore.listFinalAudits(batch.batchId),
          implementationAttempts: runtime.gateStore.listImplementationAttempts(batch.batchId),
          verificationRecords,
          verificationAttestations: verificationRecords.flatMap((record) =>
            runtime.gateStore.listAttestationsForRecord(record.verificationRecordId),
          ),
          gateApprovals: runtime.gateStore
            .getEvents(batch.batchId)
            .filter((event) => event.eventType === 'BATCH_GATE_APPROVED'),
        };
      }),
    };
    const target = resolve(projectDir, options.output);
    writeFileSync(target, JSON.stringify(output, null, 2));
    printJson({ workflowId, output: target, invocations: output.invocationAudit.length });
  });
}

export async function reviewWorkflowDecideCommand(
  workflowId: string,
  options: {
    readonly action: 'fix_again' | 'accept_risk' | 'cancel';
    readonly rationale: string;
    readonly findings?: string;
    readonly actor?: string;
  },
): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const runtime = createRuntime(db, projectDir);
    const runner = buildRunner(
      runtime,
      projectDir,
      workflowId,
      resolveInvocationTimeoutSeconds(projectDir),
    );
    const action =
      options.action === 'fix_again'
        ? 'FIX_AGAIN'
        : options.action === 'accept_risk'
          ? 'ACCEPT_RISK_AND_CONTINUE'
          : 'CANCEL_WORKFLOW';
    // The decision is made by a persisted HUMAN WORKFLOW_OWNER execution, and the record
    // carries that execution's ID so the audit trail names a durable identity.
    const decisionOrdinal = runtime.runnerStore.listDecisions(workflowId).length + 1;
    const owner = persistCliActor(runtime.store, {
      actorExecutionId: `${workflowId}:decision:${decisionOrdinal}:owner`,
      actorType: 'HUMAN',
      authorities: ['WORKFLOW_OWNER'],
    });
    const decision = runner.decide({
      workflowId,
      action,
      actor: `${options.actor ?? 'human-owner'} (${owner.actorExecutionId})`,
      rationale: options.rationale,
      ...(options.findings === undefined
        ? {}
        : { findingIds: options.findings.split(',').map((id) => id.trim()) }),
    });
    printJson({
      workflowId,
      decisionId: decision.decisionId,
      action: decision.action,
      commitSha: decision.commitSha,
      resume: `codemoot workflow run-resume ${workflowId} --background`,
    });
  });
}

// ---------------------------------------------------------------------------
// Contract pre-flight (codemoot workflow preflight)
// ---------------------------------------------------------------------------

/**
 * ONE real model call per contract, handed to the REAL parser.
 *
 * Four contract-shape defects each cost a full paid invocation to discover — 13-43 minutes
 * and $2-5 apiece — because the only way to learn that a prompt produced an unparseable
 * document was to run the workflow. The pre-flight closes that loop in about a minute: it
 * builds the SAME instruction the workflow builds (from the same schema), makes one call,
 * and hands the answer to the SAME parser that would reject it mid-run.
 *
 * This is the `--dry-run` that was scoped earlier and abandoned, on the grounds that a
 * synthetic response could not satisfy the cross-field superRefines. That premise was
 * wrong: nothing needs to be synthesised, because a real model answers the question
 * directly. No workflow, no outline, no branch, no database, no state.
 *
 * What it does NOT prove: prompt parity beyond the instruction block (the real prompts also
 * carry the plan and repository audit), cross-batch rules that only exist across several
 * documents, and reliability — one valid document is not proof the next one is valid.
 */
interface PreflightCase {
  readonly contractKind: string;
  readonly schema: Parameters<typeof reviewWorkflowContracts.buildContractInstruction>[0];
  readonly parse: (rawTranscript: string) => unknown;
  readonly role: 'implementer' | 'reviewer';
  /** A synthetic scenario: the CONTENT is irrelevant, only the document shape is tested. */
  readonly task: string;
}

// REFINEMENT_RESULT is absent deliberately — it is assembled locally from the outline and
// the per-batch plans, so no agent is ever asked to produce one.
// Exported so the test suite can assert PARITY by identity: each case must carry the very
// schema the prompt is generated from and the very parser that judges a real run. A
// pre-flight against a lookalike schema would pass while the workflow still failed.
export const PREFLIGHT_CASES: readonly PreflightCase[] = [
  {
    contractKind: 'BATCH_PLAN_RESULT',
    schema: reviewWorkflowContracts.batchPlanContractSchema,
    parse: reviewWorkflowContracts.parseBatchPlanResult,
    role: 'implementer',
    task: [
      'Author ONE batch plan for the hypothetical batch below. The CONTENT does not matter:',
      'this is a contract pre-flight, and only the document shape is being checked.',
      '',
      'Batch: add a --version flag to a command-line tool.',
      '- batchId: preflight:batch:1',
      '- batchPlanVersionId: preflight:batch:1:plan:1',
      '- ordinal: 1',
      '- The only requirement to cover is: preflight-requirement-1',
    ].join('\n'),
  },
  {
    contractKind: 'REFINEMENT_OUTLINE_RESULT',
    schema: reviewWorkflowContracts.refinementOutlineContractSchema,
    parse: reviewWorkflowContracts.parseRefinementOutline,
    role: 'implementer',
    task: [
      'Produce a refinement OUTLINE for the hypothetical plan below. Do not write batch',
      'bodies — the outline carries batch identity only. Content does not matter.',
      '',
      'Plan: add a --version flag, then document it.',
      '- Use batchId preflight:batch:N and batchPlanVersionId preflight:batch:N:plan:1',
      '- Exactly two batches, ordinals 1 and 2',
      '- The only requirement to cover is: preflight-requirement-1',
    ].join('\n'),
  },
  {
    contractKind: 'REVIEW_RESULT',
    schema: reviewWorkflowContracts.reviewResultContractSchema,
    parse: reviewWorkflowContracts.parseReviewResult,
    role: 'reviewer',
    task: [
      'Produce a plan review with verdict APPROVED and no findings. Content does not matter.',
      'Echo this target verbatim:',
      JSON.stringify(
        {
          kind: 'PLAN',
          planVersionId: 'preflight:batch:1:plan:1',
          planContentHash: 'a'.repeat(64),
          repositoryContextSha: 'b'.repeat(40),
        },
        null,
        2,
      ),
    ].join('\n'),
  },
  {
    contractKind: 'IMPLEMENTATION_RESULT',
    schema: reviewWorkflowContracts.implementationResultContractSchema,
    parse: reviewWorkflowContracts.parseImplementationResult,
    role: 'implementer',
    task: [
      'Report a COMPLETE implementation that changed exactly one file, src/example.ts, and',
      'produced no verification records. Content does not matter.',
    ].join('\n'),
  },
  {
    contractKind: 'DISPOSITION_RESULT',
    schema: reviewWorkflowContracts.dispositionResultContractSchema,
    parse: reviewWorkflowContracts.parseDispositionResult,
    role: 'implementer',
    task: [
      'Report a correction pass that FIXED exactly one finding, preflight-finding-1, against',
      `commit ${'c'.repeat(40)}. Content does not matter.`,
    ].join('\n'),
  },
  {
    contractKind: 'FINAL_AUDIT_RESULT',
    schema: reviewWorkflowContracts.finalAuditResultContractSchema,
    parse: reviewWorkflowContracts.parseFinalAuditResult,
    role: 'reviewer',
    task: [
      'Produce an APPROVED final audit with no findings, covering requirement',
      'preflight-requirement-1 and criterion preflight-criterion-1, both PASSED.',
      'Content does not matter. Echo this target verbatim:',
      JSON.stringify(
        {
          kind: 'FINAL_AUDIT',
          reviewedCommitSha: 'd'.repeat(40),
          repositoryContextSha: 'd'.repeat(40),
          reviewRangeEvidenceId: 'preflight:batch:1:range:1',
          patchHash: 'e'.repeat(64),
          refinedPlanVersionId: 'preflight:refined-plan:1',
        },
        null,
        2,
      ),
    ].join('\n'),
  },
];

/**
 * A pre-flight must fail FAST: the configured `cliAdapter.timeout` is sized for a real
 * refinement (hours), which would turn a gate into a hang.
 */
const PREFLIGHT_TIMEOUT_SECONDS = 900;

export async function reviewWorkflowPreflightCommand(options: {
  readonly contract?: string;
  readonly timeout?: number;
}): Promise<void> {
  const projectDir = process.cwd();
  const config = loadConfig({ projectDir });
  const registry = ModelRegistry.fromConfig(config, projectDir);
  const selected = options.contract ?? 'BATCH_PLAN_RESULT';
  const cases =
    selected === 'all'
      ? PREFLIGHT_CASES
      : PREFLIGHT_CASES.filter((entry) => entry.contractKind === selected);
  if (cases.length === 0) {
    throw new Error(
      `Unknown contract "${selected}". Choose one of: ${PREFLIGHT_CASES.map((entry) => entry.contractKind).join(', ')}, or "all".`,
    );
  }
  const timeoutSeconds = options.timeout ?? PREFLIGHT_TIMEOUT_SECONDS;
  const outputDir = resolve(projectDir, '.cowork', 'preflight');

  const results: unknown[] = [];
  for (const entry of cases) {
    const alias = config.roles[entry.role]?.model;
    if (alias === undefined) {
      results.push({
        contract: entry.contractKind,
        ok: false,
        error: `No "${entry.role}" role is configured in .cowork.yml`,
      });
      continue;
    }
    const adapter = registry.getAdapter(alias);
    // The instruction is generated from the SAME schema the parser validates against, so a
    // pass here means the prompt and the validator genuinely agree.
    const prompt = `${entry.task}\n\n${reviewWorkflowContracts.buildContractInstruction(
      entry.schema,
      entry.contractKind,
    )}`;
    const startedAt = Date.now();
    try {
      const call = await adapter.send(prompt, { timeout: timeoutSeconds * 1000 });
      const durationMs = Date.now() - startedAt;
      try {
        entry.parse(call.text);
        results.push({
          contract: entry.contractKind,
          ok: true,
          role: entry.role,
          model: call.model,
          durationMs,
          responseChars: call.text.length,
          inputTokens: call.usage?.inputTokens,
          outputTokens: call.usage?.outputTokens,
        });
      } catch (parseError) {
        // The whole point is to see WHAT the model produced: a blind rejection is the
        // failure mode this command exists to end.
        mkdirSync(outputDir, { recursive: true });
        const rejectedPath = resolve(outputDir, `${entry.contractKind}.rejected.txt`);
        writeFileSync(rejectedPath, call.text);
        results.push({
          contract: entry.contractKind,
          ok: false,
          role: entry.role,
          model: call.model,
          durationMs,
          responseChars: call.text.length,
          // Reported on failure too: whether a rejection correlates with prompt size or
          // contract type is only answerable if the failing calls carry their usage.
          inputTokens: call.usage?.inputTokens,
          outputTokens: call.usage?.outputTokens,
          rejection: parseError instanceof Error ? parseError.message : String(parseError),
          rejectedResponse: rejectedPath,
        });
      }
    } catch (invocationError) {
      results.push({
        contract: entry.contractKind,
        ok: false,
        role: entry.role,
        durationMs: Date.now() - startedAt,
        error: invocationError instanceof Error ? invocationError.message : String(invocationError),
      });
    }
  }

  const ok = results.every((result) => (result as { ok: boolean }).ok);
  printJson({ ok, timeoutSeconds, results });
  if (!ok) process.exitCode = 1;
}

/**
 * Discards staged batch plans by ordinal.
 *
 * Refinement stages one draft per batch, keyed by ordinal — but which work an ordinal
 * contains is decided by the outline. Before the outline was pinned, a resume could
 * re-partition the plan and author a draft for an ordinal the accepted decomposition never
 * had. Those drafts are staging residue and must be removed before the run can continue.
 *
 * This removes staging rows only. Every invocation that produced them stays in the immutable
 * invocation audit with its full prompt, response and cost, so the record of what happened
 * and what it cost is unchanged.
 */
export async function reviewWorkflowDiscardDraftsCommand(
  workflowId: string,
  options: { readonly discard: string },
): Promise<void> {
  await withDatabase(async (db) => {
    const runtime = createRuntime(db, process.cwd());
    const discard = new Set(
      options.discard
        .split(',')
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isInteger(value)),
    );
    if (discard.size === 0) throw new Error('--discard requires at least one ordinal');
    const staged = runtime.store.workflowStore.listRefinementDrafts(workflowId);
    const keep = staged.map((entry) => entry.ordinal).filter((ordinal) => !discard.has(ordinal));
    const removed = runtime.store.workflowStore.discardRefinementDraftsOutside(workflowId, keep);
    printJson({
      workflowId,
      discarded: removed,
      remainingOrdinals: runtime.store.workflowStore
        .listRefinementDrafts(workflowId)
        .map((entry) => entry.ordinal),
    });
  });
}

/**
 * Extends a RUNNING workflow's token budget by explicit human authorisation.
 *
 * Limits are frozen into runner state at workflow start so an agent cannot quietly widen
 * its own allowance, and editing `.cowork.yml` cannot help either: the configuration hash
 * covers the whole file, so any edit invalidates the role assignments and blocks resume.
 * Both are deliberate. Together they left no way to continue a workflow that hit a budget
 * which turned out to be structurally too small — the only option was to discard the work
 * and start over.
 *
 * This is the sanctioned escape: additive, human-only, and recorded in the immutable runner
 * log with actor and rationale. The frozen contract is never edited, so what the workflow
 * started under stays legible beside what a human later permitted.
 */
export async function reviewWorkflowGrantBudgetCommand(
  workflowId: string,
  options: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly actor?: string;
    readonly rationale: string;
  },
): Promise<void> {
  await withDatabase(async (db) => {
    const runtime = createRuntime(db, process.cwd());
    if (options.inputTokens === undefined && options.outputTokens === undefined) {
      throw new Error('Grant at least one of --input-tokens or --output-tokens');
    }
    const granted = runtime.runnerStore.grantBudget({
      workflowId,
      inputTokens: options.inputTokens ?? 0,
      outputTokens: options.outputTokens ?? 0,
      actor: options.actor ?? 'human-owner',
      rationale: options.rationale,
    });
    const state = runtime.runnerStore.require(workflowId);
    const limits = state.limits;
    printJson({
      workflowId,
      granted,
      effectiveBudget:
        limits === undefined
          ? null
          : {
              inputTokens: limits.maxInputTokensPerBatch + granted.inputTokens,
              outputTokens: limits.maxOutputTokensPerBatch + granted.outputTokens,
            },
      resume: `codemoot workflow run-resume ${workflowId} --background`,
    });
  });
}
