import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowCommandStore } from '../../../src/memory/review-workflow-command-store.js';
import { ReviewWorkflowJobService } from '../../../src/review-workflow-jobs/service.js';
import { ReviewWorkflowJobStore } from '../../../src/review-workflow-jobs/store.js';
import {
  ReviewWorkflowJobError,
  deriveExpectedReceipt,
} from '../../../src/review-workflow-jobs/types.js';
import { transitionBatch } from '../../../src/review-workflow/state-machine.js';
import type {
  ActorExecutionIdentity,
  AgentAssignment,
  ReviewWorkflowBatch,
  StateChangingCommandRequest,
  TransitionCommand,
  WorkflowRun,
} from '../../../src/review-workflow/types.js';

const NOW = '2026-07-31T12:00:00.000Z';
const WORKFLOW_ID = 'workflow-13';
const OTHER_WORKFLOW_ID = 'workflow-other';
const BATCH_ID = 'batch-13';
const COMMAND_ID = `${BATCH_ID}:verify:1`;

function assignmentFixture(role: 'IMPLEMENTER' | 'REVIEWER'): AgentAssignment {
  const implementer = role === 'IMPLEMENTER';
  return {
    assignmentId: implementer ? 'assignment-implementer' : 'assignment-reviewer',
    workflowId: WORKFLOW_ID,
    assignedRole: role,
    configuredAgentKey: implementer ? 'implementer' : 'reviewer',
    configuredModelAlias: implementer ? 'implementer' : 'reviewer',
    expectedAdapterKind: implementer ? 'CLAUDE' : 'CODEX',
    provider: implementer ? 'anthropic' : 'openai',
    configuredModel: implementer ? 'claude-supported' : 'codex-supported',
    commitPermission: implementer ? 'AUTHORIZED' : 'DENIED',
    configurationHash: 'configuration-hash',
    assignedAt: NOW,
  };
}

/** Schema-valid START_CODE_REVIEW guard vocabulary, matching what real operations reserve. */
function guardCommand(): TransitionCommand {
  return {
    type: 'START_CODE_REVIEW',
    evidence: {
      reviewedCommitSha: 'a'.repeat(40),
      currentHeadSha: 'a'.repeat(40),
      cleanWorktree: true,
      unresolvedFindingCount: 0,
      incompleteDispositionCount: 0,
      roleSeparation: {
        implementerAssignment: assignmentFixture('IMPLEMENTER'),
        reviewerAssignment: assignmentFixture('REVIEWER'),
        minimumIdentityAssurance: 'PROCESS_ATTESTED',
      },
    },
  };
}

function hashOf(value: unknown): string {
  return 'c'.repeat(64) + (JSON.stringify(value)?.length ?? 0);
}

describe('ReviewWorkflowJobService', () => {
  let db: Database.Database;
  let jobStore: ReviewWorkflowJobStore;
  let commandStore: ReviewWorkflowCommandStore;
  let service: ReviewWorkflowJobService;
  let clockNow: Date;

  function requester(commandId: string): ActorExecutionIdentity {
    return {
      actorExecutionId: `${commandId}:requester`,
      actorType: 'HUMAN',
      authoritiesExercised: ['WORKFLOW_OWNER'],
      identityAssurance: 'CLI_ASSERTED',
      observedEvidence: [],
      startedAt: NOW,
    };
  }

  function commandRequest(
    commandId: string,
    command: TransitionCommand,
    batchId = BATCH_ID,
    workflowId = WORKFLOW_ID,
  ): StateChangingCommandRequest {
    const request = {
      commandId,
      workflowId,
      batchId,
      expectedAggregateVersion: 0,
      requester: requester(commandId),
      authorityExercised: 'WORKFLOW_OWNER' as const,
      command,
    };
    return { ...request, canonicalRequestHash: hashOf(request) };
  }

  function createWorkflowRow(workflowId: string): void {
    const workflow: WorkflowRun = {
      workflowId,
      status: 'ACTIVE',
      generalPlanVersionId: `${workflowId}:general-plan`,
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      configurationHash: 'configuration-hash',
      createdAt: NOW,
      updatedAt: NOW,
    };
    jobStore.workflowStore.createWorkflow(workflow);
  }

  function createBatchRow(batchId: string, ordinal: number, workflowId = WORKFLOW_ID): void {
    const batch: ReviewWorkflowBatch = {
      batchId,
      workflowId,
      ordinal,
      persistedState: 'DRAFT',
      aggregateVersion: 0,
      currentPlanVersionId: `${batchId}:plan:1`,
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      createdAt: NOW,
      updatedAt: NOW,
    };
    jobStore.workflowStore.createBatch(batch);
  }

  /**
   * Reserves the fixture receipt the way a real verification operation would: the
   * START_CODE_REVIEW guard vocabulary with a claimed VERIFICATION_EXECUTION side effect
   * under the derived record identity, optionally completed.
   */
  function reserveFixtureReceipt(options?: {
    readonly commandId?: string;
    readonly batchId?: string;
    readonly workflowId?: string;
    readonly command?: TransitionCommand;
    readonly sideEffectKind?: 'VERIFICATION_EXECUTION' | 'AGENT_INVOCATION';
    readonly sideEffectIdentity?: string;
    readonly complete?: 'SUCCEEDED' | 'FAILED_FINAL';
    readonly result?: unknown;
  }): void {
    const commandId = options?.commandId ?? COMMAND_ID;
    commandStore.reserve(
      commandRequest(
        commandId,
        options?.command ?? guardCommand(),
        options?.batchId ?? BATCH_ID,
        options?.workflowId ?? WORKFLOW_ID,
      ),
      options?.sideEffectKind ?? 'VERIFICATION_EXECUTION',
    );
    commandStore.claimSideEffect(commandId, options?.sideEffectIdentity ?? `${commandId}:record`);
    if (options?.complete === 'SUCCEEDED') {
      commandStore.succeedWithoutTransition({
        commandId,
        resultHash: hashOf('done'),
        result: options.result ?? { observedStatus: 'SUCCEEDED' },
      });
    }
    if (options?.complete === 'FAILED_FINAL') {
      commandStore.recordOutcome({
        commandId,
        status: 'FAILED_FINAL',
        errorCode: 'VERIFICATION_EXECUTION_FAILED',
      });
    }
  }

  /** Produces one real persisted workflow event via a kernel-derived BLOCK_BATCH transition. */
  function emitBlockedEvent(batchId: string, commandId: string): void {
    const command: TransitionCommand = { type: 'BLOCK_BATCH', reason: 'Fixture event' };
    commandStore.reserve(commandRequest(commandId, command, batchId));
    const transition = transitionBatch({
      currentState: 'DRAFT',
      command,
      actor: requester(commandId),
    });
    if (!transition.allowed) throw new Error('Fixture transition rejected');
    commandStore.succeedWithTransition({
      commandId,
      transition,
      eventType: 'BATCH_BLOCKED',
      eventPayload: { reason: 'Fixture event' },
      resultHash: hashOf(commandId),
    });
  }

  beforeEach(() => {
    clockNow = new Date(NOW);
    db = openDatabase(':memory:');
    jobStore = new ReviewWorkflowJobStore(db, () => clockNow);
    commandStore = new ReviewWorkflowCommandStore(db, () => clockNow);
    service = new ReviewWorkflowJobService(jobStore, commandStore);
    createWorkflowRow(WORKFLOW_ID);
    createBatchRow(BATCH_ID, 13);
  });

  afterEach(() => {
    db.close();
  });

  function enqueueJob(overrides?: {
    readonly jobId?: string;
    readonly commandId?: string;
    readonly maxAttempts?: number;
    readonly jobType?: 'VERIFICATION' | 'CODE_REVIEW' | 'FINAL_AUDIT';
  }) {
    return service.enqueue({
      jobId: overrides?.jobId ?? 'job-1',
      workflowId: WORKFLOW_ID,
      batchId: BATCH_ID,
      jobType: overrides?.jobType ?? 'VERIFICATION',
      commandId: overrides?.commandId ?? COMMAND_ID,
      payload: { ordinal: 13, command: 1, timeout: 600 },
      ...(overrides?.maxAttempts === undefined ? {} : { maxAttempts: overrides.maxAttempts }),
    });
  }

  /** An executor behaving like a real operation: reserve, claim, complete, return. */
  function wellBehavedExecutor(result: unknown) {
    let calls = 0;
    return {
      calls: () => calls,
      executors: {
        VERIFICATION: async () => {
          calls += 1;
          reserveFixtureReceipt({ complete: 'SUCCEEDED', result });
          return result;
        },
      },
    };
  }

  it('executes a queued job and settles from the receipt the operation produced', async () => {
    enqueueJob();
    const executor = wellBehavedExecutor({ observedStatus: 'SUCCEEDED' });
    const result = await service.runNext({ workerId: 'worker-a', executors: executor.executors });
    expect(result.outcome).toBe('EXECUTED');
    if (result.outcome !== 'EXECUTED') return;
    expect(executor.calls()).toBe(1);
    expect(result.job.status).toBe('SUCCEEDED');
    expect(result.result).toEqual({ observedStatus: 'SUCCEEDED' });
    const idle = await service.runNext({ workerId: 'worker-a', executors: executor.executors });
    expect(idle.outcome).toBe('IDLE');
  });

  it('fails a job whose executor returned without producing any receipt', async () => {
    enqueueJob();
    const result = await service.runNext({
      workerId: 'worker-a',
      executors: { VERIFICATION: async () => ({ claimed: 'success' }) },
    });
    expect(result.outcome).toBe('FAILED');
    if (result.outcome !== 'FAILED') return;
    expect(result.job.status).toBe('FAILED');
    expect(result.job.errorCode).toBe('RECEIPT_MISSING');
  });

  it('reports failure when the executor returned normally but the receipt is FAILED_FINAL', async () => {
    enqueueJob();
    const result = await service.runNext({
      workerId: 'worker-a',
      executors: {
        VERIFICATION: async () => {
          // Mirrors the code-review/final-audit rejection paths: the service records a
          // final failure on the receipt and returns normally.
          reserveFixtureReceipt({ complete: 'FAILED_FINAL' });
          return { looksSuccessful: true };
        },
      },
    });
    expect(result.outcome).toBe('FAILED');
    if (result.outcome !== 'FAILED') return;
    expect(result.job.errorCode).toBe('VERIFICATION_EXECUTION_FAILED');
  });

  it('succeeds from the receipt even when the executor threw after completing it', async () => {
    enqueueJob();
    const result = await service.runNext({
      workerId: 'worker-a',
      executors: {
        VERIFICATION: async () => {
          reserveFixtureReceipt({ complete: 'SUCCEEDED', result: { recovered: true } });
          throw new Error('Crash after the durable outcome was recorded');
        },
      },
    });
    expect(result.outcome).toBe('EXECUTED');
    if (result.outcome !== 'EXECUTED') return;
    expect(result.job.status).toBe('SUCCEEDED');
    expect(result.result).toEqual({ recovered: true });
  });

  it('reconciles instead of retrying when a throw left the receipt reserved', async () => {
    enqueueJob({ maxAttempts: 3 });
    const result = await service.runNext({
      workerId: 'worker-a',
      executors: {
        VERIFICATION: async () => {
          reserveFixtureReceipt();
          throw new Error('Crash mid-invocation');
        },
      },
    });
    expect(result.outcome).toBe('RECONCILED_UNKNOWN');
    if (result.outcome !== 'RECONCILED_UNKNOWN') return;
    expect(result.job.status).toBe('FAILED');
    expect(result.job.errorCode).toBe('OUTCOME_UNKNOWN');
    expect(commandStore.get(COMMAND_ID)?.receipt.status).toBe('OUTCOME_UNKNOWN');
  });

  it('replays a completed matching receipt without calling any executor', async () => {
    reserveFixtureReceipt({
      complete: 'SUCCEEDED',
      result: { verificationRecordId: `${COMMAND_ID}:record`, observedStatus: 'SUCCEEDED' },
    });
    enqueueJob();
    let executorCalls = 0;
    const result = await service.runNext({
      workerId: 'worker-a',
      executors: {
        VERIFICATION: async () => {
          executorCalls += 1;
          return {};
        },
      },
    });
    expect(result.outcome).toBe('REPLAYED');
    if (result.outcome !== 'REPLAYED') return;
    expect(executorCalls).toBe(0);
    expect(result.job.status).toBe('SUCCEEDED');
    expect(result.result).toEqual({
      verificationRecordId: `${COMMAND_ID}:record`,
      observedStatus: 'SUCCEEDED',
    });
  });

  it('derives distinct durable identities per job type, never caller-supplied', () => {
    const verification = deriveExpectedReceipt('VERIFICATION', 'command-x');
    const codeReview = deriveExpectedReceipt('CODE_REVIEW', 'command-x');
    const finalAudit = deriveExpectedReceipt('FINAL_AUDIT', 'command-x');
    const identities = [verification, codeReview, finalAudit].map((identity) =>
      JSON.stringify(identity),
    );
    expect(new Set(identities).size).toBe(3);
    // The persisted job carries the derived identity — enqueue accepts no identity input.
    const job = enqueueJob();
    expect(job.expectedReceipt).toEqual(deriveExpectedReceipt('VERIFICATION', COMMAND_ID));
  });

  it('never settles from a receipt that does not match the job identity', async () => {
    createWorkflowRow(OTHER_WORKFLOW_ID);
    createBatchRow('batch-other', 1, OTHER_WORKFLOW_ID);
    createBatchRow('batch-14', 14);
    const cases: readonly {
      readonly name: string;
      readonly jobId: string;
      readonly commandId: string;
      readonly jobType?: 'VERIFICATION' | 'CODE_REVIEW' | 'FINAL_AUDIT';
      readonly reserve: (commandId: string) => void;
    }[] = [
      {
        name: 'cross-workflow receipt',
        jobId: 'job-xw',
        commandId: 'command-xw',
        reserve: (commandId) =>
          reserveFixtureReceipt({
            commandId,
            workflowId: OTHER_WORKFLOW_ID,
            batchId: 'batch-other',
            complete: 'SUCCEEDED',
          }),
      },
      {
        name: 'cross-batch receipt',
        jobId: 'job-xb',
        commandId: 'command-xb',
        reserve: (commandId) =>
          reserveFixtureReceipt({ commandId, batchId: 'batch-14', complete: 'SUCCEEDED' }),
      },
      {
        name: 'wrong command vocabulary (a BLOCK_BATCH receipt is never a job outcome)',
        jobId: 'job-xc',
        commandId: 'command-xc',
        reserve: (commandId) =>
          reserveFixtureReceipt({
            commandId,
            command: { type: 'BLOCK_BATCH', reason: 'Occupies the receipt' },
            complete: 'SUCCEEDED',
          }),
      },
      {
        name: 'wrong side-effect kind',
        jobId: 'job-xk',
        commandId: 'command-xk',
        reserve: (commandId) =>
          reserveFixtureReceipt({
            commandId,
            sideEffectKind: 'AGENT_INVOCATION',
            sideEffectIdentity: `${commandId}:record`,
            complete: 'SUCCEEDED',
          }),
      },
      {
        name: 'wrong side-effect identity',
        jobId: 'job-xi',
        commandId: 'command-xi',
        reserve: (commandId) =>
          reserveFixtureReceipt({
            commandId,
            sideEffectIdentity: 'someone-elses-identity',
            complete: 'SUCCEEDED',
          }),
      },
      {
        name: 'cross-job-type: a final-audit receipt never settles a code-review job',
        jobId: 'job-xt',
        commandId: 'command-xt',
        jobType: 'CODE_REVIEW',
        reserve: (commandId) =>
          reserveFixtureReceipt({
            commandId,
            sideEffectKind: 'AGENT_INVOCATION',
            sideEffectIdentity: `${commandId}:final-audit-invocation`,
            complete: 'SUCCEEDED',
          }),
      },
      {
        name: 'cross-job-type: a code-review receipt never settles a final-audit job',
        jobId: 'job-xt2',
        commandId: 'command-xt2',
        jobType: 'FINAL_AUDIT',
        reserve: (commandId) =>
          reserveFixtureReceipt({
            commandId,
            sideEffectKind: 'AGENT_INVOCATION',
            sideEffectIdentity: `${commandId}:code-review-invocation`,
            complete: 'SUCCEEDED',
          }),
      },
    ];
    for (const testCase of cases) {
      testCase.reserve(testCase.commandId);
      enqueueJob({
        jobId: testCase.jobId,
        commandId: testCase.commandId,
        ...(testCase.jobType === undefined ? {} : { jobType: testCase.jobType }),
      });
      let executorCalls = 0;
      const executor = async () => {
        executorCalls += 1;
        return {};
      };
      const result = await service.runNext({
        workerId: 'worker-a',
        executors: { VERIFICATION: executor, CODE_REVIEW: executor, FINAL_AUDIT: executor },
      });
      expect(result.outcome, testCase.name).toBe('FAILED');
      if (result.outcome !== 'FAILED') return;
      expect(executorCalls, testCase.name).toBe(0);
      expect(result.job.errorCode, testCase.name).toBe('RECEIPT_MISMATCH');
    }
  });

  it('never repeats an invocation whose reservation was lost mid-flight', async () => {
    reserveFixtureReceipt();
    enqueueJob();
    let executorCalls = 0;
    const result = await service.runNext({
      workerId: 'worker-b',
      executors: {
        VERIFICATION: async () => {
          executorCalls += 1;
          return {};
        },
      },
    });
    expect(result.outcome).toBe('RECONCILED_UNKNOWN');
    if (result.outcome !== 'RECONCILED_UNKNOWN') return;
    expect(executorCalls).toBe(0);
    expect(result.job.status).toBe('FAILED');
    expect(result.job.errorCode).toBe('OUTCOME_UNKNOWN');
    expect(commandStore.get(COMMAND_ID)?.receipt.status).toBe('OUTCOME_UNKNOWN');
  });

  it('marks the job failed when the receipt finished unsuccessfully before the claim', async () => {
    reserveFixtureReceipt({ complete: 'FAILED_FINAL' });
    enqueueJob();
    const result = await service.runNext({
      workerId: 'worker-a',
      executors: { VERIFICATION: async () => ({}) },
    });
    expect(result.outcome).toBe('FAILED');
    if (result.outcome !== 'FAILED') return;
    expect(result.job.errorCode).toBe('VERIFICATION_EXECUTION_FAILED');
  });

  it('requeues a receiptless failure only while attempts remain, then exhausts', async () => {
    enqueueJob({ maxAttempts: 2 });
    const failing = {
      VERIFICATION: async () => {
        throw new Error('Transient failure before any reservation');
      },
    };
    const first = await service.runNext({ workerId: 'worker-a', executors: failing });
    expect(first.outcome).toBe('RETRY_SCHEDULED');
    if (first.outcome !== 'RETRY_SCHEDULED') return;
    expect(first.job.status).toBe('QUEUED');
    expect(first.job.attemptCount).toBe(1);
    const second = await service.runNext({ workerId: 'worker-a', executors: failing });
    expect(second.outcome).toBe('FAILED');
    if (second.outcome !== 'FAILED') return;
    expect(second.job.status).toBe('FAILED');
    expect(second.job.attemptCount).toBe(2);
    const idle = await service.runNext({ workerId: 'worker-a', executors: failing });
    expect(idle.outcome).toBe('IDLE');
  });

  it('lets a second worker reclaim an expired job and settle from its fresh execution', async () => {
    enqueueJob({ maxAttempts: 3 });
    const claimed = jobStore.claimNext('worker-a', 60);
    expect(claimed?.status).toBe('RUNNING');
    expect(jobStore.claimNext('worker-b', 60)).toBeNull();
    clockNow = new Date('2026-07-31T12:05:00.000Z');
    const executor = wellBehavedExecutor({ recovered: true });
    const result = await service.runNext({ workerId: 'worker-b', executors: executor.executors });
    expect(result.outcome).toBe('EXECUTED');
    if (result.outcome !== 'EXECUTED') return;
    expect(result.job.workerId).toBe('worker-b');
    expect(result.job.attemptCount).toBe(2);
  });

  describe('expired final attempts settle from the receipt alone', () => {
    async function claimFinalAttemptAndExpire(): Promise<void> {
      enqueueJob({ maxAttempts: 1 });
      const claimed = jobStore.claimNext('worker-a', 60);
      expect(claimed?.attemptCount).toBe(1);
      clockNow = new Date('2026-07-31T12:05:00.000Z');
    }

    it('fails terminally when no receipt exists, never re-invoking', async () => {
      await claimFinalAttemptAndExpire();
      let executorCalls = 0;
      const result = await service.runNext({
        workerId: 'worker-b',
        executors: {
          VERIFICATION: async () => {
            executorCalls += 1;
            return {};
          },
        },
      });
      expect(result.outcome).toBe('FAILED');
      if (result.outcome !== 'FAILED') return;
      expect(executorCalls).toBe(0);
      expect(result.job.errorCode).toBe('ATTEMPTS_EXHAUSTED');
      expect(result.job.status).toBe('FAILED');
    });

    it('replays a successful receipt', async () => {
      await claimFinalAttemptAndExpire();
      reserveFixtureReceipt({ complete: 'SUCCEEDED', result: { late: true } });
      const result = await service.runNext({ workerId: 'worker-b', executors: {} });
      expect(result.outcome).toBe('REPLAYED');
      if (result.outcome !== 'REPLAYED') return;
      expect(result.job.status).toBe('SUCCEEDED');
      expect(result.result).toEqual({ late: true });
    });

    it('reconciles a still-reserved receipt to OUTCOME_UNKNOWN', async () => {
      await claimFinalAttemptAndExpire();
      reserveFixtureReceipt();
      const result = await service.runNext({ workerId: 'worker-b', executors: {} });
      expect(result.outcome).toBe('RECONCILED_UNKNOWN');
      if (result.outcome !== 'RECONCILED_UNKNOWN') return;
      expect(commandStore.get(COMMAND_ID)?.receipt.status).toBe('OUTCOME_UNKNOWN');
    });

    it('surfaces a final-failure receipt', async () => {
      await claimFinalAttemptAndExpire();
      reserveFixtureReceipt({ complete: 'FAILED_FINAL' });
      const result = await service.runNext({ workerId: 'worker-b', executors: {} });
      expect(result.outcome).toBe('FAILED');
      if (result.outcome !== 'FAILED') return;
      expect(result.job.errorCode).toBe('VERIFICATION_EXECUTION_FAILED');
    });
  });

  it('requeues a missing-executor claim without consuming the attempt', async () => {
    // maxAttempts: 1 is the stranding case: if the claim consumed the attempt, the queued
    // job could never be claimed again.
    enqueueJob({ maxAttempts: 1 });
    await expect(service.runNext({ workerId: 'worker-a', executors: {} })).rejects.toThrowError(
      ReviewWorkflowJobError,
    );
    const job = jobStore.require('job-1');
    expect(job.status).toBe('QUEUED');
    expect(job.attemptCount).toBe(0);
    expect(job.errorCode).toBe('EXECUTOR_MISSING');
    // The job becomes executable as soon as an executor is registered.
    const executor = wellBehavedExecutor({ observedStatus: 'SUCCEEDED' });
    const result = await service.runNext({ workerId: 'worker-a', executors: executor.executors });
    expect(result.outcome).toBe('EXECUTED');
    if (result.outcome !== 'EXECUTED') return;
    expect(result.job.status).toBe('SUCCEEDED');
    expect(result.job.attemptCount).toBe(1);
  });

  it('cancels queued jobs and ignores a cancelled job’s late completion', async () => {
    enqueueJob();
    const cancelled = service.cancel('job-1');
    expect(cancelled.status).toBe('CANCELLED');
    expect(await service.runNext({ workerId: 'worker-a', executors: {} })).toEqual({
      outcome: 'IDLE',
    });
    expect(() => service.cancel('job-1')).toThrowError(ReviewWorkflowJobError);

    enqueueJob({ jobId: 'job-2', commandId: `${BATCH_ID}:verify:2` });
    const claimed = jobStore.claimNext('worker-a', 600);
    expect(claimed?.jobId).toBe('job-2');
    service.cancel('job-2');
    const late = jobStore.succeed('job-2', 'worker-a', { ignored: true });
    expect(late.status).toBe('CANCELLED');
    expect(late.result).toBeNull();
  });

  it('binds each command ID to exactly one job and each job ID to one record', () => {
    enqueueJob();
    expect(() => enqueueJob({ jobId: 'job-other' })).toThrowError(/already owned by another job/);
    expect(() => enqueueJob({ commandId: `${BATCH_ID}:verify:other` })).toThrowError(
      /already exists/,
    );
    expect(() =>
      service.enqueue({
        jobId: 'job-missing-batch',
        workflowId: WORKFLOW_ID,
        batchId: 'batch-unknown',
        jobType: 'VERIFICATION',
        commandId: 'command-unknown',
        payload: {},
      }),
    ).toThrowError(/does not belong to workflow/);
  });

  it('reads workflow events incrementally and advances a durable monotonic cursor', () => {
    createBatchRow('batch-14', 14);
    emitBlockedEvent(BATCH_ID, 'command-event-1');
    emitBlockedEvent('batch-14', 'command-event-2');

    const all = jobStore.listWorkflowEvents(WORKFLOW_ID);
    expect(all).toHaveLength(2);
    expect(all.map((event) => event.eventType)).toEqual(['BATCH_BLOCKED', 'BATCH_BLOCKED']);
    const firstEventId = all[0]?.eventId ?? 0;

    const page = jobStore.listWorkflowEvents(WORKFLOW_ID, 0, 1);
    expect(page).toHaveLength(1);
    const rest = jobStore.listWorkflowEvents(WORKFLOW_ID, firstEventId);
    expect(rest).toHaveLength(1);
    expect(rest[0]?.batchId).toBe('batch-14');

    const cursor = jobStore.advanceCursor({
      cursorId: 'consumer-1',
      workflowId: WORKFLOW_ID,
      lastEventId: firstEventId,
    });
    expect(cursor.lastEventId).toBe(firstEventId);
    expect(jobStore.listWorkflowEvents(WORKFLOW_ID, cursor.lastEventId)).toHaveLength(1);
    expect(() =>
      jobStore.advanceCursor({
        cursorId: 'consumer-1',
        workflowId: WORKFLOW_ID,
        lastEventId: firstEventId - 1,
      }),
    ).toThrowError(/cannot move backwards/);
    expect(() =>
      jobStore.advanceCursor({
        cursorId: 'consumer-1',
        workflowId: 'workflow-elsewhere',
        lastEventId: firstEventId + 5,
      }),
    ).toThrowError(/belongs to workflow/);
  });
});
