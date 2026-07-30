// Additive workflow MCP tools: schema validation of identity/idempotency inputs, replay
// safety through the shared coordinator, and stability of the original five tool schemas.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  openDatabase,
  reviewWorkflow,
  reviewWorkflowIdentity,
  reviewWorkflowPersistence,
} from '@codemoot/core';
import {
  workflowEventsInputSchema,
  workflowGateInputSchema,
  workflowJobsInputSchema,
  workflowStatusInputSchema,
} from '@codemoot/core';
import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { TOOL_DEFINITIONS } from '../src/server.js';
import { formatWorkflowToolError } from '../src/tools/workflow.js';
import {
  WORKFLOW_TOOL_DEFINITIONS,
  type WorkflowToolRuntime,
  createWorkflowToolRuntime,
  handleWorkflowEvents,
  handleWorkflowGate,
  handleWorkflowJobs,
  handleWorkflowStatus,
} from '../src/tools/workflow.js';

const NOW = '2026-07-31T12:00:00.000Z';
const WORKFLOW_ID = 'workflow-14';
const BATCH_ID = 'workflow-14:batch:14';

const CONFIG_FILE_CONTENT = JSON.stringify({
  configVersion: 3,
  workflow: 'review-gated-batches',
  models: {
    implementer: {
      provider: 'anthropic',
      model: 'claude-supported',
      cliAdapter: { kind: 'claude', command: 'claude', args: [], timeout: 600 },
    },
    reviewer: {
      provider: 'openai',
      model: 'codex-supported',
      cliAdapter: { kind: 'codex', command: 'codex', args: ['exec'], timeout: 600 },
    },
  },
  roles: {
    implementer: { model: 'implementer' },
    reviewer: { model: 'reviewer' },
  },
  reviewGated: {
    identity: {
      minimumAssurance: 'process_attested',
      requireDifferentAdapterKinds: true,
      prohibitSharedSessions: true,
    },
    commit: { mode: 'either', agentMayCommit: true },
    gates: {
      planReview: 'required',
      codeReview: 'required',
      verification: 'required',
      humanMerge: 'required',
      blockingSeverities: ['critical', 'high'],
      requireAllFindingResponses: true,
      requireAcceptedAttestations: true,
    },
  },
  debate: { enabled: false },
});

function parseText(result: { content: readonly { type: 'text'; text: string }[] }): unknown {
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error('Tool returned no text content');
  return JSON.parse(text);
}

describe('workflow MCP tool surface', () => {
  it('keeps the original five tool schemas unchanged and adds exactly four workflow tools', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'codemoot_review',
      'codemoot_plan',
      'codemoot_debate',
      'codemoot_memory',
      'codemoot_cost',
    ]);
    expect(TOOL_DEFINITIONS.map((tool) => tool.inputSchema.required ?? [])).toEqual([
      ['content'],
      ['task'],
      ['question'],
      ['action'],
      [],
    ]);
    expect(WORKFLOW_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'codemoot_workflow_status',
      'codemoot_workflow_events',
      'codemoot_workflow_gate',
      'codemoot_workflow_jobs',
    ]);
  });

  it('advertises JSON Schemas that agree with the runtime zod validation on every branch', () => {
    const ajv = new Ajv({ strict: false, useDefaults: false });
    const zodByTool = {
      codemoot_workflow_status: workflowStatusInputSchema,
      codemoot_workflow_events: workflowEventsInputSchema,
      codemoot_workflow_gate: workflowGateInputSchema,
      codemoot_workflow_jobs: workflowJobsInputSchema,
    };
    const cases: readonly { readonly tool: keyof typeof zodByTool; readonly input: unknown }[] = [
      // status
      { tool: 'codemoot_workflow_status', input: { workflowId: 'wf' } },
      { tool: 'codemoot_workflow_status', input: {} },
      { tool: 'codemoot_workflow_status', input: { workflowId: 'wf', extra: true } },
      // events: bounds and acknowledge-without-cursor
      { tool: 'codemoot_workflow_events', input: { workflowId: 'wf' } },
      { tool: 'codemoot_workflow_events', input: { workflowId: 'wf', after: 5, limit: 500 } },
      { tool: 'codemoot_workflow_events', input: { workflowId: 'wf', limit: 501 } },
      { tool: 'codemoot_workflow_events', input: { workflowId: 'wf', after: -1 } },
      { tool: 'codemoot_workflow_events', input: { workflowId: 'wf', acknowledge: true } },
      {
        tool: 'codemoot_workflow_events',
        input: { workflowId: 'wf', acknowledge: true, cursorId: 'c1' },
      },
      { tool: 'codemoot_workflow_events', input: { workflowId: 'wf', unknown: 1 } },
      // gate: identity requirements and SHA vocabulary
      {
        tool: 'codemoot_workflow_gate',
        input: { action: 'evaluate', workflowId: 'wf', ordinal: 1, commandId: 'c' },
      },
      {
        tool: 'codemoot_workflow_gate',
        input: { action: 'evaluate', workflowId: 'wf', ordinal: 1 },
      },
      {
        tool: 'codemoot_workflow_gate',
        input: {
          action: 'evaluate',
          workflowId: 'wf',
          ordinal: 1,
          commandId: 'c',
          expectedVersion: 3,
        },
      },
      {
        tool: 'codemoot_workflow_gate',
        input: { action: 'mark_merged', workflowId: 'wf', ordinal: 1, commandId: 'c' },
      },
      {
        tool: 'codemoot_workflow_gate',
        input: {
          action: 'mark_merged',
          workflowId: 'wf',
          ordinal: 1,
          commandId: 'c',
          mergeCommitSha: 'a'.repeat(40),
        },
      },
      {
        tool: 'codemoot_workflow_gate',
        input: {
          action: 'mark_merged',
          workflowId: 'wf',
          ordinal: 1,
          commandId: 'c',
          mergeCommitSha: 'A'.repeat(64),
        },
      },
      {
        tool: 'codemoot_workflow_gate',
        input: {
          action: 'mark_merged',
          workflowId: 'wf',
          ordinal: 1,
          commandId: 'c',
          mergeCommitSha: 'a'.repeat(39),
        },
      },
      {
        tool: 'codemoot_workflow_gate',
        input: {
          action: 'reconcile_stale',
          workflowId: 'wf',
          ordinal: 1,
          commandId: 'c',
          unknown: true,
        },
      },
      // jobs: job-type discrimination and conditional requirements
      {
        tool: 'codemoot_workflow_jobs',
        input: {
          action: 'enqueue',
          workflowId: 'wf',
          ordinal: 1,
          jobType: 'verification',
          command: 1,
        },
      },
      {
        tool: 'codemoot_workflow_jobs',
        input: { action: 'enqueue', workflowId: 'wf', ordinal: 1, jobType: 'verification' },
      },
      {
        tool: 'codemoot_workflow_jobs',
        input: { action: 'enqueue', workflowId: 'wf', ordinal: 1, jobType: 'final_audit' },
      },
      {
        tool: 'codemoot_workflow_jobs',
        input: {
          action: 'enqueue',
          workflowId: 'wf',
          ordinal: 1,
          jobType: 'final_audit',
          expectedVersion: 2,
        },
      },
      {
        tool: 'codemoot_workflow_jobs',
        input: { action: 'enqueue', workflowId: 'wf', ordinal: 1, jobType: 'code_review' },
      },
      // code_review accepts NO expectedVersion: the coordinator derives its own reservation
      // version, so a caller pin would be silently ignored — both representations reject it.
      {
        tool: 'codemoot_workflow_jobs',
        input: {
          action: 'enqueue',
          workflowId: 'wf',
          ordinal: 1,
          jobType: 'code_review',
          expectedVersion: 99,
        },
      },
      { tool: 'codemoot_workflow_jobs', input: { action: 'enqueue', jobType: 'code_review' } },
      { tool: 'codemoot_workflow_jobs', input: { action: 'list', workflowId: 'wf' } },
      { tool: 'codemoot_workflow_jobs', input: { action: 'list' } },
      { tool: 'codemoot_workflow_jobs', input: { action: 'show', jobId: 'j1' } },
      { tool: 'codemoot_workflow_jobs', input: { action: 'show' } },
      { tool: 'codemoot_workflow_jobs', input: { action: 'cancel', jobId: 'j1' } },
      { tool: 'codemoot_workflow_jobs', input: { action: 'cancel' } },
      { tool: 'codemoot_workflow_jobs', input: { action: 'cancel', jobId: 'j1', extra: 1 } },
    ];
    for (const testCase of cases) {
      const definition = WORKFLOW_TOOL_DEFINITIONS.find((tool) => tool.name === testCase.tool);
      if (definition === undefined) throw new Error(`Missing definition ${testCase.tool}`);
      const advertised = ajv.compile(definition.inputSchema);
      const zodAccepts = zodByTool[testCase.tool].safeParse(testCase.input).success;
      const advertisedAccepts = advertised(testCase.input);
      expect(
        advertisedAccepts,
        `${testCase.tool} ${JSON.stringify(testCase.input)}: advertised=${String(advertisedAccepts)} zod=${String(zodAccepts)}`,
      ).toBe(zodAccepts);
    }
  });

  it('returns stable structured errors for workflow tools', () => {
    const zodFailure = workflowGateInputSchema.safeParse({ action: 'evaluate' });
    if (zodFailure.success) throw new Error('Fixture must fail');
    const invalid = formatWorkflowToolError(zodFailure.error);
    expect(invalid.isError).toBe(true);
    const invalidBody = JSON.parse(invalid.content[0]?.text ?? '{}') as {
      error: { code: string; issues?: unknown[] };
    };
    expect(invalidBody.error.code).toBe('INVALID_INPUT');
    expect(Array.isArray(invalidBody.error.issues)).toBe(true);

    class CodedError extends Error {
      readonly code = 'COMMAND_REPLAY_MISMATCH';
    }
    const coded = formatWorkflowToolError(new CodedError('Command exists for another operation'));
    const codedBody = JSON.parse(coded.content[0]?.text ?? '{}') as {
      error: { code: string; message: string };
    };
    expect(codedBody.error.code).toBe('COMMAND_REPLAY_MISMATCH');
    expect(codedBody.error.message).toContain('another operation');

    const plain = formatWorkflowToolError(new Error('Workflow wf does not exist'));
    const plainBody = JSON.parse(plain.content[0]?.text ?? '{}') as { error: { code: string } };
    expect(plainBody.error.code).toBe('UNKNOWN');
  });
});

describe('workflow MCP tool handlers', () => {
  let db: ReturnType<typeof openDatabase>;
  let repositoryRoot: string;
  let runtime: WorkflowToolRuntime;
  let commandStore: reviewWorkflowPersistence.ReviewWorkflowCommandStore;
  let headSha: string;
  let snapshot: reviewWorkflowIdentity.ReviewWorkflowConfigurationSnapshot;

  function git(arguments_: readonly string[]): string {
    return execFileSync('git', arguments_, {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
  }

  function requester(commandId: string): reviewWorkflow.ActorExecutionIdentity {
    return {
      actorExecutionId: `${commandId}:requester`,
      actorType: 'SYSTEM',
      authoritiesExercised: ['SYSTEM_RECONCILER'],
      identityAssurance: 'PROCESS_ATTESTED',
      observedEvidence: [],
      startedAt: NOW,
    };
  }

  function commandRequest(
    commandId: string,
    command: reviewWorkflow.TransitionCommand,
    expectedVersion = 0,
  ): reviewWorkflow.StateChangingCommandRequest {
    const request = {
      commandId,
      workflowId: WORKFLOW_ID,
      batchId: BATCH_ID,
      expectedAggregateVersion: expectedVersion,
      requester: requester(commandId),
      authorityExercised: 'SYSTEM_RECONCILER' as const,
      command,
    };
    return { ...request, canonicalRequestHash: `hash:${commandId}` };
  }

  beforeEach(() => {
    repositoryRoot = mkdtempSync(join(tmpdir(), 'codemoot-mcp-workflow-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repositoryRoot });
    git(['config', 'user.name', 'CodeMoot Test']);
    git(['config', 'user.email', 'codemoot@example.com']);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'base'], { cwd: repositoryRoot });
    headSha = git(['rev-parse', 'HEAD']);
    writeFileSync(join(repositoryRoot, '.cowork.yml'), CONFIG_FILE_CONTENT);
    db = openDatabase(':memory:');
    runtime = createWorkflowToolRuntime(db, repositoryRoot);
    commandStore = new reviewWorkflowPersistence.ReviewWorkflowCommandStore(db);
    snapshot = reviewWorkflowIdentity.createReviewWorkflowConfigurationSnapshot(
      loadConfig({ projectDir: repositoryRoot }),
      {
        workflowId: WORKFLOW_ID,
        implementerAssignmentId: 'assignment-implementer',
        reviewerAssignmentId: 'assignment-reviewer',
        assignedAt: NOW,
      },
    );
    runtime.gateStore.workflowStore.createWorkflow({
      workflowId: WORKFLOW_ID,
      status: 'ACTIVE',
      generalPlanVersionId: `${WORKFLOW_ID}:general-plan`,
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      configurationHash: snapshot.configurationHash,
      createdAt: NOW,
      updatedAt: NOW,
    });
    runtime.gateStore.workflowStore.saveEntity({
      kind: 'AGENT_ASSIGNMENT',
      value: snapshot.assignments.implementer,
    });
    runtime.gateStore.workflowStore.saveEntity({
      kind: 'AGENT_ASSIGNMENT',
      value: snapshot.assignments.reviewer,
    });
    runtime.gateStore.workflowStore.createBatch({
      batchId: BATCH_ID,
      workflowId: WORKFLOW_ID,
      ordinal: 14,
      persistedState: 'VERIFYING',
      aggregateVersion: 0,
      currentPlanVersionId: `${BATCH_ID}:plan:1`,
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  });

  it('rejects missing identity and idempotency inputs at the schema boundary', async () => {
    await expect(
      handleWorkflowGate(runtime, { action: 'evaluate', workflowId: WORKFLOW_ID, ordinal: 14 }),
    ).rejects.toThrowError(ZodError);
    await expect(
      handleWorkflowGate(runtime, {
        action: 'mark_merged',
        workflowId: WORKFLOW_ID,
        ordinal: 14,
        commandId: 'command-1',
      }),
    ).rejects.toThrowError(ZodError);
    await expect(
      handleWorkflowEvents(runtime, { workflowId: WORKFLOW_ID, acknowledge: true }),
    ).rejects.toThrowError(ZodError);
    // Verification-without-command is now rejected by the schema itself, matching the
    // advertised contract.
    await expect(
      handleWorkflowJobs(runtime, {
        action: 'enqueue',
        workflowId: WORKFLOW_ID,
        ordinal: 14,
        jobType: 'verification',
      }),
    ).rejects.toThrowError(ZodError);
    await expect(handleWorkflowStatus(runtime, {})).rejects.toThrowError(ZodError);
  });

  it('reports batch states with derived effective approval state', async () => {
    const result = parseText(await handleWorkflowStatus(runtime, { workflowId: WORKFLOW_ID }));
    expect(result).toMatchObject({
      workflow: { workflowId: WORKFLOW_ID },
      batches: [
        {
          batchId: BATCH_ID,
          ordinal: 14,
          state: 'VERIFYING',
          effectiveState: 'VERIFYING',
          approvalValid: false,
          codeReviewRounds: 0,
        },
      ],
    });
  });

  it('reads events incrementally and acknowledges a durable cursor', async () => {
    const command: reviewWorkflow.TransitionCommand = {
      type: 'BLOCK_BATCH',
      reason: 'Fixture event',
    };
    commandStore.reserve(commandRequest('command-event-1', command));
    const transition = reviewWorkflow.transitionBatch({
      currentState: 'VERIFYING',
      command,
      actor: requester('command-event-1'),
    });
    if (!transition.allowed) throw new Error('Fixture transition rejected');
    commandStore.succeedWithTransition({
      commandId: 'command-event-1',
      transition,
      eventType: 'BATCH_BLOCKED',
      eventPayload: { reason: 'Fixture event' },
      resultHash: 'hash:event-1',
    });

    const first = parseText(
      await handleWorkflowEvents(runtime, {
        workflowId: WORKFLOW_ID,
        cursorId: 'consumer-1',
        acknowledge: true,
      }),
    );
    expect(first).toMatchObject({ cursorId: 'consumer-1', acknowledged: true });
    const firstEvents = (first as { events: readonly { eventType: string }[] }).events;
    expect(firstEvents.map((event) => event.eventType)).toEqual(['BATCH_BLOCKED']);

    const second = parseText(
      await handleWorkflowEvents(runtime, {
        workflowId: WORKFLOW_ID,
        cursorId: 'consumer-1',
        acknowledge: true,
      }),
    );
    expect((second as { events: readonly unknown[] }).events).toHaveLength(0);
    expect((second as { acknowledged: boolean }).acknowledged).toBe(false);
  });

  it('replays a recorded gate approval for the same command ID without new events', async () => {
    const conditions = {
      reviewedCommitSha: headSha,
      currentHeadSha: headSha,
      headMatchesReviewedCommit: true,
      cleanWorktree: true,
      unresolvedCriticalOrHighFindingCount: 0,
      incompleteDispositionCount: 0,
      requiredCriteriaPassed: true,
      requiredVerificationComplete: true,
      requiredAttestationsAccepted: true,
      manualAndBrowserEvidenceIndependentlyAttested: true,
      finalDiffReviewed: true,
      scopeMatchesApprovedPlan: true,
      documentationComplete: true,
    };
    const { headMatchesReviewedCommit, ...evidenceConditions } = conditions;
    void headMatchesReviewedCommit;
    const evidence = {
      ...evidenceConditions,
      roleSeparation: {
        implementerAssignment: snapshot.assignments.implementer,
        reviewerAssignment: snapshot.assignments.reviewer,
        minimumIdentityAssurance: 'PROCESS_ATTESTED',
      },
    };
    const command: reviewWorkflow.TransitionCommand = reviewWorkflow.transitionCommandSchema.parse({
      type: 'APPROVE_FOR_MERGE',
      evidence,
    });
    commandStore.reserve(commandRequest('gate-command-1', command));
    const transition = reviewWorkflow.transitionBatch({
      currentState: 'VERIFYING',
      command,
      actor: requester('gate-command-1'),
    });
    if (!transition.allowed) throw new Error('Fixture transition rejected');
    commandStore.succeedWithTransition({
      commandId: 'gate-command-1',
      transition,
      eventType: 'BATCH_GATE_APPROVED',
      eventPayload: { approvedCommitSha: headSha },
      resultHash: 'hash:gate-1',
      result: { conditions, evidence },
    });

    // A same-ID retry over MCP replays the recorded approval instead of re-evaluating.
    const replay = parseText(
      await handleWorkflowGate(runtime, {
        action: 'evaluate',
        workflowId: WORKFLOW_ID,
        ordinal: 14,
        commandId: 'gate-command-1',
      }),
    );
    expect(replay).toMatchObject({
      status: 'APPROVED_FOR_MERGE',
      batchId: BATCH_ID,
      approvedCommitSha: headSha,
    });
    expect(
      runtime.gateStore
        .getEvents(BATCH_ID)
        .filter((event) => event.eventType === 'BATCH_GATE_APPROVED'),
    ).toHaveLength(1);

    // The recorded approval is visible in effective state, and mark_merged with a real
    // descendant merge commit records MERGED through the same coordinator.
    execFileSync('git', ['commit', '--allow-empty', '-m', 'external merge'], {
      cwd: repositoryRoot,
    });
    const mergeSha = git(['rev-parse', 'HEAD']);
    git(['reset', '--hard', headSha]);
    const merged = parseText(
      await handleWorkflowGate(runtime, {
        action: 'mark_merged',
        workflowId: WORKFLOW_ID,
        ordinal: 14,
        commandId: 'mark-merged-1',
        mergeCommitSha: mergeSha,
      }),
    );
    expect(merged).toMatchObject({ status: 'MERGED', mergeCommitSha: mergeSha });
  });

  it('rejects gate actions in invalid states through the coordinator guards', async () => {
    await expect(
      handleWorkflowGate(runtime, {
        action: 'reconcile_stale',
        workflowId: WORKFLOW_ID,
        ordinal: 14,
        commandId: 'reconcile-1',
      }),
    ).rejects.toThrowError(/must be APPROVED_FOR_MERGE/);
    await expect(
      handleWorkflowGate(runtime, {
        action: 'mark_merged',
        workflowId: WORKFLOW_ID,
        ordinal: 14,
        commandId: 'mark-merged-invalid',
        mergeCommitSha: 'a'.repeat(40),
      }),
    ).rejects.toThrowError(/must be APPROVED_FOR_MERGE/);
  });

  it('enqueues worker-compatible jobs with derived stable command IDs', async () => {
    const enqueued = parseText(
      await handleWorkflowJobs(runtime, {
        action: 'enqueue',
        workflowId: WORKFLOW_ID,
        ordinal: 14,
        jobType: 'verification',
        command: 1,
        timeout: 600,
      }),
    );
    expect(enqueued).toEqual({
      status: 'QUEUED',
      jobId: `${BATCH_ID}:verify:1:job`,
      commandId: `${BATCH_ID}:verify:1`,
    });
    const job = runtime.jobStore.require(`${BATCH_ID}:verify:1:job`);
    expect(job.jobType).toBe('VERIFICATION');
    expect(job.payload).toEqual({ ordinal: 14, command: 1, timeout: 600 });
    expect(job.expectedReceipt).toEqual({
      commandType: 'START_CODE_REVIEW',
      sideEffectKind: 'VERIFICATION_EXECUTION',
      sideEffectIdentity: `${BATCH_ID}:verify:1:record`,
    });

    // A duplicate enqueue is refused by the command binding — replay safety at enqueue.
    await expect(
      handleWorkflowJobs(runtime, {
        action: 'enqueue',
        workflowId: WORKFLOW_ID,
        ordinal: 14,
        jobType: 'verification',
        command: 1,
      }),
    ).rejects.toThrowError(/already exists|already owned/);

    const audit = parseText(
      await handleWorkflowJobs(runtime, {
        action: 'enqueue',
        workflowId: WORKFLOW_ID,
        ordinal: 14,
        jobType: 'final_audit',
      }),
    );
    expect(audit).toMatchObject({ commandId: `${BATCH_ID}:final-audit` });
    const review = parseText(
      await handleWorkflowJobs(runtime, {
        action: 'enqueue',
        workflowId: WORKFLOW_ID,
        ordinal: 14,
        jobType: 'code_review',
      }),
    );
    expect(review).toMatchObject({ commandId: `${BATCH_ID}:code-review-1` });

    const listed = parseText(
      await handleWorkflowJobs(runtime, { action: 'list', workflowId: WORKFLOW_ID }),
    );
    expect((listed as { jobs: readonly unknown[] }).jobs).toHaveLength(3);
    const cancelled = parseText(
      await handleWorkflowJobs(runtime, { action: 'cancel', jobId: `${BATCH_ID}:verify:1:job` }),
    );
    expect(cancelled).toEqual({ jobId: `${BATCH_ID}:verify:1:job`, status: 'CANCELLED' });
    const shown = parseText(
      await handleWorkflowJobs(runtime, { action: 'show', jobId: `${BATCH_ID}:verify:1:job` }),
    );
    expect(shown).toMatchObject({ status: 'CANCELLED' });
  });
});
