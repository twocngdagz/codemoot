// The autonomous runner: success across batches, every hard-limit path, no-progress
// detection, stall derivation, human decisions, session-continuity and push failure stops —
// all driven through injected phases so the loop is deterministic.

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowStore } from '../../../src/memory/review-workflow-store.js';
import {
  AutonomousWorkflowRunner,
  deriveObservedStatus,
} from '../../../src/review-workflow-runner/service.js';
import { ReviewWorkflowRunnerStore } from '../../../src/review-workflow-runner/store.js';
import type {
  RunnerBatchDescriptor,
  RunnerConfig,
  RunnerGit,
  RunnerOptions,
  RunnerPhases,
} from '../../../src/review-workflow-runner/types.js';
import { RoleInvocationError } from '../../../src/roles/role-invocation.js';

const WORKFLOW_ID = 'workflow-run';
const NOW = '2026-08-02T12:00:00.000Z';

const BASE_CONFIG: RunnerConfig = {
  maxPlanReviewRoundsPerBatch: 2,
  maxCodeReviewRoundsPerBatch: 3,
  maxCorrectionPassesPerBatch: 2,
  maxCostUsdPerWorkflow: 25,
  maxVerificationAttemptsPerCommand: 2,
  maxFinalAuditsPerBatch: 1,
  maxAgentInvocationsPerBatch: 12,
  maxTotalAgentInvocations: 100,
  maxBatchRuntimeMinutes: 240,
  maxWorkflowRuntimeMinutes: 1440,
  maxConsecutiveNoProgressActions: 2,
  maxInputTokensPerBatch: 500_000,
  maxOutputTokensPerBatch: 100_000,
  heartbeatIntervalSeconds: 30,
  heartbeatExpirySeconds: 120,
};

class FakeGit implements RunnerGit {
  branch = 'codemoot/test-branch';
  head = 'a'.repeat(40);
  base = '9'.repeat(40);
  remote: string | null = null;
  pushShouldFail = false;
  pushes = 0;
  currentBranch(): string {
    return this.branch;
  }
  headSha(): string {
    return this.head;
  }
  clean = true;
  isClean(): boolean {
    return this.clean;
  }
  createBranch(): void {}
  push(): void {
    this.pushes += 1;
    if (this.pushShouldFail) throw new Error('remote rejected the push');
    this.remote = this.head;
  }
  remoteHeadSha(): string | null {
    return this.remote;
  }
  refSha(): string {
    return this.base;
  }
  fingerprint = 'clean-tree';
  statusFingerprint(): string {
    return this.fingerprint;
  }
}

type PhaseOverrides = Partial<RunnerPhases>;

function happyPhases(
  batches: readonly RunnerBatchDescriptor[],
  overrides?: PhaseOverrides,
): RunnerPhases & { calls: string[] } {
  const calls: string[] = [];
  const base: RunnerPhases = {
    refinePlan: async () => {
      calls.push('refine');
      return batches;
    },
    reviewPlan: async (batch, round) => {
      calls.push(`plan-review:${batch.ordinal}:${round}`);
      return { approved: true };
    },
    revisePlan: async () => {
      calls.push('plan-revision');
    },
    implement: async (batch) => {
      calls.push(`implement:${batch.ordinal}`);
      return { commitSha: 'b'.repeat(40) };
    },
    reviewCode: async (batch, round) => {
      calls.push(`code-review:${batch.ordinal}:${round}`);
      return { approved: true, blockingFindingIds: [] };
    },
    correct: async (batch, pass) => {
      calls.push(`correct:${batch.ordinal}:${pass}`);
      return { commitSha: 'c'.repeat(40) };
    },
    verificationCommandCount: () => 1,
    verify: async (batch, index, attempt) => {
      calls.push(`verify:${batch.ordinal}:${index}:${attempt}`);
      return { accepted: true, resultFingerprint: 'fp-ok' };
    },
    finalAudit: async (batch) => {
      calls.push(`final-audit:${batch.ordinal}`);
      return { approved: true };
    },
    gate: async (batch) => {
      calls.push(`gate:${batch.ordinal}`);
      return { approved: true, failedConditions: [] };
    },
    resumeStage: async (batch) => {
      calls.push(`resume-stage:${batch.ordinal}`);
      return 'PLAN_REVIEW';
    },
    usedPacing: async (batch) => ({
      // Mirrors the coordinator's event-derived truth: exactly what actually completed.
      planReviewRounds: calls.filter((call) => call.startsWith(`plan-review:${batch.ordinal}:`))
        .length,
      codeReviewRounds: calls.filter((call) => call.startsWith(`code-review:${batch.ordinal}:`))
        .length,
      correctionPasses: calls.filter((call) => call.startsWith(`correct:${batch.ordinal}:`)).length,
      grantedReviewRounds: 0,
      grantedCorrectionPasses: 0,
    }),
    applyDecision: async (batch, action) => {
      calls.push(`apply-decision:${batch.ordinal}:${action}`);
    },
    workflowAudit: async () => {
      calls.push('workflow-audit');
      return { approved: true, issues: [] };
    },
  };
  return Object.assign({ calls }, base, overrides);
}

describe('AutonomousWorkflowRunner', () => {
  let db: Database.Database;
  let runnerStore: ReviewWorkflowRunnerStore;
  let git: FakeGit;
  let notifications: string[];
  let clockNow: Date;

  const batches: RunnerBatchDescriptor[] = [
    { ordinal: 1, batchId: 'batch-1' },
    { ordinal: 2, batchId: 'batch-2' },
  ];

  function makeRunner(
    phases: RunnerPhases,
    config: Partial<RunnerConfig> = {},
    options: RunnerOptions = {},
  ) {
    return new AutonomousWorkflowRunner(
      runnerStore,
      { ...BASE_CONFIG, ...config },
      git,
      phases,
      { notify: (message) => notifications.push(message) },
      () => clockNow,
      { setInterval: () => 0, clearInterval: () => {} },
      options,
    );
  }

  beforeEach(() => {
    clockNow = new Date(NOW);
    db = openDatabase(':memory:');
    runnerStore = new ReviewWorkflowRunnerStore(db, () => clockNow);
    const workflowStore = new ReviewWorkflowStore(db);
    workflowStore.createWorkflow({
      workflowId: WORKFLOW_ID,
      status: 'ACTIVE',
      generalPlanVersionId: `${WORKFLOW_ID}:general-plan`,
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      configurationHash: 'configuration-hash',
      createdAt: NOW,
      updatedAt: NOW,
    });
    git = new FakeGit();
    notifications = [];
    runnerStore.initState({
      workflowId: WORKFLOW_ID,
      branch: git.branch,
      baseBranch: 'master',
      baseSha: '9'.repeat(40),
    });
  });

  afterEach(() => {
    db.close();
  });

  it('runs every batch to completion, pushes after each gate, and notifies exactly once', async () => {
    const phases = happyPhases(batches);
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(result.status).toBe('READY_FOR_HUMAN_VERIFICATION');
    const state = runnerStore.require(WORKFLOW_ID);
    expect(state.totalBatches).toBe(2);
    expect(state.counters.completedOrdinals).toEqual([1, 2]);
    expect(git.pushes).toBe(2);
    expect(git.remoteHeadSha('')).toBe(git.headSha());
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('ready for human verification');
    // Ordinary progress emitted checkpoints, never notifications.
    const checkpoints = runnerStore.listLog(WORKFLOW_ID, { types: ['CHECKPOINT'] });
    expect(checkpoints.length).toBeGreaterThanOrEqual(10);
    expect(phases.calls.filter((call) => call.startsWith('implement'))).toEqual([
      'implement:1',
      'implement:2',
    ]);
  });

  it('plan-as-is: opens every batch with the acceptance, never a plan-review round', async () => {
    const phases = happyPhases(batches, {
      resumeStage: async (batch) => {
        // The CLI's mode-aware mapping: DRAFT re-enters at IMPLEMENTATION in this mode.
        void batch;
        return 'IMPLEMENTATION';
      },
    });
    const accepted: number[] = [];
    phases.acceptPlanAsIs = async (batch) => {
      accepted.push(batch.ordinal);
      phases.calls.push(`accept-as-is:${batch.ordinal}`);
    };
    const result = await makeRunner(phases, {}, { planAsIs: true }).run(WORKFLOW_ID);
    expect(result.status).toBe('READY_FOR_HUMAN_VERIFICATION');
    expect(accepted).toEqual([1, 2]);
    // ZERO plan-review or plan-revision activity — the stage is skipped, not short-circuited.
    expect(phases.calls.some((call) => call.startsWith('plan-review'))).toBe(false);
    expect(phases.calls.some((call) => call.startsWith('plan-revision'))).toBe(false);
    // The acceptance opens the batch: it precedes that batch's implementation.
    expect(phases.calls.indexOf('accept-as-is:1')).toBeLessThan(
      phases.calls.indexOf('implement:1'),
    );
    expect(phases.calls.indexOf('accept-as-is:2')).toBeLessThan(
      phases.calls.indexOf('implement:2'),
    );
  });

  it('plan-as-is without an acceptPlanAsIs phase stops instead of reverting to plan review', async () => {
    // happyPhases deliberately carries no acceptPlanAsIs — the refined-mode surface.
    const phases = happyPhases(batches);
    const result = await makeRunner(phases, {}, { planAsIs: true }).run(WORKFLOW_ID);
    expect(result.status).toBe('HUMAN_DECISION_REQUIRED');
    expect(result.stopDetails).toContain('acceptPlanAsIs');
    // It stopped BEFORE any review or implementation could run.
    expect(phases.calls.some((call) => call.startsWith('plan-review'))).toBe(false);
    expect(phases.calls.some((call) => call.startsWith('implement'))).toBe(false);
  });

  it('freezes the batch count at refinement and stops on unapproved expansion', async () => {
    await makeRunner(happyPhases(batches)).run(WORKFLOW_ID);
    // A second run must not accept a changed batch count.
    runnerStore.update(WORKFLOW_ID, { status: 'RUNNING' });
    const expanded = happyPhases([...batches, { ordinal: 3, batchId: 'batch-3' }]);
    const result = await makeRunner(expanded).run(WORKFLOW_ID);
    expect(result.status).toBe('HUMAN_DECISION_REQUIRED');
    expect(result.stopDetails).toContain('plan amendment');
  });

  it('stops with PLAN_REVIEW_LIMIT_REACHED after the configured rounds', async () => {
    const phases = happyPhases(batches, {
      reviewPlan: async () => ({ approved: false }),
      revisePlan: async () => {},
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(result.stopReason).toBe('PLAN_REVIEW_LIMIT_REACHED');
    expect(runnerStore.require(WORKFLOW_ID).status).toBe('HUMAN_DECISION_REQUIRED');
    expect(notifications).toHaveLength(1);
    const stops = runnerStore.listLog(WORKFLOW_ID, { types: ['STOP'] });
    expect(stops.at(-1)?.message).toContain('PLAN_REVIEW_LIMIT_REACHED');
  });

  it('stops with CORRECTION_LIMIT_REACHED when blockers survive every allowed pass', async () => {
    const phases = happyPhases(batches, {
      reviewCode: async (_batch, round) => ({
        approved: false,
        blockingFindingIds: [`finding-${round}`],
      }),
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(['CORRECTION_LIMIT_REACHED', 'CODE_REVIEW_LIMIT_REACHED']).toContain(result.stopReason);
    expect(runnerStore.require(WORKFLOW_ID).status).toBe('HUMAN_DECISION_REQUIRED');
  });

  it('stops with VERIFICATION_LIMIT_REACHED after bounded attempts', async () => {
    const phases = happyPhases(batches, {
      verify: async (_batch, _index, attempt) => ({
        accepted: false,
        resultFingerprint: `fp-${attempt}`,
      }),
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(result.stopReason).toBe('VERIFICATION_LIMIT_REACHED');
  });

  it('detects repeated identical verification failures as no progress', async () => {
    const phases = happyPhases(batches, {
      verify: async () => ({ accepted: false, resultFingerprint: 'same-result' }),
    });
    const result = await makeRunner(phases, { maxVerificationAttemptsPerCommand: 5 }).run(
      WORKFLOW_ID,
    );
    expect(result.stopReason).toBe('NO_PROGRESS_LIMIT_REACHED');
  });

  it('stops with BATCH_RUNTIME_LIMIT_REACHED when a batch exceeds its budget', async () => {
    const phases = happyPhases(batches, {
      implement: async (batch) => {
        clockNow = new Date(Date.parse(NOW) + 300 * 60_000);
        return { commitSha: 'b'.repeat(40) };
      },
    });
    const result = await makeRunner(phases, { maxWorkflowRuntimeMinutes: 10_000 }).run(WORKFLOW_ID);
    expect(result.stopReason).toBe('BATCH_RUNTIME_LIMIT_REACHED');
  });

  it('stops with WORKFLOW_RUNTIME_LIMIT_REACHED across batches', async () => {
    const phases = happyPhases(batches, {
      gate: async () => {
        clockNow = new Date(Date.parse(NOW) + 2000 * 60_000);
        return { approved: true, failedConditions: [] };
      },
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(result.stopReason).toBe('WORKFLOW_RUNTIME_LIMIT_REACHED');
  });

  it('enforces the per-batch invocation budget from the immutable audit', async () => {
    const workflowStore = new ReviewWorkflowStore(db);
    // Simulate 12 audited invocations for batch-1.
    for (let index = 0; index < 12; index += 1) {
      workflowStore.recordInvocationAudit({
        invocationId: `audit-${index}`,
        workflowId: WORKFLOW_ID,
        batchId: 'batch-1',
        commandId: `command-${index}`,
        actorExecutionId: 'actor',
        adapterKind: 'CLAUDE',
        configuredModel: 'claude-supported',
        vendorSessionId: 'claude-thread-1',
        sessionOutcome: 'RESUMED',
        prompt: 'p',
        promptHash: 'h'.repeat(64),
        response: 'r',
        responseHash: 'h'.repeat(64),
        redactionCount: 0,
        inputTokens: 10,
        outputTokens: 5,
        startedAt: NOW,
        finishedAt: NOW,
        durationMs: 10,
        resultStatus: 'SUCCEEDED',
        createdAt: NOW,
      });
    }
    const result = await makeRunner(happyPhases(batches)).run(WORKFLOW_ID);
    expect(result.stopReason).toBe('INVOCATION_LIMIT_REACHED');
  });

  it('stops with TOKEN_BUDGET_REACHED when audited tokens exhaust the batch budget', async () => {
    const workflowStore = new ReviewWorkflowStore(db);
    workflowStore.recordInvocationAudit({
      invocationId: 'audit-tokens',
      workflowId: WORKFLOW_ID,
      batchId: 'batch-1',
      commandId: 'command-tokens',
      actorExecutionId: 'actor',
      adapterKind: 'CLAUDE',
      configuredModel: 'claude-supported',
      vendorSessionId: 'claude-thread-1',
      sessionOutcome: 'RESUMED',
      prompt: 'p',
      promptHash: 'h'.repeat(64),
      response: 'r',
      responseHash: 'h'.repeat(64),
      redactionCount: 0,
      inputTokens: 600_000,
      outputTokens: 5,
      startedAt: NOW,
      finishedAt: NOW,
      durationMs: 10,
      resultStatus: 'SUCCEEDED',
      createdAt: NOW,
    });
    const result = await makeRunner(happyPhases(batches)).run(WORKFLOW_ID);
    expect(result.stopReason).toBe('TOKEN_BUDGET_REACHED');
  });

  it('stops with SESSION_CONTINUITY_FAILURE when a phase hits a continuity error', async () => {
    const phases = happyPhases(batches, {
      reviewCode: async () => {
        throw new RoleInvocationError('SESSION_RESUME_FAILED', 'vendor rejected the session');
      },
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(result.stopReason).toBe('SESSION_CONTINUITY_FAILURE');
    expect(notifications).toHaveLength(1);
  });

  it('stops with PUSH_FAILED and never retries the push blindly', async () => {
    git.pushShouldFail = true;
    const result = await makeRunner(happyPhases(batches)).run(WORKFLOW_ID);
    expect(result.stopReason).toBe('PUSH_FAILED');
    expect(git.pushes).toBe(1);
  });

  it('stops when the active branch is not the workflow branch', async () => {
    git.branch = 'master';
    const result = await makeRunner(happyPhases(batches)).run(WORKFLOW_ID);
    expect(result.status).toBe('HUMAN_DECISION_REQUIRED');
    expect(result.stopDetails).toContain('not the workflow branch');
  });

  it('requires an explicit decision to continue and honours FIX_AGAIN and CANCEL', async () => {
    const singleBatch: RunnerBatchDescriptor[] = [{ ordinal: 1, batchId: 'batch-1' }];
    const blocked = happyPhases(singleBatch, {
      reviewCode: async () => ({ approved: false, blockingFindingIds: ['finding-1'] }),
    });
    const runner = makeRunner(blocked, { maxCorrectionPassesPerBatch: 0 });
    const first = await runner.run(WORKFLOW_ID);
    expect(first.status).toBe('HUMAN_DECISION_REQUIRED');

    // Without a decision, resuming changes nothing and never re-invokes.
    const idle = await runner.run(WORKFLOW_ID);
    expect(idle.status).toBe('HUMAN_DECISION_REQUIRED');

    // ACCEPT_RISK records an immutable SHA-bound decision and continues past the blockers.
    const decision = runner.decide({
      workflowId: WORKFLOW_ID,
      action: 'ACCEPT_RISK_AND_CONTINUE',
      actor: 'roy',
      rationale: 'Finding accepted for this release',
      findingIds: ['finding-1'],
    });
    expect(decision.commitSha).toBe(git.headSha());
    expect(runnerStore.listDecisions(WORKFLOW_ID)).toHaveLength(1);
    const resumed = await runner.run(WORKFLOW_ID);
    expect(resumed.status).toBe('READY_FOR_HUMAN_VERIFICATION');

    // CANCEL terminates a stopped workflow.
    const db2 = openDatabase(':memory:');
    const store2 = new ReviewWorkflowRunnerStore(db2, () => clockNow);
    new ReviewWorkflowStore(db2).createWorkflow({
      workflowId: WORKFLOW_ID,
      status: 'ACTIVE',
      generalPlanVersionId: `${WORKFLOW_ID}:general-plan`,
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      configurationHash: 'configuration-hash',
      createdAt: NOW,
      updatedAt: NOW,
    });
    store2.initState({
      workflowId: WORKFLOW_ID,
      branch: git.branch,
      baseBranch: 'master',
      baseSha: '9'.repeat(40),
    });
    const runner2 = new AutonomousWorkflowRunner(
      store2,
      { ...BASE_CONFIG, maxCorrectionPassesPerBatch: 0 },
      git,
      blocked,
      { notify: () => {} },
      () => clockNow,
      { setInterval: () => 0, clearInterval: () => {} },
    );
    git.branch = 'codemoot/test-branch';
    await runner2.run(WORKFLOW_ID);
    runner2.decide({
      workflowId: WORKFLOW_ID,
      action: 'CANCEL_WORKFLOW',
      actor: 'roy',
      rationale: 'Not worth continuing',
    });
    const cancelled = await runner2.run(WORKFLOW_ID);
    expect(cancelled.status).toBe('CANCELLED');
    db2.close();
  });

  it('emits durable heartbeats via the scheduler and derives STALLED after expiry', async () => {
    let tick: (() => void) | null = null;
    const scheduler = {
      setInterval: (fn: () => void) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {},
    };
    const phases = happyPhases([batches[0] as RunnerBatchDescriptor], {
      implement: async () => {
        tick?.();
        tick?.();
        return { commitSha: 'b'.repeat(40) };
      },
    });
    const runner = new AutonomousWorkflowRunner(
      runnerStore,
      BASE_CONFIG,
      git,
      phases,
      { notify: () => {} },
      () => clockNow,
      scheduler,
    );
    await runner.run(WORKFLOW_ID);
    const heartbeats = runnerStore.listLog(WORKFLOW_ID, { types: ['HEARTBEAT'] });
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(heartbeats[0]?.message).toContain('active');

    // Stall derivation: a RUNNING state whose heartbeat aged past expiry is STALLED.
    runnerStore.update(WORKFLOW_ID, {
      status: 'RUNNING',
      lastHeartbeatAt: NOW,
    });
    const state = runnerStore.require(WORKFLOW_ID);
    const fresh = deriveObservedStatus(state, 120, new Date(Date.parse(NOW) + 60_000));
    expect(fresh.status).toBe('RUNNING');
    const stalled = deriveObservedStatus(state, 120, new Date(Date.parse(NOW) + 300_000));
    expect(stalled).toEqual({ status: 'STALLED', reason: 'WORKER_HEARTBEAT_EXPIRED' });
  });

  it('resumes idempotently: completed batches are never re-processed', async () => {
    const phases = happyPhases(batches);
    await makeRunner(phases).run(WORKFLOW_ID);
    const callsAfterFirst = phases.calls.length;
    runnerStore.update(WORKFLOW_ID, { status: 'RUNNING' });
    const second = await makeRunner(phases).run(WORKFLOW_ID);
    expect(second.status).toBe('READY_FOR_HUMAN_VERIFICATION');
    // Only the idempotent refine listing and completion audit ran again — no batch phase repeated.
    expect(phases.calls.slice(callsAfterFirst)).toEqual(['refine', 'workflow-audit']);
  });

  it('stops when a phase modifies the base branch', async () => {
    const phases = happyPhases(batches, {
      implement: async () => {
        git.base = 'e'.repeat(40);
        return { commitSha: 'b'.repeat(40) };
      },
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(result.status).toBe('HUMAN_DECISION_REQUIRED');
    expect(result.stopDetails).toContain('must never be modified');
  });

  it('stops when a phase pushes early outside the gated PUSH phase', async () => {
    const phases = happyPhases(batches, {
      implement: async () => {
        git.remote = 'd'.repeat(40); // simulated forbidden push during implementation
        return { commitSha: 'b'.repeat(40) };
      },
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(result.status).toBe('HUMAN_DECISION_REQUIRED');
    expect(result.stopDetails).toContain('only the gated PUSH phase may push');
  });

  it('stops when the workflow-wide completion audit reports issues', async () => {
    const phases = happyPhases(batches, {
      workflowAudit: async () => ({
        approved: false,
        issues: ['batch 1 has unresolved blocking findings: finding-9'],
      }),
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(result.status).toBe('HUMAN_DECISION_REQUIRED');
    expect(result.stopDetails).toContain('finding-9');
  });

  it('retains an immutable per-batch completion summary for the final report', async () => {
    await makeRunner(happyPhases(batches)).run(WORKFLOW_ID);
    const state = runnerStore.require(WORKFLOW_ID);
    expect(state.counters.completedBatches).toHaveLength(2);
    const first = state.counters.completedBatches[0];
    expect(first).toMatchObject({
      ordinal: 1,
      batchId: 'batch-1',
      planReviewRounds: 1,
      codeReviewRounds: 1,
      correctionPasses: 0,
      finalAudits: 1,
    });
    expect(first?.pushedCommitSha).toBe(git.headSha());
  });

  it('stops with COST_BUDGET_REACHED from the audited cost, failures included', async () => {
    const workflowStore = new ReviewWorkflowStore(db);
    workflowStore.recordInvocationAudit({
      invocationId: 'audit-cost',
      workflowId: WORKFLOW_ID,
      batchId: 'batch-1',
      commandId: 'command-cost',
      actorExecutionId: 'actor',
      adapterKind: 'CLAUDE',
      configuredModel: 'claude-supported',
      vendorSessionId: 'unknown',
      sessionOutcome: 'NONE',
      prompt: 'p',
      promptHash: 'h'.repeat(64),
      response: '',
      responseHash: 'h'.repeat(64),
      redactionCount: 0,
      failure: { classification: 'OTHER', message: 'timed out' },
      costUsd: 30,
      startedAt: NOW,
      finishedAt: NOW,
      durationMs: 10,
      resultStatus: 'FAILED',
      createdAt: NOW,
    });
    const result = await makeRunner(happyPhases(batches)).run(WORKFLOW_ID);
    expect(result.stopReason).toBe('COST_BUDGET_REACHED');
  });

  it('classifies authentication failures as AUTHENTICATION_REQUIRED', async () => {
    const phases = happyPhases(batches, {
      implement: async () => {
        throw new Error('Claude CLI subprocess exited with code 1: Invalid API key');
      },
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(result.stopReason).toBe('AUTHENTICATION_REQUIRED');
  });

  it('refuses to run while another live worker holds the lease', async () => {
    expect(runnerStore.acquireLease(WORKFLOW_ID, 'other-worker', 3600)).toBe(true);
    await expect(
      makeRunner(happyPhases(batches), {}, { workerId: 'this-worker' }).run(WORKFLOW_ID),
    ).rejects.toThrow(/held by another live worker/);
    // After the other lease expires, this worker takes over.
    clockNow = new Date(Date.parse(NOW) + 3_700_000);
    const result = await makeRunner(happyPhases(batches), {}, { workerId: 'this-worker' }).run(
      WORKFLOW_ID,
    );
    expect(result.status).toBe('READY_FOR_HUMAN_VERIFICATION');
  });

  it('re-enters a restarted batch at the domain-derived stage without repeating phases', async () => {
    const phases = happyPhases([{ ordinal: 1, batchId: 'batch-1' }], {
      resumeStage: async () => 'VERIFICATION',
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(result.status).toBe('READY_FOR_HUMAN_VERIFICATION');
    expect(phases.calls.some((call) => call.startsWith('implement'))).toBe(false);
    expect(phases.calls.some((call) => call.startsWith('code-review'))).toBe(false);
    expect(phases.calls.some((call) => call.startsWith('verify'))).toBe(true);
  });

  it('validates decisions: single pending, known findings, and contract capacity', async () => {
    const singleBatch: RunnerBatchDescriptor[] = [{ ordinal: 1, batchId: 'batch-1' }];
    const blocked = happyPhases(singleBatch, {
      reviewCode: async () => ({ approved: false, blockingFindingIds: ['finding-1'] }),
    });
    const contract = { maxCodeReviewRounds: 2, maxCorrectionPasses: 1 };
    const runner = makeRunner(blocked, {}, { contract });
    const first = await runner.run(WORKFLOW_ID);
    expect(['CODE_REVIEW_LIMIT_REACHED', 'CORRECTION_LIMIT_REACHED']).toContain(first.stopReason);

    // ACCEPT_RISK may only name the recorded unresolved blocking set.
    expect(() =>
      runner.decide({
        workflowId: WORKFLOW_ID,
        action: 'ACCEPT_RISK_AND_CONTINUE',
        actor: 'roy',
        rationale: 'accept',
        findingIds: ['finding-unknown'],
      }),
    ).toThrow(/must name only unresolved blocking findings/);

    const decision = runner.decide({
      workflowId: WORKFLOW_ID,
      action: 'ACCEPT_RISK_AND_CONTINUE',
      actor: 'roy',
      rationale: 'accepted for release',
      findingIds: ['finding-1'],
    });
    expect(decision.commitSha).toBe(git.headSha());

    // Only one decision may be pending at a time.
    expect(() =>
      runner.decide({
        workflowId: WORKFLOW_ID,
        action: 'CANCEL_WORKFLOW',
        actor: 'roy',
        rationale: 'cancel too',
      }),
    ).toThrow(/already has an unconsumed/);

    // Consuming the decision applies it to the DOMAIN state before any phase runs.
    await runner.run(WORKFLOW_ID);
    expect(blocked.calls).toContain('apply-decision:1:ACCEPT_RISK_AND_CONTINUE');
  });

  it('FIX_AGAIN is always available and applies a kernel-granted extra round', async () => {
    const singleBatch: RunnerBatchDescriptor[] = [{ ordinal: 1, batchId: 'batch-1' }];
    let granted = 0;
    let reviews = 0;
    const blocked = happyPhases(singleBatch, {
      reviewCode: async () => {
        reviews += 1;
        // Approved only on the human-granted extra round.
        return granted > 0
          ? { approved: true, blockingFindingIds: [] }
          : { approved: false, blockingFindingIds: ['finding-1'] };
      },
      usedPacing: async () => ({
        planReviewRounds: 0,
        codeReviewRounds: reviews,
        correctionPasses: 0,
        grantedReviewRounds: granted,
        grantedCorrectionPasses: granted,
      }),
      applyDecision: async (_batch, action) => {
        if (action === 'FIX_AGAIN') granted += 1;
      },
    });
    const contract = { maxCodeReviewRounds: 1, maxCorrectionPasses: 1 };
    const runner = makeRunner(blocked, { maxCodeReviewRoundsPerBatch: 1 }, { contract });
    const first = await runner.run(WORKFLOW_ID);
    expect(first.stopReason).toBe('CODE_REVIEW_LIMIT_REACHED');
    // FIX_AGAIN is never refused; the grant extends the coordinator contract by one round.
    runner.decide({
      workflowId: WORKFLOW_ID,
      action: 'FIX_AGAIN',
      actor: 'roy',
      rationale: 'one more round',
    });
    const resumed = await runner.run(WORKFLOW_ID);
    expect(resumed.status).toBe('READY_FOR_HUMAN_VERIFICATION');
    expect(reviews).toBe(2);
  });

  it('invalidates a pending decision when HEAD moved past its recorded SHA', async () => {
    const singleBatch: RunnerBatchDescriptor[] = [{ ordinal: 1, batchId: 'batch-1' }];
    const blocked = happyPhases(singleBatch, {
      reviewCode: async () => ({ approved: false, blockingFindingIds: ['finding-1'] }),
    });
    const runner = makeRunner(blocked, { maxCorrectionPassesPerBatch: 0 });
    await runner.run(WORKFLOW_ID);
    runner.decide({
      workflowId: WORKFLOW_ID,
      action: 'ACCEPT_RISK_AND_CONTINUE',
      actor: 'roy',
      rationale: 'accept',
      findingIds: ['finding-1'],
    });
    git.head = 'c'.repeat(40); // the repository moved after the decision was recorded
    const resumed = await runner.run(WORKFLOW_ID);
    expect(resumed.status).toBe('HUMAN_DECISION_REQUIRED');
    expect(resumed.stopDetails).toContain('decide again on the current commit');
  });

  it('persists WORKER_HEARTBEAT_EXPIRED and notifies once when reconciling a stalled run', async () => {
    runnerStore.update(WORKFLOW_ID, {
      status: 'RUNNING',
      lastHeartbeatAt: NOW,
      workerId: 'dead-worker',
      leaseExpiresAt: new Date(Date.parse(NOW) + 60_000).toISOString(),
    });
    const runner = makeRunner(happyPhases(batches));
    // While the lease is live, an observer never disturbs the worker.
    clockNow = new Date(Date.parse(NOW) + 30_000);
    expect(runner.reconcileStalled(WORKFLOW_ID).status).toBe('RUNNING');
    // Heartbeat AND lease expired: the stall is persisted and notified exactly once.
    clockNow = new Date(Date.parse(NOW) + 300_000);
    const stalled = runner.reconcileStalled(WORKFLOW_ID);
    expect(stalled.status).toBe('HUMAN_DECISION_REQUIRED');
    expect(stalled.stopReason).toBe('WORKER_HEARTBEAT_EXPIRED');
    expect(notifications).toHaveLength(1);
    expect(runner.reconcileStalled(WORKFLOW_ID).stopReason).toBe('WORKER_HEARTBEAT_EXPIRED');
    expect(notifications).toHaveLength(1);
  });

  it('never reports READY when workflow-level verification dirtied the worktree', async () => {
    const phases = happyPhases(batches, {
      workflowAudit: async () => {
        // A zero-exit verification command wrote a file: outcome ok, tree dirty.
        git.clean = false;
        return { approved: true, issues: [] };
      },
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(result.status).toBe('HUMAN_DECISION_REQUIRED');
    expect(result.stopDetails).toContain('preserved for inspection');
    expect(runnerStore.require(WORKFLOW_ID).status).not.toBe('READY_FOR_HUMAN_VERIFICATION');
  });

  it('pauses gracefully after the current action and resumes from the next unfinished one', async () => {
    const singleBatch: RunnerBatchDescriptor[] = [{ ordinal: 1, batchId: 'batch-1' }];
    let implementations = 0;
    const phases = happyPhases(singleBatch, {
      implement: async () => {
        // A concurrent `workflow pause` lands while this atomic action is running: the
        // action still completes and settles before anything new is scheduled.
        runnerStore.update(WORKFLOW_ID, { status: 'PAUSE_REQUESTED' });
        implementations += 1;
        return { commitSha: 'b'.repeat(40) };
      },
      resumeStage: async () => (implementations > 0 ? 'CODE_REVIEW' : 'PLAN_REVIEW'),
    });
    const runner = makeRunner(phases);
    const paused = await runner.run(WORKFLOW_ID);
    expect(paused.status).toBe('PAUSED_BY_USER');
    const pausedState = runnerStore.require(WORKFLOW_ID);
    expect(pausedState.status).toBe('PAUSED_BY_USER');
    // The in-flight action completed; the completed plan review's counter survived;
    // nothing later was scheduled.
    expect(pausedState.counters.batch?.planReviewRounds).toBe(1);
    expect(implementations).toBe(1);
    expect(phases.calls.filter((call) => call.startsWith('plan-review'))).toHaveLength(1);
    expect(phases.calls.some((call) => call.startsWith('code-review'))).toBe(false);

    // A paused workflow never continues through a bare worker start.
    expect((await runner.run(WORKFLOW_ID)).status).toBe('PAUSED_BY_USER');
    expect(phases.calls.some((call) => call.startsWith('code-review'))).toBe(false);

    // The public resume flow flips the durable status, then the worker continues from the
    // next unfinished action — completed phases are never rerun.
    runnerStore.update(WORKFLOW_ID, { status: 'RUNNING' });
    const resumed = await runner.run(WORKFLOW_ID);
    expect(resumed.status).toBe('READY_FOR_HUMAN_VERIFICATION');
    expect(phases.calls.filter((call) => call.startsWith('plan-review'))).toHaveLength(1);
    expect(implementations).toBe(1);
    expect(phases.calls.filter((call) => call.startsWith('code-review'))).toHaveLength(1);
    // Counters and limits were preserved, never reset.
    const final = runnerStore.require(WORKFLOW_ID);
    expect(final.counters.completedBatches[0]?.planReviewRounds).toBe(1);
  });

  it('stops with OUTCOME_UNKNOWN for a crashed in-flight invocation and never repeats it', async () => {
    const phases = happyPhases(batches);
    runnerStore.update(WORKFLOW_ID, {
      activeInvocation: {
        invocationId: 'invocation-crashed',
        role: 'IMPLEMENTER',
        adapterKind: 'CLAUDE',
        model: 'claude-supported',
        phase: 'IMPLEMENTATION',
        startedAt: NOW,
        stage: 'AGENT_RUNNING',
      },
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    expect(result.stopReason).toBe('OUTCOME_UNKNOWN');
    expect(result.stopDetails).toContain('invocation-crashed');
    // No phase ran at all — an uncertain agent invocation is never automatically repeated.
    expect(phases.calls).toHaveLength(0);

    // Explicit human reconciliation clears the uncertainty and the workflow continues.
    const runner = makeRunner(phases);
    runner.decide({
      workflowId: WORKFLOW_ID,
      action: 'FIX_AGAIN',
      actor: 'roy',
      rationale: 'Verified externally: the crashed invocation produced no commit.',
    });
    const resumed = await runner.run(WORKFLOW_ID);
    expect(resumed.status).toBe('READY_FOR_HUMAN_VERIFICATION');
    expect(runnerStore.require(WORKFLOW_ID).activeInvocation).toBeUndefined();
  });

  it('derives PAUSING, PAUSED_BY_USER, RESUMING, and OUTCOME_UNKNOWN observed statuses', () => {
    const base = runnerStore.require(WORKFLOW_ID);
    expect(deriveObservedStatus({ ...base, status: 'PAUSE_REQUESTED' }, 120, clockNow).status).toBe(
      'PAUSING',
    );
    expect(deriveObservedStatus({ ...base, status: 'PAUSED_BY_USER' }, 120, clockNow).status).toBe(
      'PAUSED_BY_USER',
    );
    expect(
      deriveObservedStatus({ ...base, status: 'RUNNING', phase: 'RESUMING' }, 120, clockNow).status,
    ).toBe('RESUMING');
    expect(
      deriveObservedStatus(
        { ...base, status: 'HUMAN_DECISION_REQUIRED', stopReason: 'OUTCOME_UNKNOWN' },
        120,
        clockNow,
      ).status,
    ).toBe('OUTCOME_UNKNOWN');
  });

  it('safely restarts an invocation that was reserved but whose agent never spawned', async () => {
    const phases = happyPhases(batches);
    runnerStore.update(WORKFLOW_ID, {
      activeInvocation: {
        invocationId: 'invocation-never-started',
        role: 'IMPLEMENTER',
        adapterKind: 'CLAUDE',
        model: 'claude-supported',
        phase: 'IMPLEMENTATION',
        startedAt: NOW,
        stage: 'PREPARING',
      },
    });
    const result = await makeRunner(phases).run(WORKFLOW_ID);
    // Nothing external ever ran: the workflow continues normally to completion.
    expect(result.status).toBe('READY_FOR_HUMAN_VERIFICATION');
    expect(runnerStore.require(WORKFLOW_ID).activeInvocation).toBeUndefined();
  });

  it('a pause arriving during the terminal workflow audit settles as PAUSED, never READY', async () => {
    const phases = happyPhases(batches, {
      workflowAudit: async () => {
        // The pause command lands while the final atomic action is running.
        runnerStore.update(WORKFLOW_ID, { status: 'PAUSE_REQUESTED' });
        return { approved: true, issues: [] };
      },
    });
    const runner = makeRunner(phases);
    const result = await runner.run(WORKFLOW_ID);
    expect(result.status).toBe('PAUSED_BY_USER');
    expect(runnerStore.require(WORKFLOW_ID).status).toBe('PAUSED_BY_USER');

    // Resume completes without repeating the batches.
    runnerStore.update(WORKFLOW_ID, { status: 'RUNNING' });
    const resumed = await makeRunner(happyPhases(batches)).run(WORKFLOW_ID);
    expect(resumed.status).toBe('READY_FOR_HUMAN_VERIFICATION');
  });

  it('refuses to resume when HEAD or the worktree changed while paused', async () => {
    let implementations = 0;
    const phases = happyPhases([{ ordinal: 1, batchId: 'batch-1' }], {
      implement: async () => {
        runnerStore.update(WORKFLOW_ID, { status: 'PAUSE_REQUESTED' });
        implementations += 1;
        return { commitSha: 'b'.repeat(40) };
      },
      resumeStage: async () => (implementations > 0 ? 'CODE_REVIEW' : 'PLAN_REVIEW'),
    });
    const runner = makeRunner(phases);
    expect((await runner.run(WORKFLOW_ID)).status).toBe('PAUSED_BY_USER');
    const paused = runnerStore.require(WORKFLOW_ID);
    expect(paused.pausedRepo?.headSha).toBe(git.headSha());

    // Someone commits (or dirties the tree) while the workflow is paused.
    git.head = 'e'.repeat(40);
    git.fingerprint = 'tampered-tree';
    runnerStore.update(WORKFLOW_ID, { status: 'RUNNING' });
    const drifted = await runner.run(WORKFLOW_ID);
    expect(drifted.status).toBe('HUMAN_DECISION_REQUIRED');
    expect(drifted.stopDetails).toContain('changed while paused');
    // The drifted repository was preserved untouched for inspection.
    expect(git.head).toBe('e'.repeat(40));
  });

  it('a pause request racing an already-successful READY always loses', () => {
    // The reverse race: READY landed first; a stale pause command's write must no-op.
    runnerStore.markReady(WORKFLOW_ID);
    expect(runnerStore.requestPause(WORKFLOW_ID)).toBe(false);
    expect(
      runnerStore.settleRequestedPause(WORKFLOW_ID, {
        headSha: 'a'.repeat(40),
        clean: true,
        statusFingerprint: 'fp',
      }),
    ).toBe(false);
    expect(runnerStore.require(WORKFLOW_ID).status).toBe('READY_FOR_HUMAN_VERIFICATION');
  });

  it('the terminal READY write is conditional: a pause request always wins the race', () => {
    // markReady only succeeds while RUNNING — the exact interleaving where a pause lands
    // between the completion checks and the READY write is impossible by construction.
    runnerStore.update(WORKFLOW_ID, { status: 'PAUSE_REQUESTED' });
    expect(runnerStore.markReady(WORKFLOW_ID)).toBe(false);
    expect(runnerStore.require(WORKFLOW_ID).status).toBe('PAUSE_REQUESTED');
    runnerStore.update(WORKFLOW_ID, { status: 'RUNNING' });
    expect(runnerStore.markReady(WORKFLOW_ID)).toBe(true);
    expect(runnerStore.require(WORKFLOW_ID).status).toBe('READY_FOR_HUMAN_VERIFICATION');
  });
});
