import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../../../src/config/schema.js';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowCommandStore } from '../../../src/memory/review-workflow-command-store.js';
import { ReviewWorkflowStore } from '../../../src/memory/review-workflow-store.js';
import type { BridgeCallResult } from '../../../src/models/bridge.js';
import { ModelRegistry } from '../../../src/models/registry.js';
import { ModelError } from '../../../src/utils/errors.js';
import {
  createReviewWorkflowConfigurationSnapshot,
  hashReviewWorkflowConfiguration,
} from '../../../src/review-workflow-identity/service.js';
import type { ReviewWorkflowConfigurationSnapshot } from '../../../src/review-workflow-identity/types.js';
import type {
  ActorExecutionIdentity,
  AgentAdapterKind,
  ReviewWorkflowBatch,
  SessionIdentity,
  StateChangingCommandRequest,
  WorkflowRun,
} from '../../../src/review-workflow/types.js';
import { RoleInvocationError, RoleInvocationService } from '../../../src/roles/role-invocation.js';
import { type ResolvedRoleAdapter, RoleManager } from '../../../src/roles/role-manager.js';
import type { ProjectConfig } from '../../../src/types/config.js';

const NOW = '2026-07-29T10:00:00.000Z';
const LATER = '2026-07-29T10:01:00.000Z';
const SHA = 'a'.repeat(40);

function mixedConfig(inverse = false): ProjectConfig {
  return validateConfig({
    configVersion: 3,
    workflow: 'review-gated-batches',
    models: {
      claude: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        cliAdapter: {
          kind: 'claude',
          command: 'claude',
          args: [],
          timeout: 600,
        },
      },
      codex: {
        provider: 'openai',
        model: 'gpt-5.3-codex',
        cliAdapter: {
          kind: 'codex',
          command: 'codex',
          args: ['exec'],
          timeout: 600,
        },
      },
    },
    roles: {
      implementer: { model: inverse ? 'codex' : 'claude' },
      reviewer: { model: inverse ? 'claude' : 'codex' },
    },
    reviewGated: {
      identity: {
        minimumAssurance: 'process_attested',
        requireDifferentAdapterKinds: true,
        prohibitSharedSessions: true,
      },
      commit: { mode: 'human_required', agentMayCommit: false },
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
}

function configurationSnapshot(config: ProjectConfig): ReviewWorkflowConfigurationSnapshot {
  return createReviewWorkflowConfigurationSnapshot(config, {
    workflowId: 'workflow-6',
    batchId: 'batch-6',
    implementerAssignmentId: 'assignment-implementer',
    reviewerAssignmentId: 'assignment-reviewer',
    assignedAt: NOW,
  });
}

function bridgeResult(
  resolution: ResolvedRoleAdapter,
  vendorSessionId: string,
  processId: number,
  resumedFromSessionId?: string,
  finishedAt = LATER,
): BridgeCallResult {
  const adapterKind: AgentAdapterKind = resolution.adapter.name === 'claude' ? 'CLAUDE' : 'CODEX';
  const provider = adapterKind === 'CLAUDE' ? 'anthropic' : 'openai';
  return {
    text: `${resolution.role} result`,
    model: resolution.assignment.configuredModel,
    provider,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0 },
    finishReason: 'stop',
    durationMs: 100,
    meteringSource: adapterKind === 'CLAUDE' ? 'sdk' : 'estimated',
    sessionId: vendorSessionId,
    invocationEvidence: {
      adapterKind,
      executablePath: `/usr/local/bin/${resolution.adapter.name}`,
      executableHash: adapterKind === 'CLAUDE' ? 'b'.repeat(64) : 'c'.repeat(64),
      cliVersion: adapterKind === 'CLAUDE' ? '2.1.218' : 'codex-cli 1.0.0',
      configuredModel: resolution.assignment.configuredModel,
      reportedModel: resolution.assignment.configuredModel,
      workingDirectory: '/repository',
      processId,
      processInstanceFingerprint: adapterKind === 'CLAUDE' ? 'd'.repeat(64) : 'e'.repeat(64),
      identityAssurance: 'PROCESS_ATTESTED',
      startedAt: NOW,
      finishedAt,
      resultStatus: 'SUCCEEDED',
    },
    sessionEvidence: {
      providerOrAdapter: resolution.adapter.name,
      vendorSessionId,
      ...(resumedFromSessionId === undefined ? {} : { resumedFromSessionId }),
    },
  };
}

function requester(commandId: string): ActorExecutionIdentity {
  return {
    actorExecutionId: `owner-${commandId}`,
    actorType: 'HUMAN',
    authoritiesExercised: ['WORKFLOW_OWNER'],
    identityAssurance: 'CLI_ASSERTED',
    observedEvidence: [],
    startedAt: NOW,
  };
}

describe('review-workflow role invocation', () => {
  let db: Database.Database;
  let store: ReviewWorkflowStore;
  let commandStore: ReviewWorkflowCommandStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new ReviewWorkflowStore(db);
    commandStore = new ReviewWorkflowCommandStore(db);
  });

  afterEach(() => {
    db.close();
  });

  function setup(inverse = false) {
    const config = mixedConfig(inverse);
    const snapshot = configurationSnapshot(config);
    const workflow: WorkflowRun = {
      workflowId: snapshot.workflowId,
      status: 'ACTIVE',
      generalPlanVersionId: 'general-plan-6',
      implementerAssignmentId: snapshot.assignments.implementer.assignmentId,
      reviewerAssignmentId: snapshot.assignments.reviewer.assignmentId,
      configurationHash: hashReviewWorkflowConfiguration(config),
      createdAt: NOW,
      updatedAt: NOW,
    };
    const batch: ReviewWorkflowBatch = {
      batchId: 'batch-6',
      workflowId: workflow.workflowId,
      ordinal: 6,
      persistedState: 'DRAFT',
      aggregateVersion: 0,
      currentPlanVersionId: 'batch-plan-6',
      implementerAssignmentId: workflow.implementerAssignmentId,
      reviewerAssignmentId: workflow.reviewerAssignmentId,
      originalBatchBaseSha: SHA,
      createdAt: NOW,
      updatedAt: NOW,
    };
    store.createWorkflow(workflow);
    store.createBatch(batch);
    const registry = ModelRegistry.fromConfig(config, '/repository');
    const roles = new RoleManager(config).resolveReviewWorkflowRoles(snapshot, registry);
    return { config, snapshot, roles };
  }

  function reserve(commandId: string): void {
    const request: StateChangingCommandRequest = {
      commandId,
      workflowId: 'workflow-6',
      batchId: 'batch-6',
      expectedAggregateVersion: 0,
      canonicalRequestHash: `hash-${commandId}`,
      requester: requester(commandId),
      authorityExercised: 'WORKFLOW_OWNER',
      command: { type: 'BLOCK_BATCH', reason: 'Invocation evidence fixture.' },
    };
    commandStore.reserve(request);
  }

  function persistSession(session: SessionIdentity, commandId: string): void {
    reserve(commandId);
    store.saveEntity({
      kind: 'INVOCATION_IDENTITY',
      value: {
        invocationId: session.creatingInvocationId,
        commandId,
        actorMechanism: 'test-cli',
        workingDirectory: '/repository',
        startedAt: NOW,
        resultStatus: 'SUCCEEDED',
      },
    });
    store.saveEntity({ kind: 'SESSION_IDENTITY', value: session });
  }

  it.each([
    ['Claude implementer and Codex reviewer', false],
    ['Codex implementer and Claude reviewer', true],
  ])('resolves and persists %s', async (_label, inverse) => {
    const { roles } = setup(inverse);
    reserve('command-implementer');
    reserve('command-reviewer');
    vi.spyOn(roles.implementer.adapter, 'send').mockResolvedValue(
      bridgeResult(roles.implementer, 'implementer-vendor-session', 1001),
    );
    vi.spyOn(roles.reviewer.adapter, 'send').mockResolvedValue(
      bridgeResult(roles.reviewer, 'reviewer-vendor-session', 1002),
    );
    const service = new RoleInvocationService(store);

    const implementer = await service.invoke({
      resolution: roles.implementer,
      workflowId: 'workflow-6',
      commandId: 'command-implementer',
      actorExecutionId: 'execution-implementer',
      invocationId: 'invocation-implementer',
      sessionIdentityId: 'session-implementer',
      prompt: 'Implement the approved batch.',
    });
    const reviewer = await service.invoke({
      resolution: roles.reviewer,
      workflowId: 'workflow-6',
      commandId: 'command-reviewer',
      actorExecutionId: 'execution-reviewer',
      invocationId: 'invocation-reviewer',
      sessionIdentityId: 'session-reviewer',
      prompt: 'Review the completed batch.',
    });

    expect(implementer.invocation.adapterKind).toBe(
      roles.implementer.assignment.expectedAdapterKind,
    );
    expect(reviewer.invocation.adapterKind).toBe(roles.reviewer.assignment.expectedAdapterKind);
    expect(store.getEntity('ACTOR_EXECUTION', implementer.execution.actorExecutionId)).toEqual({
      kind: 'ACTOR_EXECUTION',
      value: implementer.execution,
    });
    expect(store.getEntity('INVOCATION_IDENTITY', reviewer.invocation.invocationId)).toEqual({
      kind: 'INVOCATION_IDENTITY',
      value: reviewer.invocation,
    });
    expect(store.getEntity('SESSION_IDENTITY', reviewer.session.sessionIdentityId)).toEqual({
      kind: 'SESSION_IDENTITY',
      value: reviewer.session,
    });
  });

  it('prepares process-attested evidence without persistence until explicitly persisted', async () => {
    const { roles } = setup();
    reserve('command-refinement');
    vi.spyOn(roles.implementer.adapter, 'send').mockResolvedValue(
      bridgeResult(roles.implementer, 'refinement-vendor-session', 1010),
    );
    const service = new RoleInvocationService(store);

    const prepared = await service.prepare({
      resolution: roles.implementer,
      workflowId: 'workflow-6',
      commandId: 'command-refinement',
      actorExecutionId: 'execution-refinement',
      invocationId: 'invocation-refinement',
      sessionIdentityId: 'session-refinement',
      prompt: 'Refine the imported plan.',
      additionalAuthorities: ['PLAN_REFINER'],
    });

    expect(prepared.execution.authoritiesExercised).toEqual(['IMPLEMENTER', 'PLAN_REFINER']);
    expect(store.getEntity('INVOCATION_IDENTITY', prepared.invocation.invocationId)).toBeNull();
    service.persistPrepared(prepared);
    expect(store.getEntity('INVOCATION_IDENTITY', prepared.invocation.invocationId)).not.toBeNull();
  });

  it('rejects authority escalation before invoking the reviewer adapter', async () => {
    const { roles } = setup();
    const send = vi.spyOn(roles.reviewer.adapter, 'send');

    await expect(
      new RoleInvocationService(store).prepare({
        resolution: roles.reviewer,
        workflowId: 'workflow-6',
        commandId: 'command-reviewer-escalation',
        actorExecutionId: 'execution-reviewer-escalation',
        invocationId: 'invocation-reviewer-escalation',
        sessionIdentityId: 'session-reviewer-escalation',
        prompt: 'Refine the plan.',
        additionalAuthorities: ['PLAN_REFINER'],
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITY_NOT_ALLOWED' });
    expect(send).not.toHaveBeenCalled();
  });

  it('allows commit authority only for an authorized implementer assignment', async () => {
    const deniedSetup = setup();
    const deniedSend = vi.spyOn(deniedSetup.roles.implementer.adapter, 'send');
    await expect(
      new RoleInvocationService(store).prepare({
        resolution: deniedSetup.roles.implementer,
        workflowId: 'workflow-6',
        commandId: 'command-denied-commit',
        actorExecutionId: 'execution-denied-commit',
        invocationId: 'invocation-denied-commit',
        sessionIdentityId: 'session-denied-commit',
        prompt: 'Commit the implementation.',
        additionalAuthorities: ['COMMIT_CREATOR'],
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITY_NOT_ALLOWED' });
    expect(deniedSend).not.toHaveBeenCalled();

    const authorizedResolution = {
      ...deniedSetup.roles.implementer,
      assignment: {
        ...deniedSetup.roles.implementer.assignment,
        commitPermission: 'AUTHORIZED' as const,
      },
    };
    vi.spyOn(authorizedResolution.adapter, 'send').mockResolvedValue(
      bridgeResult(authorizedResolution, 'authorized-commit-session', 1011),
    );
    const prepared = await new RoleInvocationService(store).prepare({
      resolution: authorizedResolution,
      workflowId: 'workflow-6',
      commandId: 'command-authorized-commit',
      actorExecutionId: 'execution-authorized-commit',
      invocationId: 'invocation-authorized-commit',
      sessionIdentityId: 'session-authorized-commit',
      prompt: 'Commit the implementation.',
      additionalAuthorities: ['COMMIT_CREATOR'],
    });

    expect(prepared.execution.authoritiesExercised).toEqual(['IMPLEMENTER', 'COMMIT_CREATOR']);
  });

  it('rejects a snapshot that reuses the same configured agent key', () => {
    const { config, snapshot } = setup();
    const registry = ModelRegistry.fromConfig(config, '/repository');
    const reusedAgentSnapshot = {
      ...snapshot,
      assignments: {
        ...snapshot.assignments,
        reviewer: {
          ...snapshot.assignments.reviewer,
          configuredAgentKey: snapshot.assignments.implementer.configuredAgentKey,
        },
      },
    };

    expect(() =>
      new RoleManager(config).resolveReviewWorkflowRoles(reusedAgentSnapshot, registry),
    ).toThrow();
  });

  it('rejects assignment snapshots after the ROLE CONFIGURATION changes', () => {
    const { config, snapshot } = setup();
    const changedConfig = {
      ...config,
      models: {
        ...config.models,
        implementer: { ...config.models.implementer, model: 'claude-sonnet-5' },
      },
    };
    const registry = ModelRegistry.fromConfig(changedConfig, '/repository');

    expect(() =>
      new RoleManager(changedConfig).resolveReviewWorkflowRoles(snapshot, registry),
    ).toThrow('active configuration');
  });

  it('does NOT reject when something unrelated to the assignment changes', () => {
    // This used to throw, because the hash covered the entire ProjectConfig. That conflated
    // "the roles moved" with "any setting changed", and it is why a workflow that hit a
    // too-small token budget could not be continued: the limit was frozen, and raising it
    // invalidated the assignments. A project description cannot make an assignment stale.
    const { config, snapshot } = setup();
    const changedConfig = {
      ...config,
      project: { ...config.project, description: 'Edited long after assignment.' },
      reviewGated: {
        ...config.reviewGated,
        autonomous: { ...config.reviewGated?.autonomous, maxInputTokensPerBatch: 40_000_000 },
      },
    };
    const registry = ModelRegistry.fromConfig(changedConfig, '/repository');

    expect(() =>
      new RoleManager(changedConfig).resolveReviewWorkflowRoles(snapshot, registry),
    ).not.toThrow();
  });

  it('rejects a session assigned to the opposite role before invoking an adapter', async () => {
    const { roles } = setup();
    const send = vi.spyOn(roles.reviewer.adapter, 'send');
    const service = new RoleInvocationService(store);
    const implementerSession: SessionIdentity = {
      sessionIdentityId: 'session-implementer',
      workflowId: 'workflow-6',
      providerOrAdapter: roles.reviewer.adapter.name,
      vendorSessionId: 'shared-vendor-session',
      creatingInvocationId: 'invocation-implementer',
      resumeLineage: [],
      assignedRole: 'IMPLEMENTER',
      createdAt: NOW,
      lastUsedAt: NOW,
    };
    persistSession(implementerSession, 'command-prior-session');

    await expect(
      service.invoke({
        resolution: roles.reviewer,
        workflowId: 'workflow-6',
        commandId: 'command-reviewer',
        actorExecutionId: 'execution-reviewer',
        invocationId: 'invocation-reviewer',
        sessionIdentityId: 'session-reviewer',
        prompt: 'Review.',
        previousSessionIdentityId: implementerSession.sessionIdentityId,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_ROLE_MISMATCH' });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects returned vendor-session reuse across roles without persisting evidence', async () => {
    const { roles } = setup();
    reserve('command-reviewer');
    const oppositeSession: SessionIdentity = {
      sessionIdentityId: 'session-implementer',
      workflowId: 'workflow-6',
      providerOrAdapter: roles.reviewer.adapter.name,
      vendorSessionId: 'shared-vendor-session',
      creatingInvocationId: 'invocation-implementer',
      resumeLineage: [],
      assignedRole: 'IMPLEMENTER',
      createdAt: NOW,
      lastUsedAt: NOW,
    };
    persistSession(oppositeSession, 'command-opposite-session');
    vi.spyOn(roles.reviewer.adapter, 'send').mockResolvedValue(
      bridgeResult(roles.reviewer, oppositeSession.vendorSessionId, 1002),
    );

    await expect(
      new RoleInvocationService(store).invoke({
        resolution: roles.reviewer,
        workflowId: 'workflow-6',
        commandId: 'command-reviewer',
        actorExecutionId: 'execution-reviewer',
        invocationId: 'invocation-reviewer',
        sessionIdentityId: 'session-reviewer',
        prompt: 'Review.',
      }),
    ).rejects.toBeInstanceOf(RoleInvocationError);
    expect(store.getEntity('INVOCATION_IDENTITY', 'invocation-reviewer')).toBeNull();
  });

  it('persists the CLI output when a BOUND resume fails — a transcript is never discarded', async () => {
    // The live failure: a ~60-minute implementer call was rejected by the protocol parser
    // AFTER the CLI ran to completion; the resume path wrapped the adapter's error and the
    // failure audit wrote NULL, discarding the whole transcript exactly when it was the
    // only diagnostic. The wrapper must carry the evidence and the audit must persist it.
    const { roles } = setup();
    reserve('command-evidence-first');
    reserve('command-evidence-retry');
    vi.spyOn(roles.implementer.adapter, 'send').mockResolvedValue(
      bridgeResult(roles.implementer, 'bound-vendor-session', 1001),
    );
    const service = new RoleInvocationService(store);
    const first = await service.prepare({
      resolution: roles.implementer,
      workflowId: 'workflow-6',
      commandId: 'command-evidence-first',
      actorExecutionId: 'execution-evidence-first',
      invocationId: 'invocation-evidence-first',
      sessionIdentityId: 'session-evidence-first',
      prompt: 'Implement the batch.',
      sessionBinding: { batchId: 'batch-6', role: 'IMPLEMENTER' },
      auditPhase: 'IMPLEMENTATION',
    });
    service.persistPrepared(first);

    const protocolFailure = new ModelError(
      'Invalid Claude CLI output: Claude CLI result session ID matches none of the announced init sessions',
      'anthropic',
      'claude-sonnet-4-6',
    );
    protocolFailure.partialOutput = {
      stdout: '{"type":"system","subtype":"init"}\nSIXTY-MINUTE-TRANSCRIPT-EVIDENCE',
      stderr: '',
    };
    vi.spyOn(roles.implementer.adapter, 'resume').mockRejectedValue(protocolFailure);

    await expect(
      service.prepare({
        resolution: roles.implementer,
        workflowId: 'workflow-6',
        commandId: 'command-evidence-retry',
        actorExecutionId: 'execution-evidence-retry',
        invocationId: 'invocation-evidence-retry',
        sessionIdentityId: 'session-evidence-unused',
        prompt: 'Continue the batch.',
        sessionBinding: { batchId: 'batch-6', role: 'IMPLEMENTER', expectExisting: true },
        auditPhase: 'IMPLEMENTATION',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_RESUME_FAILED' });

    const failureRow = store
      .listInvocationAudit('workflow-6')
      .find((row) => row.resultStatus === 'FAILED');
    expect(failureRow).toBeDefined();
    // The evidence survived the wrapper: raw stdout persisted, parse error recorded.
    expect(failureRow?.rawStdout).toContain('SIXTY-MINUTE-TRANSCRIPT-EVIDENCE');
    expect(failureRow?.failure?.message).toContain('matches none of the announced');
  });

  it('resumes only the role-owned session and stores the new invocation link', async () => {
    const { roles } = setup();
    reserve('command-first');
    reserve('command-resume');
    vi.spyOn(roles.implementer.adapter, 'send').mockResolvedValue(
      bridgeResult(roles.implementer, 'implementer-vendor-session', 1001),
    );
    const service = new RoleInvocationService(store);
    const first = await service.invoke({
      resolution: roles.implementer,
      workflowId: 'workflow-6',
      commandId: 'command-first',
      actorExecutionId: 'execution-first',
      invocationId: 'invocation-first',
      sessionIdentityId: 'session-implementer',
      prompt: 'Implement.',
    });
    vi.spyOn(roles.implementer.adapter, 'resume').mockResolvedValue(
      bridgeResult(
        roles.implementer,
        first.session.vendorSessionId,
        1003,
        first.session.vendorSessionId,
        '2026-07-29T10:02:00.000Z',
      ),
    );

    const resumed = await service.invoke({
      resolution: roles.implementer,
      workflowId: 'workflow-6',
      commandId: 'command-resume',
      actorExecutionId: 'execution-resume',
      invocationId: 'invocation-resume',
      sessionIdentityId: 'unused-new-session-id',
      prompt: 'Address findings.',
      previousSessionIdentityId: first.session.sessionIdentityId,
    });

    expect(resumed.resumed).toBe(true);
    expect(resumed.execution.sessionIdentityId).toBe(first.session.sessionIdentityId);
    expect(store.getEntity('SESSION_IDENTITY', first.session.sessionIdentityId)).toMatchObject({
      value: { lastUsedAt: '2026-07-29T10:02:00.000Z' },
    });
    expect(store.getEntity('INVOCATION_IDENTITY', resumed.invocation.invocationId)).not.toBeNull();
  });
});
