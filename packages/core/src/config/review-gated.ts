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
};
