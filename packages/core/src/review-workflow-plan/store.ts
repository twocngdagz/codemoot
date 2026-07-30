import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  ReviewWorkflowPersistenceError,
  ReviewWorkflowStore,
} from '../memory/review-workflow-store.js';
import {
  acceptanceCriterionSchema,
  findingSchema,
  planRequirementSchema,
  repositoryAuditSchema,
  reviewWorkflowBatchSchema,
  workflowRunSchema,
} from '../review-workflow/schemas.js';
import type {
  AcceptanceCriterion,
  ActorExecutionIdentity,
  AgentAssignment,
  BatchPlanVersion,
  Finding,
  GeneralPlanVersion,
  PlanRequirement,
  RepositoryAudit,
  ReviewWorkflowBatch,
  WorkflowRun,
} from '../review-workflow/types.js';

const payloadRowSchema = z.object({ payload_json: z.string() });

export interface WorkflowIntakePersistenceInput {
  readonly workflow: WorkflowRun;
  readonly assignments: readonly [AgentAssignment, AgentAssignment];
  readonly owner: ActorExecutionIdentity;
  readonly generalPlan: GeneralPlanVersion;
  readonly requirements: readonly PlanRequirement[];
  readonly repositoryAudit: RepositoryAudit;
}

export class ReviewWorkflowPlanStore {
  readonly workflowStore: ReviewWorkflowStore;

  constructor(private readonly db: Database.Database) {
    this.workflowStore = new ReviewWorkflowStore(db);
  }

  runAtomically<Value>(operation: () => Value): Value {
    return this.db.transaction(operation)();
  }

  createWorkflowIntake(input: WorkflowIntakePersistenceInput): void {
    this.runAtomically(() => {
      this.workflowStore.createWorkflow(input.workflow);
      for (const assignment of input.assignments) {
        this.workflowStore.saveEntity({ kind: 'AGENT_ASSIGNMENT', value: assignment });
      }
      this.workflowStore.saveEntity({ kind: 'ACTOR_EXECUTION', value: input.owner });
      this.workflowStore.saveEntity({
        kind: 'GENERAL_PLAN_VERSION',
        value: input.generalPlan,
      });
      for (const requirement of input.requirements) {
        this.workflowStore.saveEntity({ kind: 'PLAN_REQUIREMENT', value: requirement });
      }
      this.workflowStore.saveEntity({
        kind: 'REPOSITORY_AUDIT',
        value: input.repositoryAudit,
      });
    });
  }

  getWorkflow(workflowId: string): WorkflowRun | null {
    return this.workflowStore.getWorkflow(workflowId);
  }

  getBatch(batchId: string): ReviewWorkflowBatch | null {
    return this.workflowStore.getBatch(batchId);
  }

  getAssignment(assignmentId: string): AgentAssignment | null {
    const entity = this.workflowStore.getEntity('AGENT_ASSIGNMENT', assignmentId);
    return entity?.kind === 'AGENT_ASSIGNMENT' ? entity.value : null;
  }

  getGeneralPlan(generalPlanVersionId: string): GeneralPlanVersion | null {
    const entity = this.workflowStore.getEntity('GENERAL_PLAN_VERSION', generalPlanVersionId);
    return entity?.kind === 'GENERAL_PLAN_VERSION' ? entity.value : null;
  }

  getRepositoryAudit(repositoryAuditId: string): RepositoryAudit | null {
    const entity = this.workflowStore.getEntity('REPOSITORY_AUDIT', repositoryAuditId);
    return entity?.kind === 'REPOSITORY_AUDIT' ? entity.value : null;
  }

  getLatestRepositoryAudit(workflowId: string): RepositoryAudit | null {
    const audits = this.readPayloads(
      `SELECT payload_json
       FROM review_workflow_repository_audits
       WHERE workflow_id = ?
       ORDER BY created_at DESC, repository_audit_id DESC
       LIMIT 1`,
      [workflowId],
      repositoryAuditSchema,
      'REPOSITORY_AUDIT',
    );
    return audits[0] ?? null;
  }

  getBatchPlan(batchPlanVersionId: string): BatchPlanVersion | null {
    const entity = this.workflowStore.getEntity('BATCH_PLAN_VERSION', batchPlanVersionId);
    return entity?.kind === 'BATCH_PLAN_VERSION' ? entity.value : null;
  }

  listRequirements(generalPlanVersionId: string): readonly PlanRequirement[] {
    return this.readPayloads(
      `SELECT payload_json
       FROM review_workflow_plan_requirements
       WHERE general_plan_version_id = ?
       ORDER BY created_at, requirement_id`,
      [generalPlanVersionId],
      planRequirementSchema,
      'PLAN_REQUIREMENT',
    );
  }

  listBatches(workflowId: string): readonly ReviewWorkflowBatch[] {
    return this.readPayloads(
      `SELECT payload_json
       FROM review_workflow_batches
       WHERE workflow_id = ?
       ORDER BY ordinal`,
      [workflowId],
      reviewWorkflowBatchSchema,
      'BATCH',
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

  listPlanFindings(batchId: string): readonly Finding[] {
    return this.readPayloads(
      `SELECT payload_json
       FROM review_workflow_findings
       WHERE batch_id = ? AND review_kind = 'PLAN'
       ORDER BY review_round_number, finding_id`,
      [batchId],
      findingSchema,
      'FINDING',
    );
  }

  updateRefinedPlanPointer(
    workflowId: string,
    refinedPlanVersionId: string,
    updatedAt: string,
  ): WorkflowRun {
    const current = this.workflowStore.getWorkflow(workflowId);
    if (current === null) {
      throw new ReviewWorkflowPersistenceError(
        'WORKFLOW_NOT_FOUND',
        `Workflow ${workflowId} does not exist`,
      );
    }
    const refined = this.workflowStore.getEntity('REFINED_PLAN_VERSION', refinedPlanVersionId);
    if (refined?.kind !== 'REFINED_PLAN_VERSION' || refined.value.workflowId !== workflowId) {
      throw new ReviewWorkflowPersistenceError(
        'PERSISTED_DATA_INVALID',
        `Refined plan ${refinedPlanVersionId} does not belong to workflow ${workflowId}`,
      );
    }
    const updated = workflowRunSchema.parse({
      ...current,
      refinedPlanVersionId,
      updatedAt,
    });
    const payloadJson = serialize(updated);
    const recordHash = hash({ kind: 'WORKFLOW', value: updated });
    const result = this.db
      .prepare(
        `UPDATE review_workflows
         SET refined_plan_version_id = ?,
             aggregate_version = aggregate_version + 1,
             payload_json = ?,
             record_hash = ?,
             updated_at = ?
         WHERE workflow_id = ? AND payload_json = ?`,
      )
      .run(
        refinedPlanVersionId,
        payloadJson,
        recordHash,
        updatedAt,
        workflowId,
        serialize(current),
      );
    if (result.changes !== 1) {
      throw new ReviewWorkflowPersistenceError(
        'AGGREGATE_VERSION_CONFLICT',
        `Workflow ${workflowId} changed while its refined-plan pointer was updated`,
      );
    }
    return updated;
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
          const payload = payloadRowSchema.parse(row).payload_json;
          return schema.parse(JSON.parse(payload));
        } catch {
          throw new ReviewWorkflowPersistenceError(
            'PERSISTED_DATA_INVALID',
            `Stored ${kind} payload failed domain validation`,
          );
        }
      });
  }
}

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ReviewWorkflowPersistenceError(
      'PERSISTED_DATA_INVALID',
      'Review workflow plan persistence received a non-serializable value',
    );
  }
  return serialized;
}

function hash(value: unknown): string {
  return createHash('sha256').update(serialize(value)).digest('hex');
}
