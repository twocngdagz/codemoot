import type { ReviewGatedConfig } from '../types/config.js';

export const COMPATIBILITY_REVIEW_GATED_CONFIG: ReviewGatedConfig = {
  identity: {
    minimumAssurance: 'config_only',
    requireDifferentAdapterKinds: false,
    prohibitSharedSessions: true,
  },
  commit: {
    mode: 'human_required',
    agentMayCommit: false,
  },
  gates: {
    planReview: 'required',
    codeReview: 'required',
    verification: 'required',
    humanMerge: 'required',
    blockingSeverities: ['critical', 'high'],
    requireAllFindingResponses: true,
    requireAcceptedAttestations: true,
  },
  pacing: {
    maxCodeReviewRounds: 3,
    maxCorrectionPasses: 2,
    deferNonBlockingFindings: true,
    unresolvedAfterFinalReview: 'human_decision_required',
  },
  autonomous: {
    maxPlanReviewRoundsPerBatch: 2,
    maxCodeReviewRoundsPerBatch: 3,
    maxCorrectionPassesPerBatch: 2,
    maxVerificationAttemptsPerCommand: 2,
    maxFinalAuditsPerBatch: 1,
    maxAgentInvocationsPerBatch: 12,
    maxTotalAgentInvocations: 100,
    maxBatchRuntimeMinutes: 240,
    maxWorkflowRuntimeMinutes: 1440,
    maxConsecutiveNoProgressActions: 2,
    maxInputTokensPerBatch: 500_000,
    maxOutputTokensPerBatch: 100_000,
    maxCostUsdPerWorkflow: 25,
    heartbeatIntervalSeconds: 30,
    heartbeatExpirySeconds: 120,
  },
};
