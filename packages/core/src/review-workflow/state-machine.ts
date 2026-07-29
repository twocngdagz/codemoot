// packages/core/src/review-workflow/state-machine.ts — Pure guarded batch transitions

import {
  type ActorExecutionIdentity,
  type ActorType,
  type AgentAssignment,
  type ApprovalValidityInput,
  type Authority,
  BLOCKABLE_BATCH_STATES,
  type BatchState,
  type BlockableBatchState,
  type CodeReviewEvidence,
  type EffectiveBatchState,
  IDENTITY_ASSURANCE_LEVELS,
  type MergeApprovalEvidence,
  RESUMABLE_BATCH_STATES,
  type ResumableBatchState,
  type RoleSeparationEvidence,
  SAFE_BLOCKED_RESUME_STATES,
  TERMINAL_BATCH_STATES,
  type TransitionCommand,
  type TransitionInput,
  type TransitionRejectionCode,
  type TransitionResult,
} from './types.js';

interface ActorRule {
  readonly actorTypes: readonly ActorType[];
  readonly authorities: readonly Authority[];
}

const IDENTITY_ASSURANCE_RANK = new Map(
  IDENTITY_ASSURANCE_LEVELS.map((level, index) => [
    level,
    IDENTITY_ASSURANCE_LEVELS.length - index,
  ]),
);

const RESUMABLE_STATE_SET = new Set<BatchState>(RESUMABLE_BATCH_STATES);
const BLOCKABLE_STATE_SET = new Set<BatchState>(BLOCKABLE_BATCH_STATES);
const TERMINAL_STATE_SET = new Set<BatchState>(TERMINAL_BATCH_STATES);

const COMMAND_ACTOR_RULES: Record<TransitionCommand['type'], ActorRule> = {
  CREATE_BATCH: {
    actorTypes: ['AGENT', 'HUMAN', 'SYSTEM'],
    authorities: ['PLAN_REFINER'],
  },
  START_PLAN_REVIEW: {
    actorTypes: ['AGENT'],
    authorities: ['REVIEWER'],
  },
  APPROVE_PLAN: {
    actorTypes: ['AGENT'],
    authorities: ['REVIEWER'],
  },
  REJECT_PLAN: {
    actorTypes: ['AGENT'],
    authorities: ['REVIEWER'],
  },
  SUBMIT_REVISED_PLAN: {
    actorTypes: ['AGENT', 'HUMAN'],
    authorities: ['PLAN_REFINER'],
  },
  START_IMPLEMENTATION: {
    actorTypes: ['AGENT'],
    authorities: ['IMPLEMENTER'],
  },
  MARK_IMPLEMENTATION_READY: {
    actorTypes: ['AGENT'],
    authorities: ['IMPLEMENTER'],
  },
  RESUME_IMPLEMENTATION: {
    actorTypes: ['AGENT'],
    authorities: ['IMPLEMENTER'],
  },
  COMPLETE_IMPLEMENTATION: {
    actorTypes: ['AGENT', 'HUMAN'],
    authorities: ['COMMIT_CREATOR'],
  },
  START_CODE_REVIEW: {
    actorTypes: ['AGENT'],
    authorities: ['REVIEWER'],
  },
  REJECT_CODE_REVIEW: {
    actorTypes: ['AGENT'],
    authorities: ['REVIEWER'],
  },
  APPROVE_CODE_REVIEW: {
    actorTypes: ['AGENT'],
    authorities: ['REVIEWER'],
  },
  FAIL_VERIFICATION: {
    actorTypes: ['AGENT', 'SYSTEM'],
    authorities: ['REVIEWER', 'SYSTEM_RECONCILER'],
  },
  APPROVE_FOR_MERGE: {
    actorTypes: ['SYSTEM'],
    authorities: ['SYSTEM_RECONCILER'],
  },
  RECONCILE_STALE_APPROVAL: {
    actorTypes: ['SYSTEM'],
    authorities: ['SYSTEM_RECONCILER'],
  },
  RECORD_EXTERNAL_MERGE: {
    actorTypes: ['HUMAN', 'CI'],
    authorities: ['MERGE_RECORDER'],
  },
  BLOCK_BATCH: {
    actorTypes: ['AGENT', 'HUMAN', 'CI', 'SYSTEM'],
    authorities: [
      'WORKFLOW_OWNER',
      'PLAN_REFINER',
      'IMPLEMENTER',
      'COMMIT_CREATOR',
      'REVIEWER',
      'VERIFICATION_EXECUTOR',
      'VERIFICATION_ATTESTOR',
      'MERGE_RECORDER',
      'SYSTEM_RECONCILER',
    ],
  },
  RESUME_BATCH: {
    actorTypes: ['HUMAN', 'SYSTEM'],
    authorities: ['WORKFLOW_OWNER', 'SYSTEM_RECONCILER'],
  },
  CANCEL_BATCH: {
    actorTypes: ['HUMAN'],
    authorities: ['WORKFLOW_OWNER'],
  },
};

export function calculateEffectiveBatchState(input: ApprovalValidityInput): EffectiveBatchState {
  if (input.persistedState === 'APPROVAL_STALE') {
    return {
      persistedState: input.persistedState,
      effectiveState: 'APPROVAL_STALE',
      approvalValid: false,
    };
  }

  if (input.persistedState !== 'APPROVED_FOR_MERGE') {
    return {
      persistedState: input.persistedState,
      effectiveState: input.persistedState,
      approvalValid: false,
    };
  }

  if (input.invalidationPersisted) {
    return {
      persistedState: input.persistedState,
      effectiveState: 'APPROVAL_STALE',
      approvalValid: false,
    };
  }

  const approvalValid =
    input.persistedApprovalSha !== undefined && input.persistedApprovalSha === input.currentHeadSha;

  return {
    persistedState: input.persistedState,
    effectiveState: approvalValid ? 'APPROVED_FOR_MERGE' : 'APPROVAL_STALE',
    approvalValid,
  };
}

export function transitionBatch(input: TransitionInput): TransitionResult {
  const { currentState, command, actor, blockedFromState, blockedResumeState } = input;

  if (currentState !== null && TERMINAL_STATE_SET.has(currentState)) {
    return reject(
      currentState,
      command,
      'TERMINAL_STATE',
      `Batch state ${currentState} is terminal`,
    );
  }

  const stateRejection = validateSourceState(currentState, command);
  if (stateRejection !== undefined) {
    return stateRejection;
  }

  const actorRejection = validateActor(command, actor, currentState);
  if (actorRejection !== undefined) {
    return actorRejection;
  }

  switch (command.type) {
    case 'CREATE_BATCH':
      return allow(currentState, command, 'DRAFT');

    case 'START_PLAN_REVIEW': {
      const rejection = validateRoleActor(
        actor,
        command.roleSeparation,
        'REVIEWER',
        command,
        currentState,
      );
      return rejection ?? allow(currentState, command, 'PLAN_REVIEW');
    }

    case 'APPROVE_PLAN': {
      const roleRejection = validateRoleActor(
        actor,
        command.evidence.roleSeparation,
        'REVIEWER',
        command,
        currentState,
      );
      if (roleRejection !== undefined) return roleRejection;

      if (
        command.evidence.reviewedPlanVersionId !== command.evidence.currentPlanVersionId ||
        command.evidence.reviewedPlanContentHash !== command.evidence.currentPlanContentHash
      ) {
        return reject(
          currentState,
          command,
          'PLAN_VERSION_STALE',
          'Plan approval must target the current immutable plan version and hash',
        );
      }
      if (command.evidence.unresolvedFindingCount > 0) {
        return reject(
          currentState,
          command,
          'PLAN_FINDINGS_UNRESOLVED',
          'Plan findings remain unresolved',
        );
      }
      if (command.evidence.incompleteDispositionCount > 0) {
        return reject(
          currentState,
          command,
          'FINDING_DISPOSITIONS_INCOMPLETE',
          'Plan finding dispositions are incomplete',
        );
      }
      return allow(currentState, command, 'APPROVED_FOR_IMPLEMENTATION');
    }

    case 'REJECT_PLAN': {
      const rejection = validateRoleActor(
        actor,
        command.evidence.roleSeparation,
        'REVIEWER',
        command,
        currentState,
      );
      if (rejection !== undefined) return rejection;
      if (
        command.evidence.reviewedPlanVersionId !== command.evidence.currentPlanVersionId ||
        command.evidence.reviewedPlanContentHash !== command.evidence.currentPlanContentHash
      ) {
        return reject(
          currentState,
          command,
          'PLAN_VERSION_STALE',
          'Plan rejection must target the current immutable plan version',
        );
      }
      if (command.evidence.unresolvedFindingCount === 0) {
        return reject(
          currentState,
          command,
          'REVIEW_FINDINGS_REQUIRED',
          'Plan rejection requires at least one unresolved structured finding',
        );
      }
      return allow(currentState, command, 'PLAN_NEEDS_REVISION');
    }

    case 'SUBMIT_REVISED_PLAN':
      if (command.evidence.previousPlanVersionId === command.evidence.revisedPlanVersionId) {
        return reject(
          currentState,
          command,
          'PLAN_VERSION_STALE',
          'A revised plan must have a new immutable version ID',
        );
      }
      if (command.evidence.dispositionCount < command.evidence.findingCount) {
        return reject(
          currentState,
          command,
          'FINDING_DISPOSITIONS_INCOMPLETE',
          'Every plan finding requires a disposition',
        );
      }
      return allow(currentState, command, 'DRAFT');

    case 'START_IMPLEMENTATION': {
      const roleRejection = validateRoleActor(
        actor,
        command.evidence.roleSeparation,
        'IMPLEMENTER',
        command,
        currentState,
      );
      if (roleRejection !== undefined) return roleRejection;
      if (command.evidence.approvedPlanVersionId !== command.evidence.currentPlanVersionId) {
        return reject(
          currentState,
          command,
          'PLAN_VERSION_STALE',
          'Implementation requires the currently approved plan version',
        );
      }
      return allow(currentState, command, 'IMPLEMENTING');
    }

    case 'MARK_IMPLEMENTATION_READY': {
      const rejection = validateRoleActor(
        actor,
        command.evidence.roleSeparation,
        'IMPLEMENTER',
        command,
        currentState,
      );
      if (rejection !== undefined) return rejection;
      if (command.evidence.implementationReady.actorExecutionId !== actor.actorExecutionId) {
        return reject(
          currentState,
          command,
          'ROLE_VIOLATION',
          'Implementation-ready evidence must be produced by the acting implementer',
        );
      }
      return allow(currentState, command, 'AWAITING_COMMIT');
    }

    case 'RESUME_IMPLEMENTATION': {
      const rejection = validateRoleActor(
        actor,
        command.roleSeparation,
        'IMPLEMENTER',
        command,
        currentState,
      );
      return rejection ?? allow(currentState, command, 'IMPLEMENTING');
    }

    case 'COMPLETE_IMPLEMENTATION': {
      const { evidence } = command;
      if (
        evidence.providedCommitSha !== evidence.resultingCommitSha ||
        evidence.resultingCommitSha !== evidence.currentHeadSha
      ) {
        return reject(
          currentState,
          command,
          'COMMIT_SHA_MISMATCH',
          'Provided, resulting, and current HEAD commit SHAs must match',
        );
      }
      if (!evidence.cleanWorktree) {
        return reject(
          currentState,
          command,
          'DIRTY_WORKTREE',
          'Implementation completion requires a clean worktree',
        );
      }
      if (!evidence.ancestryValid) {
        return reject(
          currentState,
          command,
          'GIT_ANCESTRY_INVALID',
          'Implementation commit must have valid batch ancestry',
        );
      }

      const permissionRejection = validateCommitPermission(actor, evidence.implementerAssignment, {
        policy: evidence.commitPolicy,
        mode: evidence.creationMode,
      });
      if (permissionRejection !== undefined) {
        return reject(currentState, command, permissionRejection.code, permissionRejection.message);
      }
      return allow(currentState, command, 'IMPLEMENTATION_COMPLETE');
    }

    case 'START_CODE_REVIEW': {
      const rejection = validateCodeReview(actor, command.evidence, command, currentState, false);
      return rejection ?? allow(currentState, command, 'CODE_REVIEW');
    }

    case 'REJECT_CODE_REVIEW': {
      const rejection = validateCodeReview(actor, command.evidence, command, currentState, false);
      if (rejection !== undefined) return rejection;
      if (command.evidence.unresolvedFindingCount === 0) {
        return reject(
          currentState,
          command,
          'REVIEW_FINDINGS_REQUIRED',
          'Code review rejection requires at least one unresolved structured finding',
        );
      }
      return allow(currentState, command, 'NEEDS_REVISION');
    }

    case 'APPROVE_CODE_REVIEW': {
      const rejection = validateCodeReview(actor, command.evidence, command, currentState, true);
      return rejection ?? allow(currentState, command, 'VERIFYING');
    }

    case 'FAIL_VERIFICATION':
      if (command.evidence.reviewedCommitSha !== command.evidence.currentHeadSha) {
        return reject(
          currentState,
          command,
          'REVIEW_SHA_STALE',
          'Failed verification evidence must target the current branch HEAD',
        );
      }
      if (command.evidence.failedVerificationRecordIds.length === 0) {
        return reject(
          currentState,
          command,
          'VERIFICATION_INCOMPLETE',
          'Verification failure requires at least one failed verification record',
        );
      }
      return allow(currentState, command, 'NEEDS_REVISION');

    case 'APPROVE_FOR_MERGE': {
      const separationRejection = validateRoleSeparation(
        command.evidence.roleSeparation,
        actor,
        command,
        currentState,
      );
      if (separationRejection !== undefined) return separationRejection;

      const gateRejection = validateMergeApproval(command.evidence, currentState, command);
      return gateRejection ?? allow(currentState, command, 'APPROVED_FOR_MERGE');
    }

    case 'RECONCILE_STALE_APPROVAL':
      if (command.evidence.persistedApprovalSha === command.evidence.currentHeadSha) {
        return reject(
          currentState,
          command,
          'INVALID_TRANSITION',
          'Approval is not stale while the persisted approval SHA equals current HEAD',
        );
      }
      return allow(currentState, command, 'APPROVAL_STALE');

    case 'RECORD_EXTERNAL_MERGE':
      if (!command.evidence.effectiveApprovalValid) {
        return reject(
          currentState,
          command,
          'APPROVAL_STALE',
          'External merge cannot be recorded for an invalid approval',
        );
      }
      if (command.evidence.approvedCommitSha !== command.evidence.currentHeadSha) {
        return reject(
          currentState,
          command,
          'APPROVAL_STALE',
          'Approved commit SHA must equal current HEAD before merge recording',
        );
      }
      return allow(currentState, command, 'MERGED');

    case 'BLOCK_BATCH':
      if (!isBlockableState(currentState)) {
        throw new Error(`Cannot derive block context from ${currentState ?? 'no state'}`);
      }
      return allow(currentState, command, 'BLOCKED', {
        blockedFromState: currentState,
        blockedResumeState: SAFE_BLOCKED_RESUME_STATES[currentState],
      });

    case 'RESUME_BATCH':
      if (blockedFromState === undefined || blockedResumeState === undefined) {
        return reject(
          currentState,
          command,
          'BLOCKED_RESUME_STATE_REQUIRED',
          'Resuming a blocked batch requires its persisted kernel-derived resume state',
        );
      }
      if (
        !isBlockableState(blockedFromState) ||
        !RESUMABLE_STATE_SET.has(blockedResumeState) ||
        SAFE_BLOCKED_RESUME_STATES[blockedFromState] !== blockedResumeState
      ) {
        return reject(
          currentState,
          command,
          'BLOCKED_RESUME_TARGET_INVALID',
          `Cannot resume a blocked batch directly into ${blockedResumeState}`,
        );
      }
      return allow(currentState, command, blockedResumeState);

    case 'CANCEL_BATCH':
      return allow(currentState, command, 'CANCELLED');

    default:
      return assertNever(command);
  }
}

function validateSourceState(
  currentState: BatchState | null,
  command: TransitionCommand,
): TransitionResult | undefined {
  const expectedStates = expectedSourceStates(command);
  if (expectedStates.includes(currentState)) return undefined;

  return reject(
    currentState,
    command,
    'INVALID_TRANSITION',
    `Command ${command.type} is not valid from ${currentState ?? 'no state'}`,
  );
}

function expectedSourceStates(command: TransitionCommand): readonly (BatchState | null)[] {
  switch (command.type) {
    case 'CREATE_BATCH':
      return [null];
    case 'START_PLAN_REVIEW':
      return ['DRAFT'];
    case 'APPROVE_PLAN':
    case 'REJECT_PLAN':
      return ['PLAN_REVIEW'];
    case 'SUBMIT_REVISED_PLAN':
      return ['PLAN_NEEDS_REVISION'];
    case 'START_IMPLEMENTATION':
      return ['APPROVED_FOR_IMPLEMENTATION'];
    case 'MARK_IMPLEMENTATION_READY':
      return ['IMPLEMENTING'];
    case 'RESUME_IMPLEMENTATION':
      return ['AWAITING_COMMIT', 'NEEDS_REVISION', 'APPROVAL_STALE'];
    case 'COMPLETE_IMPLEMENTATION':
      return ['AWAITING_COMMIT'];
    case 'START_CODE_REVIEW':
      return ['IMPLEMENTATION_COMPLETE'];
    case 'APPROVE_CODE_REVIEW':
    case 'REJECT_CODE_REVIEW':
      return ['CODE_REVIEW'];
    case 'FAIL_VERIFICATION':
    case 'APPROVE_FOR_MERGE':
      return ['VERIFYING'];
    case 'RECONCILE_STALE_APPROVAL':
    case 'RECORD_EXTERNAL_MERGE':
      return ['APPROVED_FOR_MERGE'];
    case 'BLOCK_BATCH':
      return BLOCKABLE_BATCH_STATES;
    case 'RESUME_BATCH':
      return ['BLOCKED'];
    case 'CANCEL_BATCH':
      return [
        'DRAFT',
        'PLAN_REVIEW',
        'PLAN_NEEDS_REVISION',
        'APPROVED_FOR_IMPLEMENTATION',
        'IMPLEMENTING',
        'AWAITING_COMMIT',
        'IMPLEMENTATION_COMPLETE',
        'CODE_REVIEW',
        'NEEDS_REVISION',
        'VERIFYING',
        'APPROVED_FOR_MERGE',
        'APPROVAL_STALE',
        'BLOCKED',
      ];
    default:
      return assertNever(command);
  }
}

function validateActor(
  command: TransitionCommand,
  actor: ActorExecutionIdentity,
  currentState: BatchState | null,
): TransitionResult | undefined {
  const rule = COMMAND_ACTOR_RULES[command.type];
  if (!rule.actorTypes.includes(actor.actorType)) {
    return reject(
      currentState,
      command,
      'ACTOR_TYPE_NOT_ALLOWED',
      `Actor type ${actor.actorType} cannot execute ${command.type}`,
    );
  }
  if (!rule.authorities.some((authority) => actor.authoritiesExercised.includes(authority))) {
    return reject(
      currentState,
      command,
      'AUTHORITY_REQUIRED',
      `Command ${command.type} requires one of: ${rule.authorities.join(', ')}`,
    );
  }
  return undefined;
}

function validateRoleActor(
  actor: ActorExecutionIdentity,
  evidence: RoleSeparationEvidence,
  requiredRole: 'IMPLEMENTER' | 'REVIEWER',
  command: TransitionCommand,
  currentState: BatchState | null,
): TransitionResult | undefined {
  const separationRejection = validateRoleSeparation(evidence, actor, command, currentState);
  if (separationRejection !== undefined) return separationRejection;

  const expectedAssignment =
    requiredRole === 'IMPLEMENTER' ? evidence.implementerAssignment : evidence.reviewerAssignment;
  if (
    actor.assignmentId !== expectedAssignment.assignmentId ||
    expectedAssignment.assignedRole !== requiredRole
  ) {
    return reject(
      currentState,
      command,
      'ROLE_VIOLATION',
      `Actor is not the assigned ${requiredRole.toLowerCase()}`,
    );
  }

  const expectedSession =
    requiredRole === 'IMPLEMENTER'
      ? evidence.implementerSessionIdentityId
      : evidence.reviewerSessionIdentityId;
  if (expectedSession !== undefined && actor.sessionIdentityId !== expectedSession) {
    return reject(
      currentState,
      command,
      'ROLE_VIOLATION',
      `Actor session does not match the assigned ${requiredRole.toLowerCase()} session`,
    );
  }
  return undefined;
}

function validateRoleSeparation(
  evidence: RoleSeparationEvidence,
  actor: ActorExecutionIdentity,
  command: TransitionCommand,
  currentState: BatchState | null,
): TransitionResult | undefined {
  if (
    evidence.implementerAssignment.assignedRole !== 'IMPLEMENTER' ||
    evidence.reviewerAssignment.assignedRole !== 'REVIEWER' ||
    evidence.implementerAssignment.workflowId !== evidence.reviewerAssignment.workflowId ||
    (evidence.implementerAssignment.batchId !== undefined &&
      evidence.reviewerAssignment.batchId !== undefined &&
      evidence.implementerAssignment.batchId !== evidence.reviewerAssignment.batchId)
  ) {
    return reject(
      currentState,
      command,
      'ROLE_VIOLATION',
      'Implementer and reviewer assignments must identify the expected roles in one workflow',
    );
  }

  if (
    evidence.implementerAssignment.assignmentId === evidence.reviewerAssignment.assignmentId ||
    evidence.implementerAssignment.configuredAgentKey ===
      evidence.reviewerAssignment.configuredAgentKey
  ) {
    return reject(
      currentState,
      command,
      'SAME_AGENT',
      'Implementer and reviewer must be different configured agents',
    );
  }

  if (
    evidence.implementerSessionIdentityId !== undefined &&
    evidence.implementerSessionIdentityId === evidence.reviewerSessionIdentityId
  ) {
    return reject(
      currentState,
      command,
      'SHARED_SESSION',
      'Implementer and reviewer cannot share a session identity',
    );
  }

  const actualRank = IDENTITY_ASSURANCE_RANK.get(actor.identityAssurance) ?? 0;
  const minimumRank = IDENTITY_ASSURANCE_RANK.get(evidence.minimumIdentityAssurance) ?? 0;
  if (actualRank < minimumRank) {
    return reject(
      currentState,
      command,
      'IDENTITY_ASSURANCE_INSUFFICIENT',
      `Actor identity assurance ${actor.identityAssurance} is below the required level`,
    );
  }
  return undefined;
}

function validateCommitPermission(
  actor: ActorExecutionIdentity,
  implementerAssignment: AgentAssignment,
  options: {
    readonly policy: 'HUMAN_REQUIRED' | 'AGENT_AUTHORIZED' | 'EITHER';
    readonly mode: 'AGENT_AUTHORIZED' | 'HUMAN_CREATED';
  },
): { readonly code: TransitionRejectionCode; readonly message: string } | undefined {
  if (actor.actorType === 'AGENT') {
    if (
      actor.assignmentId !== implementerAssignment.assignmentId ||
      implementerAssignment.assignedRole !== 'IMPLEMENTER'
    ) {
      return {
        code: 'ROLE_VIOLATION',
        message: 'Only the assigned implementer agent may create an agent-authorized commit',
      };
    }
    if (
      options.mode !== 'AGENT_AUTHORIZED' ||
      options.policy === 'HUMAN_REQUIRED' ||
      implementerAssignment.commitPermission !== 'AUTHORIZED'
    ) {
      return {
        code: 'COMMIT_PERMISSION_DENIED',
        message: 'The assigned agent does not have permission to create this commit',
      };
    }
    return undefined;
  }

  if (options.mode !== 'HUMAN_CREATED' || options.policy === 'AGENT_AUTHORIZED') {
    return {
      code: 'COMMIT_PERMISSION_DENIED',
      message: 'Commit policy does not allow a human-created implementation commit',
    };
  }
  return undefined;
}

function validateCodeReview(
  actor: ActorExecutionIdentity,
  evidence: CodeReviewEvidence,
  command: TransitionCommand,
  currentState: BatchState | null,
  requireResolvedFindings: boolean,
): TransitionResult | undefined {
  const roleRejection = validateRoleActor(
    actor,
    evidence.roleSeparation,
    'REVIEWER',
    command,
    currentState,
  );
  if (roleRejection !== undefined) return roleRejection;
  if (evidence.reviewedCommitSha !== evidence.currentHeadSha) {
    return reject(
      currentState,
      command,
      'REVIEW_SHA_STALE',
      'Code review must target the current branch HEAD',
    );
  }
  if (!evidence.cleanWorktree) {
    return reject(currentState, command, 'DIRTY_WORKTREE', 'Code review requires a clean worktree');
  }
  if (requireResolvedFindings && evidence.unresolvedFindingCount > 0) {
    return reject(
      currentState,
      command,
      'CODE_FINDINGS_UNRESOLVED',
      'Code findings remain unresolved',
    );
  }
  if (requireResolvedFindings && evidence.incompleteDispositionCount > 0) {
    return reject(
      currentState,
      command,
      'FINDING_DISPOSITIONS_INCOMPLETE',
      'Code finding dispositions are incomplete',
    );
  }
  return undefined;
}

function validateMergeApproval(
  evidence: MergeApprovalEvidence,
  currentState: BatchState | null,
  command: TransitionCommand,
): TransitionResult | undefined {
  if (evidence.reviewedCommitSha !== evidence.currentHeadSha) {
    return reject(
      currentState,
      command,
      'REVIEW_SHA_STALE',
      'Final approval requires the reviewed commit SHA to equal current HEAD',
    );
  }
  if (!evidence.cleanWorktree) {
    return reject(
      currentState,
      command,
      'DIRTY_WORKTREE',
      'Final approval requires a clean worktree',
    );
  }
  if (evidence.unresolvedCriticalOrHighFindingCount > 0) {
    return reject(
      currentState,
      command,
      'FINAL_AUDIT_FINDINGS_UNRESOLVED',
      'Critical or high final-audit findings remain unresolved',
    );
  }
  if (evidence.incompleteDispositionCount > 0) {
    return reject(
      currentState,
      command,
      'FINDING_DISPOSITIONS_INCOMPLETE',
      'Final-audit finding dispositions are incomplete',
    );
  }
  if (!evidence.requiredAttestationsAccepted) {
    return reject(
      currentState,
      command,
      'ATTESTATION_REQUIRED',
      'Required verification attestations have not been accepted',
    );
  }
  if (!evidence.manualAndBrowserEvidenceIndependentlyAttested) {
    return reject(
      currentState,
      command,
      'ATTESTATION_REQUIRED',
      'Manual and browser evidence requires independent attestation',
    );
  }
  if (
    !evidence.requiredCriteriaPassed ||
    !evidence.requiredVerificationComplete ||
    !evidence.finalDiffReviewed ||
    !evidence.scopeMatchesApprovedPlan ||
    !evidence.documentationComplete
  ) {
    return reject(
      currentState,
      command,
      'VERIFICATION_INCOMPLETE',
      'Final approval conditions are incomplete',
    );
  }
  return undefined;
}

function allow(
  previousState: BatchState | null,
  command: TransitionCommand,
  nextState: BatchState,
  blockContext?: {
    readonly blockedFromState: BlockableBatchState;
    readonly blockedResumeState: ResumableBatchState;
  },
): TransitionResult {
  return {
    allowed: true,
    commandType: command.type,
    previousState,
    nextState,
    ...blockContext,
  };
}

function isBlockableState(state: BatchState | null): state is BlockableBatchState {
  return state !== null && BLOCKABLE_STATE_SET.has(state);
}

function reject(
  state: BatchState | null,
  command: TransitionCommand,
  code: TransitionRejectionCode,
  message: string,
): TransitionResult {
  return {
    allowed: false,
    commandType: command.type,
    state,
    code,
    message,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled transition command: ${String(value)}`);
}
