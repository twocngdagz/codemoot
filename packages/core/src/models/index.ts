// packages/core/src/models -- Model abstraction layer (Vercel AI SDK 6)

export {
  ModelRegistry,
  createCliAdapter,
  createModelAdapter,
  resolveModelAdapterKind,
} from './registry.js';
export type { ModelAdapter, ModelAdapterHealth } from './registry.js';
export { callModel, streamModel } from './caller.js';
export type { TextDeltaEmitter } from './caller.js';
export { withFallback } from './fallback.js';
export { CostTracker } from './cost-tracker.js';
export { getModelPricing, calculateCost } from './pricing.js';
export type { ModelPricing } from './pricing.js';
export {
  CliAdapter,
  buildFilteredEnv,
  estimateTokenUsage,
  killProcessTree,
  parseCodexJsonl,
} from './cli-adapter.js';
export type {
  CliCallOptions,
  CodexCallResult,
  CodexInvocationEvidence,
  CodexSessionEvidence,
  ResumeCallOptions,
  ProgressCallbacks,
} from './cli-adapter.js';
export {
  ClaudeCliAdapter,
  buildClaudeEnvironment,
} from './claude-cli-adapter.js';
export type {
  ClaudeCallOptions,
  ClaudeCallResult,
  ClaudeInvocationEvidence,
  ClaudeSessionEvidence,
} from './claude-cli-adapter.js';
export {
  ClaudeCliProtocolError,
  SUPPORTED_CLAUDE_CLI_VERSION_RANGE,
  isSupportedClaudeCliVersion,
  parseClaudeCliStream,
} from './claude-cli-protocol.js';
export type { ParsedClaudeCliOutput } from './claude-cli-protocol.js';
export { detectCli, clearDetectionCache } from './cli-detector.js';
export type { CliDetectionResult } from './cli-detector.js';
export type {
  BridgeAdapterKind,
  BridgeCallResult,
  CliBridge,
  BridgeCapabilities,
  BridgeInvocationEvidence,
  BridgeOptions,
  BridgeResumeOptions,
  BridgeSessionEvidence,
} from './bridge.js';
export { callBridge } from './bridge.js';
export { probeCliCommand } from './cli-runtime-evidence.js';
export type { CliProbeResult, CliRuntimeEvidence } from './cli-runtime-evidence.js';
