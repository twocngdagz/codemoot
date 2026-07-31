// Durable runner state, append-only progress log (heartbeats, checkpoints, stops,
// decisions), immutable risk decisions, and audit-derived budget aggregates.

import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  HUMAN_DECISION_ACTIONS,
  RUNNER_STATUSES,
  type RiskDecisionRecord,
  type RunnerActiveInvocation,
  type RunnerConfig,
  type RunnerCounters,
  RunnerError,
  type RunnerLogEntry,
  type RunnerState,
} from './types.js';

/** Frozen-limit shape persisted at workflow start; enforcement never re-reads config. */
const activeInvocationSchema = z.object({
  invocationId: z.string().min(1),
  role: z.string().nullable().optional(),
  adapterKind: z.string().min(1),
  model: z.string().min(1),
  phase: z.string().nullable().optional(),
  startedAt: z.string().min(1),
});

const limitsSchema = z.object({
  maxPlanReviewRoundsPerBatch: z.number(),
  maxCodeReviewRoundsPerBatch: z.number(),
  maxCorrectionPassesPerBatch: z.number(),
  maxVerificationAttemptsPerCommand: z.number(),
  maxFinalAuditsPerBatch: z.number(),
  maxAgentInvocationsPerBatch: z.number(),
  maxTotalAgentInvocations: z.number(),
  maxBatchRuntimeMinutes: z.number(),
  maxWorkflowRuntimeMinutes: z.number(),
  maxConsecutiveNoProgressActions: z.number(),
  maxInputTokensPerBatch: z.number(),
  maxOutputTokensPerBatch: z.number(),
  maxCostUsdPerWorkflow: z.number(),
  heartbeatIntervalSeconds: z.number(),
  heartbeatExpirySeconds: z.number(),
});

const stateRowSchema = z.object({
  workflow_id: z.string().min(1),
  status: z.enum(RUNNER_STATUSES),
  branch: z.string().min(1),
  base_branch: z.string().min(1),
  base_sha: z.string().min(1),
  total_batches: z.number().int().nonnegative(),
  current_ordinal: z.number().int().nullable(),
  phase: z.string().nullable(),
  review_round: z.number().int().nullable(),
  correction_pass: z.number().int().nullable(),
  phase_started_at: z.string().nullable(),
  last_heartbeat_at: z.string().nullable(),
  last_checkpoint: z.string().nullable(),
  stop_reason: z.string().nullable(),
  stop_details: z.string().nullable(),
  notified: z.number().int(),
  worker_id: z.string().nullable(),
  lease_expires_at: z.string().nullable(),
  limits_json: z.string().nullable(),
  active_invocation_json: z.string().nullable(),
  counters_json: z.string().min(1),
  started_at: z.string().min(1),
  updated_at: z.string().min(1),
});

const logRowSchema = z.object({
  log_id: z.number().int(),
  workflow_id: z.string().min(1),
  batch_id: z.string().nullable(),
  entry_type: z.enum(['HEARTBEAT', 'CHECKPOINT', 'STOP', 'DECISION', 'NOTIFICATION']),
  phase: z.string().nullable(),
  message: z.string(),
  payload_json: z.string().nullable(),
  created_at: z.string().min(1),
});

const decisionRowSchema = z.object({
  decision_id: z.string().min(1),
  workflow_id: z.string().min(1),
  batch_id: z.string().nullable(),
  action: z.enum(HUMAN_DECISION_ACTIONS),
  actor: z.string().min(1),
  finding_ids_json: z.string().min(1),
  rationale: z.string().min(1),
  commit_sha: z.string().min(1),
  created_at: z.string().min(1),
});

const countersSchema = z.object({
  batch: z
    .object({
      ordinal: z.number().int().positive(),
      batchId: z.string().min(1),
      planReviewRounds: z.number().int().nonnegative(),
      codeReviewRounds: z.number().int().nonnegative(),
      correctionPasses: z.number().int().nonnegative(),
      finalAudits: z.number().int().nonnegative(),
      verificationAttempts: z.record(z.string(), z.number().int().nonnegative()),
      noProgressStreak: z.number().int().nonnegative(),
      batchStartedAt: z.string().min(1),
      deferredFindingIds: z.array(z.string()),
      acceptedRiskFindingIds: z.array(z.string()),
      outstandingBlockingFindingIds: z.array(z.string()).default([]),
    })
    .nullable(),
  completedOrdinals: z.array(z.number().int().positive()),
  completedBatches: z
    .array(
      z.object({
        ordinal: z.number().int().positive(),
        batchId: z.string().min(1),
        planReviewRounds: z.number().int().nonnegative(),
        codeReviewRounds: z.number().int().nonnegative(),
        correctionPasses: z.number().int().nonnegative(),
        finalAudits: z.number().int().nonnegative(),
        verificationAttempts: z.record(z.string(), z.number().int().nonnegative()),
        deferredFindingIds: z.array(z.string()),
        acceptedRiskFindingIds: z.array(z.string()),
        completedAt: z.string().min(1),
        pushedCommitSha: z.string().min(1),
      }),
    )
    .default([]),
  pendingDecision: z.enum(HUMAN_DECISION_ACTIONS).optional(),
});

type Clock = () => Date;

export class ReviewWorkflowRunnerStore {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock = () => new Date(),
  ) {}

  initState(input: {
    readonly workflowId: string;
    readonly branch: string;
    readonly baseBranch: string;
    readonly baseSha: string;
    readonly limits?: RunnerConfig;
  }): RunnerState {
    const now = this.timestamp();
    const counters: RunnerCounters = { batch: null, completedOrdinals: [], completedBatches: [] };
    this.db
      .prepare(
        `INSERT INTO review_workflow_runner_state (
          workflow_id, status, branch, base_branch, base_sha, total_batches,
          notified, limits_json, counters_json, started_at, updated_at
        ) VALUES (?, 'RUNNING', ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        input.workflowId,
        input.branch,
        input.baseBranch,
        input.baseSha,
        input.limits === undefined ? null : JSON.stringify(input.limits),
        JSON.stringify(counters),
        now,
        now,
      );
    return this.require(input.workflowId);
  }

  get(workflowId: string): RunnerState | null {
    const row = this.db
      .prepare('SELECT * FROM review_workflow_runner_state WHERE workflow_id = ?')
      .get(workflowId);
    if (row === undefined) return null;
    const parsed = stateRowSchema.parse(row);
    return {
      workflowId: parsed.workflow_id,
      status: parsed.status,
      branch: parsed.branch,
      baseBranch: parsed.base_branch,
      baseSha: parsed.base_sha,
      totalBatches: parsed.total_batches,
      ...(parsed.current_ordinal === null ? {} : { currentOrdinal: parsed.current_ordinal }),
      ...(parsed.phase === null ? {} : { phase: parsed.phase }),
      ...(parsed.review_round === null ? {} : { reviewRound: parsed.review_round }),
      ...(parsed.correction_pass === null ? {} : { correctionPass: parsed.correction_pass }),
      ...(parsed.phase_started_at === null ? {} : { phaseStartedAt: parsed.phase_started_at }),
      ...(parsed.last_heartbeat_at === null ? {} : { lastHeartbeatAt: parsed.last_heartbeat_at }),
      ...(parsed.last_checkpoint === null ? {} : { lastCheckpoint: parsed.last_checkpoint }),
      ...(parsed.stop_reason === null ? {} : { stopReason: parsed.stop_reason }),
      ...(parsed.stop_details === null ? {} : { stopDetails: parsed.stop_details }),
      notified: parsed.notified === 1,
      ...(parsed.limits_json === null
        ? {}
        : { limits: limitsSchema.parse(JSON.parse(parsed.limits_json)) }),
      ...(parsed.active_invocation_json === null
        ? {}
        : {
            activeInvocation: activeInvocationSchema.parse(
              JSON.parse(parsed.active_invocation_json),
            ),
          }),
      ...(parsed.worker_id === null ? {} : { workerId: parsed.worker_id }),
      ...(parsed.lease_expires_at === null ? {} : { leaseExpiresAt: parsed.lease_expires_at }),
      counters: countersSchema.parse(JSON.parse(parsed.counters_json)),
      startedAt: parsed.started_at,
      updatedAt: parsed.updated_at,
    };
  }

  require(workflowId: string): RunnerState {
    const state = this.get(workflowId);
    if (state === null) {
      throw new RunnerError('RUNNER_STATE_MISSING', `Workflow ${workflowId} has no runner state`);
    }
    return state;
  }

  update(
    workflowId: string,
    patch: Partial<{
      status: RunnerState['status'];
      totalBatches: number;
      currentOrdinal: number | null;
      phase: string | null;
      reviewRound: number | null;
      correctionPass: number | null;
      phaseStartedAt: string | null;
      lastHeartbeatAt: string | null;
      lastCheckpoint: string | null;
      stopReason: string | null;
      stopDetails: string | null;
      notified: boolean;
      workerId: string | null;
      leaseExpiresAt: string | null;
      activeInvocation: RunnerActiveInvocation | null;
      counters: RunnerCounters;
    }>,
  ): RunnerState {
    const columns: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      columns.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.totalBatches !== undefined) set('total_batches', patch.totalBatches);
    if (patch.currentOrdinal !== undefined) set('current_ordinal', patch.currentOrdinal);
    if (patch.phase !== undefined) set('phase', patch.phase);
    if (patch.reviewRound !== undefined) set('review_round', patch.reviewRound);
    if (patch.correctionPass !== undefined) set('correction_pass', patch.correctionPass);
    if (patch.phaseStartedAt !== undefined) set('phase_started_at', patch.phaseStartedAt);
    if (patch.lastHeartbeatAt !== undefined) set('last_heartbeat_at', patch.lastHeartbeatAt);
    if (patch.lastCheckpoint !== undefined) set('last_checkpoint', patch.lastCheckpoint);
    if (patch.stopReason !== undefined) set('stop_reason', patch.stopReason);
    if (patch.stopDetails !== undefined) set('stop_details', patch.stopDetails);
    if (patch.notified !== undefined) set('notified', patch.notified ? 1 : 0);
    if (patch.workerId !== undefined) set('worker_id', patch.workerId);
    if (patch.leaseExpiresAt !== undefined) set('lease_expires_at', patch.leaseExpiresAt);
    if (patch.activeInvocation !== undefined)
      set(
        'active_invocation_json',
        patch.activeInvocation === null ? null : JSON.stringify(patch.activeInvocation),
      );
    if (patch.counters !== undefined) set('counters_json', JSON.stringify(patch.counters));
    set('updated_at', this.timestamp());
    this.db
      .prepare(
        `UPDATE review_workflow_runner_state SET ${columns.join(', ')} WHERE workflow_id = ?`,
      )
      .run(...values, workflowId);
    return this.require(workflowId);
  }

  appendLog(entry: {
    readonly workflowId: string;
    readonly batchId?: string;
    readonly entryType: RunnerLogEntry['entryType'];
    readonly phase?: string;
    readonly message: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO review_workflow_runner_log (
          workflow_id, batch_id, entry_type, phase, message, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.workflowId,
        entry.batchId ?? null,
        entry.entryType,
        entry.phase ?? null,
        entry.message,
        entry.payload === undefined ? null : JSON.stringify(entry.payload),
        this.timestamp(),
      );
  }

  listLog(
    workflowId: string,
    options?: {
      readonly afterLogId?: number;
      readonly types?: readonly RunnerLogEntry['entryType'][];
      readonly limit?: number;
    },
  ): readonly RunnerLogEntry[] {
    const conditions = ['workflow_id = ?'];
    const values: unknown[] = [workflowId];
    if (options?.afterLogId !== undefined) {
      conditions.push('log_id > ?');
      values.push(options.afterLogId);
    }
    if (options?.types !== undefined && options.types.length > 0) {
      conditions.push(`entry_type IN (${options.types.map(() => '?').join(', ')})`);
      values.push(...options.types);
    }
    values.push(options?.limit ?? 500);
    return this.db
      .prepare(
        `SELECT * FROM review_workflow_runner_log
         WHERE ${conditions.join(' AND ')} ORDER BY log_id ASC LIMIT ?`,
      )
      .all(...values)
      .map((row) => {
        const parsed = logRowSchema.parse(row);
        return {
          logId: parsed.log_id,
          workflowId: parsed.workflow_id,
          ...(parsed.batch_id === null ? {} : { batchId: parsed.batch_id }),
          entryType: parsed.entry_type,
          ...(parsed.phase === null ? {} : { phase: parsed.phase }),
          message: parsed.message,
          ...(parsed.payload_json === null
            ? {}
            : {
                payload: z.record(z.string(), z.unknown()).parse(JSON.parse(parsed.payload_json)),
              }),
          createdAt: parsed.created_at,
        };
      });
  }

  recordDecision(decision: RiskDecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO review_workflow_risk_decisions (
          decision_id, workflow_id, batch_id, action, actor,
          finding_ids_json, rationale, commit_sha, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.decisionId,
        decision.workflowId,
        decision.batchId ?? null,
        decision.action,
        decision.actor,
        JSON.stringify(decision.findingIds),
        decision.rationale,
        decision.commitSha,
        decision.createdAt,
      );
  }

  listDecisions(workflowId: string): readonly RiskDecisionRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM review_workflow_risk_decisions WHERE workflow_id = ? ORDER BY created_at',
      )
      .all(workflowId)
      .map((row) => {
        const parsed = decisionRowSchema.parse(row);
        return {
          decisionId: parsed.decision_id,
          workflowId: parsed.workflow_id,
          ...(parsed.batch_id === null ? {} : { batchId: parsed.batch_id }),
          action: parsed.action,
          actor: parsed.actor,
          findingIds: z.array(z.string()).parse(JSON.parse(parsed.finding_ids_json)),
          rationale: parsed.rationale,
          commitSha: parsed.commit_sha,
          createdAt: parsed.created_at,
        };
      });
  }

  /** Budget aggregates from the immutable invocation audit. */
  auditTotals(
    workflowId: string,
    batchId?: string,
  ): { invocations: number; inputTokens: number; outputTokens: number; costUsd: number } {
    const row =
      batchId === undefined
        ? this.db
            .prepare(
              `SELECT COUNT(*) AS invocations,
                      COALESCE(SUM(input_tokens), 0) AS input_tokens,
                      COALESCE(SUM(output_tokens), 0) AS output_tokens,
                      COALESCE(SUM(cost_usd), 0) AS cost_usd
               FROM review_workflow_invocation_audit WHERE workflow_id = ?`,
            )
            .get(workflowId)
        : this.db
            .prepare(
              `SELECT COUNT(*) AS invocations,
                      COALESCE(SUM(input_tokens), 0) AS input_tokens,
                      COALESCE(SUM(output_tokens), 0) AS output_tokens,
                      COALESCE(SUM(cost_usd), 0) AS cost_usd
               FROM review_workflow_invocation_audit WHERE workflow_id = ? AND batch_id = ?`,
            )
            .get(workflowId, batchId);
    const parsed = z
      .object({
        invocations: z.number().int(),
        input_tokens: z.number(),
        output_tokens: z.number(),
        cost_usd: z.number(),
      })
      .parse(row);
    return {
      invocations: parsed.invocations,
      inputTokens: parsed.input_tokens,
      outputTokens: parsed.output_tokens,
      costUsd: parsed.cost_usd,
    };
  }

  /**
   * Acquires (or re-acquires) the exclusive worker lease. Exactly one live worker may run a
   * workflow; a second worker only succeeds after the previous lease expired.
   */
  acquireLease(workflowId: string, workerId: string, leaseSeconds: number): boolean {
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    const result = this.db
      .prepare(
        `UPDATE review_workflow_runner_state
         SET worker_id = ?, lease_expires_at = ?, updated_at = ?
         WHERE workflow_id = ?
           AND (worker_id IS NULL OR worker_id = ? OR lease_expires_at IS NULL OR lease_expires_at < ?)`,
      )
      .run(workerId, expiresAt, now.toISOString(), workflowId, workerId, now.toISOString());
    return result.changes === 1;
  }

  releaseLease(workflowId: string, workerId: string): void {
    this.db
      .prepare(
        `UPDATE review_workflow_runner_state
         SET worker_id = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE workflow_id = ? AND worker_id = ?`,
      )
      .run(this.clock().toISOString(), workflowId, workerId);
  }

  private timestamp(): string {
    return this.clock().toISOString();
  }
}
