// packages/core/src/types/config.ts

export type ModelProvider = 'openai' | 'anthropic';

export type CliAdapterKind = 'codex' | 'claude';

export interface CliAdapterConfig {
  kind?: CliAdapterKind;
  command: string;
  args: string[];
  timeout: number;
  versionConstraint?: string;
  outputFile?: string;
  maxOutputBytes?: number;
  envAllowlist?: string[];
}

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  maxTokens: number;
  temperature: number;
  timeout: number;
  cliAdapter?: CliAdapterConfig;
}

export interface RoleConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPromptFile?: string;
}

export interface DebateConfig {
  enabled?: boolean;
  defaultPattern: DebatePattern;
  maxRounds: number;
  consensusThreshold: number;
}

export type DebatePattern =
  | 'structured-rounds'
  | 'proposal-critique'
  | 'free-flowing'
  | 'parallel-panel';

export interface MemoryConfig {
  embeddingModel?: string;
  autoExtractFacts: boolean;
  contextBudget: {
    activeContext: number;
    retrievedMemory: number;
    messageBuffer: number;
  };
}

export interface BudgetConfig {
  perSession: number;
  perDay: number;
  perMonth: number;
  warningAt: number;
  action: 'warn' | 'pause' | 'block';
}

export interface OutputConfig {
  saveTranscripts: boolean;
  transcriptFormat: 'markdown' | 'json';
  transcriptDir: string;
}

export type ReviewGatedIdentityAssurance =
  | 'authenticated_subject'
  | 'cli_asserted'
  | 'process_attested'
  | 'config_only';

export interface ReviewGatedIdentityConfig {
  minimumAssurance: ReviewGatedIdentityAssurance;
  requireDifferentAdapterKinds: boolean;
  prohibitSharedSessions: boolean;
}

export type ReviewGatedCommitMode = 'human_required' | 'agent_authorized' | 'either';

export interface ReviewGatedCommitConfig {
  mode: ReviewGatedCommitMode;
  agentMayCommit: boolean;
}

export type ReviewGatedBlockingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ReviewGatedGateConfig {
  planReview: 'required';
  codeReview: 'required';
  verification: 'required';
  humanMerge: 'required';
  blockingSeverities: ReviewGatedBlockingSeverity[];
  requireAllFindingResponses: boolean;
  requireAcceptedAttestations: boolean;
}

export interface ReviewGatedPacingConfig {
  maxCodeReviewRounds: number;
  maxCorrectionPasses: number;
  deferNonBlockingFindings: true;
  unresolvedAfterFinalReview: 'human_decision_required';
}

export interface ReviewGatedAutonomousConfig {
  maxPlanReviewRoundsPerBatch: number;
  maxCodeReviewRoundsPerBatch: number;
  maxCorrectionPassesPerBatch: number;
  maxVerificationAttemptsPerCommand: number;
  maxFinalAuditsPerBatch: number;
  maxAgentInvocationsPerBatch: number;
  maxTotalAgentInvocations: number;
  maxBatchRuntimeMinutes: number;
  maxWorkflowRuntimeMinutes: number;
  maxConsecutiveNoProgressActions: number;
  maxInputTokensPerBatch: number;
  maxOutputTokensPerBatch: number;
  maxCostUsdPerWorkflow: number;
  heartbeatIntervalSeconds: number;
  heartbeatExpirySeconds: number;
}

export interface ReviewGatedConfig {
  identity: ReviewGatedIdentityConfig;
  commit: ReviewGatedCommitConfig;
  gates: ReviewGatedGateConfig;
  pacing: ReviewGatedPacingConfig;
  autonomous: ReviewGatedAutonomousConfig;
}

export interface ProjectConfig {
  configVersion?: number;
  project: {
    name: string;
    description: string;
  };
  models: Record<string, ModelConfig>;
  roles: Record<string, RoleConfig>;
  workflow: string;
  mode: ExecutionMode;
  debate: DebateConfig;
  reviewGated?: ReviewGatedConfig;
  memory: MemoryConfig;
  budget: BudgetConfig;
  output: OutputConfig;
  advanced: {
    retryAttempts: number;
    stream: boolean;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
}

export type ExecutionMode = 'autonomous' | 'interactive' | 'dashboard';
export type PresetName = 'cli-first' | 'review-gated';
