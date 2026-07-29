import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import {
  type NonTransitionCommandOutcomeStatus,
  ReviewWorkflowCommandStore,
} from '../../../src/memory/review-workflow-command-store.js';
import {
  ReviewWorkflowPersistenceError,
  ReviewWorkflowStore,
} from '../../../src/memory/review-workflow-store.js';
import { transitionBatch } from '../../../src/review-workflow/state-machine.js';
import type {
  ActorExecutionIdentity,
  AllowedTransition,
  ReviewWorkflowBatch,
  StateChangingCommandRequest,
  TransitionCommand,
  WorkflowRun,
} from '../../../src/review-workflow/types.js';

const NOW = '2026-07-29T00:00:00.000Z';
const SHA_A = 'a'.repeat(40);

const WORKFLOW: WorkflowRun = {
  workflowId: 'workflow-1',
  status: 'ACTIVE',
  generalPlanVersionId: 'general-plan-1',
  implementerAssignmentId: 'assignment-implementer',
  reviewerAssignmentId: 'assignment-reviewer',
  configurationHash: 'configuration-hash',
  createdAt: NOW,
  updatedAt: NOW,
};

const BATCH: ReviewWorkflowBatch = {
  batchId: 'batch-1',
  workflowId: WORKFLOW.workflowId,
  ordinal: 1,
  persistedState: 'DRAFT',
  aggregateVersion: 0,
  currentPlanVersionId: 'batch-plan-1',
  implementerAssignmentId: WORKFLOW.implementerAssignmentId,
  reviewerAssignmentId: WORKFLOW.reviewerAssignmentId,
  originalBatchBaseSha: SHA_A,
  createdAt: NOW,
  updatedAt: NOW,
};

const OWNER: ActorExecutionIdentity = {
  actorExecutionId: 'actor-owner',
  actorType: 'HUMAN',
  authoritiesExercised: ['WORKFLOW_OWNER'],
  identityAssurance: 'CLI_ASSERTED',
  observedEvidence: [],
  startedAt: NOW,
};

const PLAN_REFINER: ActorExecutionIdentity = {
  actorExecutionId: 'actor-plan-refiner',
  actorType: 'HUMAN',
  authoritiesExercised: ['PLAN_REFINER'],
  identityAssurance: 'CLI_ASSERTED',
  observedEvidence: [],
  startedAt: NOW,
};

function makeRequest(
  commandId: string,
  expectedAggregateVersion = 0,
  command: TransitionCommand = {
    type: 'BLOCK_BATCH',
    reason: 'Waiting for external evidence.',
  },
): StateChangingCommandRequest {
  return {
    commandId,
    workflowId: WORKFLOW.workflowId,
    batchId: BATCH.batchId,
    expectedAggregateVersion,
    canonicalRequestHash: `hash-${commandId}`,
    requester: OWNER,
    authorityExercised: 'WORKFLOW_OWNER',
    command,
  };
}

function requireAllowed(
  request: StateChangingCommandRequest,
  currentState: ReviewWorkflowBatch['persistedState'] | null,
  blockedContext?: {
    readonly blockedFromState: ReviewWorkflowBatch['persistedState'];
    readonly blockedResumeState: ReviewWorkflowBatch['persistedState'];
  },
): AllowedTransition {
  const result = transitionBatch({
    currentState,
    command: request.command,
    actor: request.requester,
    ...(blockedContext ?? {}),
  });
  if (!result.allowed) {
    throw new Error(`Expected ${request.command.type} to be allowed, received ${result.code}`);
  }
  return result;
}

function expectPersistenceCode(operation: () => unknown, expectedCode: string): void {
  try {
    operation();
    throw new Error(`Expected ${expectedCode}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewWorkflowPersistenceError);
    if (!(error instanceof ReviewWorkflowPersistenceError)) throw error;
    expect(error.code).toBe(expectedCode);
  }
}

describe('ReviewWorkflowCommandStore', () => {
  let db: Database.Database;
  let workflowStore: ReviewWorkflowStore;
  let commandStore: ReviewWorkflowCommandStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    workflowStore = new ReviewWorkflowStore(db);
    commandStore = new ReviewWorkflowCommandStore(db);
    workflowStore.createWorkflow(WORKFLOW);
    workflowStore.createBatch(BATCH);
  });

  afterEach(() => {
    db.close();
  });

  it('reserves a command and replays the identical request', () => {
    const request = makeRequest('command-1');

    const first = commandStore.reserve(request);
    const replay = commandStore.reserve(request);

    expect(first.replayed).toBe(false);
    expect(first.command.receipt.status).toBe('RESERVED');
    expect(first.command.receipt.requesterActorExecutionId).toBe(OWNER.actorExecutionId);
    expect(replay.replayed).toBe(true);
    expect(replay.command).toEqual(first.command);
  });

  it.each([
    {
      name: 'request hash',
      change: (request: StateChangingCommandRequest): StateChangingCommandRequest => ({
        ...request,
        canonicalRequestHash: 'different-hash',
      }),
    },
    {
      name: 'actor',
      change: (request: StateChangingCommandRequest): StateChangingCommandRequest => ({
        ...request,
        requester: { ...request.requester, actorExecutionId: 'different-actor' },
      }),
    },
    {
      name: 'target SHA',
      change: (request: StateChangingCommandRequest): StateChangingCommandRequest => ({
        ...request,
        targetCommitSha: SHA_A,
      }),
    },
  ])('rejects reuse of a command ID with a different $name', ({ change }) => {
    const request = makeRequest('command-conflict');
    commandStore.reserve(request);

    expectPersistenceCode(() => commandStore.reserve(change(request)), 'IDEMPOTENCY_CONFLICT');
  });

  it('rejects stale reservations and missing aggregates', () => {
    expectPersistenceCode(
      () => commandStore.reserve(makeRequest('command-stale', 1)),
      'AGGREGATE_VERSION_CONFLICT',
    );
    expectPersistenceCode(
      () =>
        commandStore.reserve({
          ...makeRequest('command-missing'),
          batchId: 'missing-batch',
        }),
      'BATCH_NOT_FOUND',
    );
  });

  it('rejects reservations for a missing workflow before checking the batch', () => {
    const isolatedDb = openDatabase(':memory:');
    try {
      const isolatedCommandStore = new ReviewWorkflowCommandStore(isolatedDb);
      expectPersistenceCode(
        () =>
          isolatedCommandStore.reserve({
            ...makeRequest('command-missing-workflow'),
            workflowId: 'missing-workflow',
          }),
        'WORKFLOW_NOT_FOUND',
      );
    } finally {
      isolatedDb.close();
    }
  });

  it('allows one side-effect claim and never reclaims it after start', () => {
    const request = makeRequest('command-side-effect');
    const reserved = commandStore.reserve(request, 'AGENT_INVOCATION');
    expect(reserved.command.sideEffect?.state).toBe('NOT_STARTED');

    const firstClaim = commandStore.claimSideEffect(request.commandId, 'invocation-1');
    const replayedClaim = commandStore.claimSideEffect(request.commandId, 'invocation-1');

    expect(firstClaim.shouldInvoke).toBe(true);
    expect(firstClaim.command.receipt.status).toBe('RUNNING');
    expect(firstClaim.command.sideEffect?.state).toBe('STARTING');
    expect(replayedClaim.shouldInvoke).toBe(false);
    expectPersistenceCode(
      () => commandStore.claimSideEffect(request.commandId, 'invocation-2'),
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('resumes a durable NOT_STARTED reservation after a pre-invocation interruption', () => {
    const request = makeRequest('command-pre-invocation');
    commandStore.reserve(request, 'VERIFICATION_EXECUTION');

    const retryStore = new ReviewWorkflowCommandStore(db);
    const replay = retryStore.reserve(request, 'VERIFICATION_EXECUTION');
    const claim = retryStore.claimSideEffect(request.commandId, 'verification-1');

    expect(replay.replayed).toBe(true);
    expect(replay.command.sideEffect?.state).toBe('NOT_STARTED');
    expect(claim.shouldInvoke).toBe(true);
  });

  it('rejects a side-effect claim after a final failure', () => {
    const request = makeRequest('command-final-failure');
    commandStore.reserve(request, 'AGENT_INVOCATION');
    commandStore.recordOutcome({
      commandId: request.commandId,
      status: 'FAILED_FINAL',
      errorCode: 'INVOCATION_FAILED',
    });

    expectPersistenceCode(
      () => commandStore.claimSideEffect(request.commandId, 'invocation-after-failure'),
      'COMMAND_STATE_CONFLICT',
    );
  });

  it('records unknown outcomes without allowing reinvocation and then reconciles', () => {
    const request = makeRequest('command-unknown');
    commandStore.reserve(request, 'AGENT_INVOCATION');
    commandStore.claimSideEffect(request.commandId, 'invocation-unknown');

    const unknown = commandStore.recordOutcome({
      commandId: request.commandId,
      status: 'OUTCOME_UNKNOWN',
      errorCode: 'PROCESS_INTERRUPTED',
    });
    const claimAfterUnknown = commandStore.claimSideEffect(request.commandId, 'invocation-unknown');
    const reconciled = commandStore.recordOutcome({
      commandId: request.commandId,
      status: 'RECONCILED',
      resultHash: 'reconciled-result-hash',
      result: { outcome: 'no-transition-committed' },
    });

    expect(unknown.command.receipt.status).toBe('OUTCOME_UNKNOWN');
    expect(claimAfterUnknown.shouldInvoke).toBe(false);
    expect(reconciled.command.receipt.status).toBe('RECONCILED');
    expect(reconciled.command.sideEffect?.state).toBe('OUTCOME_RECORDED');
    expect(
      commandStore.recordOutcome({
        commandId: request.commandId,
        status: 'RECONCILED',
        resultHash: 'reconciled-result-hash',
        result: { outcome: 'no-transition-committed' },
      }).replayed,
    ).toBe(true);
  });

  it.each<NonTransitionCommandOutcomeStatus>(['FAILED_FINAL', 'TIMED_OUT', 'OUTCOME_UNKNOWN'])(
    'persists and replays a %s outcome',
    (status) => {
      const request = makeRequest(`command-${status.toLowerCase()}`);
      commandStore.reserve(request);
      const input = {
        commandId: request.commandId,
        status,
        resultHash: `result-${status}`,
        result: { status },
        errorCode: `ERROR_${status}`,
      };

      expect(commandStore.recordOutcome(input).replayed).toBe(false);
      expect(commandStore.recordOutcome(input).replayed).toBe(true);
      expect(commandStore.get(request.commandId)?.receipt.status).toBe(status);
    },
  );

  it('rejects reconciliation before an indeterminate outcome is recorded', () => {
    const reservedRequest = makeRequest('command-reconcile-reserved');
    commandStore.reserve(reservedRequest);
    expectPersistenceCode(
      () =>
        commandStore.recordOutcome({
          commandId: reservedRequest.commandId,
          status: 'RECONCILED',
        }),
      'COMMAND_STATE_CONFLICT',
    );

    const runningRequest = makeRequest('command-reconcile-running');
    commandStore.reserve(runningRequest, 'AGENT_INVOCATION');
    commandStore.claimSideEffect(runningRequest.commandId, 'invocation-running');
    expectPersistenceCode(
      () =>
        commandStore.recordOutcome({
          commandId: runningRequest.commandId,
          status: 'RECONCILED',
        }),
      'COMMAND_STATE_CONFLICT',
    );
  });

  it('rejects completion while a reserved side effect is still NOT_STARTED', () => {
    const request = makeRequest('command-side-effect-not-started');
    const transition = requireAllowed(request, 'DRAFT');
    commandStore.reserve(request, 'AGENT_INVOCATION');

    expectPersistenceCode(
      () =>
        commandStore.succeedWithTransition({
          commandId: request.commandId,
          transition,
          eventType: 'batch.blocked',
          eventPayload: {},
          resultHash: 'not-started-result',
        }),
      'COMMAND_STATE_CONFLICT',
    );
  });

  it('rejects a caller-supplied transition that differs from the kernel result', () => {
    const request = makeRequest('command-fabricated-transition');
    const transition = requireAllowed(request, 'DRAFT');
    const fabricatedTransition: AllowedTransition = {
      ...transition,
      nextState: 'APPROVED_FOR_MERGE',
    };
    commandStore.reserve(request);

    expectPersistenceCode(
      () =>
        commandStore.succeedWithTransition({
          commandId: request.commandId,
          transition: fabricatedTransition,
          eventType: 'batch.approved',
          eventPayload: {},
          resultHash: 'fabricated-result',
        }),
      'COMMAND_STATE_CONFLICT',
    );
    expect(workflowStore.getBatch(BATCH.batchId)).toEqual(BATCH);
    expect(commandStore.get(request.commandId)?.receipt.status).toBe('RESERVED');
  });

  it('commits aggregate state, event, and receipt atomically', () => {
    const blockRequest = makeRequest('command-block');
    const blockTransition = requireAllowed(blockRequest, 'DRAFT');
    commandStore.reserve(blockRequest);

    const completed = commandStore.succeedWithTransition({
      commandId: blockRequest.commandId,
      transition: blockTransition,
      eventType: 'batch.blocked',
      eventPayload: { reason: 'Waiting for external evidence.' },
      resultHash: 'block-result-hash',
      result: { state: 'BLOCKED' },
    });
    const blockedBatch = workflowStore.getBatch(BATCH.batchId);
    if (blockedBatch === null) throw new Error('Expected blocked batch');

    expect(completed.command.receipt.status).toBe('SUCCEEDED');
    expect(completed.command.receipt.resultingAggregateVersion).toBe(1);
    expect(blockedBatch.persistedState).toBe('BLOCKED');
    expect(blockedBatch.aggregateVersion).toBe(1);
    expect(blockedBatch.blockedFromState).toBe('DRAFT');
    expect(blockedBatch.blockedResumeState).toBe('DRAFT');
    expect(workflowStore.getEvents(BATCH.batchId)).toMatchObject([
      {
        sequence: 1,
        aggregateVersion: 1,
        eventType: 'batch.blocked',
        commandId: blockRequest.commandId,
      },
    ]);

    expect(
      commandStore.succeedWithTransition({
        commandId: blockRequest.commandId,
        transition: blockTransition,
        eventType: 'batch.blocked',
        eventPayload: { reason: 'Waiting for external evidence.' },
        resultHash: 'block-result-hash',
        result: { state: 'BLOCKED' },
      }).replayed,
    ).toBe(true);

    const resumeRequest = makeRequest('command-resume', 1, { type: 'RESUME_BATCH' });
    const resumeTransition = requireAllowed(resumeRequest, 'BLOCKED', {
      blockedFromState: blockedBatch.blockedFromState,
      blockedResumeState: blockedBatch.blockedResumeState,
    });
    commandStore.reserve(resumeRequest);
    commandStore.succeedWithTransition({
      commandId: resumeRequest.commandId,
      transition: resumeTransition,
      eventType: 'batch.resumed',
      eventPayload: {},
      resultHash: 'resume-result-hash',
    });

    expect(workflowStore.getBatch(BATCH.batchId)).toMatchObject({
      persistedState: 'DRAFT',
      aggregateVersion: 2,
    });
    expect(workflowStore.getEvents(BATCH.batchId).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('advances the current plan pointer when a revised plan is submitted', () => {
    const isolatedDb = openDatabase(':memory:');
    try {
      const isolatedWorkflowStore = new ReviewWorkflowStore(isolatedDb);
      const isolatedCommandStore = new ReviewWorkflowCommandStore(isolatedDb);
      const revisionBatch: ReviewWorkflowBatch = {
        ...BATCH,
        persistedState: 'PLAN_NEEDS_REVISION',
      };
      const request: StateChangingCommandRequest = {
        ...makeRequest('command-submit-revised-plan', 0, {
          type: 'SUBMIT_REVISED_PLAN',
          evidence: {
            previousPlanVersionId: BATCH.currentPlanVersionId,
            revisedPlanVersionId: 'batch-plan-2',
            revisedPlanContentHash: 'batch-plan-hash-2',
            dispositionCount: 2,
            findingCount: 2,
          },
        }),
        requester: PLAN_REFINER,
        authorityExercised: 'PLAN_REFINER',
      };
      const transition = requireAllowed(request, revisionBatch.persistedState);
      isolatedWorkflowStore.createWorkflow(WORKFLOW);
      isolatedWorkflowStore.createBatch(revisionBatch);
      isolatedCommandStore.reserve(request);

      isolatedCommandStore.succeedWithTransition({
        commandId: request.commandId,
        transition,
        eventType: 'batch.revised-plan-submitted',
        eventPayload: { planVersionId: 'batch-plan-2' },
        resultHash: 'revised-plan-result',
      });

      expect(isolatedWorkflowStore.getBatch(BATCH.batchId)).toMatchObject({
        persistedState: 'DRAFT',
        aggregateVersion: 1,
        currentPlanVersionId: 'batch-plan-2',
      });
    } finally {
      isolatedDb.close();
    }
  });

  it('rejects a stale completion after another command advances the batch', () => {
    const firstRequest = makeRequest('command-first');
    const secondRequest = makeRequest('command-second');
    const firstTransition = requireAllowed(firstRequest, 'DRAFT');
    const secondTransition = requireAllowed(secondRequest, 'DRAFT');
    commandStore.reserve(firstRequest);
    commandStore.reserve(secondRequest);

    commandStore.succeedWithTransition({
      commandId: firstRequest.commandId,
      transition: firstTransition,
      eventType: 'batch.blocked',
      eventPayload: {},
      resultHash: 'first-result',
    });

    expectPersistenceCode(
      () =>
        commandStore.succeedWithTransition({
          commandId: secondRequest.commandId,
          transition: secondTransition,
          eventType: 'batch.blocked',
          eventPayload: {},
          resultHash: 'second-result',
        }),
      'AGGREGATE_VERSION_CONFLICT',
    );
    expect(commandStore.get(secondRequest.commandId)?.receipt.status).toBe('RESERVED');
    expect(workflowStore.getEvents(BATCH.batchId)).toHaveLength(1);
  });

  it('rolls back batch and receipt changes when event append fails', () => {
    const request = makeRequest('command-rollback');
    const transition = requireAllowed(request, 'DRAFT');
    commandStore.reserve(request);
    db.exec(`
      CREATE TRIGGER fail_review_workflow_event_insert
      BEFORE INSERT ON review_workflow_events
      BEGIN
        SELECT RAISE(ABORT, 'forced event failure');
      END;
    `);

    expect(() =>
      commandStore.succeedWithTransition({
        commandId: request.commandId,
        transition,
        eventType: 'batch.blocked',
        eventPayload: {},
        resultHash: 'rollback-result',
      }),
    ).toThrow('forced event failure');

    expect(workflowStore.getBatch(BATCH.batchId)).toEqual(BATCH);
    expect(commandStore.get(request.commandId)?.receipt.status).toBe('RESERVED');
    expect(workflowStore.getEvents(BATCH.batchId)).toEqual([]);
  });

  it('reserves and atomically creates the initial batch aggregate', () => {
    const isolatedDb = openDatabase(':memory:');
    try {
      const isolatedWorkflowStore = new ReviewWorkflowStore(isolatedDb);
      const isolatedCommandStore = new ReviewWorkflowCommandStore(isolatedDb);
      isolatedWorkflowStore.createWorkflow(WORKFLOW);
      const request: StateChangingCommandRequest = {
        commandId: 'command-create',
        workflowId: WORKFLOW.workflowId,
        batchId: 'batch-created',
        expectedAggregateVersion: 0,
        canonicalRequestHash: 'create-hash',
        requester: PLAN_REFINER,
        authorityExercised: 'PLAN_REFINER',
        command: { type: 'CREATE_BATCH' },
      };
      const transition = requireAllowed(request, null);
      const batch: ReviewWorkflowBatch = {
        ...BATCH,
        batchId: request.batchId,
        aggregateVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };

      isolatedCommandStore.reserve(request);
      const completed = isolatedCommandStore.succeedWithBatchCreation({
        commandId: request.commandId,
        transition,
        batch,
        eventType: 'batch.created',
        eventPayload: {},
        resultHash: 'create-result-hash',
      });

      expect(completed.command.receipt.status).toBe('SUCCEEDED');
      expect(isolatedWorkflowStore.getBatch(batch.batchId)).toEqual(batch);
      expect(isolatedWorkflowStore.getEvents(batch.batchId)).toHaveLength(1);
    } finally {
      isolatedDb.close();
    }
  });
});
