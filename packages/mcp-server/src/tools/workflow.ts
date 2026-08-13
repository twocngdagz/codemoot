// Additive review-workflow MCP tools (Batch 14). Every state-changing action calls the same
// shared coordinator services the CLI uses, with an explicit command ID and optional expected
// batch version — so programmatic callers get exactly the CLI's identity, idempotency, and
// replay guarantees. The original five tools are untouched.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig,
  type openDatabase,
  reviewWorkflowContracts,
  reviewWorkflowGate,
  reviewWorkflowGit,
  reviewWorkflowIdentity,
  reviewWorkflowJobs,
  reviewWorkflowPersistence,
  reviewWorkflowPlan,
  workflowEventsInputSchema,
  workflowGateInputSchema,
  workflowJobsInputSchema,
  workflowStatusInputSchema,
} from '@codemoot/core';
import type { WorkflowJobsInput, reviewWorkflow } from '@codemoot/core';
import { ZodError, z } from 'zod';

export interface WorkflowToolRuntime {
  readonly projectDir: string;
  readonly planStore: reviewWorkflowPlan.ReviewWorkflowPlanStore;
  readonly gateStore: reviewWorkflowGate.ReviewWorkflowGateStore;
  readonly gateService: reviewWorkflowGate.ReviewWorkflowGateService;
  readonly jobStore: reviewWorkflowJobs.ReviewWorkflowJobStore;
  readonly jobService: reviewWorkflowJobs.ReviewWorkflowJobService;
}

/**
 * Builds the workflow tool runtime lazily per call: the Git repository handle is only valid
 * inside a repository, and the MCP server must start cleanly outside one.
 */
export function createWorkflowToolRuntime(
  db: ReturnType<typeof openDatabase>,
  projectDir: string,
): WorkflowToolRuntime {
  const gateStore = new reviewWorkflowGate.ReviewWorkflowGateStore(db);
  const commandStore = new reviewWorkflowPersistence.ReviewWorkflowCommandStore(db);
  const contractService = new reviewWorkflowContracts.ReviewWorkflowContractService(
    gateStore.workflowStore,
  );
  const repository = new reviewWorkflowGit.LocalGitRepository(projectDir);
  const gitService = new reviewWorkflowGit.ReviewWorkflowGitService(repository, {
    storePatch: (artifact) => {
      const directory = join(projectDir, '.codemoot', 'review-workflow', 'patches');
      mkdirSync(directory, { recursive: true });
      const location = join(directory, `${artifact.kind}-${artifact.patchHash}.patch`);
      writeFileSync(location, artifact.patch);
      return location;
    },
  });
  const roleInvocation = new (class {
    prepare(): never {
      throw new Error('Workflow MCP tools never invoke agent subprocesses');
    }
    persistPrepared(): never {
      throw new Error('Workflow MCP tools never invoke agent subprocesses');
    }
  })();
  const jobStore = new reviewWorkflowJobs.ReviewWorkflowJobStore(db);
  return {
    projectDir,
    planStore: new reviewWorkflowPlan.ReviewWorkflowPlanStore(db),
    gateStore,
    gateService: new reviewWorkflowGate.ReviewWorkflowGateService(
      gateStore,
      commandStore,
      contractService,
      gitService,
      repository,
      roleInvocation,
    ),
    jobStore,
    jobService: new reviewWorkflowJobs.ReviewWorkflowJobService(jobStore, commandStore),
  };
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function requireBatchByOrdinal(
  runtime: WorkflowToolRuntime,
  workflowId: string,
  ordinal: number,
): reviewWorkflow.ReviewWorkflowBatch {
  const batch = runtime.planStore
    .listBatches(workflowId)
    .find((candidate) => candidate.ordinal === ordinal);
  if (batch === undefined) throw new Error(`Workflow ${workflowId} has no batch ${ordinal}`);
  return batch;
}

/**
 * Rebuilds the authoritative configuration snapshot exactly the way the CLI does: fresh
 * config from disk, immutable persisted assignments, schema-parsed as one snapshot.
 */
function resolveConfigurationSnapshot(runtime: WorkflowToolRuntime, workflowId: string) {
  const workflow = runtime.gateStore.workflowStore.getWorkflow(workflowId);
  if (workflow === null) throw new Error(`Workflow ${workflowId} does not exist`);
  const implementer = runtime.gateStore.getAssignment(workflow.implementerAssignmentId);
  const reviewer = runtime.gateStore.getAssignment(workflow.reviewerAssignmentId);
  if (implementer === null || reviewer === null) {
    throw new Error(`Workflow ${workflowId} is missing its immutable role assignments`);
  }
  const config = loadConfig({ projectDir: runtime.projectDir });
  const fresh = reviewWorkflowIdentity.createReviewWorkflowConfigurationSnapshot(config, {
    workflowId,
    implementerAssignmentId: implementer.assignmentId,
    reviewerAssignmentId: reviewer.assignmentId,
    assignedAt: implementer.assignedAt,
  });
  return reviewWorkflowIdentity.reviewWorkflowConfigurationSnapshotSchema.parse({
    ...fresh,
    assignments: { implementer, reviewer },
  });
}

export async function handleWorkflowStatus(runtime: WorkflowToolRuntime, args: unknown) {
  const input = workflowStatusInputSchema.parse(args);
  const workflow = runtime.gateStore.workflowStore.getWorkflow(input.workflowId);
  if (workflow === null) throw new Error(`Workflow ${input.workflowId} does not exist`);
  const batches = runtime.planStore.listBatches(input.workflowId).map((batch) => {
    const effective = runtime.gateService.effectiveState(batch.batchId);
    return {
      batchId: batch.batchId,
      ordinal: batch.ordinal,
      state: batch.persistedState,
      effectiveState: effective.effectiveState,
      approvalValid: effective.approvalValid,
      ...(effective.persistedApprovalSha === undefined
        ? {}
        : { approvedCommitSha: effective.persistedApprovalSha }),
      planVersionId: batch.currentPlanVersionId,
      aggregateVersion: batch.aggregateVersion,
      codeReviewRounds: runtime.gateStore
        .getEvents(batch.batchId)
        .filter((event) => event.eventType === 'CODE_REVIEW_STARTED').length,
    };
  });
  return textResult({ workflow, batches });
}

export async function handleWorkflowEvents(runtime: WorkflowToolRuntime, args: unknown) {
  const input = workflowEventsInputSchema.parse(args);
  const cursor = input.cursorId === undefined ? null : runtime.jobStore.getCursor(input.cursorId);
  if (cursor !== null && cursor.workflowId !== input.workflowId) {
    throw new Error(`Cursor ${input.cursorId} belongs to workflow ${cursor.workflowId}`);
  }
  const afterEventId = cursor === null ? input.after : cursor.lastEventId;
  const events = runtime.jobStore.listWorkflowEvents(input.workflowId, afterEventId, input.limit);
  const lastEventId = events.at(-1)?.eventId ?? afterEventId;
  const acknowledged = input.acknowledge && input.cursorId !== undefined && events.length > 0;
  if (acknowledged && input.cursorId !== undefined) {
    runtime.jobStore.advanceCursor({
      cursorId: input.cursorId,
      workflowId: input.workflowId,
      lastEventId,
    });
  }
  return textResult({
    workflowId: input.workflowId,
    afterEventId,
    lastEventId,
    ...(input.cursorId === undefined ? {} : { cursorId: input.cursorId, acknowledged }),
    events,
  });
}

export async function handleWorkflowGate(runtime: WorkflowToolRuntime, args: unknown) {
  const input = workflowGateInputSchema.parse(args);
  const batch = requireBatchByOrdinal(runtime, input.workflowId, input.ordinal);
  switch (input.action) {
    case 'evaluate': {
      const result = runtime.gateService.evaluateGate({
        workflowId: input.workflowId,
        batchId: batch.batchId,
        configuration: resolveConfigurationSnapshot(runtime, input.workflowId),
        commandId: input.commandId,
        ...(input.expectedVersion === undefined
          ? {}
          : { expectedBatchVersion: input.expectedVersion }),
        createdAt: new Date().toISOString(),
      });
      return textResult(
        result.approved
          ? {
              status: 'APPROVED_FOR_MERGE',
              batchId: batch.batchId,
              approvedCommitSha: result.conditions.reviewedCommitSha,
              conditions: result.conditions,
            }
          : {
              status: 'NOT_APPROVED',
              batchId: batch.batchId,
              failedConditions: result.failedConditions,
              conditions: result.conditions,
            },
      );
    }
    case 'reconcile_stale': {
      const reconciled = runtime.gateService.reconcileStaleApproval({
        workflowId: input.workflowId,
        batchId: batch.batchId,
        commandId: input.commandId,
        ...(input.expectedVersion === undefined
          ? {}
          : { expectedBatchVersion: input.expectedVersion }),
        createdAt: new Date().toISOString(),
      });
      return textResult({ status: reconciled.persistedState, batchId: batch.batchId });
    }
    case 'mark_merged': {
      // The recorder identity is persisted by the coordinator itself when the command is
      // reserved — pre-persisting a variant here would conflict with that immutable record.
      const merged = runtime.gateService.markMerged({
        workflowId: input.workflowId,
        batchId: batch.batchId,
        mergeCommitSha: input.mergeCommitSha,
        recorder: {
          actorExecutionId: `${input.commandId}:recorder`,
          actorType: input.recorderActorType,
        },
        commandId: input.commandId,
        ...(input.expectedVersion === undefined
          ? {}
          : { expectedBatchVersion: input.expectedVersion }),
        createdAt: new Date().toISOString(),
      });
      return textResult({
        status: merged.persistedState,
        batchId: batch.batchId,
        mergeCommitSha: input.mergeCommitSha,
        note: 'External merge recorded; CodeMoot never executes merges.',
      });
    }
  }
}

export async function handleWorkflowJobs(runtime: WorkflowToolRuntime, args: unknown) {
  const input = workflowJobsInputSchema.parse(args);
  switch (input.action) {
    case 'enqueue': {
      const batch = requireBatchByOrdinal(runtime, input.workflowId, input.ordinal);
      const enqueue = deriveJobEnqueue(runtime, batch, input);
      const job = runtime.jobService.enqueue(enqueue);
      return textResult({ status: 'QUEUED', jobId: job.jobId, commandId: job.commandId });
    }
    case 'list':
      return textResult({
        workflowId: input.workflowId,
        jobs: runtime.jobStore.list(input.workflowId, input.status),
      });
    case 'show':
      return textResult(runtime.jobStore.require(input.jobId));
    case 'cancel': {
      const job = runtime.jobService.cancel(input.jobId);
      return textResult({ jobId: job.jobId, status: job.status });
    }
  }
}

/**
 * Derives the same stable command IDs and worker-compatible payloads the CLI uses, so a job
 * enqueued over MCP is indistinguishable from one enqueued by `--background` and is
 * processed by the same `workflow jobs run` worker.
 */
function deriveJobEnqueue(
  runtime: WorkflowToolRuntime,
  batch: reviewWorkflow.ReviewWorkflowBatch,
  input: Extract<WorkflowJobsInput, { action: 'enqueue' }>,
): reviewWorkflowJobs.EnqueueJobInput {
  const base = {
    workflowId: input.workflowId,
    batchId: batch.batchId,
    ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
  };
  if (input.jobType === 'verification') {
    const commandId = `${batch.batchId}:verify:${input.command}`;
    return {
      ...base,
      jobId: `${commandId}:job`,
      jobType: 'VERIFICATION',
      commandId,
      payload: {
        ordinal: input.ordinal,
        command: input.command,
        timeout: input.timeout,
        ...(input.toolVersion === undefined ? {} : { toolVersion: input.toolVersion }),
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      },
    };
  }
  if (input.jobType === 'final_audit') {
    const commandId = `${batch.batchId}:final-audit`;
    return {
      ...base,
      jobId: `${commandId}:job`,
      jobType: 'FINAL_AUDIT',
      commandId,
      payload: {
        ordinal: input.ordinal,
        timeout: input.timeout,
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      },
    };
  }
  const round =
    runtime.gateStore
      .getEvents(batch.batchId)
      .filter((event) => event.eventType === 'CODE_REVIEW_STARTED').length + 1;
  const commandId = `${batch.batchId}:code-review-${round}`;
  return {
    ...base,
    jobId: `${commandId}:job`,
    jobType: 'CODE_REVIEW',
    commandId,
    payload: { ordinal: input.ordinal, round, timeout: input.timeout },
  };
}

/**
 * Formats coordinator failures as a stable structured error for programmatic clients:
 * `{ error: { code, name, message } }`. Typed domain errors (gate, jobs, persistence)
 * expose their `.code`; zod input rejections map to INVALID_INPUT with the issue list.
 */
export function formatWorkflowToolError(error: unknown) {
  const shaped =
    error instanceof ZodError
      ? {
          code: 'INVALID_INPUT',
          name: 'ZodError',
          message: 'Tool input failed schema validation',
          issues: error.issues,
        }
      : error instanceof Error
        ? {
            code: readErrorCode(error) ?? 'UNKNOWN',
            name: error.name,
            message: error.message,
          }
        : { code: 'UNKNOWN', name: 'Error', message: String(error) };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: shaped }, null, 2) }],
    isError: true,
  };
}

function readErrorCode(error: Error): string | undefined {
  const carrier = z.object({ code: z.string().min(1) }).safeParse(error);
  return carrier.success ? carrier.data.code : undefined;
}

/** Runs one workflow tool call, converting every failure to the structured error shape. */
export async function runWorkflowTool(
  execute: () => Promise<{ content: { type: 'text'; text: string }[] }>,
) {
  try {
    return await execute();
  } catch (error) {
    return formatWorkflowToolError(error);
  }
}

// --- Advertised JSON Schemas ---
// Faithful mirrors of the zod validation: per-action branches with exact required lists,
// bounds, conditional requirements, and additionalProperties: false throughout, so no input
// accepted by the advertised contract is rejected by the runtime schema (and vice versa).

const WORKFLOW_ID_JSON = { type: 'string', minLength: 1, description: 'Review workflow ID' };
const ORDINAL_JSON = {
  type: 'integer',
  minimum: 1,
  description: 'One-based batch ordinal',
};
const COMMAND_ID_JSON = {
  type: 'string',
  minLength: 1,
  description: 'Stable command ID; a same-ID retry replays the recorded outcome',
};
const EXPECTED_VERSION_JSON = {
  type: 'integer',
  minimum: 0,
  description: 'Expected batch aggregate version, enforced at reservation',
};
// The established domain Git-SHA vocabulary: 40- or 64-hex, case-insensitive.
const GIT_SHA_JSON = {
  type: 'string',
  pattern: '^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$',
  description: 'Git SHA (40- or 64-hex, case-insensitive)',
};
const TIMEOUT_JSON = {
  type: 'integer',
  minimum: 1,
  default: 1800,
  description: 'Operation timeout in seconds',
};
const MAX_ATTEMPTS_JSON = {
  type: 'integer',
  minimum: 1,
  maximum: 10,
  description: 'Maximum job attempts',
};
const JOB_ID_JSON = { type: 'string', minLength: 1, description: 'Job ID' };

const ENQUEUE_BASE_PROPERTIES = {
  action: { type: 'string', const: 'enqueue', description: 'Job operation' },
  workflowId: WORKFLOW_ID_JSON,
  ordinal: ORDINAL_JSON,
  timeout: TIMEOUT_JSON,
  maxAttempts: MAX_ATTEMPTS_JSON,
};

export const WORKFLOW_TOOL_DEFINITIONS = [
  {
    name: 'codemoot_workflow_status',
    description:
      'Read a review-gated workflow: batch states, effective merge-approval state, and review rounds. The runner block also reports the frozen execution scope (planAsIs, maxBatches) and, for a stopped run, the named stop reason — BATCH_SCOPE_REACHED means the workflow stopped at its operator-set --max-batches boundary as requested, and only an explicit resume --max-batches above the completed count continues it.',
    inputSchema: {
      type: 'object' as const,
      properties: { workflowId: WORKFLOW_ID_JSON },
      required: ['workflowId'],
      additionalProperties: false,
    },
  },
  {
    name: 'codemoot_workflow_events',
    description:
      'Read workflow events incrementally by event-ID cursor; optionally acknowledge a durable named cursor.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflowId: WORKFLOW_ID_JSON,
        after: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description: 'Read events after this event ID',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          default: 100,
          description: 'Maximum events to return',
        },
        cursorId: { type: 'string', minLength: 1, description: 'Durable named cursor' },
        acknowledge: {
          type: 'boolean',
          default: false,
          description: 'Advance the named cursor past the returned events (requires cursorId)',
        },
      },
      required: ['workflowId'],
      additionalProperties: false,
      if: { properties: { acknowledge: { const: true } }, required: ['acknowledge'] },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then conditional keyword, not a thenable.
      then: { required: ['cursorId'] },
    },
  },
  {
    name: 'codemoot_workflow_gate',
    description:
      'Evaluate the merge gate, reconcile a stale approval, or record an external merge. Requires an explicit command ID; same-ID retries replay the durable receipt, and expectedVersion pins the batch aggregate version.',
    inputSchema: {
      type: 'object' as const,
      oneOf: [
        {
          properties: {
            action: { type: 'string', const: 'evaluate', description: 'Gate operation' },
            workflowId: WORKFLOW_ID_JSON,
            ordinal: ORDINAL_JSON,
            commandId: COMMAND_ID_JSON,
            expectedVersion: EXPECTED_VERSION_JSON,
          },
          required: ['action', 'workflowId', 'ordinal', 'commandId'],
          additionalProperties: false,
        },
        {
          properties: {
            action: { type: 'string', const: 'reconcile_stale', description: 'Gate operation' },
            workflowId: WORKFLOW_ID_JSON,
            ordinal: ORDINAL_JSON,
            commandId: COMMAND_ID_JSON,
            expectedVersion: EXPECTED_VERSION_JSON,
          },
          required: ['action', 'workflowId', 'ordinal', 'commandId'],
          additionalProperties: false,
        },
        {
          properties: {
            action: { type: 'string', const: 'mark_merged', description: 'Gate operation' },
            workflowId: WORKFLOW_ID_JSON,
            ordinal: ORDINAL_JSON,
            commandId: COMMAND_ID_JSON,
            expectedVersion: EXPECTED_VERSION_JSON,
            mergeCommitSha: GIT_SHA_JSON,
            recorderActorType: {
              type: 'string',
              enum: ['HUMAN', 'CI'],
              default: 'CI',
              description: 'Merge recorder actor type',
            },
          },
          required: ['action', 'workflowId', 'ordinal', 'commandId', 'mergeCommitSha'],
          additionalProperties: false,
        },
      ],
    },
  },
  {
    name: 'codemoot_workflow_jobs',
    description:
      'Enqueue, list, show, or cancel background workflow jobs. Enqueued jobs carry derived stable command IDs and are processed by the CLI worker with receipt-bound replay safety. Code-review jobs accept no expectedVersion: the code-review coordinator derives its reservation version itself.',
    inputSchema: {
      type: 'object' as const,
      oneOf: [
        {
          properties: {
            ...ENQUEUE_BASE_PROPERTIES,
            jobType: { type: 'string', const: 'verification', description: 'Job type' },
            command: {
              type: 'integer',
              minimum: 1,
              description: 'Plan verification-command index',
            },
            toolVersion: {
              type: 'string',
              minLength: 1,
              description: 'Observed tool version recorded as evidence',
            },
            expectedVersion: EXPECTED_VERSION_JSON,
          },
          required: ['action', 'workflowId', 'ordinal', 'jobType', 'command'],
          additionalProperties: false,
        },
        {
          properties: {
            ...ENQUEUE_BASE_PROPERTIES,
            jobType: { type: 'string', const: 'final_audit', description: 'Job type' },
            expectedVersion: EXPECTED_VERSION_JSON,
          },
          required: ['action', 'workflowId', 'ordinal', 'jobType'],
          additionalProperties: false,
        },
        {
          properties: {
            ...ENQUEUE_BASE_PROPERTIES,
            jobType: { type: 'string', const: 'code_review', description: 'Job type' },
          },
          required: ['action', 'workflowId', 'ordinal', 'jobType'],
          additionalProperties: false,
        },
        {
          properties: {
            action: { type: 'string', const: 'list', description: 'Job operation' },
            workflowId: WORKFLOW_ID_JSON,
            status: {
              type: 'string',
              enum: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
              description: 'Status filter',
            },
          },
          required: ['action', 'workflowId'],
          additionalProperties: false,
        },
        {
          properties: {
            action: { type: 'string', const: 'show', description: 'Job operation' },
            jobId: JOB_ID_JSON,
          },
          required: ['action', 'jobId'],
          additionalProperties: false,
        },
        {
          properties: {
            action: { type: 'string', const: 'cancel', description: 'Job operation' },
            jobId: JOB_ID_JSON,
          },
          required: ['action', 'jobId'],
          additionalProperties: false,
        },
      ],
    },
  },
];
