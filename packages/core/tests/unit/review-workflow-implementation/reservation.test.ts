// The reserve-before-invoke re-entrancy decision, as a truth table.
//
// A deterministic command ID is reused by every retry of the same operation, so "this ID
// exists" cannot by itself mean "the side effect happened". The classifier answers from the
// reservation's own recorded state: superseded ONLY when the operation matches and nothing
// started; blocked in every other case, exactly as before.

import { describe, expect, it } from 'vitest';
import type {
  ReviewWorkflowCommandSideEffect,
  StoredReviewWorkflowCommand,
} from '../../../src/memory/review-workflow-command-store.js';
import {
  type ReservationExpectation,
  planReservation,
} from '../../../src/review-workflow-implementation/reservation.js';
import type {
  CommandReceipt,
  StateChangingCommandRequest,
} from '../../../src/review-workflow/types.js';

const NOW = '2026-08-13T00:00:00.000Z';

const EXPECTED: ReservationExpectation = {
  workflowId: 'workflow-1',
  batchId: 'workflow-1:batch:1',
  commandType: 'START_CODE_REVIEW',
  sideEffectKind: 'AGENT_INVOCATION',
};

function stored(overrides: {
  readonly receipt?: Partial<CommandReceipt>;
  readonly request?: Partial<StateChangingCommandRequest>;
  readonly sideEffect?: Partial<ReviewWorkflowCommandSideEffect> | null;
}): StoredReviewWorkflowCommand {
  const request = {
    commandId: 'command-1',
    workflowId: EXPECTED.workflowId,
    batchId: EXPECTED.batchId,
    expectedAggregateVersion: 3,
    canonicalRequestHash: 'hash-1',
    requester: {
      actorExecutionId: 'actor-1',
      actorType: 'AGENT' as const,
      authoritiesExercised: ['REVIEWER'],
      identityAssurance: 'PROCESS_ATTESTED' as const,
      observedEvidence: [],
      startedAt: NOW,
    },
    authorityExercised: 'REVIEWER',
    command: { type: EXPECTED.commandType },
    ...(overrides.request ?? {}),
  } as unknown as StateChangingCommandRequest;
  const receipt = {
    commandId: request.commandId,
    workflowId: request.workflowId,
    batchId: request.batchId,
    commandType: request.command.type,
    expectedAggregateVersion: request.expectedAggregateVersion,
    canonicalRequestHash: request.canonicalRequestHash,
    requesterActorExecutionId: request.requester.actorExecutionId,
    authorityExercised: request.authorityExercised,
    status: 'RESERVED',
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides.receipt ?? {}),
  } as unknown as CommandReceipt;
  const sideEffect =
    overrides.sideEffect === null
      ? null
      : ({
          commandId: request.commandId,
          kind: 'AGENT_INVOCATION',
          state: 'NOT_STARTED',
          createdAt: NOW,
          updatedAt: NOW,
          ...(overrides.sideEffect ?? {}),
        } as ReviewWorkflowCommandSideEffect);
  return { request, receipt, sideEffect, result: null };
}

describe('planReservation', () => {
  it('AC2: a free command ID is reserved exactly as before', () => {
    expect(planReservation(null, EXPECTED)).toEqual({ action: 'RESERVE' });
  });

  it('AC1: a reservation that never started is superseded, not blocked', () => {
    const plan = planReservation(stored({}), EXPECTED);
    expect(plan.action).toBe('SUPERSEDE_THEN_RESERVE');
  });

  it.each([
    ['RUNNING', 'the claim landed and the agent may already have been called'],
    ['SUCCEEDED', 'the command completed'],
    ['FAILED_FINAL', 'the command failed terminally and only an authorised release frees it'],
  ])('AC3: a %s receipt stays blocked (%s)', (status) => {
    const plan = planReservation(stored({ receipt: { status } }), EXPECTED);
    expect(plan).toMatchObject({ action: 'BLOCK' });
  });

  it.each(['STARTING', 'OUTCOME_RECORDED'] as const)(
    'AC3: a %s side effect stays blocked even under a RESERVED receipt',
    (state) => {
      const plan = planReservation(stored({ sideEffect: { state } }), EXPECTED);
      expect(plan).toMatchObject({ action: 'BLOCK' });
    },
  );

  it('AC3: a bound side-effect identity stays blocked even with a NOT_STARTED side effect', () => {
    // Belt and braces: the claim writes both halves in one transaction, so either half
    // having landed is enough to prove the external call may have been made.
    const plan = planReservation(
      stored({ receipt: { sideEffectIdentity: 'invocation-1' } }),
      EXPECTED,
    );
    expect(plan).toMatchObject({ action: 'BLOCK' });
  });

  it('AC3: a reservation that recorded durable state stays blocked', () => {
    const plan = planReservation(
      stored({ receipt: { resultingAggregateVersion: 4, resultingEventSequence: 9 } }),
      EXPECTED,
    );
    expect(plan).toMatchObject({ action: 'BLOCK' });
  });

  it('AC3: a reservation with no side-effect row is not an agent-invocation reservation', () => {
    const plan = planReservation(stored({ sideEffect: null }), EXPECTED);
    expect(plan).toMatchObject({ action: 'BLOCK' });
  });

  it.each([
    ['workflow', { request: { workflowId: 'workflow-other' } }],
    ['batch', { request: { batchId: 'workflow-1:batch:2' } }],
    ['command type', { request: { command: { type: 'START_IMPLEMENTATION' } } }],
    ['side-effect kind', { sideEffect: { kind: 'VERIFICATION_EXECUTION' } }],
  ])('AC4: a clean unstarted reservation for a different %s is rejected', (_label, overrides) => {
    const plan = planReservation(stored(overrides as Parameters<typeof stored>[0]), EXPECTED);
    expect(plan).toMatchObject({ action: 'BLOCK' });
  });
});
