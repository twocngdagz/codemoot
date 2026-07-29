import { ControllerError, invariant } from './errors.mjs';

export const AGENT_PHASES = Object.freeze([
  'IMPLEMENT',
  'REVIEW_INITIAL',
  'FIX_BLOCKING_FINDINGS',
  'REVIEW_FINAL',
]);

export const TERMINAL_PHASES = Object.freeze(['HUMAN_DECISION_REQUIRED', 'BLOCKED', 'DONE']);

export const ALL_PHASES = Object.freeze([
  ...AGENT_PHASES,
  'READY_TO_COMMIT',
  'CLOSE_BATCH',
  'ADVANCE_BATCH',
  ...TERMINAL_PHASES,
]);

const NEXT_ACTIONS = Object.freeze({
  IMPLEMENT: 'RUN_IMPLEMENTER',
  REVIEW_INITIAL: 'RUN_INITIAL_REVIEWER',
  FIX_BLOCKING_FINDINGS: 'RUN_IMPLEMENTER_CORRECTION',
  REVIEW_FINAL: 'RUN_FINAL_REVIEWER',
  READY_TO_COMMIT: 'COMMIT_OR_VERIFY_APPROVED_COMMIT',
  CLOSE_BATCH: 'PUSH_OR_VERIFY_PUSH_POLICY',
  ADVANCE_BATCH: 'ADVANCE_APPROVED_BATCH',
  HUMAN_DECISION_REQUIRED: 'AWAIT_HUMAN_DECISION',
  BLOCKED: 'RESOLVE_BLOCKER',
  DONE: 'NONE',
});

export function roleForPhase(state, phase) {
  if (phase === 'IMPLEMENT' || phase === 'FIX_BLOCKING_FINDINGS') {
    return { authorisedRole: 'IMPLEMENTER', authorisedAgent: state.implementer };
  }
  if (phase === 'REVIEW_INITIAL' || phase === 'REVIEW_FINAL') {
    return { authorisedRole: 'REVIEWER', authorisedAgent: state.reviewer };
  }
  return { authorisedRole: 'CONTROLLER', authorisedAgent: 'controller' };
}

export function enterPhase(state, phase, stopReason = null) {
  invariant(ALL_PHASES.includes(phase), 'PHASE_INVALID', `Unknown phase ${phase}`);
  return {
    ...state,
    phase,
    ...roleForPhase(state, phase),
    nextAction: NEXT_ACTIONS[phase],
    stopReason,
  };
}

export function transitionWithArtifact(state, type, artifact, artifactPath) {
  const next = {
    ...state,
    artifacts: { ...state.artifacts },
    actionCount: (state.actionCount ?? 0) + 1,
  };

  if (state.phase === 'IMPLEMENT' && type === 'implementationReport') {
    next.artifacts.implementationReport = artifactPath;
    return enterPhase(next, 'REVIEW_INITIAL');
  }

  if (state.phase === 'REVIEW_INITIAL' && type === 'initialReview') {
    invariant(
      state.reviewRound === 0,
      'INITIAL_REVIEW_LIMIT_REACHED',
      'The single initial-review pass has already been used',
    );
    next.reviewRound = 1;
    next.reviewedHeadSha = artifact.reviewedHeadSha;
    next.artifacts.initialReview = artifactPath;
    next.openBlockingFindingIds = artifact.findings
      .filter((finding) => finding.blocking)
      .map((finding) => finding.findingId);
    next.deferredFindingIds = artifact.findings
      .filter((finding) => !finding.blocking)
      .map((finding) => finding.findingId);
    if (artifact.verdict === 'APPROVED') {
      return enterPhase(next, 'READY_TO_COMMIT');
    }
    if (artifact.verdict === 'NEEDS_REVISION') {
      return enterPhase(next, 'FIX_BLOCKING_FINDINGS');
    }
    return enterPhase(next, 'BLOCKED', 'INITIAL_REVIEW_BLOCKED');
  }

  if (state.phase === 'FIX_BLOCKING_FINDINGS' && type === 'correctionReport') {
    invariant(
      state.correctionRound === 0,
      'CORRECTION_LIMIT_REACHED',
      'The single correction pass has already been used',
    );
    next.correctionRound = 1;
    next.artifacts.correctionReport = artifactPath;
    return enterPhase(next, 'REVIEW_FINAL');
  }

  if (state.phase === 'REVIEW_FINAL' && type === 'finalReview') {
    invariant(
      state.reviewRound === 1,
      'FINAL_REVIEW_LIMIT_REACHED',
      'The final review requires exactly one prior initial review',
    );
    next.reviewRound = 2;
    next.reviewedHeadSha = artifact.reviewedHeadSha;
    next.artifacts.finalReview = artifactPath;
    if (artifact.verdict === 'APPROVED') {
      next.openBlockingFindingIds = [];
      return enterPhase(next, 'READY_TO_COMMIT');
    }
    if (artifact.verdict === 'HUMAN_DECISION_REQUIRED') {
      return enterPhase(next, 'HUMAN_DECISION_REQUIRED', 'FINAL_REVIEW_REQUIRES_HUMAN');
    }
    return enterPhase(next, 'BLOCKED', 'FINAL_REVIEW_BLOCKED');
  }

  throw new ControllerError(
    'TRANSITION_NOT_ALLOWED',
    `Artefact ${type} cannot advance phase ${state.phase}`,
  );
}

export function initialiseNextBatch(state, batch, currentHead) {
  invariant(
    state.phase === 'ADVANCE_BATCH',
    'TRANSITION_NOT_ALLOWED',
    'The next batch may start only from ADVANCE_BATCH',
  );
  const next = {
    ...state,
    activeBatch: batch.batchId,
    batchPlanPath: batch.planPath,
    baseSha: batch.baseSha ?? currentHead,
    reviewedHeadSha: null,
    reviewRound: 0,
    correctionRound: 0,
    openBlockingFindingIds: [],
    deferredFindingIds: [],
    artifacts: {
      implementationReport: null,
      initialReview: null,
      correctionReport: null,
      finalReview: null,
    },
    requiredAcceptanceCriteria: batch.acceptanceCriteria ?? [],
    mergeBlockingCriteria: batch.mergeBlockingCriteria ?? [],
    commitMessage: batch.commitMessage ?? null,
    approvalSnapshot: null,
    approvedCommitSha: null,
    pushedCommitSha: null,
    lastInvocation: null,
  };
  return enterPhase(next, 'IMPLEMENT');
}
