// @codemoot/core - Multi-model AI orchestration engine
// Sprint 1: Core engine + SQLite memory + model abstraction
// Sprint 2: CLI-first hybrid + MCP types + security + cancellation

export const VERSION = '0.2.14';

// Type definitions
export type {
  // Config
  ModelProvider,
  CliAdapterKind,
  ModelConfig,
  RoleConfig,
  DebateConfig,
  DebatePattern,
  MemoryConfig,
  BudgetConfig,
  OutputConfig,
  ProjectConfig,
  ExecutionMode,
  PresetName,
  CliAdapterConfig,
  ReviewGatedIdentityAssurance,
  ReviewGatedIdentityConfig,
  ReviewGatedCommitMode,
  ReviewGatedCommitConfig,
  ReviewGatedBlockingSeverity,
  ReviewGatedGateConfig,
  ReviewGatedPacingConfig,
  ReviewGatedConfig,
  // Workflow
  WorkflowDefinition,
  StepDefinition,
  StepType,
  LoopConfig,
  ResolvedWorkflow,
  ResolvedStep,
  // Events
  SessionStartedEvent,
  SessionCompletedEvent,
  SessionFailedEvent,
  StepStartedEvent,
  StepCompletedEvent,
  StepFailedEvent,
  TextDeltaEvent,
  TextDoneEvent,
  LoopIterationEvent,
  CostUpdateEvent,
  TokenUsage,
  EngineEvent,
  // Session
  SessionStatus,
  Session,
  TranscriptEntry,
  // Memory
  MemoryCategory,
  MemoryRecord,
  ArtifactType,
  ArtifactRecord,
  CostLogEntry,
  // Models
  ChatMessage,
  CallModelOptions,
  ModelCallResult,
  FallbackConfig,
  // MCP types
  ResultStatus,
  MeteringSource,
  ReviewResult,
  DebateResponse,
  DebateResult,
  ReviewInput,
  PlanInput,
  DebateInput,
  MemoryInput,
  CostInput,
  // Roles
  BuiltInRole,
  Role,
  // Cleanup
  CleanupScope,
  CleanupConfidence,
  CleanupFinding,
  CleanupReport,
  CleanupSource,
  // Build
  BuildPhase,
  BuildRun,
  BuildSummary,
  // Debate engine
  DebateEngineState,
  // Jobs
  JobType,
  JobStatus,
  JobRecord,
  JobLogRecord,
  EnqueueOptions,
} from './types/index.js';

export {
  ErrorCode,
  TerminalReason,
  DlpReasonCode,
  reviewInputSchema,
  planInputSchema,
  debateInputSchema,
  memoryInputSchema,
  costInputSchema,
  reviewOutputSchema,
  debateOutputSchema,
  workflowEventsInputSchema,
  workflowGateInputSchema,
  workflowJobsInputSchema,
  workflowStatusInputSchema,
} from './types/index.js';
export type {
  WorkflowEventsInput,
  WorkflowGateInput,
  WorkflowJobsInput,
  WorkflowStatusInput,
} from './types/index.js';

// Utilities
export {
  generateSessionId,
  generateId,
  ConfigError,
  ModelError,
  WorkflowError,
  DatabaseError,
  withRetry,
  createLogger,
  parseVerdict,
  sleep,
} from './utils/index.js';
export type { RetryOptions, Logger, LogLevel, VerdictResult } from './utils/index.js';
export {
  DEFAULT_TIMEOUT_SEC,
  CLEANUP_TIMEOUT_SEC,
  DEFAULT_MAX_TOKENS,
  IMPLEMENTER_MAX_TOKENS,
  MCP_CONTENT_MAX_LENGTH,
  MCP_TASK_MAX_LENGTH,
  MCP_TIMEOUT_MAX,
  HTTP_TOO_MANY_REQUESTS,
  DAYS_PER_YEAR,
  REVIEW_DIFF_MAX_CHARS,
  REVIEW_TEXT_MAX_CHARS,
  BINARY_SNIFF_BYTES,
  CONTEXT_ACTIVE,
  CONTEXT_RETRIEVED,
  CONTEXT_BUFFER,
  DLP_MAX_CONTENT,
  DLP_MAX_PROCESSING_MS,
} from './utils/constants.js';

// Configuration
export {
  DEFAULT_CONFIG,
  COMPATIBILITY_REVIEW_GATED_CONFIG,
  cliAdapterConfigSchema,
  cliAdapterKindSchema,
  modelConfigSchema,
  modelProviderSchema,
  projectConfigSchema,
  reviewGatedCommitConfigSchema,
  reviewGatedConfigSchema,
  reviewGatedGateConfigSchema,
  reviewGatedIdentityConfigSchema,
  reviewGatedPacingConfigSchema,
  validateConfig,
  loadPreset,
  listPresets,
  loadConfig,
  writeConfig,
  migrateConfig,
  CURRENT_VERSION,
  getReviewPreset,
  listPresetNames,
  REVIEW_PRESETS,
  createIgnoreFilter,
  loadIgnorePatterns,
  shouldIgnore,
} from './config/index.js';
export type { ProjectConfigInput, ReviewPreset } from './config/index.js';

// Memory / Database
export {
  openDatabase,
  runMigrations,
  getSchemaVersion,
  SessionStore,
  MemoryStore,
  ArtifactStore,
  CostStore,
  DebateStore,
  BuildStore,
  MessageStore,
  parseDebateVerdict,
  buildReconstructionPrompt,
  estimateTokens,
  calculateDebateTokens,
  getTokenBudgetStatus,
  preflightTokenCheck,
  SessionManager,
  JobStore,
  CacheStore,
  hashContent,
  hashConfig,
  reviewWorkflowPersistence,
} from './memory/index.js';
export type {
  CostSummary,
  DebateTurnRow,
  DebateTurnStatus,
  DebateMessageRow,
  MessageStatus,
  ParsedVerdict,
  UnifiedSession,
  SessionEvent,
  CacheEntry,
} from './memory/index.js';

// Model Abstraction (CLI-only)
export {
  ModelRegistry,
  callBridge,
  callModel,
  streamModel,
  withFallback,
  CostTracker,
  getModelPricing,
  calculateCost,
  CliAdapter,
  ClaudeCliAdapter,
  buildClaudeEnvironment,
  ClaudeCliProtocolError,
  SUPPORTED_CLAUDE_CLI_VERSION_RANGE,
  isSupportedClaudeCliVersion,
  parseClaudeCliStream,
  detectCli,
  clearDetectionCache,
  createCliAdapter,
  createModelAdapter,
  probeCliCommand,
  resolveModelAdapterKind,
} from './models/index.js';
export type {
  BridgeAdapterKind,
  BridgeCallResult,
  BridgeInvocationEvidence,
  BridgeSessionEvidence,
  TextDeltaEmitter,
  ModelPricing,
  ModelAdapter,
  ModelAdapterHealth,
  CliCallOptions,
  CodexCallResult,
  CodexInvocationEvidence,
  CodexSessionEvidence,
  ClaudeCallOptions,
  ClaudeCallResult,
  ClaudeInvocationEvidence,
  ClaudeSessionEvidence,
  ParsedClaudeCliOutput,
  CliDetectionResult,
  ProgressCallbacks,
  CliBridge,
  BridgeCapabilities,
  BridgeOptions,
  BridgeResumeOptions,
  CliProbeResult,
  CliRuntimeEvidence,
} from './models/index.js';

// Roles
export {
  ROLE_INVOCATION_ERROR_CODES,
  RoleInvocationError,
  RoleInvocationService,
  RoleManager,
  renderPrompt,
} from './roles/index.js';
export type {
  PreparedRoleInvocation,
  PromptType,
  PromptVariables,
  ResolvedRoleAdapter,
  ReviewWorkflowRoleResolution,
  RoleInvocationErrorCode,
  RoleInvocationInput,
  RoleInvocationResult,
} from './roles/index.js';

// Engine (Workflow + Execution)
export {
  EventBus,
  LoopController,
  Orchestrator,
  StepRunner,
  WorkflowEngine,
  CancellationToken,
  CancellationError,
  evaluatePolicy,
  DEFAULT_RULES,
} from './engine/index.js';
export type {
  DebateOptions,
  LoopResult,
  OrchestratorOptions,
  PlanOptions,
  ReviewOptions,
  RunOptions,
  SessionResult,
  StepResult,
  PolicyRule,
  PolicyContext,
  PolicyResult,
  PolicyMode,
  PolicyDecision,
} from './engine/index.js';

// Context Builder
export { ContextBuilder, buildHandoffEnvelope } from './context/index.js';
export type {
  AssembledContext,
  ContextBudget,
  ContextBuilderOptions,
  HandoffCommand,
  HandoffEnvelopeOptions,
} from './context/index.js';

// Cleanup Scanners
export {
  scanUnusedDeps,
  scanUnusedExports,
  scanHardcoded,
  scanDuplicates,
  scanDeadCode,
  scanSecurity,
  scanNearDuplicates,
  scanAntiPatterns,
  runAllScanners,
  mergeThreeWay,
  mergeTwoWay,
  computeThreeWayStats,
  computeTwoWayStats,
  recalculateConfidenceStats,
  hostFindingsSchema,
} from './cleanup/index.js';
export type { HostFindingInput } from './cleanup/index.js';

// Security (DLP + Retry)
export {
  withCanonicalRetry,
  isRetryable,
  isRateLimit,
  sanitize,
  DEFAULT_DLP_CONFIG,
} from './security/index.js';
export type {
  RetryConfig,
  AttemptResult,
  DlpMode,
  DlpResult,
  DlpRedaction,
  DlpAuditEntry,
  DlpConfig,
} from './security/index.js';

// Review-gated workflow domain kernel
export * as reviewWorkflow from './review-workflow/index.js';
export * as reviewWorkflowContracts from './review-workflow-contracts/index.js';
export * as reviewWorkflowGit from './review-workflow-git/index.js';
export * as reviewWorkflowIdentity from './review-workflow-identity/index.js';
export * as reviewWorkflowBaseline from './review-workflow-baseline/index.js';
export * as reviewWorkflowVerification from './review-workflow-verification/index.js';
export * as reviewWorkflowPlan from './review-workflow-plan/index.js';
export * as reviewWorkflowGate from './review-workflow-gate/index.js';
export * as reviewWorkflowImplementation from './review-workflow-implementation/index.js';
export * as reviewWorkflowJobs from './review-workflow-jobs/index.js';
export * as reviewWorkflowRunner from './review-workflow-runner/index.js';
