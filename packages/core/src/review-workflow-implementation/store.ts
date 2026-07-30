import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  type ReviewWorkflowEvent,
  ReviewWorkflowPersistenceError,
  ReviewWorkflowStore,
} from '../memory/review-workflow-store.js';
import { structuredReviewSchema } from '../review-workflow-contracts/schemas.js';
import type { StructuredReview } from '../review-workflow-contracts/types.js';
import {
  acceptanceCriterionSchema,
  findingDispositionSchema,
  implementationAttemptSchema,
  implementationReadyEvidenceSchema,
} from '../review-workflow/schemas.js';
import type {
  AcceptanceCriterion,
  ActorExecutionIdentity,
  AgentAssignment,
  BatchPlanVersion,
  Finding,
  FindingDisposition,
  ImplementationAttempt,
  ImplementationReadyEvidence,
  ReviewWorkflowBatch,
  SessionIdentity,
  WorkflowRun,
} from '../review-workflow/types.js';

const payloadRowSchema = z.object({ payload_json: z.string() });

export class ReviewWorkflowImplementationStore {
  readonly workflowStore: ReviewWorkflowStore;

  constructor(private readonly db: Database.Database) {
    this.workflowStore = new ReviewWorkflowStore(db);
  }

  runAtomically<Value>(operation: () => Value): Value {
    return this.db.transaction(operation)();
  }

  getWorkflow(workflowId: string): WorkflowRun | null {
    return this.workflowStore.getWorkflow(workflowId);
  }

  getBatch(batchId: string): ReviewWorkflowBatch | null {
    return this.workflowStore.getBatch(batchId);
  }

  getBatchPlan(batchPlanVersionId: string): BatchPlanVersion | null {
    const entity = this.workflowStore.getEntity('BATCH_PLAN_VERSION', batchPlanVersionId);
    return entity?.kind === 'BATCH_PLAN_VERSION' ? entity.value : null;
  }

  getAssignment(assignmentId: string): AgentAssignment | null {
    const entity = this.workflowStore.getEntity('AGENT_ASSIGNMENT', assignmentId);
    return entity?.kind === 'AGENT_ASSIGNMENT' ? entity.value : null;
  }

  getActorExecution(actorExecutionId: string): ActorExecutionIdentity | null {
    const entity = this.workflowStore.getEntity('ACTOR_EXECUTION', actorExecutionId);
    return entity?.kind === 'ACTOR_EXECUTION' ? entity.value : null;
  }

  getSessionIdentity(sessionIdentityId: string): SessionIdentity | null {
    const entity = this.workflowStore.getEntity('SESSION_IDENTITY', sessionIdentityId);
    return entity?.kind === 'SESSION_IDENTITY' ? entity.value : null;
  }

  getEvents(batchId: string): readonly ReviewWorkflowEvent[] {
    return this.workflowStore.getEvents(batchId);
  }

  getImplementationAttempt(implementationAttemptId: string): ImplementationAttempt | null {
    const entity = this.workflowStore.getEntity('IMPLEMENTATION_ATTEMPT', implementationAttemptId);
    return entity?.kind === 'IMPLEMENTATION_ATTEMPT' ? entity.value : null;
  }

  getImplementationReadyEvidence(
    implementationReadyEvidenceId: string,
  ): ImplementationReadyEvidence | null {
    const entity = this.workflowStore.getEntity(
      'IMPLEMENTATION_READY_EVIDENCE',
      implementationReadyEvidenceId,
    );
    return entity?.kind === 'IMPLEMENTATION_READY_EVIDENCE' ? entity.value : null;
  }

  listImplementationAttempts(batchId: string): readonly ImplementationAttempt[] {
    return this.readPayloads(
      `SELECT payload_json
       FROM review_workflow_implementation_attempts
       WHERE batch_id = ?
       ORDER BY attempt_number, implementation_attempt_id`,
      [batchId],
      implementationAttemptSchema,
      'IMPLEMENTATION_ATTEMPT',
    );
  }

  listAcceptanceCriteria(batchPlanVersionId: string): readonly AcceptanceCriterion[] {
    return this.readPayloads(
      `SELECT payload_json
       FROM review_workflow_acceptance_criteria
       WHERE batch_plan_version_id = ?
       ORDER BY acceptance_criterion_id`,
      [batchPlanVersionId],
      acceptanceCriterionSchema,
      'ACCEPTANCE_CRITERION',
    );
  }

  listCodeReviews(batchId: string): readonly StructuredReview[] {
    return this.readPayloads(
      `SELECT payload_json
       FROM review_workflow_structured_reviews
       WHERE batch_id = ? AND review_kind = 'CODE'
       ORDER BY review_round_number`,
      [batchId],
      structuredReviewSchema,
      'STRUCTURED_REVIEW',
    );
  }

  getFinding(findingId: string): Finding | null {
    const entity = this.workflowStore.getEntity('FINDING', findingId);
    return entity?.kind === 'FINDING' ? entity.value : null;
  }

  listDispositionsForFinding(findingId: string): readonly FindingDisposition[] {
    return this.readPayloads(
      `SELECT payload_json
       FROM review_workflow_dispositions
       WHERE finding_id = ?
       ORDER BY created_at, disposition_id`,
      [findingId],
      findingDispositionSchema,
      'FINDING_DISPOSITION',
    );
  }

  listImplementationReadyEvidence(
    implementationAttemptId: string,
  ): readonly ImplementationReadyEvidence[] {
    return this.readPayloads(
      `SELECT payload_json
       FROM review_workflow_implementation_ready_evidence
       WHERE implementation_attempt_id = ?
       ORDER BY created_at, implementation_ready_evidence_id`,
      [implementationAttemptId],
      implementationReadyEvidenceSchema,
      'IMPLEMENTATION_READY_EVIDENCE',
    );
  }

  private readPayloads<Value>(
    sql: string,
    values: readonly unknown[],
    schema: z.ZodType<Value>,
    kind: string,
  ): readonly Value[] {
    return this.db
      .prepare(sql)
      .all(...values)
      .map((row) => {
        try {
          return schema.parse(JSON.parse(payloadRowSchema.parse(row).payload_json));
        } catch {
          throw new ReviewWorkflowPersistenceError(
            'PERSISTED_DATA_INVALID',
            `Stored ${kind} payload failed domain validation`,
          );
        }
      });
  }
}
