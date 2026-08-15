// Re-entrancy for reserve-before-invoke: deciding what an EXISTING command ID means.
//
// Every side-effecting command reserves its receipt before the external call so a crash can
// never leave an invocation nobody claimed. The command IDs are deterministic by design, so a
// retry derives the ID its predecessor already used. The original guard read "this ID exists"
// as "the side effect already happened" and refused — which is right for a command that
// started or completed, and wrong for one that stopped in the window BETWEEN reserving and
// starting. In that window nothing happened at all, yet the reservation blocked its own
// resume, and no sweep freed it (it is RESERVED, not FAILED_FINAL).
//
// So the question is answered from the reservation's OWN recorded state, never by relaxing a
// constraint: same operation and demonstrably not started -> supersede and reserve afresh;
// anything else -> blocked, exactly as before.

import type {
  ReviewWorkflowCommandSideEffect,
  ReviewWorkflowSideEffectKind,
  StoredReviewWorkflowCommand,
} from '../memory/review-workflow-command-store.js';

export interface ReservationExpectation {
  readonly workflowId: string;
  readonly batchId: string;
  readonly commandType: string;
  readonly sideEffectKind: ReviewWorkflowSideEffectKind;
}

export type ReservationPlan =
  /** No command holds this ID: reserve it. */
  | { readonly action: 'RESERVE' }
  /**
   * A reservation for this exact operation exists and provably never started. Supersede it
   * (archived, not destroyed) and reserve the current attempt's request.
   */
  | { readonly action: 'SUPERSEDE_THEN_RESERVE'; readonly reason: string }
  /** The ID is genuinely taken — a different operation, or one that already acted. */
  | { readonly action: 'BLOCK'; readonly reason: string };

function describeSideEffect(sideEffect: ReviewWorkflowCommandSideEffect | null): string {
  return sideEffect === null ? 'no reserved side effect' : `side effect ${sideEffect.state}`;
}

/**
 * Classifies an existing command ID against the operation the caller is about to reserve.
 *
 * The operation identity is checked FIRST: a clean unstarted reservation for some other
 * workflow, batch, command type or side-effect kind is a genuine ID collision and stays
 * blocked, however harmless its state looks.
 */
export function planReservation(
  stored: StoredReviewWorkflowCommand | null,
  expected: ReservationExpectation,
): ReservationPlan {
  if (stored === null) return { action: 'RESERVE' };

  const storedKind = stored.sideEffect?.kind;
  if (
    stored.request.workflowId !== expected.workflowId ||
    stored.request.batchId !== expected.batchId ||
    stored.request.command.type !== expected.commandType ||
    storedKind !== expected.sideEffectKind
  ) {
    return {
      action: 'BLOCK',
      reason:
        `it is reserved for a different operation (${stored.request.command.type} on ` +
        `${stored.request.batchId} of ${stored.request.workflowId}, ` +
        `${storedKind ?? 'no side effect kind'}), not ${expected.commandType} on ` +
        `${expected.batchId} of ${expected.workflowId}, ${expected.sideEffectKind}`,
    };
  }

  // Anything past RESERVED means the claim landed and the external call may have been made.
  if (stored.receipt.status !== 'RESERVED') {
    return {
      action: 'BLOCK',
      reason: `its receipt is ${stored.receipt.status} (${describeSideEffect(stored.sideEffect)})`,
    };
  }
  if (stored.receipt.sideEffectIdentity !== undefined) {
    return {
      action: 'BLOCK',
      reason: `it is bound to side-effect identity ${stored.receipt.sideEffectIdentity}`,
    };
  }
  if (stored.sideEffect === null || stored.sideEffect.state !== 'NOT_STARTED') {
    return { action: 'BLOCK', reason: `it has ${describeSideEffect(stored.sideEffect)}` };
  }
  if (
    stored.receipt.resultingAggregateVersion !== undefined ||
    stored.receipt.resultingEventSequence !== undefined
  ) {
    return { action: 'BLOCK', reason: 'it recorded durable state' };
  }

  return {
    action: 'SUPERSEDE_THEN_RESERVE',
    reason: `Unstarted ${expected.commandType} reservation superseded by a resumed attempt`,
  };
}
