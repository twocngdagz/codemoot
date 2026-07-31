// The autonomous workflow runner: sequences the existing coordinators through every batch
// with finite validated limits (never exceeding the immutable coordinator pacing contract),
// durable heartbeats, an exclusive worker lease, pre/post branch invariants around every
// phase, no-progress detection, stable stop reasons, and single-notification stops. It never
// merges, never resets a limit silently, and stops the moment a limit, blocker, or
// continuity failure is reached.

import { isAuthenticationFailure, isSessionContinuityError } from '../roles/role-invocation.js';
import type { ReviewWorkflowRunnerStore } from './store.js';
import {
  type HumanDecisionAction,
  type RiskDecisionRecord,
  type RunnerBatchCounters,
  type RunnerBatchDescriptor,
  type RunnerConfig,
  RunnerError,
  type RunnerGit,
  type RunnerHooks,
  type RunnerOptions,
  type RunnerPhases,
  type RunnerRunResult,
  type RunnerScheduler,
  type RunnerState,
  type RunnerStopReason,
  type RunnerUsedPacing,
} from './types.js';

type Clock = () => Date;

const defaultScheduler: RunnerScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

class RunnerStop extends Error {
  constructor(
    readonly reason: RunnerStopReason,
    readonly details: string,
  ) {
    super(`${reason}: ${details}`);
    this.name = 'RunnerStop';
  }
}

const BATCH_STAGE_ORDER = [
  'PLAN_REVIEW',
  'IMPLEMENTATION',
  'CODE_REVIEW',
  'VERIFICATION',
  'PUSH',
] as const;

export class AutonomousWorkflowRunner {
  constructor(
    private readonly store: ReviewWorkflowRunnerStore,
    private readonly config: RunnerConfig,
    private readonly git: RunnerGit,
    private readonly phases: RunnerPhases,
    private readonly hooks: RunnerHooks,
    private readonly clock: Clock = () => new Date(),
    private readonly scheduler: RunnerScheduler = defaultScheduler,
    private readonly options: RunnerOptions = {},
  ) {}

  /**
   * The limits frozen into the runner state at workflow start. Editing configuration
   * between workers can never raise or lower enforcement mid-workflow.
   */
  private limits(workflowId: string): RunnerConfig {
    return this.store.require(workflowId).limits ?? this.config;
  }

  /** Effective review limit: the immutable contract wins; human grants extend explicitly. */
  private maxCodeReviewRounds(workflowId: string, granted: number): number {
    return (
      Math.min(
        this.limits(workflowId).maxCodeReviewRoundsPerBatch,
        this.options.contract?.maxCodeReviewRounds ?? Number.POSITIVE_INFINITY,
      ) + granted
    );
  }

  private maxCorrectionPasses(workflowId: string, granted: number): number {
    return (
      Math.min(
        this.limits(workflowId).maxCorrectionPassesPerBatch,
        this.options.contract?.maxCorrectionPasses ?? Number.POSITIVE_INFINITY,
      ) + granted
    );
  }

  /**
   * Runs (or resumes) the workflow until completion or a stop, under an exclusive worker
   * lease. Resuming after a human decision consumes the pending decision exactly once;
   * nothing else can restart a stopped runner.
   */
  async run(workflowId: string): Promise<RunnerRunResult> {
    const state = this.store.require(workflowId);
    if (state.status === 'CANCELLED' || state.status === 'READY_FOR_HUMAN_VERIFICATION') {
      return { status: state.status };
    }
    const workerId = this.options.workerId ?? `worker-${process.pid}`;
    const leaseSeconds =
      this.options.leaseSeconds ?? this.limits(workflowId).heartbeatExpirySeconds;
    if (!this.store.acquireLease(workflowId, workerId, leaseSeconds)) {
      throw new RunnerError(
        'WORKER_LEASE_HELD',
        `Workflow ${workflowId} is held by another live worker; wait for its lease to expire`,
      );
    }
    try {
      return await this.runLeased(workflowId, workerId, leaseSeconds);
    } finally {
      this.store.releaseLease(workflowId, workerId);
    }
  }

  private async runLeased(
    workflowId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<RunnerRunResult> {
    let state = this.store.require(workflowId);
    const decision = state.counters.pendingDecision;
    if (state.status === 'HUMAN_DECISION_REQUIRED') {
      if (decision === undefined) {
        return {
          status: state.status,
          stopReason: 'HUMAN_DECISION_REQUIRED',
          stopDetails: state.stopDetails ?? 'Awaiting an explicit human decision',
        };
      }
      state = this.consumeDecision(state, decision);
      if (state.status === 'CANCELLED') return { status: 'CANCELLED' };
      if (state.status === 'HUMAN_DECISION_REQUIRED') {
        return {
          status: state.status,
          stopReason: 'HUMAN_DECISION_REQUIRED',
          stopDetails: state.stopDetails ?? 'The pending decision could not be applied',
        };
      }
      // Apply the decision to the DOMAIN: unblock the batch (FIX_AGAIN grants exactly one
      // extra round + pass via the kernel resume event) and persist SHA-bound risk
      // acceptance so the state machine and merge gate honour it.
      const recorded = this.store.listDecisions(workflowId).at(-1);
      if (recorded !== undefined && state.counters.batch !== null) {
        try {
          await this.phases.applyDecision(
            { ordinal: state.counters.batch.ordinal, batchId: state.counters.batch.batchId },
            decision,
            recorded,
          );
        } catch (error) {
          return this.stop(
            workflowId,
            'HUMAN_DECISION_REQUIRED',
            `The ${decision} decision could not be applied to the domain state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    const workflowStartedAt = Date.parse(state.startedAt);
    const heartbeatContext = { workerId, leaseSeconds };
    try {
      // Phase 0: refine once; the batch count is frozen when refinement is approved.
      this.assertWorkflowBudgets(workflowId, workflowStartedAt);
      let batches: readonly RunnerBatchDescriptor[];
      if (state.totalBatches === 0) {
        batches = await this.withPhase(workflowId, null, 'PLAN_REFINEMENT', heartbeatContext, () =>
          this.phases.refinePlan(),
        );
        if (batches.length === 0) {
          throw new RunnerStop('HUMAN_DECISION_REQUIRED', 'Refinement produced no batches');
        }
        state = this.store.update(workflowId, { totalBatches: batches.length });
        this.checkpoint(
          workflowId,
          null,
          'PLAN_REFINEMENT',
          `Plan refined: ${batches.length} batches`,
        );
      } else {
        batches = await this.phases.refinePlan();
        if (batches.length !== state.totalBatches) {
          throw new RunnerStop(
            'HUMAN_DECISION_REQUIRED',
            `Batch count changed from the frozen ${state.totalBatches} to ${batches.length}; a plan amendment requires human approval`,
          );
        }
      }

      for (const batch of batches) {
        state = this.store.require(workflowId);
        if (state.counters.completedOrdinals.includes(batch.ordinal)) continue;
        this.assertWorkflowRuntime(workflowId, workflowStartedAt);
        state = this.beginBatch(workflowId, state, batch);
        await this.runBatch(workflowId, batch, workflowStartedAt, heartbeatContext);
        this.finishBatch(workflowId, batch);
        this.checkpoint(workflowId, batch.batchId, 'PUSH', `Batch ${batch.ordinal} completed`);
      }

      return await this.complete(workflowId, heartbeatContext);
    } catch (error) {
      if (error instanceof RunnerStop) {
        return this.stop(workflowId, error.reason, error.details);
      }
      if (isSessionContinuityError(error)) {
        return this.stop(workflowId, 'SESSION_CONTINUITY_FAILURE', error.message);
      }
      if (isAuthenticationFailure(error)) {
        return this.stop(workflowId, 'AUTHENTICATION_REQUIRED', error.message);
      }
      return this.stop(
        workflowId,
        'HUMAN_DECISION_REQUIRED',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private finishBatch(workflowId: string, batch: RunnerBatchDescriptor): void {
    const counters = this.store.require(workflowId).counters;
    const active = counters.batch;
    if (active !== null && active.ordinal === batch.ordinal) {
      // Retain the immutable completion summary — the final report is built from these.
      counters.completedBatches.push({
        ordinal: active.ordinal,
        batchId: active.batchId,
        planReviewRounds: active.planReviewRounds,
        codeReviewRounds: active.codeReviewRounds,
        correctionPasses: active.correctionPasses,
        finalAudits: active.finalAudits,
        verificationAttempts: { ...active.verificationAttempts },
        deferredFindingIds: [...active.deferredFindingIds],
        acceptedRiskFindingIds: [...active.acceptedRiskFindingIds],
        completedAt: this.clock().toISOString(),
        pushedCommitSha: this.git.headSha(),
      });
    }
    counters.completedOrdinals.push(batch.ordinal);
    counters.batch = null;
    this.store.update(workflowId, { counters, currentOrdinal: null });
  }

  /**
   * Records the human decision on a stopped workflow. Risk acceptance is immutable,
   * SHA-bound, and valid only for the exact recorded outstanding blocking set.
   */
  decide(input: {
    readonly workflowId: string;
    readonly action: HumanDecisionAction;
    readonly actor: string;
    readonly rationale: string;
    readonly findingIds?: readonly string[];
  }): RiskDecisionRecord {
    const state = this.store.require(input.workflowId);
    if (state.status !== 'HUMAN_DECISION_REQUIRED') {
      throw new RunnerError(
        'DECISION_NOT_PENDING',
        `Workflow ${input.workflowId} is ${state.status}; no human decision is pending`,
      );
    }
    if (state.counters.pendingDecision !== undefined) {
      throw new RunnerError(
        'DECISION_ALREADY_PENDING',
        `Workflow ${input.workflowId} already has an unconsumed ${state.counters.pendingDecision} decision`,
      );
    }
    if (input.actor.trim().length === 0) {
      throw new RunnerError('DECISION_ACTOR_REQUIRED', 'A decision requires the deciding actor');
    }
    const batch = state.counters.batch;
    if (input.action === 'ACCEPT_RISK_AND_CONTINUE') {
      const outstanding = batch?.outstandingBlockingFindingIds ?? [];
      const requested = input.findingIds ?? [];
      if (outstanding.length === 0) {
        throw new RunnerError(
          'DECISION_FINDINGS_UNKNOWN',
          'ACCEPT_RISK_AND_CONTINUE requires a recorded outstanding blocking set; this stop has none',
        );
      }
      const invalid = requested.filter((id) => !outstanding.includes(id));
      if (requested.length === 0 || invalid.length > 0) {
        throw new RunnerError(
          'DECISION_FINDINGS_INVALID',
          `ACCEPT_RISK_AND_CONTINUE must name only unresolved blocking findings (${outstanding.join(', ')}); invalid: ${invalid.join(', ') || 'none named'}`,
        );
      }
    }
    const decision: RiskDecisionRecord = {
      decisionId: `${input.workflowId}:decision:${this.store.listDecisions(input.workflowId).length + 1}`,
      workflowId: input.workflowId,
      ...(batch === null ? {} : { batchId: batch.batchId }),
      action: input.action,
      actor: input.actor,
      findingIds: input.findingIds ?? [],
      rationale: input.rationale,
      commitSha: this.git.headSha(),
      createdAt: this.clock().toISOString(),
    };
    this.store.recordDecision(decision);
    this.store.appendLog({
      workflowId: input.workflowId,
      ...(decision.batchId === undefined ? {} : { batchId: decision.batchId }),
      entryType: 'DECISION',
      message: `${input.action} by ${input.actor}`,
      payload: { findingIds: decision.findingIds, commitSha: decision.commitSha },
    });
    const counters = state.counters;
    counters.pendingDecision = input.action;
    this.store.update(input.workflowId, { counters });
    return decision;
  }

  private consumeDecision(state: RunnerState, decision: HumanDecisionAction): RunnerState {
    const counters = state.counters;
    counters.pendingDecision = undefined;
    if (decision === 'CANCEL_WORKFLOW') {
      this.store.appendLog({
        workflowId: state.workflowId,
        entryType: 'STOP',
        message: 'Workflow cancelled by human decision',
      });
      return this.store.update(state.workflowId, { status: 'CANCELLED', counters });
    }
    // A decision binds to the exact commit it was made on; a moved HEAD invalidates it.
    const recorded = this.store.listDecisions(state.workflowId).at(-1);
    const head = this.git.headSha();
    if (recorded !== undefined && recorded.commitSha !== head) {
      this.store.appendLog({
        workflowId: state.workflowId,
        entryType: 'STOP',
        message: `Decision ${recorded.decisionId} is stale: recorded on ${recorded.commitSha}, HEAD is now ${head}`,
      });
      return this.store.update(state.workflowId, {
        counters,
        stopDetails: `Decision ${recorded.decisionId} was bound to ${recorded.commitSha} but HEAD is ${head}; decide again on the current commit`,
      });
    }
    if (counters.batch !== null) {
      // Round/pass budgets are derived from durable coordinator events (including the human
      // grants applied by applyDecision) — counters are never edited to fake capacity.
      counters.batch.noProgressStreak = 0;
      if (decision === 'ACCEPT_RISK_AND_CONTINUE') {
        counters.batch.acceptedRiskFindingIds.push(...(recorded?.findingIds ?? []));
      }
    }
    return this.store.update(state.workflowId, {
      status: 'RUNNING',
      stopReason: null,
      stopDetails: null,
      notified: false,
      counters,
    });
  }

  private beginBatch(
    workflowId: string,
    state: RunnerState,
    batch: RunnerBatchDescriptor,
  ): RunnerState {
    if (state.counters.batch !== null && state.counters.batch.ordinal === batch.ordinal) {
      return state; // resuming the same batch after a decision or restart
    }
    const counters = state.counters;
    const batchCounters: RunnerBatchCounters = {
      ordinal: batch.ordinal,
      batchId: batch.batchId,
      planReviewRounds: 0,
      codeReviewRounds: 0,
      correctionPasses: 0,
      finalAudits: 0,
      verificationAttempts: {},
      noProgressStreak: 0,
      batchStartedAt: this.clock().toISOString(),
      deferredFindingIds: [],
      acceptedRiskFindingIds: [],
      outstandingBlockingFindingIds: [],
    };
    counters.batch = batchCounters;
    this.checkpoint(workflowId, batch.batchId, null, `Batch ${batch.ordinal} started`);
    return this.store.update(workflowId, { counters, currentOrdinal: batch.ordinal });
  }

  private async runBatch(
    workflowId: string,
    batch: RunnerBatchDescriptor,
    workflowStartedAt: number,
    heartbeat: HeartbeatContext,
  ): Promise<void> {
    // A restarted worker re-enters at the stage the DOMAIN state proves, never from scratch.
    const stage = await this.phases.resumeStage(batch);
    if (stage === 'COMPLETE') return;
    if (stage === 'BLOCKED') {
      throw new RunnerStop(
        'HUMAN_DECISION_REQUIRED',
        `Batch ${batch.ordinal} is BLOCKED in the domain state and needs a human decision`,
      );
    }
    const startIndex = BATCH_STAGE_ORDER.indexOf(stage);
    if (startIndex <= BATCH_STAGE_ORDER.indexOf('PLAN_REVIEW')) {
      await this.planReviewStage(workflowId, batch, workflowStartedAt, heartbeat);
    }
    if (startIndex <= BATCH_STAGE_ORDER.indexOf('IMPLEMENTATION')) {
      await this.implementationStage(workflowId, batch, workflowStartedAt, heartbeat);
    }
    if (startIndex <= BATCH_STAGE_ORDER.indexOf('CODE_REVIEW')) {
      await this.codeReviewStage(workflowId, batch, workflowStartedAt, heartbeat);
    }
    if (startIndex <= BATCH_STAGE_ORDER.indexOf('VERIFICATION')) {
      await this.verificationStage(workflowId, batch, workflowStartedAt, heartbeat);
      await this.auditAndGateStage(workflowId, batch, workflowStartedAt, heartbeat);
    }
    await this.pushStage(workflowId, batch, workflowStartedAt, heartbeat);
  }

  /** Durable coordinator events are the round/pass authority; counters mirror them. */
  private async syncPacing(
    workflowId: string,
    batch: RunnerBatchDescriptor,
  ): Promise<RunnerUsedPacing> {
    const used = await this.phases.usedPacing(batch);
    this.mutateBatch(workflowId, (b) => {
      b.planReviewRounds = Math.max(b.planReviewRounds, used.planReviewRounds);
      b.codeReviewRounds = Math.max(b.codeReviewRounds, used.codeReviewRounds);
      b.correctionPasses = Math.max(b.correctionPasses, used.correctionPasses);
    });
    return used;
  }

  private async planReviewStage(
    workflowId: string,
    batch: RunnerBatchDescriptor,
    workflowStartedAt: number,
    heartbeat: HeartbeatContext,
  ): Promise<void> {
    await this.syncPacing(workflowId, batch);
    let planApproved = false;
    for (
      let round = this.batchCounters(workflowId).planReviewRounds + 1;
      !planApproved;
      round += 1
    ) {
      if (round > this.limits(workflowId).maxPlanReviewRoundsPerBatch) {
        throw new RunnerStop(
          'PLAN_REVIEW_LIMIT_REACHED',
          `Batch ${batch.ordinal} plan review exhausted ${this.limits(workflowId).maxPlanReviewRoundsPerBatch} rounds`,
        );
      }
      this.assertBatchBudgets(workflowId, batch, workflowStartedAt);
      this.mutateBatch(workflowId, (b) => {
        b.planReviewRounds = round;
      });
      const review = await this.withPhase(workflowId, batch, 'PLAN_REVIEW', heartbeat, () =>
        this.phases.reviewPlan(batch, round),
      );
      this.checkpoint(
        workflowId,
        batch.batchId,
        'PLAN_REVIEW',
        `Plan review round ${round}: ${review.approved ? 'approved' : 'needs revision'}`,
      );
      if (review.approved) {
        planApproved = true;
        this.recordProgress(workflowId, true);
        break;
      }
      // The explicit review limit takes precedence over the generic no-progress detector.
      if (round >= this.limits(workflowId).maxPlanReviewRoundsPerBatch) {
        throw new RunnerStop(
          'PLAN_REVIEW_LIMIT_REACHED',
          `Batch ${batch.ordinal} plan review still needs revision after ${round} rounds`,
        );
      }
      this.recordProgress(workflowId, false);
      this.assertBatchBudgets(workflowId, batch, workflowStartedAt);
      await this.withPhase(workflowId, batch, 'PLAN_REVISION', heartbeat, () =>
        this.phases.revisePlan(batch, round),
      );
      this.checkpoint(
        workflowId,
        batch.batchId,
        'PLAN_REVISION',
        `Plan revision after round ${round} submitted`,
      );
      this.recordProgress(workflowId, true);
    }
  }

  private async implementationStage(
    workflowId: string,
    batch: RunnerBatchDescriptor,
    workflowStartedAt: number,
    heartbeat: HeartbeatContext,
  ): Promise<void> {
    this.assertBatchBudgets(workflowId, batch, workflowStartedAt);
    const implemented = await this.withPhase(workflowId, batch, 'IMPLEMENTATION', heartbeat, () =>
      this.phases.implement(batch),
    );
    this.checkpoint(workflowId, batch.batchId, 'COMMIT', `Commit created ${implemented.commitSha}`);
    this.recordProgress(workflowId, true);
  }

  private async codeReviewStage(
    workflowId: string,
    batch: RunnerBatchDescriptor,
    workflowStartedAt: number,
    heartbeat: HeartbeatContext,
  ): Promise<void> {
    let approved = false;
    let previousBlockers: readonly string[] = [];
    const used = await this.syncPacing(workflowId, batch);
    const maxRounds = this.maxCodeReviewRounds(workflowId, used.grantedReviewRounds);
    const maxPasses = this.maxCorrectionPasses(workflowId, used.grantedCorrectionPasses);
    for (
      let round = this.batchCounters(workflowId).codeReviewRounds + 1;
      round <= maxRounds;
      round += 1
    ) {
      this.assertBatchBudgets(workflowId, batch, workflowStartedAt);
      this.mutateBatch(workflowId, (b) => {
        b.codeReviewRounds = round;
      });
      this.store.update(workflowId, { reviewRound: round });
      const review = await this.withPhase(workflowId, batch, 'CODE_REVIEW', heartbeat, () =>
        this.phases.reviewCode(batch, round),
      );
      this.checkpoint(
        workflowId,
        batch.batchId,
        'CODE_REVIEW',
        `Code review round ${round}: ${review.approved ? 'approved' : `${review.blockingFindingIds.length} blocking`}`,
      );
      const accepted = this.batchCounters(workflowId).acceptedRiskFindingIds;
      const outstanding = review.blockingFindingIds.filter((id) => !accepted.includes(id));
      this.mutateBatch(workflowId, (b) => {
        b.outstandingBlockingFindingIds = [...outstanding];
      });
      if (review.approved || outstanding.length === 0) {
        approved = true;
        this.recordProgress(workflowId, true);
        break;
      }
      const resolvedSome =
        previousBlockers.length > 0 && outstanding.length < previousBlockers.length;
      this.recordProgress(workflowId, round === 1 || resolvedSome);
      previousBlockers = outstanding;

      const pass = this.batchCounters(workflowId).correctionPasses + 1;
      if (pass > maxPasses || round >= maxRounds) {
        throw new RunnerStop(
          pass > maxPasses ? 'CORRECTION_LIMIT_REACHED' : 'CODE_REVIEW_LIMIT_REACHED',
          `Batch ${batch.ordinal} has ${outstanding.length} unresolved blocking findings (${outstanding.join(', ')})`,
        );
      }
      this.mutateBatch(workflowId, (b) => {
        b.correctionPasses = pass;
      });
      this.store.update(workflowId, { correctionPass: pass });
      const corrected = await this.withPhase(workflowId, batch, 'CORRECTION', heartbeat, () =>
        this.phases.correct(batch, pass, outstanding),
      );
      this.checkpoint(
        workflowId,
        batch.batchId,
        'CORRECTION',
        `Correction pass ${pass} committed ${corrected.commitSha}`,
      );
      this.recordProgress(workflowId, true);
    }
    if (!approved) {
      throw new RunnerStop(
        'CODE_REVIEW_LIMIT_REACHED',
        `Batch ${batch.ordinal} was not approved within the configured review rounds`,
      );
    }
  }

  private async verificationStage(
    workflowId: string,
    batch: RunnerBatchDescriptor,
    workflowStartedAt: number,
    heartbeat: HeartbeatContext,
  ): Promise<void> {
    const commandCount = this.phases.verificationCommandCount(batch);
    for (let index = 1; index <= commandCount; index += 1) {
      let accepted = false;
      let lastFingerprint: string | null = null;
      for (
        let attempt = (this.batchCounters(workflowId).verificationAttempts[String(index)] ?? 0) + 1;
        attempt <= this.limits(workflowId).maxVerificationAttemptsPerCommand;
        attempt += 1
      ) {
        this.assertBatchBudgets(workflowId, batch, workflowStartedAt);
        this.mutateBatch(workflowId, (b) => {
          b.verificationAttempts[String(index)] = attempt;
        });
        const result = await this.withPhase(workflowId, batch, 'VERIFICATION', heartbeat, () =>
          this.phases.verify(batch, index, attempt),
        );
        if (result.accepted) {
          accepted = true;
          this.recordProgress(workflowId, true);
          break;
        }
        // A repeated failure with an identical result is not progress.
        this.recordProgress(workflowId, lastFingerprint !== result.resultFingerprint);
        lastFingerprint = result.resultFingerprint;
      }
      if (!accepted) {
        throw new RunnerStop(
          'VERIFICATION_LIMIT_REACHED',
          `Batch ${batch.ordinal} verification command ${index} failed ${this.limits(workflowId).maxVerificationAttemptsPerCommand} attempts`,
        );
      }
    }
    this.checkpoint(workflowId, batch.batchId, 'VERIFICATION', 'Verification complete');
  }

  private async auditAndGateStage(
    workflowId: string,
    batch: RunnerBatchDescriptor,
    workflowStartedAt: number,
    heartbeat: HeartbeatContext,
  ): Promise<void> {
    this.assertBatchBudgets(workflowId, batch, workflowStartedAt);
    const audits = this.batchCounters(workflowId).finalAudits + 1;
    if (audits > this.limits(workflowId).maxFinalAuditsPerBatch) {
      throw new RunnerStop(
        'FINAL_AUDIT_LIMIT_REACHED',
        `Batch ${batch.ordinal} already used its single final audit`,
      );
    }
    this.mutateBatch(workflowId, (b) => {
      b.finalAudits = audits;
    });
    const audit = await this.withPhase(workflowId, batch, 'FINAL_AUDIT', heartbeat, () =>
      this.phases.finalAudit(batch),
    );
    this.checkpoint(
      workflowId,
      batch.batchId,
      'FINAL_AUDIT',
      `Final audit: ${audit.approved ? 'approved' : 'needs revision'}`,
    );
    if (!audit.approved) {
      throw new RunnerStop(
        'HUMAN_DECISION_REQUIRED',
        `Batch ${batch.ordinal} final audit returned NEEDS_REVISION`,
      );
    }

    this.assertBatchBudgets(workflowId, batch, workflowStartedAt);
    const gate = await this.withPhase(workflowId, batch, 'GATE', heartbeat, () =>
      this.phases.gate(batch),
    );
    this.checkpoint(
      workflowId,
      batch.batchId,
      'GATE',
      gate.approved ? 'Gate approved' : `Gate failed: ${gate.failedConditions.join(', ')}`,
    );
    if (!gate.approved) {
      throw new RunnerStop(
        'HUMAN_DECISION_REQUIRED',
        `Batch ${batch.ordinal} gate failed: ${gate.failedConditions.join(', ')}`,
      );
    }
  }

  private async pushStage(
    workflowId: string,
    batch: RunnerBatchDescriptor,
    workflowStartedAt: number,
    heartbeat: HeartbeatContext,
  ): Promise<void> {
    this.assertWorkflowRuntime(workflowId, workflowStartedAt);
    await this.withPhase(workflowId, batch, 'PUSH', heartbeat, async () => {
      const state = this.store.require(workflowId);
      try {
        this.git.push(state.branch);
      } catch (error) {
        throw new RunnerStop('PUSH_FAILED', error instanceof Error ? error.message : 'Push failed');
      }
      const local = this.git.headSha();
      const remote = this.git.remoteHeadSha(state.branch);
      if (remote !== local) {
        throw new RunnerStop(
          'PUSH_FAILED',
          `Remote HEAD ${remote ?? 'missing'} does not match local ${local} after push`,
        );
      }
    });
    this.checkpoint(workflowId, batch.batchId, 'PUSH', `Pushed ${this.git.headSha()}`);
    this.recordProgress(workflowId, true);
  }

  private async complete(
    workflowId: string,
    heartbeat: HeartbeatContext,
  ): Promise<RunnerRunResult> {
    // Workflow-wide final validation: every batch approval must still be effective, no
    // blocking finding may remain unresolved, and the audit trail must be complete.
    const audit = await this.withPhase(workflowId, null, 'FINAL_AUDIT', heartbeat, () =>
      this.phases.workflowAudit(),
    );
    this.store.appendLog({
      workflowId,
      entryType: 'CHECKPOINT',
      phase: 'FINAL_AUDIT',
      message: `Workflow-wide audit: ${audit.approved ? 'approved' : 'failed'} (${audit.verification?.length ?? 0} verification commands re-run)`,
      ...(audit.verification === undefined
        ? {}
        : { payload: { verification: [...audit.verification] } }),
    });
    if (!audit.approved) {
      return this.stop(
        workflowId,
        'HUMAN_DECISION_REQUIRED',
        `Workflow-wide final audit failed: ${audit.issues.join('; ')}`,
      );
    }
    const state = this.store.require(workflowId);
    // READY means everything is committed and pushed: a worktree dirtied by workflow-level
    // verification (even by a zero-exit command) can never be reported ready. Unexpected
    // changes are preserved for human inspection — never cleaned or reset.
    if (!this.git.isClean()) {
      return this.stop(
        workflowId,
        'HUMAN_DECISION_REQUIRED',
        'Completion requires a clean worktree and index; workflow-level verification left uncommitted changes, which were preserved for inspection',
      );
    }
    const local = this.git.headSha();
    const remote = this.git.remoteHeadSha(state.branch);
    if (remote !== local) {
      return this.stop(
        workflowId,
        'PUSH_FAILED',
        `Completion requires matching HEADs: local ${local}, remote ${remote ?? 'missing'}`,
      );
    }
    this.store.update(workflowId, {
      status: 'READY_FOR_HUMAN_VERIFICATION',
      phase: null,
      stopReason: null,
      stopDetails: null,
      notified: true,
    });
    this.checkpoint(workflowId, null, null, 'Workflow complete: READY_FOR_HUMAN_VERIFICATION');
    this.notify(
      workflowId,
      `Workflow ${workflowId} branch ${state.branch} is ready for human verification`,
    );
    return { status: 'READY_FOR_HUMAN_VERIFICATION' };
  }

  /** Stops autonomous execution: persist reason + checkpoint summary, notify exactly once. */
  private stop(workflowId: string, reason: RunnerStopReason, details: string): RunnerRunResult {
    const state = this.store.require(workflowId);
    // Every stable stop reason requires an explicit human decision before anything resumes.
    const status = 'HUMAN_DECISION_REQUIRED' as const;
    this.store.update(workflowId, {
      status,
      stopReason: reason,
      stopDetails: details,
    });
    this.store.appendLog({
      workflowId,
      ...(state.counters.batch === null ? {} : { batchId: state.counters.batch.batchId }),
      entryType: 'STOP',
      ...(state.phase === undefined ? {} : { phase: state.phase }),
      message: `${reason}: ${details}`,
      payload: { reason, details, checkpoint: state.lastCheckpoint ?? null },
    });
    const current = this.store.require(workflowId);
    if (!current.notified) {
      this.notify(workflowId, `Workflow ${workflowId} stopped: ${reason} — ${details}`);
      this.store.update(workflowId, { notified: true });
    }
    return { status, stopReason: reason, stopDetails: details };
  }

  /** Owner notification is durable (NOTIFICATION log entry) before any transport hook runs. */
  private notify(workflowId: string, message: string): void {
    this.store.appendLog({ workflowId, entryType: 'NOTIFICATION', message });
    this.hooks.notify(message);
  }

  /**
   * Marks a running workflow whose worker heartbeat AND lease both expired as stalled. Safe
   * to call from any observer (status/watch/resume); a live worker is never disturbed.
   */
  reconcileStalled(workflowId: string): RunnerState {
    const state = this.store.require(workflowId);
    if (state.status !== 'RUNNING') return state;
    const now = this.clock();
    const heartbeatExpired =
      state.lastHeartbeatAt !== undefined &&
      (now.getTime() - Date.parse(state.lastHeartbeatAt)) / 1000 >
        this.limits(workflowId).heartbeatExpirySeconds;
    const leaseExpired =
      state.leaseExpiresAt === undefined || Date.parse(state.leaseExpiresAt) < now.getTime();
    if (heartbeatExpired && leaseExpired) {
      this.stop(
        workflowId,
        'WORKER_HEARTBEAT_EXPIRED',
        `Worker ${state.workerId ?? 'unknown'} heartbeat expired at ${state.lastHeartbeatAt}; the workflow is stalled`,
      );
      return this.store.require(workflowId);
    }
    return state;
  }

  /**
   * Runs one phase with the branch/base/remote invariants, durable phase state, and a
   * CodeMoot-generated heartbeat (no LLM, no tokens) that also renews the worker lease.
   */
  private async withPhase<T>(
    workflowId: string,
    batch: RunnerBatchDescriptor | null,
    phase: string,
    heartbeatContext: HeartbeatContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    const state = this.store.require(workflowId);
    this.assertRepositoryInvariants(state, `before ${phase}`);
    const remoteBefore = this.git.remoteHeadSha(state.branch);
    const now = this.clock().toISOString();
    this.store.update(workflowId, {
      phase,
      phaseStartedAt: now,
      lastHeartbeatAt: now,
    });
    const startedAtMs = this.clock().getTime();
    const heartbeat = this.scheduler.setInterval(() => {
      const beat = this.clock();
      this.store.update(workflowId, {
        lastHeartbeatAt: beat.toISOString(),
        leaseExpiresAt: new Date(
          beat.getTime() + heartbeatContext.leaseSeconds * 1000,
        ).toISOString(),
      });
      this.store.appendLog({
        workflowId,
        ...(batch === null ? {} : { batchId: batch.batchId }),
        entryType: 'HEARTBEAT',
        phase,
        message: `${phase} active, elapsed ${Math.round((beat.getTime() - startedAtMs) / 1000)}s`,
        payload: {
          workerId: heartbeatContext.workerId,
          headSha: this.git.headSha(),
          ...(batch === null ? {} : { ordinal: batch.ordinal, batchId: batch.batchId }),
          activeInvocation: this.store.require(workflowId).activeInvocation ?? null,
        },
      });
    }, this.limits(workflowId).heartbeatIntervalSeconds * 1000);
    try {
      const result = await fn();
      const after = this.store.require(workflowId);
      this.assertRepositoryInvariants(after, `after ${phase}`);
      if (phase !== 'PUSH') {
        const remoteAfter = this.git.remoteHeadSha(after.branch);
        if (remoteAfter !== remoteBefore) {
          throw new RunnerStop(
            'HUMAN_DECISION_REQUIRED',
            `Remote branch ${after.branch} changed during ${phase} (${remoteBefore ?? 'missing'} -> ${remoteAfter ?? 'missing'}); only the gated PUSH phase may push`,
          );
        }
      }
      return result;
    } finally {
      this.scheduler.clearInterval(heartbeat);
    }
  }

  /** The active branch must be the workflow branch and the base branch must be untouched. */
  private assertRepositoryInvariants(state: RunnerState, when: string): void {
    const activeBranch = this.git.currentBranch();
    if (activeBranch !== state.branch) {
      throw new RunnerStop(
        'HUMAN_DECISION_REQUIRED',
        `Active branch ${activeBranch} is not the workflow branch ${state.branch} (${when})`,
      );
    }
    const baseNow = this.git.refSha(state.baseBranch);
    if (baseNow !== state.baseSha) {
      throw new RunnerStop(
        'HUMAN_DECISION_REQUIRED',
        `Base branch ${state.baseBranch} moved from ${state.baseSha} to ${baseNow} (${when}); the base branch must never be modified`,
      );
    }
  }

  private checkpoint(
    workflowId: string,
    batchId: string | null,
    phase: string | null,
    message: string,
  ): void {
    this.store.appendLog({
      workflowId,
      ...(batchId === null ? {} : { batchId }),
      entryType: 'CHECKPOINT',
      ...(phase === null ? {} : { phase }),
      message,
    });
    this.store.update(workflowId, { lastCheckpoint: message });
  }

  private recordProgress(workflowId: string, progressed: boolean): void {
    this.mutateBatch(workflowId, (batch) => {
      batch.noProgressStreak = progressed ? 0 : batch.noProgressStreak + 1;
    });
    const counters = this.batchCounters(workflowId);
    if (counters.noProgressStreak >= this.limits(workflowId).maxConsecutiveNoProgressActions) {
      throw new RunnerStop(
        'NO_PROGRESS_LIMIT_REACHED',
        `${counters.noProgressStreak} consecutive actions produced no measurable progress`,
      );
    }
  }

  private assertWorkflowRuntime(workflowId: string, workflowStartedAt: number): void {
    const elapsedMinutes = (this.clock().getTime() - workflowStartedAt) / 60_000;
    const max = this.limits(workflowId).maxWorkflowRuntimeMinutes;
    if (elapsedMinutes > max) {
      throw new RunnerStop('WORKFLOW_RUNTIME_LIMIT_REACHED', `Workflow exceeded ${max} minutes`);
    }
  }

  /** Workflow-scoped budgets: runtime, total invocations (failures included), and cost. */
  private assertWorkflowBudgets(workflowId: string, workflowStartedAt: number): void {
    this.assertWorkflowRuntime(workflowId, workflowStartedAt);
    const limits = this.limits(workflowId);
    const totals = this.store.auditTotals(workflowId);
    if (totals.invocations >= limits.maxTotalAgentInvocations) {
      throw new RunnerStop(
        'INVOCATION_LIMIT_REACHED',
        `Workflow used ${totals.invocations} agent invocations (max ${limits.maxTotalAgentInvocations})`,
      );
    }
    if (totals.costUsd >= limits.maxCostUsdPerWorkflow) {
      throw new RunnerStop(
        'COST_BUDGET_REACHED',
        `Workflow audited cost $${totals.costUsd.toFixed(2)} reached the $${limits.maxCostUsdPerWorkflow} budget`,
      );
    }
  }

  private assertBatchBudgets(
    workflowId: string,
    batch: RunnerBatchDescriptor,
    workflowStartedAt: number,
  ): void {
    this.assertWorkflowBudgets(workflowId, workflowStartedAt);
    const limits = this.limits(workflowId);
    const counters = this.batchCounters(workflowId);
    const elapsedMinutes = (this.clock().getTime() - Date.parse(counters.batchStartedAt)) / 60_000;
    if (elapsedMinutes > limits.maxBatchRuntimeMinutes) {
      throw new RunnerStop(
        'BATCH_RUNTIME_LIMIT_REACHED',
        `Batch ${batch.ordinal} exceeded ${limits.maxBatchRuntimeMinutes} minutes`,
      );
    }
    const batchTotals = this.store.auditTotals(workflowId, batch.batchId);
    if (batchTotals.invocations >= limits.maxAgentInvocationsPerBatch) {
      throw new RunnerStop(
        'INVOCATION_LIMIT_REACHED',
        `Batch ${batch.ordinal} used ${batchTotals.invocations} agent invocations (max ${limits.maxAgentInvocationsPerBatch})`,
      );
    }
    if (
      batchTotals.inputTokens >= limits.maxInputTokensPerBatch ||
      batchTotals.outputTokens >= limits.maxOutputTokensPerBatch
    ) {
      throw new RunnerStop(
        'TOKEN_BUDGET_REACHED',
        `Batch ${batch.ordinal} token budget exhausted (input ${batchTotals.inputTokens}, output ${batchTotals.outputTokens})`,
      );
    }
  }

  private batchCounters(workflowId: string): RunnerBatchCounters {
    const counters = this.store.require(workflowId).counters;
    if (counters.batch === null) {
      throw new RunnerError('BATCH_COUNTERS_MISSING', 'No active batch counters');
    }
    return counters.batch;
  }

  private mutateBatch(workflowId: string, mutate: (batch: RunnerBatchCounters) => void): void {
    const state = this.store.require(workflowId);
    if (state.counters.batch === null) {
      throw new RunnerError('BATCH_COUNTERS_MISSING', 'No active batch counters');
    }
    mutate(state.counters.batch);
    this.store.update(workflowId, { counters: state.counters });
  }
}

interface HeartbeatContext {
  readonly workerId: string;
  readonly leaseSeconds: number;
}

/** Derives the observable status: a running workflow with an expired heartbeat is STALLED. */
export function deriveObservedStatus(
  state: RunnerState,
  heartbeatExpirySeconds: number,
  now: Date,
): { status: string; reason?: string } {
  if (state.status !== 'RUNNING') return { status: state.status };
  if (state.lastHeartbeatAt === undefined) return { status: 'RUNNING' };
  const ageSeconds = (now.getTime() - Date.parse(state.lastHeartbeatAt)) / 1000;
  if (ageSeconds > heartbeatExpirySeconds) {
    return { status: 'STALLED', reason: 'WORKER_HEARTBEAT_EXPIRED' };
  }
  return { status: 'RUNNING' };
}
