// Contracts for the autonomous workflow runner: finite limits, durable state, stable stop
// reasons, and an injected phase surface so the loop is deterministic and testable. The
// runner orchestrates the EXISTING coordinators — it never redefines workflow semantics.

import type { ReviewGatedAutonomousConfig } from '../types/config.js';

export const RUNNER_STOP_REASONS = [
  'PLAN_REVIEW_LIMIT_REACHED',
  'CODE_REVIEW_LIMIT_REACHED',
  'CORRECTION_LIMIT_REACHED',
  'VERIFICATION_LIMIT_REACHED',
  'FINAL_AUDIT_LIMIT_REACHED',
  'INVOCATION_LIMIT_REACHED',
  'BATCH_RUNTIME_LIMIT_REACHED',
  'WORKFLOW_RUNTIME_LIMIT_REACHED',
  'NO_PROGRESS_LIMIT_REACHED',
  'TOKEN_BUDGET_REACHED',
  'COST_BUDGET_REACHED',
  'WORKER_HEARTBEAT_EXPIRED',
  'OUTCOME_UNKNOWN',
  'SESSION_CONTINUITY_FAILURE',
  'AUTHENTICATION_REQUIRED',
  'PUSH_FAILED',
  'HUMAN_DECISION_REQUIRED',
] as const;
export type RunnerStopReason = (typeof RUNNER_STOP_REASONS)[number];

export const RUNNER_STATUSES = [
  'RUNNING',
  'PAUSE_REQUESTED',
  'PAUSED_BY_USER',
  'HUMAN_DECISION_REQUIRED',
  'CANCELLED',
  'READY_FOR_HUMAN_VERIFICATION',
  'FAILED',
] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

export const RUNNER_PHASES = [
  'PLAN_REFINEMENT',
  'PLAN_REVIEW',
  'PLAN_REVISION',
  'IMPLEMENTATION',
  'COMMIT',
  'CODE_REVIEW',
  'CORRECTION',
  'VERIFICATION',
  'FINAL_AUDIT',
  'GATE',
  'PUSH',
] as const;
export type RunnerPhase = (typeof RUNNER_PHASES)[number];

export const HUMAN_DECISION_ACTIONS = [
  'FIX_AGAIN',
  'ACCEPT_RISK_AND_CONTINUE',
  'CANCEL_WORKFLOW',
] as const;
export type HumanDecisionAction = (typeof HUMAN_DECISION_ACTIONS)[number];

export class RunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

export interface RunnerBatchCounters {
  readonly ordinal: number;
  readonly batchId: string;
  planReviewRounds: number;
  codeReviewRounds: number;
  correctionPasses: number;
  finalAudits: number;
  verificationAttempts: Record<string, number>;
  noProgressStreak: number;
  batchStartedAt: string;
  deferredFindingIds: string[];
  acceptedRiskFindingIds: string[];
  /** The exact unresolved blocking set at the moment the batch stopped; validates ACCEPT_RISK. */
  outstandingBlockingFindingIds: string[];
}

/** Immutable completion summary retained per batch for the final workflow report. */
export interface RunnerBatchSummary {
  readonly ordinal: number;
  readonly batchId: string;
  readonly planReviewRounds: number;
  readonly codeReviewRounds: number;
  readonly correctionPasses: number;
  readonly finalAudits: number;
  readonly verificationAttempts: Record<string, number>;
  readonly deferredFindingIds: readonly string[];
  readonly acceptedRiskFindingIds: readonly string[];
  readonly completedAt: string;
  readonly pushedCommitSha: string;
}

export interface RunnerCounters {
  batch: RunnerBatchCounters | null;
  completedOrdinals: number[];
  completedBatches: RunnerBatchSummary[];
  /** Set by an explicit human decision; consumed once by the resumed run. */
  pendingDecision?: HumanDecisionAction;
  /**
   * Human-authorised, additive token-budget extensions. The frozen per-workflow limits are
   * never edited — a grant sits beside them, so the contract the workflow started under
   * stays legible next to what a human later permitted.
   */
  budgetGrants: { inputTokens: number; outputTokens: number };
}

/**
 * The agent invocation currently in flight, persisted for live monitoring AND crash
 * classification: PREPARING means the external agent process never spawned (safe to
 * restart); AGENT_RUNNING means the agent ran and its outcome is unknown until the
 * response and receipt become durable (never auto-repeated).
 */
export interface RunnerActiveInvocation {
  readonly invocationId: string;
  readonly role?: string | null;
  readonly adapterKind: string;
  readonly model: string;
  readonly phase?: string | null;
  readonly startedAt: string;
  readonly stage: 'PREPARING' | 'AGENT_RUNNING';
}

/** Repository state captured at pause time and verified on resume. */
export interface RunnerPausedRepoState {
  readonly headSha: string;
  readonly clean: boolean;
  readonly statusFingerprint: string;
}

export interface RunnerState {
  readonly workflowId: string;
  /** The limits frozen at workflow start; later config edits never change enforcement. */
  readonly limits?: RunnerConfig;
  /** Set while an agent invocation is in flight; null between invocations. */
  readonly activeInvocation?: RunnerActiveInvocation;
  /** Captured when the workflow pauses; compared and cleared on resume. */
  readonly pausedRepo?: RunnerPausedRepoState;
  readonly status: RunnerStatus;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly totalBatches: number;
  readonly currentOrdinal?: number;
  readonly phase?: string;
  readonly reviewRound?: number;
  readonly correctionPass?: number;
  readonly phaseStartedAt?: string;
  readonly lastHeartbeatAt?: string;
  readonly lastCheckpoint?: string;
  readonly stopReason?: string;
  readonly stopDetails?: string;
  readonly notified: boolean;
  readonly workerId?: string;
  readonly leaseExpiresAt?: string;
  readonly counters: RunnerCounters;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface RunnerLogEntry {
  readonly logId: number;
  readonly workflowId: string;
  readonly batchId?: string;
  readonly entryType: 'HEARTBEAT' | 'CHECKPOINT' | 'STOP' | 'DECISION' | 'NOTIFICATION';
  readonly phase?: string;
  readonly message: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface RiskDecisionRecord {
  readonly decisionId: string;
  readonly workflowId: string;
  readonly batchId?: string;
  readonly action: HumanDecisionAction;
  readonly actor: string;
  readonly findingIds: readonly string[];
  readonly rationale: string;
  readonly commitSha: string;
  readonly createdAt: string;
}

export interface RunnerBatchDescriptor {
  readonly ordinal: number;
  readonly batchId: string;
}

/** Git operations the runner is permitted: branch create, verify, push. Nothing else. */
export interface RunnerGit {
  currentBranch(): string;
  headSha(): string;
  isClean(): boolean;
  createBranch(name: string): void;
  push(branch: string): void;
  remoteHeadSha(branch: string): string | null;
  /** Local SHA of an arbitrary ref — used to prove the base branch was never touched. */
  refSha(ref: string): string;
  /** Stable fingerprint of the worktree/index status — detects paused-state drift. */
  statusFingerprint(): string;
}

/** Where a (possibly restarted) batch re-enters its stage sequence, derived from domain state. */
export const RUNNER_BATCH_STAGES = [
  'PLAN_REVIEW',
  'IMPLEMENTATION',
  'CODE_REVIEW',
  'VERIFICATION',
  'PUSH',
  'COMPLETE',
  'BLOCKED',
] as const;
export type RunnerBatchStage = (typeof RUNNER_BATCH_STAGES)[number];

/**
 * The injected phase surface. Every method drives the EXISTING coordinators; the runner
 * only sequences, counts, and stops. Implementations must be idempotent per the underlying
 * command receipts.
 */
export interface RunnerPhases {
  refinePlan(): Promise<readonly RunnerBatchDescriptor[]>;
  reviewPlan(batch: RunnerBatchDescriptor, round: number): Promise<{ approved: boolean }>;
  revisePlan(batch: RunnerBatchDescriptor, round: number): Promise<void>;
  implement(batch: RunnerBatchDescriptor): Promise<{ commitSha: string }>;
  reviewCode(
    batch: RunnerBatchDescriptor,
    round: number,
  ): Promise<{ approved: boolean; blockingFindingIds: readonly string[] }>;
  correct(
    batch: RunnerBatchDescriptor,
    pass: number,
    blockingFindingIds: readonly string[],
  ): Promise<{ commitSha: string }>;
  verificationCommandCount(batch: RunnerBatchDescriptor): number;
  verify(
    batch: RunnerBatchDescriptor,
    commandIndex: number,
    attempt: number,
  ): Promise<{ accepted: boolean; resultFingerprint: string }>;
  finalAudit(batch: RunnerBatchDescriptor): Promise<{ approved: boolean }>;
  gate(
    batch: RunnerBatchDescriptor,
  ): Promise<{ approved: boolean; failedConditions: readonly string[] }>;
  /** Derives the batch's authoritative re-entry stage from persisted domain state. */
  resumeStage(batch: RunnerBatchDescriptor): Promise<RunnerBatchStage>;
  /** Durable pacing usage and human-granted extensions, derived from coordinator events. */
  usedPacing(batch: RunnerBatchDescriptor): Promise<RunnerUsedPacing>;
  /**
   * Applies a consumed human decision to the DOMAIN state: resumes a BLOCKED batch
   * (FIX_AGAIN grants one review round + correction pass) and records SHA-bound
   * ACCEPT_FINDINGS_RISK so the kernel and gate honour the decision.
   */
  applyDecision(
    batch: RunnerBatchDescriptor,
    action: HumanDecisionAction,
    decision: RiskDecisionRecord,
  ): Promise<void>;
  /** Workflow-wide completion audit: batch states, approval validity, unresolved blockers, audit coverage. */
  workflowAudit(): Promise<RunnerWorkflowAuditResult>;
}

export interface RunnerUsedPacing {
  readonly planReviewRounds: number;
  readonly codeReviewRounds: number;
  readonly correctionPasses: number;
  readonly grantedReviewRounds: number;
  readonly grantedCorrectionPasses: number;
}

export interface RunnerWorkflowAuditResult {
  readonly approved: boolean;
  readonly issues: readonly string[];
  /** Workflow-level verification re-run at the final HEAD. */
  readonly verification?: readonly {
    readonly command: string;
    readonly ok: boolean;
    readonly exitCode: number | null;
  }[];
}

export interface RunnerHooks {
  /** Owner notification — called at most once per stop. Never called for ordinary progress. */
  notify(message: string): void;
}

export interface RunnerScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RunnerRunResult {
  readonly status: RunnerStatus;
  readonly stopReason?: RunnerStopReason;
  readonly stopDetails?: string;
}

export type RunnerConfig = ReviewGatedAutonomousConfig;

/** The immutable coordinator pacing contract; runner limits may never exceed it. */
export interface RunnerContractPacing {
  readonly maxCodeReviewRounds: number;
  readonly maxCorrectionPasses: number;
}

export interface RunnerOptions {
  readonly contract?: RunnerContractPacing;
  /**
   * Trusted-operator mode: the CURRENT configuration limits apply rather than the ones
   * frozen at workflow start. Opt-in only, and never inferred — the assumption it changes
   * is about who is in the room.
   */
  readonly trustedOperator?: boolean;
  /** Stable identity of this worker process; required for the exclusive lease. */
  readonly workerId?: string;
  readonly leaseSeconds?: number;
}
