import { describe, expect, it } from 'vitest';
import {
  type ActorExecutionIdentity,
  type AgentAssignment,
  type Authority,
  BLOCKABLE_BATCH_STATES,
  type BatchState,
  type CodeReviewEvidence,
  type CommitCompletionEvidence,
  type MergeApprovalEvidence,
  RESUMABLE_BATCH_STATES,
  type ResumableBatchState,
  type RoleSeparationEvidence,
  SAFE_BLOCKED_RESUME_STATES,
  TRANSITION_COMMAND_TYPES,
  type TransitionCommand,
  type TransitionCommandType,
  type TransitionRejectionCode,
  calculateEffectiveBatchState,
  transitionBatch,
  transitionCommandSchema,
} from '../../../src/review-workflow/index.js';

const NOW = '2026-07-29T00:00:00.000Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function makeAssignment(
  role: 'IMPLEMENTER' | 'REVIEWER',
  overrides: Partial<AgentAssignment> = {},
): AgentAssignment {
  const isImplementer = role === 'IMPLEMENTER';
  return {
    assignmentId: isImplementer ? 'assignment-implementer' : 'assignment-reviewer',
    workflowId: 'workflow-1',
    assignedRole: role,
    configuredAgentKey: isImplementer ? 'claude-agent' : 'codex-agent',
    configuredModelAlias: isImplementer ? 'claude-model' : 'codex-model',
    expectedAdapterKind: isImplementer ? 'CLAUDE' : 'CODEX',
    provider: isImplementer ? 'anthropic' : 'openai',
    configuredModel: isImplementer ? 'claude-test' : 'codex-test',
    commitPermission: isImplementer ? 'AUTHORIZED' : 'DENIED',
    configurationHash: 'config-hash',
    assignedAt: NOW,
    ...overrides,
  };
}

const IMPLEMENTER_ASSIGNMENT = makeAssignment('IMPLEMENTER');
const REVIEWER_ASSIGNMENT = makeAssignment('REVIEWER');

function makeActor(
  actorType: ActorExecutionIdentity['actorType'],
  authorities: readonly Authority[],
  overrides: Partial<ActorExecutionIdentity> = {},
): ActorExecutionIdentity {
  return {
    actorExecutionId: `actor-${actorType.toLowerCase()}`,
    actorType,
    authoritiesExercised: authorities,
    identityAssurance: 'PROCESS_ATTESTED',
    observedEvidence: [],
    startedAt: NOW,
    ...overrides,
  };
}

const IMPLEMENTER = makeActor('AGENT', ['IMPLEMENTER', 'COMMIT_CREATOR'], {
  actorExecutionId: 'actor-implementer',
  assignmentId: IMPLEMENTER_ASSIGNMENT.assignmentId,
  sessionIdentityId: 'session-implementer',
});

const REVIEWER = makeActor('AGENT', ['REVIEWER', 'VERIFICATION_ATTESTOR'], {
  actorExecutionId: 'actor-reviewer',
  assignmentId: REVIEWER_ASSIGNMENT.assignmentId,
  sessionIdentityId: 'session-reviewer',
});

const PLAN_REFINER = makeActor('HUMAN', ['PLAN_REFINER']);
const HUMAN_COMMITTER = makeActor('HUMAN', ['COMMIT_CREATOR']);
const OWNER = makeActor('HUMAN', ['WORKFLOW_OWNER']);
const MERGE_RECORDER = makeActor('HUMAN', ['MERGE_RECORDER']);
const SYSTEM = makeActor('SYSTEM', ['SYSTEM_RECONCILER']);

const CANCELLABLE_STATES = [
  ...BLOCKABLE_BATCH_STATES,
  'BLOCKED',
] as const satisfies readonly BatchState[];

function makeRoleSeparation(
  overrides: Partial<RoleSeparationEvidence> = {},
): RoleSeparationEvidence {
  return {
    implementerAssignment: IMPLEMENTER_ASSIGNMENT,
    reviewerAssignment: REVIEWER_ASSIGNMENT,
    implementerSessionIdentityId: 'session-implementer',
    reviewerSessionIdentityId: 'session-reviewer',
    minimumIdentityAssurance: 'PROCESS_ATTESTED',
    ...overrides,
  };
}

function makeCodeReviewEvidence(overrides: Partial<CodeReviewEvidence> = {}): CodeReviewEvidence {
  return {
    reviewedCommitSha: SHA_B,
    currentHeadSha: SHA_B,
    cleanWorktree: true,
    unresolvedFindingCount: 0,
    incompleteDispositionCount: 0,
    roleSeparation: makeRoleSeparation(),
    ...overrides,
  };
}

function makeCommitEvidence(
  overrides: Partial<CommitCompletionEvidence> = {},
): CommitCompletionEvidence {
  return {
    commitPolicy: 'AGENT_AUTHORIZED',
    creationMode: 'AGENT_AUTHORIZED',
    implementerAssignment: IMPLEMENTER_ASSIGNMENT,
    providedCommitSha: SHA_B,
    resultingCommitSha: SHA_B,
    currentHeadSha: SHA_B,
    cleanWorktree: true,
    ancestryValid: true,
    ...overrides,
  };
}

function makeMergeEvidence(overrides: Partial<MergeApprovalEvidence> = {}): MergeApprovalEvidence {
  return {
    reviewedCommitSha: SHA_B,
    currentHeadSha: SHA_B,
    cleanWorktree: true,
    unresolvedCriticalOrHighFindingCount: 0,
    incompleteDispositionCount: 0,
    requiredCriteriaPassed: true,
    requiredVerificationComplete: true,
    requiredAttestationsAccepted: true,
    manualAndBrowserEvidenceIndependentlyAttested: true,
    finalDiffReviewed: true,
    scopeMatchesApprovedPlan: true,
    documentationComplete: true,
    roleSeparation: makeRoleSeparation(),
    ...overrides,
  };
}

const COMMAND_FIXTURES = {
  CREATE_BATCH: { type: 'CREATE_BATCH' },
  START_PLAN_REVIEW: {
    type: 'START_PLAN_REVIEW',
    roleSeparation: makeRoleSeparation(),
  },
  APPROVE_PLAN: {
    type: 'APPROVE_PLAN',
    evidence: {
      reviewedPlanVersionId: 'plan-1',
      currentPlanVersionId: 'plan-1',
      reviewedPlanContentHash: 'plan-hash',
      currentPlanContentHash: 'plan-hash',
      unresolvedFindingCount: 0,
      incompleteDispositionCount: 0,
      roleSeparation: makeRoleSeparation(),
    },
  },
  REJECT_PLAN: {
    type: 'REJECT_PLAN',
    evidence: {
      reviewedPlanVersionId: 'plan-1',
      currentPlanVersionId: 'plan-1',
      reviewedPlanContentHash: 'plan-hash',
      currentPlanContentHash: 'plan-hash',
      unresolvedFindingCount: 1,
      incompleteDispositionCount: 0,
      roleSeparation: makeRoleSeparation(),
    },
  },
  SUBMIT_REVISED_PLAN: {
    type: 'SUBMIT_REVISED_PLAN',
    evidence: {
      previousPlanVersionId: 'plan-1',
      revisedPlanVersionId: 'plan-2',
      revisedPlanContentHash: 'plan-hash-2',
      dispositionCount: 2,
      findingCount: 2,
    },
  },
  ACCEPT_FINDINGS_RISK: {
    type: 'ACCEPT_FINDINGS_RISK',
    evidence: {
      decisionId: 'workflow-1:decision:1',
      findingIds: ['finding-1', 'finding-2'],
      acceptedCommitSha: SHA_A,
    },
  },
  ACCEPT_PLAN_AS_IS: {
    type: 'ACCEPT_PLAN_AS_IS',
    evidence: {
      acceptedPlanVersionId: 'plan-1',
      currentPlanVersionId: 'plan-1',
      acceptedPlanContentHash: 'plan-hash',
      currentPlanContentHash: 'plan-hash',
      rationale: 'The operator supplied the plan verbatim (plan-as-is mode).',
    },
  },
  START_IMPLEMENTATION: {
    type: 'START_IMPLEMENTATION',
    evidence: {
      approvedPlanVersionId: 'plan-2',
      currentPlanVersionId: 'plan-2',
      roleSeparation: makeRoleSeparation(),
    },
  },
  MARK_IMPLEMENTATION_READY: {
    type: 'MARK_IMPLEMENTATION_READY',
    evidence: {
      implementationReady: {
        implementationReadyEvidenceId: 'ready-1',
        implementationAttemptId: 'attempt-1',
        actorExecutionId: IMPLEMENTER.actorExecutionId,
        worktreeFingerprint: 'worktree-hash',
        changedFiles: ['packages/core/src/review-workflow/types.ts'],
        summary: 'The implementation is ready to commit.',
        capturedAt: NOW,
      },
      roleSeparation: makeRoleSeparation(),
    },
  },
  RESUME_IMPLEMENTATION: {
    type: 'RESUME_IMPLEMENTATION',
    roleSeparation: makeRoleSeparation(),
  },
  COMPLETE_IMPLEMENTATION: {
    type: 'COMPLETE_IMPLEMENTATION',
    evidence: makeCommitEvidence(),
  },
  START_CODE_REVIEW: {
    type: 'START_CODE_REVIEW',
    evidence: makeCodeReviewEvidence(),
  },
  REJECT_CODE_REVIEW: {
    type: 'REJECT_CODE_REVIEW',
    evidence: makeCodeReviewEvidence({ unresolvedFindingCount: 1 }),
  },
  APPROVE_CODE_REVIEW: {
    type: 'APPROVE_CODE_REVIEW',
    evidence: makeCodeReviewEvidence(),
  },
  FAIL_VERIFICATION: {
    type: 'FAIL_VERIFICATION',
    evidence: {
      reviewedCommitSha: SHA_B,
      currentHeadSha: SHA_B,
      failedVerificationRecordIds: ['verification-failed'],
    },
  },
  APPROVE_FOR_MERGE: {
    type: 'APPROVE_FOR_MERGE',
    evidence: makeMergeEvidence(),
  },
  RECONCILE_STALE_APPROVAL: {
    type: 'RECONCILE_STALE_APPROVAL',
    evidence: {
      persistedApprovalSha: SHA_B,
      currentHeadSha: SHA_C,
    },
  },
  RECORD_EXTERNAL_MERGE: {
    type: 'RECORD_EXTERNAL_MERGE',
    evidence: {
      approvedCommitSha: SHA_B,
      currentHeadSha: SHA_B,
      mergeCommitSha: SHA_C,
      effectiveApprovalValid: true,
    },
  },
  BLOCK_BATCH: {
    type: 'BLOCK_BATCH',
    reason: 'External dependency unavailable',
  },
  RESUME_BATCH: { type: 'RESUME_BATCH' },
  CANCEL_BATCH: {
    type: 'CANCEL_BATCH',
    reason: 'Owner cancelled the batch',
  },
} satisfies Record<TransitionCommandType, TransitionCommand>;

function expectAllowed(
  currentState: BatchState | null,
  command: TransitionCommand,
  actor: ActorExecutionIdentity,
  nextState: BatchState,
  options: {
    readonly blockedFromState?: BatchState;
    readonly blockedResumeState?: BatchState;
    readonly expectedBlockedFromState?: BatchState;
    readonly expectedBlockedResumeState?: ResumableBatchState;
  } = {},
): void {
  expect(
    transitionBatch({
      currentState,
      command,
      actor,
      ...(options.blockedFromState === undefined
        ? {}
        : { blockedFromState: options.blockedFromState }),
      ...(options.blockedResumeState === undefined
        ? {}
        : { blockedResumeState: options.blockedResumeState }),
    }),
  ).toEqual({
    allowed: true,
    commandType: command.type,
    previousState: currentState,
    nextState,
    ...(options.expectedBlockedFromState === undefined
      ? {}
      : { blockedFromState: options.expectedBlockedFromState }),
    ...(options.expectedBlockedResumeState === undefined
      ? {}
      : { blockedResumeState: options.expectedBlockedResumeState }),
  });
}

function expectRejected(
  currentState: BatchState | null,
  command: TransitionCommand,
  actor: ActorExecutionIdentity,
  code: TransitionRejectionCode,
): void {
  const result = transitionBatch({ currentState, command, actor });
  expect(result.allowed).toBe(false);
  if (!result.allowed) {
    expect(result.code).toBe(code);
    expect(result.state).toBe(currentState);
  }
}

describe('transitionBatch allowed transitions', () => {
  const cases: Array<{
    name: string;
    currentState: BatchState | null;
    command: TransitionCommand;
    actor: ActorExecutionIdentity;
    nextState: BatchState;
  }> = [
    {
      name: 'creates a draft batch',
      currentState: null,
      command: COMMAND_FIXTURES.CREATE_BATCH,
      actor: PLAN_REFINER,
      nextState: 'DRAFT',
    },
    {
      name: 'starts plan review',
      currentState: 'DRAFT',
      command: COMMAND_FIXTURES.START_PLAN_REVIEW,
      actor: REVIEWER,
      nextState: 'PLAN_REVIEW',
    },
    {
      name: 'approves a plan',
      currentState: 'PLAN_REVIEW',
      command: COMMAND_FIXTURES.APPROVE_PLAN,
      actor: REVIEWER,
      nextState: 'APPROVED_FOR_IMPLEMENTATION',
    },
    {
      name: 'rejects a plan',
      currentState: 'PLAN_REVIEW',
      command: COMMAND_FIXTURES.REJECT_PLAN,
      actor: REVIEWER,
      nextState: 'PLAN_NEEDS_REVISION',
    },
    {
      name: 'submits a revised plan',
      currentState: 'PLAN_NEEDS_REVISION',
      command: COMMAND_FIXTURES.SUBMIT_REVISED_PLAN,
      actor: PLAN_REFINER,
      nextState: 'DRAFT',
    },
    {
      name: 'starts implementation',
      currentState: 'APPROVED_FOR_IMPLEMENTATION',
      command: COMMAND_FIXTURES.START_IMPLEMENTATION,
      actor: IMPLEMENTER,
      nextState: 'IMPLEMENTING',
    },
    {
      name: 'marks implementation ready',
      currentState: 'IMPLEMENTING',
      command: COMMAND_FIXTURES.MARK_IMPLEMENTATION_READY,
      actor: IMPLEMENTER,
      nextState: 'AWAITING_COMMIT',
    },
    {
      name: 'completes an agent-authorized implementation commit',
      currentState: 'AWAITING_COMMIT',
      command: COMMAND_FIXTURES.COMPLETE_IMPLEMENTATION,
      actor: IMPLEMENTER,
      nextState: 'IMPLEMENTATION_COMPLETE',
    },
    {
      name: 'starts code review',
      currentState: 'IMPLEMENTATION_COMPLETE',
      command: COMMAND_FIXTURES.START_CODE_REVIEW,
      actor: REVIEWER,
      nextState: 'CODE_REVIEW',
    },
    {
      name: 'rejects code review',
      currentState: 'CODE_REVIEW',
      command: COMMAND_FIXTURES.REJECT_CODE_REVIEW,
      actor: REVIEWER,
      nextState: 'NEEDS_REVISION',
    },
    {
      name: 'approves code review',
      currentState: 'CODE_REVIEW',
      command: COMMAND_FIXTURES.APPROVE_CODE_REVIEW,
      actor: REVIEWER,
      nextState: 'VERIFYING',
    },
    {
      name: 'returns failed verification for correction',
      currentState: 'VERIFYING',
      command: COMMAND_FIXTURES.FAIL_VERIFICATION,
      actor: SYSTEM,
      nextState: 'NEEDS_REVISION',
    },
    {
      name: 'approves for merge',
      currentState: 'VERIFYING',
      command: COMMAND_FIXTURES.APPROVE_FOR_MERGE,
      actor: SYSTEM,
      nextState: 'APPROVED_FOR_MERGE',
    },
    {
      name: 'persists stale approval',
      currentState: 'APPROVED_FOR_MERGE',
      command: COMMAND_FIXTURES.RECONCILE_STALE_APPROVAL,
      actor: SYSTEM,
      nextState: 'APPROVAL_STALE',
    },
    {
      name: 'records an external merge',
      currentState: 'APPROVED_FOR_MERGE',
      command: COMMAND_FIXTURES.RECORD_EXTERNAL_MERGE,
      actor: MERGE_RECORDER,
      nextState: 'MERGED',
    },
  ];

  it.each(cases)('$name', ({ currentState, command, actor, nextState }) => {
    expectAllowed(currentState, command, actor, nextState);
  });

  it.each(['AWAITING_COMMIT', 'NEEDS_REVISION', 'APPROVAL_STALE'] as const)(
    'resumes implementation from %s',
    (currentState) => {
      expectAllowed(
        currentState,
        COMMAND_FIXTURES.RESUME_IMPLEMENTATION,
        IMPLEMENTER,
        'IMPLEMENTING',
      );
    },
  );

  it.each(RESUMABLE_BATCH_STATES)('resumes a blocked batch into %s', (resumeTarget) => {
    expectAllowed('BLOCKED', COMMAND_FIXTURES.RESUME_BATCH, OWNER, resumeTarget, {
      blockedFromState: resumeTarget,
      blockedResumeState: resumeTarget,
    });
  });

  it.each(BLOCKABLE_BATCH_STATES)('blocks a batch from %s', (currentState) => {
    expectAllowed(currentState, COMMAND_FIXTURES.BLOCK_BATCH, OWNER, 'BLOCKED', {
      expectedBlockedFromState: currentState,
      expectedBlockedResumeState: SAFE_BLOCKED_RESUME_STATES[currentState],
    });
  });

  it.each(CANCELLABLE_STATES)('cancels a batch from %s', (currentState) => {
    expectAllowed(currentState, COMMAND_FIXTURES.CANCEL_BATCH, OWNER, 'CANCELLED');
  });

  it('supports a human-created commit after agent implementation', () => {
    expectAllowed(
      'AWAITING_COMMIT',
      {
        type: 'COMPLETE_IMPLEMENTATION',
        evidence: makeCommitEvidence({
          commitPolicy: 'HUMAN_REQUIRED',
          creationMode: 'HUMAN_CREATED',
        }),
      },
      HUMAN_COMMITTER,
      'IMPLEMENTATION_COMPLETE',
    );
  });

  it('accepts ACCEPT_FINDINGS_RISK only from the human owner on revision states', () => {
    // Allowed sources: NEEDS_REVISION and IMPLEMENTATION_COMPLETE, both to VERIFYING.
    expectAllowed('NEEDS_REVISION', COMMAND_FIXTURES.ACCEPT_FINDINGS_RISK, OWNER, 'VERIFYING');
    expectAllowed(
      'IMPLEMENTATION_COMPLETE',
      COMMAND_FIXTURES.ACCEPT_FINDINGS_RISK,
      OWNER,
      'VERIFYING',
    );
    // Every other state is an invalid source.
    expectRejected('VERIFYING', COMMAND_FIXTURES.ACCEPT_FINDINGS_RISK, OWNER, 'INVALID_TRANSITION');
    expectRejected('DRAFT', COMMAND_FIXTURES.ACCEPT_FINDINGS_RISK, OWNER, 'INVALID_TRANSITION');
    // Agents can never accept risk, whatever authority they claim.
    expectRejected(
      'NEEDS_REVISION',
      COMMAND_FIXTURES.ACCEPT_FINDINGS_RISK,
      makeActor('AGENT', ['WORKFLOW_OWNER']),
      'ACTOR_TYPE_NOT_ALLOWED',
    );
    // A human without the owner authority is refused too.
    expectRejected(
      'NEEDS_REVISION',
      COMMAND_FIXTURES.ACCEPT_FINDINGS_RISK,
      HUMAN_COMMITTER,
      'AUTHORITY_REQUIRED',
    );
  });

  it('accepts ACCEPT_PLAN_AS_IS only from the operator, only from DRAFT', () => {
    // The plan-as-is acceptance is the operator vouching for a plan they supplied verbatim:
    // DRAFT → APPROVED_FOR_IMPLEMENTATION with no plan-review state ever entered.
    expectAllowed(
      'DRAFT',
      COMMAND_FIXTURES.ACCEPT_PLAN_AS_IS,
      OWNER,
      'APPROVED_FOR_IMPLEMENTATION',
    );
    expectAllowed(
      'DRAFT',
      COMMAND_FIXTURES.ACCEPT_PLAN_AS_IS,
      makeActor('SYSTEM', ['WORKFLOW_OWNER']),
      'APPROVED_FOR_IMPLEMENTATION',
    );
    // Only DRAFT is a valid source — a batch that entered review must finish it there.
    expectRejected(
      'PLAN_REVIEW',
      COMMAND_FIXTURES.ACCEPT_PLAN_AS_IS,
      OWNER,
      'INVALID_TRANSITION',
    );
    expectRejected(
      'APPROVED_FOR_IMPLEMENTATION',
      COMMAND_FIXTURES.ACCEPT_PLAN_AS_IS,
      OWNER,
      'INVALID_TRANSITION',
    );
    // An AGENT can never accept a plan without review — that is the manufactured-approval
    // door this command exists to keep shut — and neither can a human without ownership.
    expectRejected(
      'DRAFT',
      COMMAND_FIXTURES.ACCEPT_PLAN_AS_IS,
      makeActor('AGENT', ['WORKFLOW_OWNER']),
      'ACTOR_TYPE_NOT_ALLOWED',
    );
    expectRejected(
      'DRAFT',
      COMMAND_FIXTURES.ACCEPT_PLAN_AS_IS,
      HUMAN_COMMITTER,
      'AUTHORITY_REQUIRED',
    );
  });

  it('rejects a stale ACCEPT_PLAN_AS_IS — version and hash must match the current plan', () => {
    expectRejected(
      'DRAFT',
      {
        type: 'ACCEPT_PLAN_AS_IS',
        evidence: {
          acceptedPlanVersionId: 'plan-1',
          currentPlanVersionId: 'plan-2',
          acceptedPlanContentHash: 'plan-hash',
          currentPlanContentHash: 'plan-hash',
          rationale: 'The operator supplied the plan verbatim (plan-as-is mode).',
        },
      },
      OWNER,
      'PLAN_VERSION_STALE',
    );
    expectRejected(
      'DRAFT',
      {
        type: 'ACCEPT_PLAN_AS_IS',
        evidence: {
          acceptedPlanVersionId: 'plan-1',
          currentPlanVersionId: 'plan-1',
          acceptedPlanContentHash: 'plan-hash',
          currentPlanContentHash: 'plan-hash-2',
          rationale: 'The operator supplied the plan verbatim (plan-as-is mode).',
        },
      },
      OWNER,
      'PLAN_VERSION_STALE',
    );
  });

  it('has a fixture for every transition command', () => {
    expect(Object.keys(COMMAND_FIXTURES).sort()).toEqual([...TRANSITION_COMMAND_TYPES].sort());
  });

  it('schema-validates every transition command fixture', () => {
    for (const command of Object.values(COMMAND_FIXTURES)) {
      expect(transitionCommandSchema.safeParse(command).success).toBe(true);
    }
  });
});

describe('transitionBatch rejections', () => {
  it('rejects DRAFT to IMPLEMENTING', () => {
    expectRejected(
      'DRAFT',
      COMMAND_FIXTURES.START_IMPLEMENTATION,
      IMPLEMENTER,
      'INVALID_TRANSITION',
    );
  });

  it('rejects PLAN_NEEDS_REVISION directly to approval', () => {
    expectRejected(
      'PLAN_NEEDS_REVISION',
      COMMAND_FIXTURES.APPROVE_PLAN,
      REVIEWER,
      'INVALID_TRANSITION',
    );
  });

  it('rejects an implementer recording a review verdict', () => {
    const actor = makeActor('AGENT', ['REVIEWER'], {
      assignmentId: IMPLEMENTER_ASSIGNMENT.assignmentId,
      sessionIdentityId: 'session-implementer',
    });
    expectRejected('PLAN_REVIEW', COMMAND_FIXTURES.APPROVE_PLAN, actor, 'ROLE_VIOLATION');
  });

  it('rejects a reviewer executing implementation', () => {
    const actor = makeActor('AGENT', ['IMPLEMENTER'], {
      assignmentId: REVIEWER_ASSIGNMENT.assignmentId,
      sessionIdentityId: 'session-reviewer',
    });
    expectRejected(
      'APPROVED_FOR_IMPLEMENTATION',
      COMMAND_FIXTURES.START_IMPLEMENTATION,
      actor,
      'ROLE_VIOLATION',
    );
  });

  it('requires implementation-ready evidence from the acting implementer', () => {
    expectRejected(
      'IMPLEMENTING',
      {
        type: 'MARK_IMPLEMENTATION_READY',
        evidence: {
          ...COMMAND_FIXTURES.MARK_IMPLEMENTATION_READY.evidence,
          implementationReady: {
            ...COMMAND_FIXTURES.MARK_IMPLEMENTATION_READY.evidence.implementationReady,
            actorExecutionId: 'actor-other',
          },
        },
      },
      IMPLEMENTER,
      'ROLE_VIOLATION',
    );
  });

  it('separates actor type from authority', () => {
    const humanReviewer = makeActor('HUMAN', ['REVIEWER']);
    expectRejected(
      'DRAFT',
      COMMAND_FIXTURES.START_PLAN_REVIEW,
      humanReviewer,
      'ACTOR_TYPE_NOT_ALLOWED',
    );
  });

  it('requires explicit authority even for the correct actor type', () => {
    const actor = makeActor('AGENT', ['IMPLEMENTER'], {
      assignmentId: REVIEWER_ASSIGNMENT.assignmentId,
    });
    expectRejected('DRAFT', COMMAND_FIXTURES.START_PLAN_REVIEW, actor, 'AUTHORITY_REQUIRED');
  });

  it('rejects the same configured agent in both roles', () => {
    const roleSeparation = makeRoleSeparation({
      reviewerAssignment: makeAssignment('REVIEWER', {
        configuredAgentKey: IMPLEMENTER_ASSIGNMENT.configuredAgentKey,
      }),
    });
    expectRejected('DRAFT', { type: 'START_PLAN_REVIEW', roleSeparation }, REVIEWER, 'SAME_AGENT');
  });

  it('rejects a shared implementer and reviewer session', () => {
    const roleSeparation = makeRoleSeparation({
      reviewerSessionIdentityId: 'session-implementer',
    });
    expectRejected(
      'DRAFT',
      { type: 'START_PLAN_REVIEW', roleSeparation },
      REVIEWER,
      'SHARED_SESSION',
    );
  });

  it('rejects a reviewer that omits the expected session identity', () => {
    const actor = makeActor('AGENT', ['REVIEWER'], {
      assignmentId: REVIEWER_ASSIGNMENT.assignmentId,
    });
    expectRejected('DRAFT', COMMAND_FIXTURES.START_PLAN_REVIEW, actor, 'ROLE_VIOLATION');
  });

  it('rejects insufficient identity assurance', () => {
    const roleSeparation = makeRoleSeparation({
      minimumIdentityAssurance: 'AUTHENTICATED_SUBJECT',
    });
    expectRejected(
      'DRAFT',
      { type: 'START_PLAN_REVIEW', roleSeparation },
      REVIEWER,
      'IDENTITY_ASSURANCE_INSUFFICIENT',
    );
  });

  it('rejects plan approval for a stale plan version', () => {
    expectRejected(
      'PLAN_REVIEW',
      {
        type: 'APPROVE_PLAN',
        evidence: {
          ...COMMAND_FIXTURES.APPROVE_PLAN.evidence,
          currentPlanVersionId: 'plan-2',
        },
      },
      REVIEWER,
      'PLAN_VERSION_STALE',
    );
  });

  it('rejects plan approval with unresolved findings', () => {
    expectRejected(
      'PLAN_REVIEW',
      {
        type: 'APPROVE_PLAN',
        evidence: {
          ...COMMAND_FIXTURES.APPROVE_PLAN.evidence,
          unresolvedFindingCount: 1,
        },
      },
      REVIEWER,
      'PLAN_FINDINGS_UNRESOLVED',
    );
  });

  it('rejects plan approval with incomplete dispositions', () => {
    expectRejected(
      'PLAN_REVIEW',
      {
        type: 'APPROVE_PLAN',
        evidence: {
          ...COMMAND_FIXTURES.APPROVE_PLAN.evidence,
          incompleteDispositionCount: 1,
        },
      },
      REVIEWER,
      'FINDING_DISPOSITIONS_INCOMPLETE',
    );
  });

  it('rejects plan rejection without a structured finding', () => {
    expectRejected(
      'PLAN_REVIEW',
      {
        type: 'REJECT_PLAN',
        evidence: {
          ...COMMAND_FIXTURES.REJECT_PLAN.evidence,
          unresolvedFindingCount: 0,
        },
      },
      REVIEWER,
      'REVIEW_FINDINGS_REQUIRED',
    );
  });

  it('rejects a revision without a disposition for every plan finding', () => {
    expectRejected(
      'PLAN_NEEDS_REVISION',
      {
        type: 'SUBMIT_REVISED_PLAN',
        evidence: {
          previousPlanVersionId: 'plan-1',
          revisedPlanVersionId: 'plan-2',
          revisedPlanContentHash: 'new-hash',
          dispositionCount: 1,
          findingCount: 2,
        },
      },
      PLAN_REFINER,
      'FINDING_DISPOSITIONS_INCOMPLETE',
    );
  });

  it('rejects an unauthorized agent implementation commit', () => {
    expectRejected(
      'AWAITING_COMMIT',
      {
        type: 'COMPLETE_IMPLEMENTATION',
        evidence: makeCommitEvidence({
          implementerAssignment: makeAssignment('IMPLEMENTER', {
            commitPermission: 'DENIED',
          }),
        }),
      },
      IMPLEMENTER,
      'COMMIT_PERMISSION_DENIED',
    );
  });

  it('rejects a reviewer attempting to create an implementation commit', () => {
    const actor = makeActor('AGENT', ['COMMIT_CREATOR'], {
      assignmentId: REVIEWER_ASSIGNMENT.assignmentId,
      sessionIdentityId: 'session-reviewer',
    });
    expectRejected(
      'AWAITING_COMMIT',
      COMMAND_FIXTURES.COMPLETE_IMPLEMENTATION,
      actor,
      'ROLE_VIOLATION',
    );
  });

  it('rejects an implementation commit SHA mismatch', () => {
    expectRejected(
      'AWAITING_COMMIT',
      {
        type: 'COMPLETE_IMPLEMENTATION',
        evidence: makeCommitEvidence({ currentHeadSha: SHA_C }),
      },
      IMPLEMENTER,
      'COMMIT_SHA_MISMATCH',
    );
  });

  it('rejects implementation completion with a dirty worktree', () => {
    expectRejected(
      'AWAITING_COMMIT',
      {
        type: 'COMPLETE_IMPLEMENTATION',
        evidence: makeCommitEvidence({ cleanWorktree: false }),
      },
      IMPLEMENTER,
      'DIRTY_WORKTREE',
    );
  });

  it('rejects invalid implementation ancestry', () => {
    expectRejected(
      'AWAITING_COMMIT',
      {
        type: 'COMPLETE_IMPLEMENTATION',
        evidence: makeCommitEvidence({ ancestryValid: false }),
      },
      IMPLEMENTER,
      'GIT_ANCESTRY_INVALID',
    );
  });

  it('rejects code review approval with unresolved findings', () => {
    expectRejected(
      'CODE_REVIEW',
      {
        type: 'APPROVE_CODE_REVIEW',
        evidence: makeCodeReviewEvidence({ unresolvedFindingCount: 1 }),
      },
      REVIEWER,
      'CODE_FINDINGS_UNRESOLVED',
    );
  });

  it('rejects code review rejection without a structured finding', () => {
    expectRejected(
      'CODE_REVIEW',
      {
        type: 'REJECT_CODE_REVIEW',
        evidence: makeCodeReviewEvidence(),
      },
      REVIEWER,
      'REVIEW_FINDINGS_REQUIRED',
    );
  });

  it('rejects code review against a stale SHA', () => {
    expectRejected(
      'CODE_REVIEW',
      {
        type: 'APPROVE_CODE_REVIEW',
        evidence: makeCodeReviewEvidence({ currentHeadSha: SHA_C }),
      },
      REVIEWER,
      'REVIEW_SHA_STALE',
    );
  });

  it('rejects CODE_REVIEW directly to APPROVED_FOR_MERGE', () => {
    expectRejected('CODE_REVIEW', COMMAND_FIXTURES.APPROVE_FOR_MERGE, SYSTEM, 'INVALID_TRANSITION');
  });

  it('rejects NEEDS_REVISION directly to VERIFYING', () => {
    expectRejected(
      'NEEDS_REVISION',
      COMMAND_FIXTURES.APPROVE_CODE_REVIEW,
      REVIEWER,
      'INVALID_TRANSITION',
    );
  });

  it('rejects failed verification evidence for a stale SHA', () => {
    expectRejected(
      'VERIFYING',
      {
        type: 'FAIL_VERIFICATION',
        evidence: {
          ...COMMAND_FIXTURES.FAIL_VERIFICATION.evidence,
          currentHeadSha: SHA_C,
        },
      },
      SYSTEM,
      'REVIEW_SHA_STALE',
    );
  });

  it('rejects a verification failure without a failed record', () => {
    expectRejected(
      'VERIFYING',
      {
        type: 'FAIL_VERIFICATION',
        evidence: {
          ...COMMAND_FIXTURES.FAIL_VERIFICATION.evidence,
          failedVerificationRecordIds: [],
        },
      },
      SYSTEM,
      'VERIFICATION_INCOMPLETE',
    );
  });

  it('rejects approval without accepted required attestations', () => {
    expectRejected(
      'VERIFYING',
      {
        type: 'APPROVE_FOR_MERGE',
        evidence: makeMergeEvidence({ requiredAttestationsAccepted: false }),
      },
      SYSTEM,
      'ATTESTATION_REQUIRED',
    );
  });

  it('rejects approval with unresolved critical or high final-audit findings', () => {
    expectRejected(
      'VERIFYING',
      {
        type: 'APPROVE_FOR_MERGE',
        evidence: makeMergeEvidence({
          unresolvedCriticalOrHighFindingCount: 1,
        }),
      },
      SYSTEM,
      'FINAL_AUDIT_FINDINGS_UNRESOLVED',
    );
  });

  it('rejects approval with incomplete final-audit dispositions', () => {
    expectRejected(
      'VERIFYING',
      {
        type: 'APPROVE_FOR_MERGE',
        evidence: makeMergeEvidence({ incompleteDispositionCount: 1 }),
      },
      SYSTEM,
      'FINDING_DISPOSITIONS_INCOMPLETE',
    );
  });

  it('rejects approval without independently attested manual and browser evidence', () => {
    expectRejected(
      'VERIFYING',
      {
        type: 'APPROVE_FOR_MERGE',
        evidence: makeMergeEvidence({
          manualAndBrowserEvidenceIndependentlyAttested: false,
        }),
      },
      SYSTEM,
      'ATTESTATION_REQUIRED',
    );
  });

  it('rejects approval where reviewed SHA and HEAD differ', () => {
    expectRejected(
      'VERIFYING',
      {
        type: 'APPROVE_FOR_MERGE',
        evidence: makeMergeEvidence({ currentHeadSha: SHA_C }),
      },
      SYSTEM,
      'REVIEW_SHA_STALE',
    );
  });

  it('rejects approval from a dirty repository snapshot', () => {
    expectRejected(
      'VERIFYING',
      {
        type: 'APPROVE_FOR_MERGE',
        evidence: makeMergeEvidence({ cleanWorktree: false }),
      },
      SYSTEM,
      'DIRTY_WORKTREE',
    );
  });

  it('rejects approval when verification is incomplete', () => {
    expectRejected(
      'VERIFYING',
      {
        type: 'APPROVE_FOR_MERGE',
        evidence: makeMergeEvidence({ requiredVerificationComplete: false }),
      },
      SYSTEM,
      'VERIFICATION_INCOMPLETE',
    );
  });

  it('rejects recording an external merge for stale approval', () => {
    expectRejected(
      'APPROVED_FOR_MERGE',
      {
        type: 'RECORD_EXTERNAL_MERGE',
        evidence: {
          approvedCommitSha: SHA_B,
          currentHeadSha: SHA_C,
          mergeCommitSha: SHA_A,
          effectiveApprovalValid: false,
        },
      },
      MERGE_RECORDER,
      'APPROVAL_STALE',
    );
  });

  it('rejects resuming BLOCKED directly into an approval state', () => {
    const result = transitionBatch({
      currentState: 'BLOCKED',
      command: COMMAND_FIXTURES.RESUME_BATCH,
      actor: OWNER,
      blockedFromState: 'DRAFT',
      blockedResumeState: 'APPROVED_FOR_MERGE',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe('BLOCKED_RESUME_TARGET_INVALID');
    }
  });

  it('rejects teleporting a blocked draft directly into verification', () => {
    const result = transitionBatch({
      currentState: 'BLOCKED',
      command: COMMAND_FIXTURES.RESUME_BATCH,
      actor: OWNER,
      blockedFromState: 'DRAFT',
      blockedResumeState: 'VERIFYING',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe('BLOCKED_RESUME_TARGET_INVALID');
    }
  });

  it('rejects resuming BLOCKED without its persisted kernel-derived state', () => {
    expectRejected(
      'BLOCKED',
      COMMAND_FIXTURES.RESUME_BATCH,
      OWNER,
      'BLOCKED_RESUME_STATE_REQUIRED',
    );
  });

  it('rejects an agent attempting to resume a blocked batch', () => {
    const result = transitionBatch({
      currentState: 'BLOCKED',
      command: COMMAND_FIXTURES.RESUME_BATCH,
      actor: IMPLEMENTER,
      blockedFromState: 'DRAFT',
      blockedResumeState: 'DRAFT',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe('ACTOR_TYPE_NOT_ALLOWED');
    }
  });

  it.each(['MERGED', 'CANCELLED'] as const)(
    'rejects all transitions from terminal state %s',
    (currentState) => {
      for (const command of Object.values(COMMAND_FIXTURES)) {
        expectRejected(currentState, command, OWNER, 'TERMINAL_STATE');
      }
    },
  );

  it('does not mutate its input', () => {
    const input = {
      currentState: 'PLAN_REVIEW' as const,
      command: COMMAND_FIXTURES.APPROVE_PLAN,
      actor: REVIEWER,
    };
    const before = structuredClone(input);

    transitionBatch(input);

    expect(input).toEqual(before);
  });
});

describe('calculateEffectiveBatchState', () => {
  it('reports persisted approval as effectively stale when HEAD changes', () => {
    expect(
      calculateEffectiveBatchState({
        persistedState: 'APPROVED_FOR_MERGE',
        persistedApprovalSha: SHA_B,
        currentHeadSha: SHA_C,
        invalidationPersisted: false,
      }),
    ).toEqual({
      persistedState: 'APPROVED_FOR_MERGE',
      effectiveState: 'APPROVAL_STALE',
      approvalValid: false,
    });
  });

  it('keeps matching approval valid', () => {
    expect(
      calculateEffectiveBatchState({
        persistedState: 'APPROVED_FOR_MERGE',
        persistedApprovalSha: SHA_B,
        currentHeadSha: SHA_B,
        invalidationPersisted: false,
      }),
    ).toEqual({
      persistedState: 'APPROVED_FOR_MERGE',
      effectiveState: 'APPROVED_FOR_MERGE',
      approvalValid: true,
    });
  });

  it('does not restore an approval after invalidation was persisted', () => {
    expect(
      calculateEffectiveBatchState({
        persistedState: 'APPROVED_FOR_MERGE',
        persistedApprovalSha: SHA_B,
        currentHeadSha: SHA_B,
        invalidationPersisted: true,
      }),
    ).toEqual({
      persistedState: 'APPROVED_FOR_MERGE',
      effectiveState: 'APPROVAL_STALE',
      approvalValid: false,
    });
  });

  it('ignores an old approval invalidation marker outside approval states', () => {
    expect(
      calculateEffectiveBatchState({
        persistedState: 'IMPLEMENTING',
        persistedApprovalSha: SHA_B,
        currentHeadSha: SHA_C,
        invalidationPersisted: true,
      }),
    ).toEqual({
      persistedState: 'IMPLEMENTING',
      effectiveState: 'IMPLEMENTING',
      approvalValid: false,
    });
  });
});
