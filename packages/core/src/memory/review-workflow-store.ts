// SQLite persistence for review-gated workflow aggregates and immutable evidence.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  handoffTranscriptSchema,
  structuredReviewSchema,
} from '../review-workflow-contracts/schemas.js';
import type { HandoffTranscript, StructuredReview } from '../review-workflow-contracts/types.js';
import { hashVerificationRecord } from '../review-workflow-verification/hash.js';
import {
  acceptanceCriterionSchema,
  actorExecutionIdentitySchema,
  agentAssignmentSchema,
  batchPlanVersionSchema,
  findingDispositionSchema,
  findingSchema,
  generalPlanVersionSchema,
  implementationAttemptSchema,
  implementationCommitSchema,
  implementationReadyEvidenceSchema,
  invocationIdentitySchema,
  planRequirementSchema,
  refinedPlanVersionSchema,
  repositoryAuditSchema,
  reviewRangeEvidenceSchema,
  reviewWorkflowBatchSchema,
  sessionIdentitySchema,
  verificationAttestationSchema,
  verificationRecordSchema,
  workflowRunSchema,
} from '../review-workflow/schemas.js';
import type {
  AcceptanceCriterion,
  ActorExecutionIdentity,
  AgentAssignment,
  BatchPlanVersion,
  Finding,
  FindingDisposition,
  GeneralPlanVersion,
  ImplementationAttempt,
  ImplementationCommit,
  ImplementationReadyEvidence,
  InvocationIdentity,
  PlanRequirement,
  RefinedPlanVersion,
  RepositoryAudit,
  ReviewRangeEvidence,
  ReviewWorkflowBatch,
  SessionIdentity,
  VerificationAttestation,
  VerificationRecord,
  WorkflowRun,
} from '../review-workflow/types.js';

export const REVIEW_WORKFLOW_PERSISTENCE_ERROR_CODES = [
  'WORKFLOW_NOT_FOUND',
  'BATCH_NOT_FOUND',
  'COMMAND_NOT_FOUND',
  'AGGREGATE_VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'COMMAND_STATE_CONFLICT',
  'SIDE_EFFECT_NOT_RESERVED',
  'IMMUTABLE_ENTITY_CONFLICT',
  'HANDOFF_EVIDENCE_CONFLICT',
  'PERSISTED_DATA_INVALID',
] as const;

export type ReviewWorkflowPersistenceErrorCode =
  (typeof REVIEW_WORKFLOW_PERSISTENCE_ERROR_CODES)[number];

export class ReviewWorkflowPersistenceError extends Error {
  constructor(
    readonly code: ReviewWorkflowPersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewWorkflowPersistenceError';
  }
}

export interface ImmutableSaveResult {
  readonly inserted: boolean;
}

export interface RoleInvocationPersistenceInput {
  readonly assignment: AgentAssignment;
  readonly invocation: InvocationIdentity;
  readonly session?: SessionIdentity;
  readonly reusedSessionIdentityId?: string;
  readonly execution: ActorExecutionIdentity;
}

export interface HandoffCapturePersistenceInput {
  readonly transcript: HandoffTranscript;
  readonly review?: StructuredReview;
  readonly entities: readonly PersistableReviewWorkflowEntity[];
}

export interface ReviewWorkflowEvent {
  readonly eventId: number;
  readonly workflowId: string;
  readonly batchId: string;
  readonly sequence: number;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly commandId: string;
  readonly actorExecutionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export type PersistableReviewWorkflowEntity =
  | { readonly kind: 'AGENT_ASSIGNMENT'; readonly value: AgentAssignment }
  | { readonly kind: 'ACTOR_EXECUTION'; readonly value: ActorExecutionIdentity }
  | { readonly kind: 'INVOCATION_IDENTITY'; readonly value: InvocationIdentity }
  | { readonly kind: 'SESSION_IDENTITY'; readonly value: SessionIdentity }
  | { readonly kind: 'GENERAL_PLAN_VERSION'; readonly value: GeneralPlanVersion }
  | { readonly kind: 'PLAN_REQUIREMENT'; readonly value: PlanRequirement }
  | { readonly kind: 'REPOSITORY_AUDIT'; readonly value: RepositoryAudit }
  | { readonly kind: 'REFINED_PLAN_VERSION'; readonly value: RefinedPlanVersion }
  | { readonly kind: 'BATCH_PLAN_VERSION'; readonly value: BatchPlanVersion }
  | { readonly kind: 'ACCEPTANCE_CRITERION'; readonly value: AcceptanceCriterion }
  | { readonly kind: 'IMPLEMENTATION_ATTEMPT'; readonly value: ImplementationAttempt }
  | {
      readonly kind: 'IMPLEMENTATION_READY_EVIDENCE';
      readonly value: ImplementationReadyEvidence;
    }
  | { readonly kind: 'IMPLEMENTATION_COMMIT'; readonly value: ImplementationCommit }
  | { readonly kind: 'FINDING'; readonly value: Finding }
  | { readonly kind: 'FINDING_DISPOSITION'; readonly value: FindingDisposition }
  | {
      readonly kind: 'VERIFICATION_RECORD';
      readonly workflowId: string;
      readonly batchId: string;
      readonly value: VerificationRecord;
    }
  | { readonly kind: 'VERIFICATION_ATTESTATION'; readonly value: VerificationAttestation }
  | {
      readonly kind: 'REVIEW_RANGE_EVIDENCE';
      readonly reviewRangeEvidenceId: string;
      readonly workflowId: string;
      readonly batchId: string;
      readonly value: ReviewRangeEvidence;
    };

export type ReviewWorkflowEntityKind = PersistableReviewWorkflowEntity['kind'];

function persistableEntityId(entity: PersistableReviewWorkflowEntity): string {
  switch (entity.kind) {
    case 'AGENT_ASSIGNMENT':
      return entity.value.assignmentId;
    case 'ACTOR_EXECUTION':
      return entity.value.actorExecutionId;
    case 'INVOCATION_IDENTITY':
      return entity.value.invocationId;
    case 'SESSION_IDENTITY':
      return entity.value.sessionIdentityId;
    case 'GENERAL_PLAN_VERSION':
      return entity.value.generalPlanVersionId;
    case 'PLAN_REQUIREMENT':
      return entity.value.requirementId;
    case 'REPOSITORY_AUDIT':
      return entity.value.repositoryAuditId;
    case 'REFINED_PLAN_VERSION':
      return entity.value.refinedPlanVersionId;
    case 'BATCH_PLAN_VERSION':
      return entity.value.batchPlanVersionId;
    case 'ACCEPTANCE_CRITERION':
      return entity.value.acceptanceCriterionId;
    case 'IMPLEMENTATION_ATTEMPT':
      return entity.value.implementationAttemptId;
    case 'IMPLEMENTATION_READY_EVIDENCE':
      return entity.value.implementationReadyEvidenceId;
    case 'IMPLEMENTATION_COMMIT':
      return entity.value.resultingCommitSha;
    case 'FINDING':
      return entity.value.findingId;
    case 'FINDING_DISPOSITION':
      return entity.value.dispositionId;
    case 'VERIFICATION_RECORD':
      return entity.value.verificationRecordId;
    case 'VERIFICATION_ATTESTATION':
      return entity.value.verificationAttestationId;
    case 'REVIEW_RANGE_EVIDENCE':
      return entity.reviewRangeEvidenceId;
  }
}

function findingMatchesReview(finding: Finding, review: StructuredReview): boolean {
  if (finding.repositoryContextSha !== review.target.repositoryContextSha) return false;
  if (review.target.kind === 'PLAN') {
    return (
      finding.reviewedCommitSha === undefined &&
      finding.reviewedArtifact.artifactId === review.target.planVersionId &&
      finding.reviewedArtifact.contentHash === review.target.planContentHash
    );
  }
  return (
    finding.reviewedCommitSha === review.target.reviewedCommitSha &&
    finding.reviewedArtifact.artifactId === review.target.reviewRangeEvidenceId &&
    finding.reviewedArtifact.contentHash === review.target.patchHash
  );
}

function refinementEntitiesMatchTranscript(
  entities: readonly PersistableReviewWorkflowEntity[],
  transcript: HandoffTranscript,
): boolean {
  const refinedPlans = entities.flatMap((entity) =>
    entity.kind === 'REFINED_PLAN_VERSION' ? [entity.value] : [],
  );
  const batchPlans = entities.flatMap((entity) =>
    entity.kind === 'BATCH_PLAN_VERSION' ? [entity.value] : [],
  );
  const acceptanceCriteria = entities.flatMap((entity) =>
    entity.kind === 'ACCEPTANCE_CRITERION' ? [entity.value] : [],
  );
  if (
    refinedPlans.length !== 1 ||
    entities.some(
      (entity) =>
        entity.kind !== 'REFINED_PLAN_VERSION' &&
        entity.kind !== 'BATCH_PLAN_VERSION' &&
        entity.kind !== 'ACCEPTANCE_CRITERION',
    )
  ) {
    return false;
  }
  const refinedPlan = refinedPlans[0];
  if (
    refinedPlan === undefined ||
    refinedPlan.workflowId !== transcript.workflowId ||
    refinedPlan.actorExecutionId !== transcript.actorExecutionId
  ) {
    return false;
  }
  if (batchPlans.length === 0 && acceptanceCriteria.length === 0) {
    return entities.length === 1;
  }
  const batchPlanIds = new Set(batchPlans.map((plan) => plan.batchPlanVersionId));
  const expectedBatchPlanIds = new Set(refinedPlan.batchPlanVersionIds);
  if (
    batchPlanIds.size !== expectedBatchPlanIds.size ||
    [...batchPlanIds].some((id) => !expectedBatchPlanIds.has(id)) ||
    batchPlans.some(
      (plan) =>
        plan.workflowId !== transcript.workflowId ||
        plan.actorExecutionId !== transcript.actorExecutionId ||
        plan.repositoryContextSha !== refinedPlan.repositoryContextSha,
    ) ||
    acceptanceCriteria.some((criterion) => !batchPlanIds.has(criterion.batchPlanVersionId))
  ) {
    return false;
  }
  const criterionIds = new Set(
    acceptanceCriteria.map((criterion) => criterion.acceptanceCriterionId),
  );
  return refinedPlan.requirementCoverage.every(
    (coverage) =>
      coverage.batchPlanVersionIds.every((id) => batchPlanIds.has(id)) &&
      coverage.acceptanceCriterionIds.every((id) => criterionIds.has(id)),
  );
}

const recordHashRowSchema = z.object({ record_hash: z.string() });
const payloadRowSchema = z.object({ payload_json: z.string() });

const batchRoleSessionRowSchema = z.object({
  batch_id: z.string().min(1),
  role: z.enum(['IMPLEMENTER', 'REVIEWER']),
  workflow_id: z.string().min(1),
  session_identity_id: z.string().min(1),
  provider_or_adapter: z.string().min(1),
  vendor_session_id: z.string().min(1),
  created_at: z.string().min(1),
});

const invocationAuditRowSchema = z.object({
  invocation_id: z.string().min(1),
  workflow_id: z.string().min(1),
  batch_id: z.string().nullable(),
  phase: z.string().nullable(),
  command_id: z.string().min(1),
  role: z.enum(['IMPLEMENTER', 'REVIEWER']).nullable(),
  actor_execution_id: z.string().min(1),
  adapter_kind: z.string().min(1),
  configured_model: z.string().min(1),
  reported_model: z.string().nullable(),
  vendor_session_id: z.string().min(1),
  session_outcome: z.enum(['CREATED', 'RESUMED', 'NONE']),
  prompt: z.string(),
  prompt_hash: z.string().min(1),
  response: z.string(),
  response_hash: z.string().min(1),
  redaction_count: z.number().int().nonnegative(),
  raw_stderr: z.string().nullable(),
  raw_stdout: z.string().nullable(),
  failure_json: z.string().nullable(),
  git_before_json: z.string().nullable(),
  git_after_json: z.string().nullable(),
  changed_files_json: z.string().nullable(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  total_tokens: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  started_at: z.string().min(1),
  finished_at: z.string().min(1),
  duration_ms: z.number().int(),
  result_status: z.string().min(1),
  created_at: z.string().min(1),
});

const invocationFailureSchema = z.object({
  classification: z.string().min(1),
  message: z.string(),
});

const gitStateSchema = z.object({
  branch: z.string().min(1),
  headSha: z.string().min(1),
  clean: z.boolean(),
});

const sessionContinuityRowSchema = z.object({
  invocation_id: z.string().min(1),
  workflow_id: z.string().min(1),
  batch_id: z.string().min(1),
  role: z.enum(['IMPLEMENTER', 'REVIEWER']),
  adapter_kind: z.string().min(1),
  requested_vendor_session_id: z.string().nullable(),
  returned_vendor_session_id: z.string().nullable(),
  outcome: z.enum(['CREATED', 'RESUMED', 'FAILED']),
  error_code: z.string().nullable(),
  created_at: z.string().min(1),
});

export interface BatchRoleSession {
  readonly batchId: string;
  readonly role: 'IMPLEMENTER' | 'REVIEWER';
  readonly workflowId: string;
  readonly sessionIdentityId: string;
  readonly providerOrAdapter: string;
  readonly vendorSessionId: string;
  readonly createdAt: string;
}

export interface InvocationAuditRecord {
  readonly invocationId: string;
  readonly workflowId: string;
  readonly batchId?: string;
  readonly phase?: string;
  readonly commandId: string;
  readonly role?: 'IMPLEMENTER' | 'REVIEWER';
  readonly actorExecutionId: string;
  readonly adapterKind: string;
  readonly configuredModel: string;
  readonly reportedModel?: string;
  readonly vendorSessionId: string;
  readonly sessionOutcome: 'CREATED' | 'RESUMED' | 'NONE';
  readonly prompt: string;
  readonly promptHash: string;
  readonly response: string;
  readonly responseHash: string;
  readonly redactionCount: number;
  /** Adapter stderr captured during the invocation (secret-redacted, capped by the adapter). */
  readonly rawStderr?: string;
  /** Complete raw CLI stdout (secret-redacted, capped by the adapter). */
  readonly rawStdout?: string;
  /** Structured failure details for FAILED invocations (classification + message). */
  readonly failure?: { readonly classification: string; readonly message: string };
  /** Repository state immediately before/after the invocation, and the files it changed. */
  readonly gitBefore?: {
    readonly branch: string;
    readonly headSha: string;
    readonly clean: boolean;
  };
  readonly gitAfter?: {
    readonly branch: string;
    readonly headSha: string;
    readonly clean: boolean;
  };
  readonly changedFiles?: readonly string[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly resultStatus: string;
  readonly createdAt: string;
}

export interface SessionContinuityEvidence {
  readonly invocationId: string;
  readonly workflowId: string;
  readonly batchId: string;
  readonly role: 'IMPLEMENTER' | 'REVIEWER';
  readonly adapterKind: string;
  readonly requestedVendorSessionId?: string;
  readonly returnedVendorSessionId?: string;
  readonly outcome: 'CREATED' | 'RESUMED' | 'FAILED';
  readonly errorCode?: string;
  readonly createdAt: string;
}

function parseBatchRoleSessionRow(row: unknown): BatchRoleSession {
  const parsed = batchRoleSessionRowSchema.parse(row);
  return {
    batchId: parsed.batch_id,
    role: parsed.role,
    workflowId: parsed.workflow_id,
    sessionIdentityId: parsed.session_identity_id,
    providerOrAdapter: parsed.provider_or_adapter,
    vendorSessionId: parsed.vendor_session_id,
    createdAt: parsed.created_at,
  };
}
const contextualPayloadRowSchema = payloadRowSchema.extend({
  workflow_id: z.string(),
  batch_id: z.string(),
});
const eventRowSchema = z.object({
  event_id: z.number().int().positive(),
  workflow_id: z.string(),
  batch_id: z.string(),
  sequence: z.number().int().positive(),
  aggregate_version: z.number().int().positive(),
  event_type: z.string(),
  command_id: z.string(),
  actor_execution_id: z.string(),
  payload_json: z.string(),
  created_at: z.string(),
});

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ReviewWorkflowPersistenceError(
      'PERSISTED_DATA_INVALID',
      'Review workflow persistence received a non-serializable value',
    );
  }
  return serialized;
}

function hashRecord(value: unknown): string {
  return createHash('sha256').update(serializeJson(value)).digest('hex');
}

function parseJsonObject(serialized: string): Readonly<Record<string, unknown>> {
  try {
    return z.record(z.unknown()).parse(JSON.parse(serialized));
  } catch {
    throw new ReviewWorkflowPersistenceError(
      'PERSISTED_DATA_INVALID',
      'Stored review workflow event payload is invalid JSON',
    );
  }
}

function parseStoredPayload<T>(
  serialized: string,
  schema: z.ZodType<T>,
  entityKind:
    | ReviewWorkflowEntityKind
    | 'WORKFLOW'
    | 'BATCH'
    | 'HANDOFF_TRANSCRIPT'
    | 'STRUCTURED_REVIEW',
): T {
  try {
    return schema.parse(JSON.parse(serialized));
  } catch {
    throw new ReviewWorkflowPersistenceError(
      'PERSISTED_DATA_INVALID',
      `Stored ${entityKind} payload failed domain validation`,
    );
  }
}

export class ReviewWorkflowStore {
  constructor(private readonly db: Database.Database) {}

  saveRoleInvocation(input: RoleInvocationPersistenceInput): void {
    const hasNewSession = input.session !== undefined;
    const reusesSession = input.reusedSessionIdentityId !== undefined;
    if (hasNewSession === reusesSession) {
      throw new ReviewWorkflowPersistenceError(
        'PERSISTED_DATA_INVALID',
        'A role invocation must create one session identity or reuse one existing session',
      );
    }

    this.db.transaction(() => {
      this.saveEntity({ kind: 'AGENT_ASSIGNMENT', value: input.assignment });
      this.saveEntity({ kind: 'INVOCATION_IDENTITY', value: input.invocation });
      if (input.session !== undefined) {
        this.saveEntity({ kind: 'SESSION_IDENTITY', value: input.session });
      } else if (input.reusedSessionIdentityId !== undefined) {
        this.touchSessionIdentity(
          input.reusedSessionIdentityId,
          input.invocation.finishedAt ?? input.invocation.startedAt,
        );
      }
      this.saveEntity({ kind: 'ACTOR_EXECUTION', value: input.execution });
    })();
  }

  touchSessionIdentity(sessionIdentityId: string, lastUsedAt: string): SessionIdentity {
    const current = this.getEntity('SESSION_IDENTITY', sessionIdentityId);
    if (current === null || current.kind !== 'SESSION_IDENTITY') {
      throw new ReviewWorkflowPersistenceError(
        'PERSISTED_DATA_INVALID',
        `Session identity ${sessionIdentityId} does not exist`,
      );
    }
    const updated = sessionIdentitySchema.parse({ ...current.value, lastUsedAt });
    if (Date.parse(updated.lastUsedAt) < Date.parse(current.value.lastUsedAt)) {
      throw new ReviewWorkflowPersistenceError(
        'PERSISTED_DATA_INVALID',
        `Session identity ${sessionIdentityId} cannot move lastUsedAt backwards`,
      );
    }
    if (updated.lastUsedAt === current.value.lastUsedAt) return current.value;

    const payloadJson = serializeJson(updated);
    const recordHash = hashRecord({ kind: 'SESSION_IDENTITY', value: updated });
    this.db
      .prepare(
        `UPDATE review_workflow_sessions
         SET payload_json = ?, record_hash = ?
         WHERE session_identity_id = ?`,
      )
      .run(payloadJson, recordHash, sessionIdentityId);
    return updated;
  }

  /**
   * Rewrites the persisted configuration hash after the HASH FUNCTION itself changed.
   *
   * `1f7d011` scoped operational limits out of `hashReviewWorkflowConfiguration`, which
   * changed the value produced for an UNCHANGED configuration — and the old value was
   * already on disk in three places (the workflow row and both assignment rows, each with a
   * column copy, a payload copy, and a record hash over that payload). Every workflow
   * created before the change was rejected with "Assignment scope and configuration hash
   * must match the snapshot" even though nothing about its configuration had moved.
   *
   * The caller must FIRST prove the assignment identity is unchanged by comparing the
   * stored identity fields (role, agent key, alias, adapter kind, provider, model, commit
   * permission) against a freshly derived assignment — a direct comparison, deliberately
   * not hash archaeology, because schema-default drift means the original parse output
   * cannot be reconstructed from today's file. This method only rewrites the fingerprint.
   *
   * The agent-assignments table is protected by immutability triggers; they are dropped and
   * recreated inside the same transaction. This is the one sanctioned place to do that: a
   * migration of stored shape, after the code that reads it changed underneath it.
   */
  migrateConfigurationHash(input: {
    readonly workflowId: string;
    readonly assignmentIds: readonly string[];
    readonly toHash: string;
  }): void {
    this.db.transaction(() => {
      const workflowRow = this.db
        .prepare('SELECT payload_json FROM review_workflows WHERE workflow_id = ?')
        .get(input.workflowId);
      if (workflowRow !== undefined) {
        const payload = parseJsonObject(payloadRowSchema.parse(workflowRow).payload_json);
        const updated = { ...payload, configurationHash: input.toHash };
        this.db
          .prepare(
            `UPDATE review_workflows
             SET configuration_hash = ?, payload_json = ?, record_hash = ?
             WHERE workflow_id = ?`,
          )
          .run(
            input.toHash,
            serializeJson(updated),
            hashRecord({ kind: 'WORKFLOW', value: updated }),
            input.workflowId,
          );
      }
      this.db.exec('DROP TRIGGER IF EXISTS review_workflow_agent_assignments_immutable_update');
      try {
        for (const assignmentId of input.assignmentIds) {
          const row = this.db
            .prepare(
              'SELECT payload_json FROM review_workflow_agent_assignments WHERE assignment_id = ?',
            )
            .get(assignmentId);
          if (row === undefined) continue;
          const payload = parseJsonObject(payloadRowSchema.parse(row).payload_json);
          const updated = { ...payload, configurationHash: input.toHash };
          this.db
            .prepare(
              `UPDATE review_workflow_agent_assignments
               SET configuration_hash = ?, payload_json = ?, record_hash = ?
               WHERE assignment_id = ?`,
            )
            .run(
              input.toHash,
              serializeJson(updated),
              hashRecord({ kind: 'AGENT_ASSIGNMENT', value: updated }),
              assignmentId,
            );
        }
      } finally {
        this.db.exec(
          `CREATE TRIGGER IF NOT EXISTS review_workflow_agent_assignments_immutable_update
            BEFORE UPDATE ON review_workflow_agent_assignments
            BEGIN
              SELECT RAISE(ABORT, 'review_workflow_agent_assignments is immutable');
            END`,
        );
      }
    })();
  }

  createWorkflow(workflow: WorkflowRun): ImmutableSaveResult {
    const parsed = workflowRunSchema.parse(workflow);
    const payloadJson = serializeJson(parsed);
    const recordHash = hashRecord({ kind: 'WORKFLOW', value: parsed });
    return this.insertImmutable({
      table: 'review_workflows',
      idColumn: 'workflow_id',
      id: parsed.workflowId,
      recordHash,
      insert: () =>
        this.db
          .prepare(
            `INSERT INTO review_workflows (
              workflow_id,
              status,
              general_plan_version_id,
              refined_plan_version_id,
              implementer_assignment_id,
              reviewer_assignment_id,
              configuration_hash,
              aggregate_version,
              payload_json,
              record_hash,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
          )
          .run(
            parsed.workflowId,
            parsed.status,
            parsed.generalPlanVersionId,
            parsed.refinedPlanVersionId ?? null,
            parsed.implementerAssignmentId,
            parsed.reviewerAssignmentId,
            parsed.configurationHash,
            payloadJson,
            recordHash,
            parsed.createdAt,
            parsed.updatedAt,
          ),
    });
  }

  getWorkflow(workflowId: string): WorkflowRun | null {
    const row = this.db
      .prepare('SELECT payload_json FROM review_workflows WHERE workflow_id = ?')
      .get(workflowId);
    if (row === undefined) return null;
    const parsedRow = payloadRowSchema.parse(row);
    return parseStoredPayload(parsedRow.payload_json, workflowRunSchema, 'WORKFLOW');
  }

  createBatch(batch: ReviewWorkflowBatch): ImmutableSaveResult {
    const parsed = reviewWorkflowBatchSchema.parse(batch);
    const payloadJson = serializeJson(parsed);
    const recordHash = hashRecord({ kind: 'BATCH', value: parsed });
    return this.insertImmutable({
      table: 'review_workflow_batches',
      idColumn: 'batch_id',
      id: parsed.batchId,
      recordHash,
      insert: () =>
        this.db
          .prepare(
            `INSERT INTO review_workflow_batches (
              batch_id,
              workflow_id,
              ordinal,
              persisted_state,
              aggregate_version,
              last_event_sequence,
              current_plan_version_id,
              implementer_assignment_id,
              reviewer_assignment_id,
              original_batch_base_sha,
              blocked_from_state,
              blocked_resume_state,
              payload_json,
              record_hash,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            parsed.batchId,
            parsed.workflowId,
            parsed.ordinal,
            parsed.persistedState,
            parsed.aggregateVersion,
            parsed.currentPlanVersionId,
            parsed.implementerAssignmentId,
            parsed.reviewerAssignmentId,
            parsed.originalBatchBaseSha ?? null,
            parsed.blockedFromState ?? null,
            parsed.blockedResumeState ?? null,
            payloadJson,
            recordHash,
            parsed.createdAt,
            parsed.updatedAt,
          ),
    });
  }

  getBatch(batchId: string): ReviewWorkflowBatch | null {
    const row = this.db
      .prepare('SELECT payload_json FROM review_workflow_batches WHERE batch_id = ?')
      .get(batchId);
    if (row === undefined) return null;
    const parsedRow = payloadRowSchema.parse(row);
    return parseStoredPayload(parsedRow.payload_json, reviewWorkflowBatchSchema, 'BATCH');
  }

  findSessionIdentity(
    workflowId: string,
    providerOrAdapter: string,
    vendorSessionId: string,
  ): SessionIdentity | null {
    const row = this.db
      .prepare(
        `SELECT payload_json
         FROM review_workflow_sessions
         WHERE workflow_id = ? AND provider_or_adapter = ? AND vendor_session_id = ?`,
      )
      .get(workflowId, providerOrAdapter, vendorSessionId);
    if (row === undefined) return null;
    const parsedRow = payloadRowSchema.parse(row);
    return parseStoredPayload(parsedRow.payload_json, sessionIdentitySchema, 'SESSION_IDENTITY');
  }

  /** Runs writes in one transaction (better-sqlite3 nests via savepoints). */
  runAtomically<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * The single active vendor session for one batch role. Bindings are immutable: exactly one
   * per (batch, role), and one vendor session can never serve two bindings (the UNIQUE
   * constraint on provider + vendor session enforces cross-role and cross-batch isolation).
   */
  getBatchRoleSession(batchId: string, role: 'IMPLEMENTER' | 'REVIEWER'): BatchRoleSession | null {
    const row = this.db
      .prepare('SELECT * FROM review_workflow_batch_role_sessions WHERE batch_id = ? AND role = ?')
      .get(batchId, role);
    if (row === undefined) return null;
    return parseBatchRoleSessionRow(row);
  }

  findBatchRoleSessionByVendor(
    providerOrAdapter: string,
    vendorSessionId: string,
  ): BatchRoleSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM review_workflow_batch_role_sessions
         WHERE provider_or_adapter = ? AND vendor_session_id = ?`,
      )
      .get(providerOrAdapter, vendorSessionId);
    if (row === undefined) return null;
    return parseBatchRoleSessionRow(row);
  }

  bindBatchRoleSession(binding: BatchRoleSession): void {
    this.db
      .prepare(
        `INSERT INTO review_workflow_batch_role_sessions (
          batch_id, role, workflow_id, session_identity_id,
          provider_or_adapter, vendor_session_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.batchId,
        binding.role,
        binding.workflowId,
        binding.sessionIdentityId,
        binding.providerOrAdapter,
        binding.vendorSessionId,
        binding.createdAt,
      );
  }

  /**
   * Append-only, immutable invocation audit: full prompt and response before advancement.
   *
   * INSERT OR IGNORE, because the row is immutable and keyed by invocation ID — first write
   * wins is already this table's contract, so a second write of the same invocation is by
   * definition the same evidence. That makes it safe to audit a call the MOMENT it returns
   * rather than waiting for the command that consumes it to succeed. The outline invocation
   * used to be recorded only via `persistPrepared` at capture, so every refinement that
   * failed validation lost its outline from the ledger: one workflow reported $27.94 spent
   * against roughly $32 actual, understating by one outline per failed run.
   */
  recordInvocationAudit(audit: InvocationAuditRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO review_workflow_invocation_audit (
          invocation_id, workflow_id, batch_id, phase, command_id, role,
          actor_execution_id, adapter_kind, configured_model, reported_model,
          vendor_session_id, session_outcome, prompt, prompt_hash, response, response_hash,
          redaction_count, raw_stderr, raw_stdout, failure_json,
          git_before_json, git_after_json, changed_files_json,
          input_tokens, output_tokens, total_tokens, cost_usd,
          started_at, finished_at, duration_ms, result_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        audit.invocationId,
        audit.workflowId,
        audit.batchId ?? null,
        audit.phase ?? null,
        audit.commandId,
        audit.role ?? null,
        audit.actorExecutionId,
        audit.adapterKind,
        audit.configuredModel,
        audit.reportedModel ?? null,
        audit.vendorSessionId,
        audit.sessionOutcome,
        audit.prompt,
        audit.promptHash,
        audit.response,
        audit.responseHash,
        audit.redactionCount,
        audit.rawStderr ?? null,
        audit.rawStdout ?? null,
        audit.failure === undefined ? null : JSON.stringify(audit.failure),
        audit.gitBefore === undefined ? null : JSON.stringify(audit.gitBefore),
        audit.gitAfter === undefined ? null : JSON.stringify(audit.gitAfter),
        audit.changedFiles === undefined ? null : JSON.stringify(audit.changedFiles),
        audit.inputTokens ?? null,
        audit.outputTokens ?? null,
        audit.totalTokens ?? null,
        audit.costUsd ?? null,
        audit.startedAt,
        audit.finishedAt,
        audit.durationMs,
        audit.resultStatus,
        audit.createdAt,
      );
  }

  listInvocationAudit(
    workflowId: string,
    filters?: {
      readonly batchId?: string;
      readonly phase?: string;
      readonly invocationId?: string;
    },
  ): readonly InvocationAuditRecord[] {
    const conditions = ['workflow_id = ?'];
    const values: unknown[] = [workflowId];
    if (filters?.batchId !== undefined) {
      conditions.push('batch_id = ?');
      values.push(filters.batchId);
    }
    if (filters?.phase !== undefined) {
      conditions.push('phase = ?');
      values.push(filters.phase);
    }
    if (filters?.invocationId !== undefined) {
      conditions.push('invocation_id = ?');
      values.push(filters.invocationId);
    }
    return this.db
      .prepare(
        `SELECT * FROM review_workflow_invocation_audit
         WHERE ${conditions.join(' AND ')} ORDER BY created_at, invocation_id`,
      )
      .all(...values)
      .map((row) => {
        const parsed = invocationAuditRowSchema.parse(row);
        return {
          invocationId: parsed.invocation_id,
          workflowId: parsed.workflow_id,
          ...(parsed.batch_id === null ? {} : { batchId: parsed.batch_id }),
          ...(parsed.phase === null ? {} : { phase: parsed.phase }),
          commandId: parsed.command_id,
          ...(parsed.role === null ? {} : { role: parsed.role }),
          actorExecutionId: parsed.actor_execution_id,
          adapterKind: parsed.adapter_kind,
          configuredModel: parsed.configured_model,
          ...(parsed.reported_model === null ? {} : { reportedModel: parsed.reported_model }),
          vendorSessionId: parsed.vendor_session_id,
          sessionOutcome: parsed.session_outcome,
          prompt: parsed.prompt,
          promptHash: parsed.prompt_hash,
          response: parsed.response,
          responseHash: parsed.response_hash,
          redactionCount: parsed.redaction_count,
          ...(parsed.raw_stderr === null ? {} : { rawStderr: parsed.raw_stderr }),
          ...(parsed.raw_stdout === null ? {} : { rawStdout: parsed.raw_stdout }),
          ...(parsed.failure_json === null
            ? {}
            : {
                failure: invocationFailureSchema.parse(JSON.parse(parsed.failure_json)),
              }),
          ...(parsed.git_before_json === null
            ? {}
            : { gitBefore: gitStateSchema.parse(JSON.parse(parsed.git_before_json)) }),
          ...(parsed.git_after_json === null
            ? {}
            : { gitAfter: gitStateSchema.parse(JSON.parse(parsed.git_after_json)) }),
          ...(parsed.changed_files_json === null
            ? {}
            : { changedFiles: z.array(z.string()).parse(JSON.parse(parsed.changed_files_json)) }),
          ...(parsed.input_tokens === null ? {} : { inputTokens: parsed.input_tokens }),
          ...(parsed.output_tokens === null ? {} : { outputTokens: parsed.output_tokens }),
          ...(parsed.total_tokens === null ? {} : { totalTokens: parsed.total_tokens }),
          ...(parsed.cost_usd === null ? {} : { costUsd: parsed.cost_usd }),
          startedAt: parsed.started_at,
          finishedAt: parsed.finished_at,
          durationMs: parsed.duration_ms,
          resultStatus: parsed.result_status,
          createdAt: parsed.created_at,
        };
      });
  }

  /**
   * Stages ONE refined batch plan as soon as its own invocation completes. A failure at
   * batch N therefore preserves batches 1..N-1 and the run resumes at N — refinement used
   * to demand every batch in a single response, so one oversized answer lost everything.
   */
  saveRefinementDraft(input: {
    readonly workflowId: string;
    readonly ordinal: number;
    readonly batchId: string;
    readonly draft: unknown;
    readonly createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO review_workflow_refinement_drafts
           (workflow_id, ordinal, batch_id, draft_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workflow_id, ordinal) DO UPDATE SET
           batch_id = excluded.batch_id,
           draft_json = excluded.draft_json,
           created_at = excluded.created_at`,
      )
      .run(
        input.workflowId,
        input.ordinal,
        input.batchId,
        JSON.stringify(input.draft),
        input.createdAt,
      );
  }

  /** Every staged batch plan for a workflow, in ordinal order. */
  listRefinementDrafts(
    workflowId: string,
  ): readonly { readonly ordinal: number; readonly batchId: string; readonly draft: unknown }[] {
    return this.db
      .prepare(
        `SELECT ordinal, batch_id, draft_json FROM review_workflow_refinement_drafts
         WHERE workflow_id = ? ORDER BY ordinal`,
      )
      .all(workflowId)
      .map((row) => {
        const parsed = z
          .object({ ordinal: z.number().int(), batch_id: z.string(), draft_json: z.string() })
          .parse(row);
        return {
          ordinal: parsed.ordinal,
          batchId: parsed.batch_id,
          draft: JSON.parse(parsed.draft_json),
        };
      });
  }

  /**
   * Pins the ACCEPTED decomposition on first success, so a resume reuses it instead of
   * re-asking for it.
   *
   * Staged drafts are keyed by ordinal, but ordinal->work is decided by the outline. Asking
   * for the outline again on every resume let a non-deterministic answer re-partition the
   * plan underneath drafts authored against the previous partition: one resume returned
   * eleven batches for a ten-batch plan, reused ten byte-identical drafts, and authored a
   * near-duplicate of batch 10 as batch 11 — which then declared a dependency on batch 10.
   * Nothing detected it, because every individual draft was correct.
   */
  saveRefinementOutline(input: {
    readonly workflowId: string;
    readonly outline: unknown;
    readonly createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO review_workflow_refinement_outlines (workflow_id, outline_json, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workflow_id) DO NOTHING`,
      )
      .run(input.workflowId, JSON.stringify(input.outline), input.createdAt);
  }

  /** The pinned outline, or null when this workflow has not accepted one yet. */
  getRefinementOutline(workflowId: string): unknown | null {
    const row = this.db
      .prepare('SELECT outline_json FROM review_workflow_refinement_outlines WHERE workflow_id = ?')
      .get(workflowId);
    if (row === undefined) return null;
    return JSON.parse(z.object({ outline_json: z.string() }).parse(row).outline_json);
  }

  /**
   * Drops staged drafts whose ordinal is not part of the pinned decomposition.
   *
   * These are the residue of a decomposition that was never accepted — batch 11 of a
   * ten-batch plan. The drafts table is STAGING, not the audit trail: every invocation that
   * produced them remains in `review_workflow_invocation_audit` with its full prompt,
   * response and cost, so nothing about what happened is lost.
   */
  discardRefinementDraftsOutside(workflowId: string, keepOrdinals: readonly number[]): number {
    const kept = new Set(keepOrdinals);
    const rows = this.db
      .prepare('SELECT ordinal FROM review_workflow_refinement_drafts WHERE workflow_id = ?')
      .all(workflowId)
      .map((row) => z.object({ ordinal: z.number().int() }).parse(row).ordinal);
    const orphans = rows.filter((ordinal) => !kept.has(ordinal));
    const statement = this.db.prepare(
      'DELETE FROM review_workflow_refinement_drafts WHERE workflow_id = ? AND ordinal = ?',
    );
    for (const ordinal of orphans) statement.run(workflowId, ordinal);
    return orphans.length;
  }

  /** Append-only continuity evidence: one row per invocation attempt, including failures. */
  recordSessionContinuity(evidence: SessionContinuityEvidence): void {
    this.db
      .prepare(
        `INSERT INTO review_workflow_session_continuity (
          invocation_id, workflow_id, batch_id, role, adapter_kind,
          requested_vendor_session_id, returned_vendor_session_id,
          outcome, error_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidence.invocationId,
        evidence.workflowId,
        evidence.batchId,
        evidence.role,
        evidence.adapterKind,
        evidence.requestedVendorSessionId ?? null,
        evidence.returnedVendorSessionId ?? null,
        evidence.outcome,
        evidence.errorCode ?? null,
        evidence.createdAt,
      );
  }

  listSessionContinuity(batchId: string): readonly SessionContinuityEvidence[] {
    return this.db
      .prepare(
        `SELECT * FROM review_workflow_session_continuity
         WHERE batch_id = ? ORDER BY created_at, invocation_id`,
      )
      .all(batchId)
      .map((row) => {
        const parsed = sessionContinuityRowSchema.parse(row);
        return {
          invocationId: parsed.invocation_id,
          workflowId: parsed.workflow_id,
          batchId: parsed.batch_id,
          role: parsed.role,
          adapterKind: parsed.adapter_kind,
          ...(parsed.requested_vendor_session_id === null
            ? {}
            : { requestedVendorSessionId: parsed.requested_vendor_session_id }),
          ...(parsed.returned_vendor_session_id === null
            ? {}
            : { returnedVendorSessionId: parsed.returned_vendor_session_id }),
          outcome: parsed.outcome,
          ...(parsed.error_code === null ? {} : { errorCode: parsed.error_code }),
          createdAt: parsed.created_at,
        };
      });
  }

  getEvents(batchId: string, afterSequence = 0): readonly ReviewWorkflowEvent[] {
    const rows = this.db
      .prepare(
        `SELECT
          event_id,
          workflow_id,
          batch_id,
          sequence,
          aggregate_version,
          event_type,
          command_id,
          actor_execution_id,
          payload_json,
          created_at
        FROM review_workflow_events
        WHERE batch_id = ? AND sequence > ?
        ORDER BY sequence ASC`,
      )
      .all(batchId, afterSequence);

    return rows.map((row) => {
      const parsed = eventRowSchema.parse(row);
      return {
        eventId: parsed.event_id,
        workflowId: parsed.workflow_id,
        batchId: parsed.batch_id,
        sequence: parsed.sequence,
        aggregateVersion: parsed.aggregate_version,
        eventType: parsed.event_type,
        commandId: parsed.command_id,
        actorExecutionId: parsed.actor_execution_id,
        payload: parseJsonObject(parsed.payload_json),
        createdAt: parsed.created_at,
      };
    });
  }

  /** Workflow-scoped incremental event read: everything after the event-ID cursor, oldest first. */
  listWorkflowEvents(
    workflowId: string,
    afterEventId = 0,
    limit = 100,
  ): readonly ReviewWorkflowEvent[] {
    const rows = this.db
      .prepare(
        `SELECT
          event_id,
          workflow_id,
          batch_id,
          sequence,
          aggregate_version,
          event_type,
          command_id,
          actor_execution_id,
          payload_json,
          created_at
        FROM review_workflow_events
        WHERE workflow_id = ? AND event_id > ?
        ORDER BY event_id ASC
        LIMIT ?`,
      )
      .all(workflowId, afterEventId, limit);

    return rows.map((row) => {
      const parsed = eventRowSchema.parse(row);
      return {
        eventId: parsed.event_id,
        workflowId: parsed.workflow_id,
        batchId: parsed.batch_id,
        sequence: parsed.sequence,
        aggregateVersion: parsed.aggregate_version,
        eventType: parsed.event_type,
        commandId: parsed.command_id,
        actorExecutionId: parsed.actor_execution_id,
        payload: parseJsonObject(parsed.payload_json),
        createdAt: parsed.created_at,
      };
    });
  }

  /**
   * Records the reviewer's decision on one pending disposition. Dispositions are otherwise
   * immutable; only the PENDING → ACCEPTED/REJECTED decision fields may be completed, and a
   * completed decision can never be changed.
   */
  decideDisposition(input: {
    readonly dispositionId: string;
    readonly decision: 'ACCEPTED' | 'REJECTED';
    readonly reviewerActorExecutionId: string;
    readonly rationale: string;
    readonly decidedAt: string;
  }): FindingDisposition {
    const entity = this.getEntity('FINDING_DISPOSITION', input.dispositionId);
    if (entity === null || entity.kind !== 'FINDING_DISPOSITION') {
      throw new ReviewWorkflowPersistenceError(
        'PERSISTED_DATA_INVALID',
        `Disposition ${input.dispositionId} does not exist`,
      );
    }
    const current = entity.value;
    if (current.reviewerDecision.decision !== 'PENDING') {
      throw new ReviewWorkflowPersistenceError(
        'IMMUTABLE_ENTITY_CONFLICT',
        `Disposition ${input.dispositionId} already carries a reviewer decision`,
      );
    }
    const updated = findingDispositionSchema.parse({
      ...current,
      reviewerDecision: {
        decision: input.decision,
        reviewerActorExecutionId: input.reviewerActorExecutionId,
        rationale: input.rationale,
        decidedAt: input.decidedAt,
      },
      updatedAt: input.decidedAt,
    });
    this.db
      .prepare(
        `UPDATE review_workflow_dispositions
         SET reviewer_decision = ?, payload_json = ?, record_hash = ?, updated_at = ?
         WHERE disposition_id = ?`,
      )
      .run(
        input.decision,
        serializeJson(updated),
        hashRecord({ kind: 'FINDING_DISPOSITION', value: updated }),
        input.decidedAt,
        input.dispositionId,
      );
    return updated;
  }

  saveHandoffCapture(input: HandoffCapturePersistenceInput): void {
    const transcript = handoffTranscriptSchema.parse(input.transcript);
    const review =
      input.review === undefined ? undefined : structuredReviewSchema.parse(input.review);
    const actualRawHash = createHash('sha256').update(transcript.rawTranscript).digest('hex');
    if (actualRawHash !== transcript.rawTranscriptHash) {
      throw new ReviewWorkflowPersistenceError(
        'PERSISTED_DATA_INVALID',
        'Handoff transcript content does not match its recorded hash',
      );
    }
    const artifactIds = [
      ...(review === undefined ? [] : [review.reviewRoundId]),
      ...input.entities.map(persistableEntityId),
    ].sort();
    const recordedArtifactIds = [...transcript.parsedArtifactIds].sort();
    const entityKinds = input.entities.map((entity) => entity.kind);
    const findingIds = input.entities.flatMap((entity) =>
      entity.kind === 'FINDING' ? [entity.value.findingId] : [],
    );
    const reviewFindingIds = review === undefined ? [] : [...review.findingIds].sort();
    const artifactShapeMatchesContract =
      transcript.parseStatus === 'REJECTED'
        ? review === undefined && entityKinds.length === 0
        : transcript.contractKind === 'REFINEMENT_RESULT'
          ? review === undefined && refinementEntitiesMatchTranscript(input.entities, transcript)
          : transcript.contractKind === 'REVIEW_RESULT'
            ? review !== undefined &&
              (review.reviewKind === 'PLAN' || review.reviewKind === 'CODE') &&
              entityKinds.every((kind) => kind === 'FINDING')
            : transcript.contractKind === 'FINAL_AUDIT_RESULT'
              ? review?.reviewKind === 'FINAL_AUDIT' &&
                entityKinds.every((kind) => kind === 'FINDING')
              : transcript.contractKind === 'IMPLEMENTATION_RESULT'
                ? review === undefined &&
                  entityKinds.length === 1 &&
                  entityKinds[0] === 'IMPLEMENTATION_ATTEMPT'
                : review === undefined &&
                  entityKinds.length > 0 &&
                  entityKinds.every((kind) => kind === 'FINDING_DISPOSITION');
    const artifactContextMatchesTranscript =
      transcript.parseStatus === 'REJECTED'
        ? true
        : transcript.contractKind === 'REFINEMENT_RESULT'
          ? refinementEntitiesMatchTranscript(input.entities, transcript)
          : transcript.contractKind === 'IMPLEMENTATION_RESULT'
            ? input.entities.every(
                (entity) =>
                  entity.kind === 'IMPLEMENTATION_ATTEMPT' &&
                  entity.value.workflowId === transcript.workflowId &&
                  entity.value.batchId === transcript.batchId &&
                  entity.value.implementerActorExecutionId === transcript.actorExecutionId,
              )
            : transcript.contractKind === 'DISPOSITION_RESULT'
              ? input.entities.every(
                  (entity) =>
                    entity.kind === 'FINDING_DISPOSITION' &&
                    entity.value.actorExecutionId === transcript.actorExecutionId,
                )
              : review !== undefined &&
                review.reviewerActorExecutionId === transcript.actorExecutionId &&
                JSON.stringify(reviewFindingIds) === JSON.stringify(findingIds.sort()) &&
                input.entities.every(
                  (entity) =>
                    entity.kind === 'FINDING' &&
                    entity.value.workflowId === transcript.workflowId &&
                    entity.value.batchId === transcript.batchId &&
                    entity.value.reviewRoundId === review.reviewRoundId &&
                    entity.value.reviewRoundNumber === review.reviewRoundNumber &&
                    entity.value.reviewKind === review.reviewKind &&
                    entity.value.reviewerActorExecutionId === transcript.actorExecutionId &&
                    findingMatchesReview(entity.value, review),
                );
    if (
      (transcript.parseStatus === 'REJECTED' && artifactIds.length > 0) ||
      (transcript.parseStatus === 'PARSED' &&
        JSON.stringify(recordedArtifactIds) !== JSON.stringify(artifactIds)) ||
      !artifactShapeMatchesContract ||
      !artifactContextMatchesTranscript ||
      (transcript.contractKind !== 'REFINEMENT_RESULT' && transcript.batchId === undefined)
    ) {
      throw new ReviewWorkflowPersistenceError(
        'PERSISTED_DATA_INVALID',
        'Handoff contract does not match its captured artifacts',
      );
    }
    if (
      review !== undefined &&
      (review.transcriptId !== transcript.transcriptId ||
        review.workflowId !== transcript.workflowId ||
        review.batchId !== transcript.batchId)
    ) {
      throw new ReviewWorkflowPersistenceError(
        'PERSISTED_DATA_INVALID',
        'Structured review context does not match its handoff transcript',
      );
    }

    this.db.transaction(() => {
      if (
        transcript.contractKind === 'DISPOSITION_RESULT' &&
        !this.dispositionFindingsMatchTranscript(input.entities, transcript)
      ) {
        throw new ReviewWorkflowPersistenceError(
          'HANDOFF_EVIDENCE_CONFLICT',
          'Disposition findings do not belong to the captured workflow and batch',
        );
      }
      this.saveHandoffTranscript(transcript);
      if (review !== undefined) this.saveStructuredReview(review);
      for (const entity of input.entities) this.saveEntity(entity);
    })();
  }

  /** Every persisted handoff transcript (raw + parse status + artifact link) for export. */
  listHandoffTranscripts(workflowId: string): readonly HandoffTranscript[] {
    return this.db
      .prepare(
        `SELECT payload_json
         FROM review_workflow_handoff_transcripts
         WHERE workflow_id = ?
         ORDER BY created_at, transcript_id`,
      )
      .all(workflowId)
      .map((row) =>
        parseStoredPayload(
          payloadRowSchema.parse(row).payload_json,
          handoffTranscriptSchema,
          'HANDOFF_TRANSCRIPT',
        ),
      );
  }

  getHandoffTranscript(transcriptId: string): HandoffTranscript | null {
    const row = this.db
      .prepare(
        `SELECT payload_json
         FROM review_workflow_handoff_transcripts
         WHERE transcript_id = ?`,
      )
      .get(transcriptId);
    if (row === undefined) return null;
    return parseStoredPayload(
      payloadRowSchema.parse(row).payload_json,
      handoffTranscriptSchema,
      'HANDOFF_TRANSCRIPT',
    );
  }

  getStructuredReview(reviewRoundId: string): StructuredReview | null {
    const row = this.db
      .prepare(
        `SELECT payload_json
         FROM review_workflow_structured_reviews
         WHERE review_round_id = ?`,
      )
      .get(reviewRoundId);
    if (row === undefined) return null;
    return parseStoredPayload(
      payloadRowSchema.parse(row).payload_json,
      structuredReviewSchema,
      'STRUCTURED_REVIEW',
    );
  }

  saveEntity(entity: PersistableReviewWorkflowEntity): ImmutableSaveResult {
    switch (entity.kind) {
      case 'AGENT_ASSIGNMENT': {
        const value = agentAssignmentSchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_agent_assignments',
          idColumn: 'assignment_id',
          id: value.assignmentId,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_agent_assignments (
            assignment_id,
            workflow_id,
            batch_id,
            assigned_role,
            configured_agent_key,
            configuration_hash,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            value.assignmentId,
            value.workflowId,
            value.batchId ?? null,
            value.assignedRole,
            value.configuredAgentKey,
            value.configurationHash,
          ],
          payload: value,
          createdAt: value.assignedAt,
        });
      }
      case 'ACTOR_EXECUTION': {
        const value = actorExecutionIdentitySchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_actor_executions',
          idColumn: 'actor_execution_id',
          id: value.actorExecutionId,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_actor_executions (
            actor_execution_id,
            assignment_id,
            actor_type,
            identity_assurance,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          values: [
            value.actorExecutionId,
            value.assignmentId ?? null,
            value.actorType,
            value.identityAssurance,
          ],
          payload: value,
          createdAt: value.startedAt,
        });
      }
      case 'INVOCATION_IDENTITY': {
        const value = invocationIdentitySchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_invocations',
          idColumn: 'invocation_id',
          id: value.invocationId,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_invocations (
            invocation_id,
            command_id,
            result_status,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          values: [value.invocationId, value.commandId, value.resultStatus],
          payload: value,
          createdAt: value.startedAt,
        });
      }
      case 'SESSION_IDENTITY': {
        const value = sessionIdentitySchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_sessions',
          idColumn: 'session_identity_id',
          id: value.sessionIdentityId,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_sessions (
            session_identity_id,
            workflow_id,
            creating_invocation_id,
            resumed_from_session_identity_id,
            assigned_role,
            provider_or_adapter,
            vendor_session_id,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            value.sessionIdentityId,
            value.workflowId,
            value.creatingInvocationId,
            value.resumedFromSessionIdentityId ?? null,
            value.assignedRole,
            value.providerOrAdapter,
            value.vendorSessionId,
          ],
          payload: value,
          createdAt: value.createdAt,
        });
      }
      case 'GENERAL_PLAN_VERSION': {
        const value = generalPlanVersionSchema.parse(entity.value);
        return this.savePlanDocument(
          'GENERAL',
          value.generalPlanVersionId,
          value.workflowId,
          null,
          value.version,
          value.contentHash,
          value,
          value.createdAt,
        );
      }
      case 'PLAN_REQUIREMENT': {
        const value = planRequirementSchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_plan_requirements',
          idColumn: 'requirement_id',
          id: value.requirementId,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_plan_requirements (
            requirement_id,
            general_plan_version_id,
            required,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          values: [value.requirementId, value.generalPlanVersionId, value.required ? 1 : 0],
          payload: value,
          createdAt: value.createdAt,
        });
      }
      case 'REPOSITORY_AUDIT': {
        const value = repositoryAuditSchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_repository_audits',
          idColumn: 'repository_audit_id',
          id: value.repositoryAuditId,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_repository_audits (
            repository_audit_id,
            workflow_id,
            head_sha,
            actor_execution_id,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          values: [
            value.repositoryAuditId,
            value.workflowId,
            value.headSha,
            value.actorExecutionId,
          ],
          payload: value,
          createdAt: value.observedAt,
        });
      }
      case 'REFINED_PLAN_VERSION': {
        const value = refinedPlanVersionSchema.parse(entity.value);
        return this.savePlanDocument(
          'REFINED',
          value.refinedPlanVersionId,
          value.workflowId,
          null,
          value.version,
          value.contentHash,
          value,
          value.createdAt,
        );
      }
      case 'BATCH_PLAN_VERSION': {
        const value = batchPlanVersionSchema.parse(entity.value);
        return this.savePlanDocument(
          'BATCH',
          value.batchPlanVersionId,
          value.workflowId,
          value.batchId,
          value.version,
          value.contentHash,
          value,
          value.createdAt,
        );
      }
      case 'ACCEPTANCE_CRITERION': {
        const value = acceptanceCriterionSchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_acceptance_criteria',
          idColumn: 'acceptance_criterion_id',
          id: value.acceptanceCriterionId,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_acceptance_criteria (
            acceptance_criterion_id,
            batch_plan_version_id,
            criterion_kind,
            required,
            status,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            value.acceptanceCriterionId,
            value.batchPlanVersionId,
            value.kind,
            value.required ? 1 : 0,
            value.status,
          ],
          payload: value,
          createdAt: value.createdAt,
        });
      }
      case 'IMPLEMENTATION_ATTEMPT': {
        const value = implementationAttemptSchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_implementation_attempts',
          idColumn: 'implementation_attempt_id',
          id: value.implementationAttemptId,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_implementation_attempts (
            implementation_attempt_id,
            workflow_id,
            batch_id,
            attempt_number,
            implementer_assignment_id,
            implementer_actor_execution_id,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            value.implementationAttemptId,
            value.workflowId,
            value.batchId,
            value.attemptNumber,
            value.implementerAssignmentId,
            value.implementerActorExecutionId,
          ],
          payload: value,
          createdAt: value.startedAt,
        });
      }
      case 'IMPLEMENTATION_READY_EVIDENCE': {
        const value = implementationReadyEvidenceSchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_implementation_ready_evidence',
          idColumn: 'implementation_ready_evidence_id',
          id: value.implementationReadyEvidenceId,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_implementation_ready_evidence (
            implementation_ready_evidence_id,
            implementation_attempt_id,
            actor_execution_id,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          values: [
            value.implementationReadyEvidenceId,
            value.implementationAttemptId,
            value.actorExecutionId,
          ],
          payload: value,
          createdAt: value.capturedAt,
        });
      }
      case 'IMPLEMENTATION_COMMIT': {
        const value = implementationCommitSchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_implementation_commits',
          idColumn: 'resulting_commit_sha',
          id: value.resultingCommitSha,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_implementation_commits (
            resulting_commit_sha,
            implementation_attempt_id,
            implementation_ready_evidence_id,
            creator_actor_execution_id,
            creation_mode,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            value.resultingCommitSha,
            value.implementationAttemptId,
            value.implementationReadyEvidenceId,
            value.creatorActorExecutionId,
            value.creationMode,
          ],
          payload: value,
          createdAt: value.validatedAt,
        });
      }
      case 'FINDING': {
        const value = findingSchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_findings',
          idColumn: 'finding_id',
          id: value.findingId,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_findings (
            finding_id,
            workflow_id,
            batch_id,
            review_round_id,
            review_round_number,
            review_kind,
            severity,
            category,
            status,
            reviewed_commit_sha,
            payload_json,
            record_hash,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            value.findingId,
            value.workflowId,
            value.batchId,
            value.reviewRoundId,
            value.reviewRoundNumber,
            value.reviewKind,
            value.severity,
            value.category,
            value.status,
            value.reviewedCommitSha ?? null,
          ],
          payload: value,
          createdAt: value.createdAt,
          trailingValues: [value.updatedAt],
        });
      }
      case 'FINDING_DISPOSITION': {
        const value = findingDispositionSchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_dispositions',
          idColumn: 'disposition_id',
          id: value.dispositionId,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_dispositions (
            disposition_id,
            finding_id,
            disposition_kind,
            reviewer_decision,
            actor_execution_id,
            payload_json,
            record_hash,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            value.dispositionId,
            value.findingId,
            value.disposition,
            value.reviewerDecision.decision,
            value.actorExecutionId,
          ],
          payload: value,
          createdAt: value.createdAt,
          trailingValues: [value.updatedAt],
        });
      }
      case 'VERIFICATION_RECORD': {
        const value = verificationRecordSchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_verification_records',
          idColumn: 'verification_record_id',
          id: value.verificationRecordId,
          hashInput: {
            kind: entity.kind,
            workflowId: entity.workflowId,
            batchId: entity.batchId,
            value,
          },
          insertSql: `INSERT INTO review_workflow_verification_records (
            verification_record_id,
            workflow_id,
            batch_id,
            executor_actor_execution_id,
            verification_type,
            observed_status,
            commit_sha,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            value.verificationRecordId,
            entity.workflowId,
            entity.batchId,
            value.executorActorExecutionId,
            value.verificationType,
            value.observedStatus,
            value.commitSha,
          ],
          payload: value,
          createdAt: value.startedAt,
        });
      }
      case 'VERIFICATION_ATTESTATION': {
        const value = verificationAttestationSchema.parse(entity.value);
        const recordEntity = this.getEntity('VERIFICATION_RECORD', value.verificationRecordId);
        if (recordEntity === null || recordEntity.kind !== 'VERIFICATION_RECORD') {
          throw new ReviewWorkflowPersistenceError(
            'PERSISTED_DATA_INVALID',
            `Verification attestation ${value.verificationAttestationId} references a missing record`,
          );
        }
        const record = recordEntity.value;
        if (
          recordEntity.workflowId !== value.workflowId ||
          recordEntity.batchId !== value.batchId ||
          hashVerificationRecord(record) !== value.evidenceHash ||
          !sameStringSet(record.relatedCriterionIds, value.relatedCriterionIds) ||
          !sameStringSet(record.relatedFindingIds, value.relatedFindingIds) ||
          record.verificationType !== value.recordVerificationType ||
          record.executorActorExecutionId !== value.recordExecutorActorExecutionId ||
          record.executorActorType !== value.recordExecutorActorType ||
          record.executorAssignmentId !== value.recordExecutorAssignmentId
        ) {
          throw new ReviewWorkflowPersistenceError(
            'PERSISTED_DATA_INVALID',
            `Verification attestation ${value.verificationAttestationId} does not match its record`,
          );
        }
        return this.saveRecord({
          table: 'review_workflow_verification_attestations',
          idColumn: 'verification_attestation_id',
          id: value.verificationAttestationId,
          hashInput: { kind: entity.kind, value },
          insertSql: `INSERT INTO review_workflow_verification_attestations (
            verification_attestation_id,
            verification_record_id,
            workflow_id,
            batch_id,
            decision,
            acceptance_mode,
            attestor_actor_execution_id,
            reviewed_commit_sha,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            value.verificationAttestationId,
            value.verificationRecordId,
            value.workflowId,
            value.batchId,
            value.decision,
            value.acceptanceMode,
            value.attestorActorExecutionId,
            value.reviewedCommitSha,
          ],
          payload: value,
          createdAt: value.createdAt,
        });
      }
      case 'REVIEW_RANGE_EVIDENCE': {
        const value = reviewRangeEvidenceSchema.parse(entity.value);
        return this.saveRecord({
          table: 'review_workflow_review_range_evidence',
          idColumn: 'review_range_evidence_id',
          id: entity.reviewRangeEvidenceId,
          hashInput: {
            kind: entity.kind,
            reviewRangeEvidenceId: entity.reviewRangeEvidenceId,
            workflowId: entity.workflowId,
            batchId: entity.batchId,
            value,
          },
          insertSql: `INSERT INTO review_workflow_review_range_evidence (
            review_range_evidence_id,
            workflow_id,
            batch_id,
            current_implementation_sha,
            patch_hash,
            payload_json,
            record_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            entity.reviewRangeEvidenceId,
            entity.workflowId,
            entity.batchId,
            value.vocabulary.currentImplementationSha,
            value.patchHash,
          ],
          payload: value,
          createdAt: value.capturedAt,
        });
      }
    }
  }

  getEntity(kind: ReviewWorkflowEntityKind, id: string): PersistableReviewWorkflowEntity | null {
    switch (kind) {
      case 'AGENT_ASSIGNMENT':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_agent_assignments',
          'assignment_id',
          id,
          agentAssignmentSchema,
        );
      case 'ACTOR_EXECUTION':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_actor_executions',
          'actor_execution_id',
          id,
          actorExecutionIdentitySchema,
        );
      case 'INVOCATION_IDENTITY':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_invocations',
          'invocation_id',
          id,
          invocationIdentitySchema,
        );
      case 'SESSION_IDENTITY':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_sessions',
          'session_identity_id',
          id,
          sessionIdentitySchema,
        );
      case 'GENERAL_PLAN_VERSION':
        return this.loadPlanDocumentEntity(kind, 'GENERAL', id, generalPlanVersionSchema);
      case 'PLAN_REQUIREMENT':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_plan_requirements',
          'requirement_id',
          id,
          planRequirementSchema,
        );
      case 'REPOSITORY_AUDIT':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_repository_audits',
          'repository_audit_id',
          id,
          repositoryAuditSchema,
        );
      case 'REFINED_PLAN_VERSION':
        return this.loadPlanDocumentEntity(kind, 'REFINED', id, refinedPlanVersionSchema);
      case 'BATCH_PLAN_VERSION':
        return this.loadPlanDocumentEntity(kind, 'BATCH', id, batchPlanVersionSchema);
      case 'ACCEPTANCE_CRITERION':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_acceptance_criteria',
          'acceptance_criterion_id',
          id,
          acceptanceCriterionSchema,
        );
      case 'IMPLEMENTATION_ATTEMPT':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_implementation_attempts',
          'implementation_attempt_id',
          id,
          implementationAttemptSchema,
        );
      case 'IMPLEMENTATION_READY_EVIDENCE':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_implementation_ready_evidence',
          'implementation_ready_evidence_id',
          id,
          implementationReadyEvidenceSchema,
        );
      case 'IMPLEMENTATION_COMMIT':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_implementation_commits',
          'resulting_commit_sha',
          id,
          implementationCommitSchema,
        );
      case 'FINDING':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_findings',
          'finding_id',
          id,
          findingSchema,
        );
      case 'FINDING_DISPOSITION':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_dispositions',
          'disposition_id',
          id,
          findingDispositionSchema,
        );
      case 'VERIFICATION_RECORD': {
        const row = this.loadContextualPayload(
          'review_workflow_verification_records',
          'verification_record_id',
          id,
        );
        if (row === null) return null;
        return {
          kind,
          workflowId: row.workflowId,
          batchId: row.batchId,
          value: parseStoredPayload(row.payloadJson, verificationRecordSchema, kind),
        };
      }
      case 'VERIFICATION_ATTESTATION':
        return this.loadSimpleEntity(
          kind,
          'review_workflow_verification_attestations',
          'verification_attestation_id',
          id,
          verificationAttestationSchema,
        );
      case 'REVIEW_RANGE_EVIDENCE': {
        const row = this.loadContextualPayload(
          'review_workflow_review_range_evidence',
          'review_range_evidence_id',
          id,
        );
        if (row === null) return null;
        return {
          kind,
          reviewRangeEvidenceId: id,
          workflowId: row.workflowId,
          batchId: row.batchId,
          value: parseStoredPayload(row.payloadJson, reviewRangeEvidenceSchema, kind),
        };
      }
    }
  }

  private saveHandoffTranscript(transcript: HandoffTranscript): ImmutableSaveResult {
    return this.saveRecord({
      table: 'review_workflow_handoff_transcripts',
      idColumn: 'transcript_id',
      id: transcript.transcriptId,
      hashInput: { kind: 'HANDOFF_TRANSCRIPT', value: transcript },
      insertSql: `INSERT INTO review_workflow_handoff_transcripts (
        transcript_id,
        workflow_id,
        batch_id,
        contract_kind,
        expected_schema_version,
        actor_execution_id,
        parse_status,
        raw_transcript,
        raw_transcript_hash,
        payload_json,
        record_hash,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [
        transcript.transcriptId,
        transcript.workflowId,
        transcript.batchId ?? null,
        transcript.contractKind,
        transcript.expectedSchemaVersion,
        transcript.actorExecutionId,
        transcript.parseStatus,
        transcript.rawTranscript,
        transcript.rawTranscriptHash,
      ],
      payload: transcript,
      createdAt: transcript.createdAt,
    });
  }

  private dispositionFindingsMatchTranscript(
    entities: readonly PersistableReviewWorkflowEntity[],
    transcript: HandoffTranscript,
  ): boolean {
    return entities.every((entity) => {
      if (entity.kind !== 'FINDING_DISPOSITION') return false;
      const row = this.db
        .prepare(
          `SELECT workflow_id, batch_id
           FROM review_workflow_findings
           WHERE finding_id = ?`,
        )
        .get(entity.value.findingId);
      const parsed = z.object({ workflow_id: z.string(), batch_id: z.string() }).safeParse(row);
      return (
        parsed.success &&
        parsed.data.workflow_id === transcript.workflowId &&
        parsed.data.batch_id === transcript.batchId
      );
    });
  }

  private saveStructuredReview(review: StructuredReview): ImmutableSaveResult {
    return this.saveRecord({
      table: 'review_workflow_structured_reviews',
      idColumn: 'review_round_id',
      id: review.reviewRoundId,
      hashInput: { kind: 'STRUCTURED_REVIEW', value: review },
      insertSql: `INSERT INTO review_workflow_structured_reviews (
        review_round_id,
        transcript_id,
        workflow_id,
        batch_id,
        review_round_number,
        review_kind,
        verdict,
        reviewer_actor_execution_id,
        payload_json,
        record_hash,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [
        review.reviewRoundId,
        review.transcriptId,
        review.workflowId,
        review.batchId,
        review.reviewRoundNumber,
        review.reviewKind,
        review.verdict,
        review.reviewerActorExecutionId,
      ],
      payload: review,
      createdAt: review.createdAt,
    });
  }

  private savePlanDocument(
    kind: 'GENERAL' | 'REFINED' | 'BATCH',
    documentId: string,
    workflowId: string,
    batchId: string | null,
    version: number,
    contentHash: string,
    payload: GeneralPlanVersion | RefinedPlanVersion | BatchPlanVersion,
    createdAt: string,
  ): ImmutableSaveResult {
    return this.saveRecord({
      table: 'review_workflow_plan_documents',
      idColumn: 'document_id',
      id: documentId,
      hashInput: { kind, value: payload },
      insertSql: `INSERT INTO review_workflow_plan_documents (
        document_id,
        workflow_id,
        batch_id,
        document_kind,
        version,
        content_hash,
        payload_json,
        record_hash,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [documentId, workflowId, batchId, kind, version, contentHash],
      payload,
      createdAt,
    });
  }

  private saveRecord(input: {
    readonly table: string;
    readonly idColumn: string;
    readonly id: string;
    readonly hashInput: unknown;
    readonly insertSql: string;
    readonly values: readonly unknown[];
    readonly payload: unknown;
    readonly createdAt: string;
    readonly trailingValues?: readonly unknown[];
  }): ImmutableSaveResult {
    const payloadJson = serializeJson(input.payload);
    const recordHash = hashRecord(input.hashInput);
    return this.insertImmutable({
      table: input.table,
      idColumn: input.idColumn,
      id: input.id,
      recordHash,
      insert: () =>
        this.db
          .prepare(input.insertSql)
          .run(
            ...input.values,
            payloadJson,
            recordHash,
            input.createdAt,
            ...(input.trailingValues ?? []),
          ),
    });
  }

  private insertImmutable(input: {
    readonly table: string;
    readonly idColumn: string;
    readonly id: string;
    readonly recordHash: string;
    readonly insert: () => Database.RunResult;
  }): ImmutableSaveResult {
    const existingHash = this.getRecordHash(input.table, input.idColumn, input.id);
    if (existingHash !== null) {
      if (existingHash === input.recordHash) return { inserted: false };
      throw new ReviewWorkflowPersistenceError(
        'IMMUTABLE_ENTITY_CONFLICT',
        `Stored ${input.table} record ${input.id} differs from the supplied immutable record`,
      );
    }

    try {
      input.insert();
      return { inserted: true };
    } catch (error) {
      const racedHash = this.getRecordHash(input.table, input.idColumn, input.id);
      if (racedHash === input.recordHash) return { inserted: false };
      if (racedHash !== null) {
        throw new ReviewWorkflowPersistenceError(
          'IMMUTABLE_ENTITY_CONFLICT',
          `Stored ${input.table} record ${input.id} differs from the supplied immutable record`,
        );
      }
      throw error;
    }
  }

  private getRecordHash(table: string, idColumn: string, id: string): string | null {
    const row = this.db.prepare(`SELECT record_hash FROM ${table} WHERE ${idColumn} = ?`).get(id);
    if (row === undefined) return null;
    return recordHashRowSchema.parse(row).record_hash;
  }

  private loadSimpleEntity<
    Kind extends Exclude<ReviewWorkflowEntityKind, 'VERIFICATION_RECORD' | 'REVIEW_RANGE_EVIDENCE'>,
    Value,
  >(
    kind: Kind,
    table: string,
    idColumn: string,
    id: string,
    schema: z.ZodType<Value>,
  ): { readonly kind: Kind; readonly value: Value } | null {
    const row = this.db.prepare(`SELECT payload_json FROM ${table} WHERE ${idColumn} = ?`).get(id);
    if (row === undefined) return null;
    const parsedRow = payloadRowSchema.parse(row);
    return {
      kind,
      value: parseStoredPayload(parsedRow.payload_json, schema, kind),
    };
  }

  private loadPlanDocumentEntity<
    Kind extends 'GENERAL_PLAN_VERSION' | 'REFINED_PLAN_VERSION' | 'BATCH_PLAN_VERSION',
    Value,
  >(
    kind: Kind,
    documentKind: 'GENERAL' | 'REFINED' | 'BATCH',
    id: string,
    schema: z.ZodType<Value>,
  ): { readonly kind: Kind; readonly value: Value } | null {
    const row = this.db
      .prepare(
        `SELECT payload_json
         FROM review_workflow_plan_documents
         WHERE document_id = ? AND document_kind = ?`,
      )
      .get(id, documentKind);
    if (row === undefined) return null;
    const parsedRow = payloadRowSchema.parse(row);
    return {
      kind,
      value: parseStoredPayload(parsedRow.payload_json, schema, kind),
    };
  }

  private loadContextualPayload(
    table: string,
    idColumn: string,
    id: string,
  ): {
    readonly workflowId: string;
    readonly batchId: string;
    readonly payloadJson: string;
  } | null {
    const row = this.db
      .prepare(`SELECT workflow_id, batch_id, payload_json FROM ${table} WHERE ${idColumn} = ?`)
      .get(id);
    if (row === undefined) return null;
    const parsed = contextualPayloadRowSchema.parse(row);
    return {
      workflowId: parsed.workflow_id,
      batchId: parsed.batch_id,
      payloadJson: parsed.payload_json,
    };
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
