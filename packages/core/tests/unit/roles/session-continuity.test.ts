// Mandatory role-session continuity: the batch role-session registry — never the caller —
// decides between creating a role session and resuming it, and every deviation fails
// closed with a stable error and append-only continuity evidence.

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowCommandStore } from '../../../src/memory/review-workflow-command-store.js';
import { ReviewWorkflowStore } from '../../../src/memory/review-workflow-store.js';
import type { BridgeCallResult, BridgeOptions, CliBridge } from '../../../src/models/bridge.js';
import type {
  AgentAssignment,
  ReviewWorkflowBatch,
  WorkflowRun,
} from '../../../src/review-workflow/types.js';
import { RoleInvocationError, RoleInvocationService } from '../../../src/roles/role-invocation.js';
import type { RoleInvocationInput } from '../../../src/roles/role-invocation.js';
import type { ResolvedRoleAdapter } from '../../../src/roles/role-manager.js';

const NOW = '2026-08-01T12:00:00.000Z';
const LATER = '2026-08-01T12:01:00.000Z';
const WORKFLOW_ID = 'workflow-16';
const BATCH_A = 'workflow-16:batch:1';
const BATCH_B = 'workflow-16:batch:2';

type ResumeBehavior = 'echo' | 'fork' | 'no-claim' | 'throw';

interface LoggedBridgeCall {
  readonly kind: 'send' | 'resume';
  readonly sessionId?: string;
  readonly strictResume?: boolean;
}

class FakeBridge implements CliBridge {
  readonly calls: LoggedBridgeCall[] = [];
  resumeBehavior: ResumeBehavior = 'echo';
  nextVendorId?: string;
  supportsResume = true;
  private counter = 0;
  private processCounter = 100;

  constructor(
    readonly name: string,
    readonly model: string,
    private readonly provider: string,
  ) {}

  get capabilities() {
    return {
      supportsResume: this.supportsResume,
      supportsStream: false,
      maxContextTokens: 100_000,
      supportsTools: true,
      supportsCwd: true,
    };
  }

  stderrToEmit = '';

  async send(_prompt: string, _options?: BridgeOptions): Promise<BridgeCallResult> {
    if (this.stderrToEmit.length > 0) {
      _options?.onStderr?.(this.stderrToEmit);
    }
    this.calls.push({ kind: 'send' });
    this.counter += 1;
    const vendorId = this.nextVendorId ?? `${this.name}-thread-${this.counter}`;
    this.nextVendorId = undefined;
    return this.result(vendorId, undefined);
  }

  async resume(
    sessionId: string,
    _prompt: string,
    options?: BridgeOptions,
  ): Promise<BridgeCallResult> {
    this.calls.push({
      kind: 'resume',
      sessionId,
      ...(options?.strictResume === undefined ? {} : { strictResume: options.strictResume }),
    });
    if (this.resumeBehavior === 'throw') throw new Error('vendor rejected or expired the session');
    if (this.resumeBehavior === 'fork') {
      this.counter += 1;
      return this.result(`${this.name}-fork-${this.counter}`, undefined);
    }
    if (this.resumeBehavior === 'no-claim') return this.result(sessionId, undefined);
    return this.result(sessionId, sessionId);
  }

  private result(vendorId: string, resumedFrom: string | undefined): BridgeCallResult {
    this.processCounter += 1;
    return {
      text: 'ok',
      model: this.model,
      provider: this.provider,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0 },
      finishReason: 'stop',
      durationMs: 50,
      meteringSource: 'sdk',
      sessionId: vendorId,
      invocationEvidence: {
        adapterKind: this.name.toUpperCase() === 'CLAUDE' ? 'CLAUDE' : 'CODEX',
        executablePath: `/usr/local/bin/${this.name}`,
        cliVersion: '1.0.0',
        configuredModel: this.model,
        workingDirectory: '/repository',
        processId: this.processCounter,
        processInstanceFingerprint: 'f'.repeat(64),
        identityAssurance: 'PROCESS_ATTESTED',
        startedAt: NOW,
        finishedAt: LATER,
        resultStatus: 'SUCCEEDED',
      },
      sessionEvidence: {
        providerOrAdapter: this.name,
        vendorSessionId: vendorId,
        ...(resumedFrom === undefined ? {} : { resumedFromSessionId: resumedFrom }),
      },
    };
  }
}

function assignment(role: 'IMPLEMENTER' | 'REVIEWER'): AgentAssignment {
  const implementer = role === 'IMPLEMENTER';
  return {
    assignmentId: implementer ? 'assignment-implementer' : 'assignment-reviewer',
    workflowId: WORKFLOW_ID,
    assignedRole: role,
    configuredAgentKey: implementer ? 'implementer' : 'reviewer',
    configuredModelAlias: implementer ? 'implementer' : 'reviewer',
    expectedAdapterKind: implementer ? 'CLAUDE' : 'CODEX',
    provider: implementer ? 'anthropic' : 'openai',
    configuredModel: implementer ? 'claude-supported' : 'codex-supported',
    commitPermission: implementer ? 'AUTHORIZED' : 'DENIED',
    configurationHash: 'configuration-hash',
    assignedAt: NOW,
  };
}

describe('mandatory role-session continuity', () => {
  let db: Database.Database;
  let store: ReviewWorkflowStore;
  let commandStore: ReviewWorkflowCommandStore;
  let service: RoleInvocationService;
  let implementerBridge: FakeBridge;
  let reviewerBridge: FakeBridge;
  let invocationCounter: number;

  function resolution(role: 'implementer' | 'reviewer'): ResolvedRoleAdapter {
    return role === 'implementer'
      ? { role, assignment: assignment('IMPLEMENTER'), adapter: implementerBridge }
      : { role, assignment: assignment('REVIEWER'), adapter: reviewerBridge };
  }

  function input(
    role: 'implementer' | 'reviewer',
    binding?: RoleInvocationInput['sessionBinding'],
  ): RoleInvocationInput {
    invocationCounter += 1;
    const commandId = `command-${invocationCounter}`;
    // Mirror reserve-before-invoke: persisted invocation rows reference command receipts.
    const requester = {
      actorExecutionId: `${commandId}:requester`,
      actorType: 'HUMAN' as const,
      authoritiesExercised: ['WORKFLOW_OWNER' as const],
      identityAssurance: 'CLI_ASSERTED' as const,
      observedEvidence: [],
      startedAt: NOW,
    };
    const request = {
      commandId,
      workflowId: WORKFLOW_ID,
      batchId: binding?.batchId ?? BATCH_A,
      expectedAggregateVersion: 0,
      requester,
      authorityExercised: 'WORKFLOW_OWNER' as const,
      command: { type: 'BLOCK_BATCH' as const, reason: 'Occupies the receipt' },
    };
    commandStore.reserve({ ...request, canonicalRequestHash: `hash:${commandId}` });
    return {
      resolution: resolution(role),
      workflowId: WORKFLOW_ID,
      commandId,
      actorExecutionId: `actor-${invocationCounter}`,
      invocationId: `invocation-${invocationCounter}`,
      sessionIdentityId: `session-${invocationCounter}`,
      prompt: 'do the work',
      ...(binding === undefined ? {} : { sessionBinding: binding }),
    };
  }

  function lastFailure(batchId: string) {
    return store
      .listSessionContinuity(batchId)
      .filter((row) => row.outcome === 'FAILED')
      .at(-1);
  }

  async function invokeAndPersist(invocationInput: RoleInvocationInput) {
    const prepared = await service.prepare(invocationInput);
    service.persistPrepared(prepared);
    return prepared;
  }

  function createBatchRow(batchId: string, ordinal: number): void {
    const batch: ReviewWorkflowBatch = {
      batchId,
      workflowId: WORKFLOW_ID,
      ordinal,
      persistedState: 'IMPLEMENTING',
      aggregateVersion: 0,
      currentPlanVersionId: `${batchId}:plan:1`,
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      createdAt: NOW,
      updatedAt: NOW,
    };
    store.createBatch(batch);
  }

  beforeEach(() => {
    invocationCounter = 0;
    db = openDatabase(':memory:');
    store = new ReviewWorkflowStore(db);
    commandStore = new ReviewWorkflowCommandStore(db, () => new Date(LATER));
    service = new RoleInvocationService(store);
    implementerBridge = new FakeBridge('claude', 'claude-supported', 'anthropic');
    reviewerBridge = new FakeBridge('codex', 'codex-supported', 'openai');
    const workflow: WorkflowRun = {
      workflowId: WORKFLOW_ID,
      status: 'ACTIVE',
      generalPlanVersionId: `${WORKFLOW_ID}:general-plan`,
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      configurationHash: 'configuration-hash',
      createdAt: NOW,
      updatedAt: NOW,
    };
    store.createWorkflow(workflow);
    createBatchRow(BATCH_A, 1);
    createBatchRow(BATCH_B, 2);
  });

  afterEach(() => {
    db.close();
  });

  it('persists the full prompt/response audit with redacted secrets for every invocation', async () => {
    process.env.CODEMOOT_TEST_FAKE_KEY = 'super-secret-value-123';
    try {
      const bound = input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' });
      await invokeAndPersist({
        ...bound,
        prompt: 'do the work using super-secret-value-123',
        auditPhase: 'IMPLEMENTATION',
      });
      const audit = store.listInvocationAudit(WORKFLOW_ID);
      expect(audit).toHaveLength(1);
      const row = audit[0];
      expect(row).toMatchObject({
        workflowId: WORKFLOW_ID,
        batchId: BATCH_A,
        phase: 'IMPLEMENTATION',
        role: 'IMPLEMENTER',
        adapterKind: 'CLAUDE',
        sessionOutcome: 'CREATED',
        vendorSessionId: 'claude-thread-1',
        redactionCount: 1,
        inputTokens: 10,
        outputTokens: 5,
      });
      // The secret never reaches storage; hashes cover the ORIGINAL content.
      expect(row?.prompt).not.toContain('super-secret-value-123');
      expect(row?.prompt).toContain('[REDACTED:CODEMOOT_TEST_FAKE_KEY:');
      expect(row?.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.responseHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.response).toBe('ok');
    } finally {
      process.env.CODEMOOT_TEST_FAKE_KEY = undefined;
    }
  });

  it('creates and persists exactly one role session on the first bound invocation', async () => {
    const first = await invokeAndPersist(
      input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' }),
    );
    expect(first.resumed).toBe(false);
    expect(implementerBridge.calls).toEqual([{ kind: 'send' }]);

    const binding = store.getBatchRoleSession(BATCH_A, 'IMPLEMENTER');
    expect(binding).toMatchObject({
      batchId: BATCH_A,
      role: 'IMPLEMENTER',
      workflowId: WORKFLOW_ID,
      vendorSessionId: 'claude-thread-1',
    });
    const evidence = store.listSessionContinuity(BATCH_A);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      role: 'IMPLEMENTER',
      adapterKind: 'CLAUDE',
      returnedVendorSessionId: 'claude-thread-1',
      outcome: 'CREATED',
      workflowId: WORKFLOW_ID,
      batchId: BATCH_A,
    });
    expect(evidence[0]?.requestedVendorSessionId).toBeUndefined();
  });

  it('mandatorily resumes the exact persisted vendor session on later bound invocations', async () => {
    await invokeAndPersist(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' }));
    const second = await invokeAndPersist(
      input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER', expectExisting: true }),
    );
    expect(second.resumed).toBe(true);
    expect(second.session.vendorSessionId).toBe('claude-thread-1');
    // The adapter received the exact persisted vendor session ID, under strict resume.
    expect(implementerBridge.calls.at(-1)).toEqual({
      kind: 'resume',
      sessionId: 'claude-thread-1',
      strictResume: true,
    });
    // Still exactly one binding; evidence shows CREATED then RESUMED with matching IDs.
    expect(store.getBatchRoleSession(BATCH_A, 'IMPLEMENTER')?.vendorSessionId).toBe(
      'claude-thread-1',
    );
    const evidence = store.listSessionContinuity(BATCH_A);
    expect(evidence.map((row) => row.outcome)).toEqual(['CREATED', 'RESUMED']);
    expect(evidence[1]).toMatchObject({
      requestedVendorSessionId: 'claude-thread-1',
      returnedVendorSessionId: 'claude-thread-1',
      invocationId: 'invocation-2',
    });
  });

  it('gives implementer and reviewer distinct vendor sessions and separate bindings', async () => {
    await invokeAndPersist(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' }));
    await invokeAndPersist(input('reviewer', { batchId: BATCH_A, role: 'REVIEWER' }));
    const implementer = store.getBatchRoleSession(BATCH_A, 'IMPLEMENTER');
    const reviewer = store.getBatchRoleSession(BATCH_A, 'REVIEWER');
    expect(implementer?.vendorSessionId).toBe('claude-thread-1');
    expect(reviewer?.vendorSessionId).toBe('codex-thread-1');
    expect(implementer?.vendorSessionId).not.toBe(reviewer?.vendorSessionId);
  });

  it('starts new role sessions for a new batch instead of inheriting them', async () => {
    await invokeAndPersist(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' }));
    const second = await invokeAndPersist(
      input('implementer', { batchId: BATCH_B, role: 'IMPLEMENTER' }),
    );
    expect(second.resumed).toBe(false);
    expect(second.session.vendorSessionId).toBe('claude-thread-2');
    expect(store.getBatchRoleSession(BATCH_B, 'IMPLEMENTER')?.vendorSessionId).toBe(
      'claude-thread-2',
    );
  });

  it('blocks when a required prior session is missing, before any invocation', async () => {
    await expect(
      service.prepare(
        input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER', expectExisting: true }),
      ),
    ).rejects.toMatchObject({ code: 'ROLE_SESSION_MISSING' });
    expect(implementerBridge.calls).toHaveLength(0);
    expect(lastFailure(BATCH_A)).toMatchObject({ errorCode: 'ROLE_SESSION_MISSING' });
  });

  it('blocks when the adapter cannot resume, before any invocation', async () => {
    await invokeAndPersist(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' }));
    implementerBridge.supportsResume = false;
    await expect(
      service.prepare(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' })),
    ).rejects.toMatchObject({ code: 'SESSION_RESUME_UNSUPPORTED' });
    expect(implementerBridge.calls).toHaveLength(1);
    expect(lastFailure(BATCH_A)).toMatchObject({
      errorCode: 'SESSION_RESUME_UNSUPPORTED',
      requestedVendorSessionId: 'claude-thread-1',
    });
  });

  it('blocks when the vendor rejects or expires the resume — never a fallback session', async () => {
    await invokeAndPersist(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' }));
    implementerBridge.resumeBehavior = 'throw';
    await expect(
      service.prepare(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' })),
    ).rejects.toMatchObject({ code: 'SESSION_RESUME_FAILED' });
    // The adapter was asked to resume exactly once; no fresh-session send followed.
    expect(implementerBridge.calls.map((call) => call.kind)).toEqual(['send', 'resume']);
    expect(lastFailure(BATCH_A)).toMatchObject({ errorCode: 'SESSION_RESUME_FAILED' });
  });

  it('blocks when the returned session ID does not match the persisted identity', async () => {
    await invokeAndPersist(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' }));
    implementerBridge.resumeBehavior = 'fork';
    await expect(
      service.prepare(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' })),
    ).rejects.toMatchObject({ code: 'SESSION_IDENTITY_MISMATCH' });
    // The forked vendor session was never persisted: no fallback session identity exists.
    expect(store.findSessionIdentity(WORKFLOW_ID, 'claude', 'claude-fork-2')).toBeNull();
    expect(lastFailure(BATCH_A)).toMatchObject({
      errorCode: 'SESSION_IDENTITY_MISMATCH',
      requestedVendorSessionId: 'claude-thread-1',
      returnedVendorSessionId: 'claude-fork-2',
    });
  });

  it('blocks when the adapter echoes the ID without proving the resume', async () => {
    await invokeAndPersist(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' }));
    implementerBridge.resumeBehavior = 'no-claim';
    await expect(
      service.prepare(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' })),
    ).rejects.toMatchObject({ code: 'SESSION_RESUME_REQUIRED' });
  });

  it('rejects cross-role reuse of a vendor session', async () => {
    await invokeAndPersist(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' }));
    // Vendor sessions are adapter-scoped, so the realistic sharing risk is a reviewer on
    // the SAME adapter kind answering with the implementer's vendor session.
    const claudeReviewerBridge = new FakeBridge('claude', 'claude-supported', 'anthropic');
    claudeReviewerBridge.nextVendorId = 'claude-thread-1';
    const claudeReviewer: ResolvedRoleAdapter = {
      role: 'reviewer',
      assignment: {
        ...assignment('REVIEWER'),
        expectedAdapterKind: 'CLAUDE',
        provider: 'anthropic',
        configuredModel: 'claude-supported',
      },
      adapter: claudeReviewerBridge,
    };
    const bound = input('reviewer', { batchId: BATCH_A, role: 'REVIEWER' });
    await expect(service.prepare({ ...bound, resolution: claudeReviewer })).rejects.toMatchObject({
      code: 'CROSS_ROLE_SESSION_REUSE',
    });
    expect(store.getBatchRoleSession(BATCH_A, 'REVIEWER')).toBeNull();
    expect(lastFailure(BATCH_A)).toMatchObject({
      errorCode: 'CROSS_ROLE_SESSION_REUSE',
      role: 'REVIEWER',
    });
  });

  it('rejects reuse of a vendor session already bound to another batch', async () => {
    await invokeAndPersist(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' }));
    implementerBridge.nextVendorId = 'claude-thread-1';
    await expect(
      service.prepare(input('implementer', { batchId: BATCH_B, role: 'IMPLEMENTER' })),
    ).rejects.toMatchObject({ code: 'SESSION_IDENTITY_MISMATCH' });
    expect(store.getBatchRoleSession(BATCH_B, 'IMPLEMENTER')).toBeNull();
    expect(lastFailure(BATCH_B)).toMatchObject({ errorCode: 'SESSION_IDENTITY_MISMATCH' });
  });

  it('fails closed with evidence when the bound session does not match the adapter', async () => {
    await invokeAndPersist(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' }));
    // The bound session was created through the claude adapter; resuming it through a
    // different adapter is a continuity violation, not a silent legacy mismatch.
    const codexImplementer: ResolvedRoleAdapter = {
      role: 'implementer',
      assignment: {
        ...assignment('IMPLEMENTER'),
        expectedAdapterKind: 'CODEX',
        provider: 'openai',
        configuredModel: 'codex-supported',
      },
      adapter: reviewerBridge,
    };
    const bound = input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' });
    await expect(service.prepare({ ...bound, resolution: codexImplementer })).rejects.toMatchObject(
      { code: 'SESSION_IDENTITY_MISMATCH' },
    );
    expect(lastFailure(BATCH_A)).toMatchObject({
      errorCode: 'SESSION_IDENTITY_MISMATCH',
      requestedVendorSessionId: 'claude-thread-1',
    });
  });

  it('rejects a binding declared for the opposite role', async () => {
    await expect(
      service.prepare(input('implementer', { batchId: BATCH_A, role: 'REVIEWER' })),
    ).rejects.toMatchObject({ code: 'CROSS_ROLE_SESSION_REUSE' });
    expect(implementerBridge.calls).toHaveLength(0);
  });

  it('keeps every continuity failure as a typed RoleInvocationError', async () => {
    implementerBridge.supportsResume = false;
    await invokeAndPersist(input('reviewer', { batchId: BATCH_A, role: 'REVIEWER' }));
    try {
      await service.prepare(
        input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER', expectExisting: true }),
      );
      throw new Error('expected a continuity failure');
    } catch (error) {
      expect(error).toBeInstanceOf(RoleInvocationError);
    }
  });

  it(
    'fails the invocation closed when adapter stderr exceeds the capture limit',
    { timeout: 30_000 },
    async () => {
      implementerBridge.stderrToEmit = 'x'.repeat(5_000_001);
      const request = input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' });
      await expect(service.prepare(request)).rejects.toThrow(/capture limit/);
      // The failure itself is audited — nothing disappears.
      const failed = store
        .listInvocationAudit(WORKFLOW_ID)
        .filter((row) => row.resultStatus === 'FAILED');
      expect(failed.length).toBeGreaterThanOrEqual(1);
    },
  );

  it('never starts the agent when the active-invocation record cannot be persisted', async () => {
    const failing = new RoleInvocationService(store, undefined, {
      onStart: () => {
        throw new Error('runner state unavailable');
      },
      onAgentSpawned: () => {},
      onSettle: () => {},
    });
    const request = input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' });
    await expect(failing.prepare(request)).rejects.toThrow(/runner state unavailable/);
    expect(implementerBridge.calls).toHaveLength(0);
  });

  it('settlement failure rolls back the durable write and surfaces as an error', async () => {
    const failing = new RoleInvocationService(store, undefined, {
      onStart: () => {},
      onAgentSpawned: () => {},
      onSettle: () => {
        throw new Error('settlement write failed');
      },
    });
    const request = input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' });
    // Success-path settlement is transactional with the audit write: prepare succeeds, and
    // the persist step both fails AND rolls the audit row back — nothing half-commits.
    const prepared = await failing.prepare(request);
    expect(() => failing.persistPrepared(prepared)).toThrow(/settlement/);
    expect(
      store
        .listInvocationAudit(WORKFLOW_ID)
        .some((row) => row.invocationId === prepared.invocation.invocationId),
    ).toBe(false);
  });

  it('keeps the active-invocation marker until the durable persist settles it', async () => {
    const events: string[] = [];
    const observed = new RoleInvocationService(store, undefined, {
      onStart: (info) => events.push(`start:${info.invocationId}`),
      onAgentSpawned: (_workflowId, invocationId) => events.push(`spawned:${invocationId}`),
      onSettle: (_workflowId, invocationId) => events.push(`settle:${invocationId}`),
    });
    const request = input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' });
    const prepared = await observed.prepare(request);
    // The stage promotion fires BEFORE the agent could exist, and the response is NOT
    // durable yet: no settlement has fired, so a crash here is classified as
    // unknown-outcome, never silently repeated.
    expect(events).toEqual([`start:${request.invocationId}`, `spawned:${request.invocationId}`]);
    observed.persistPrepared(prepared);
    // Settlement fires exactly once, inside the same transaction as the audit write.
    expect(events).toEqual([
      `start:${request.invocationId}`,
      `spawned:${request.invocationId}`,
      `settle:${request.invocationId}`,
    ]);
  });

  it('never starts the agent when the AGENT_RUNNING promotion cannot be persisted', async () => {
    const failing = new RoleInvocationService(store, undefined, {
      onStart: () => {},
      onAgentSpawned: () => {
        throw new Error('stage promotion write failed');
      },
      onSettle: () => {},
    });
    const request = input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' });
    await expect(failing.prepare(request)).rejects.toThrow(/stage promotion write failed/);
    // Fail closed: the external agent process never spawned.
    expect(implementerBridge.calls).toHaveLength(0);
  });

  it('keeps the marker set when the failure audit itself cannot be persisted', async () => {
    const events: string[] = [];
    const observed = new RoleInvocationService(store, undefined, {
      onStart: (info) => events.push(`start:${info.invocationId}`),
      onAgentSpawned: (_workflowId, invocationId) => events.push(`spawned:${invocationId}`),
      onSettle: (_workflowId, invocationId) => events.push(`settle:${invocationId}`),
    });
    implementerBridge.resumeBehavior = 'throw';
    await invokeAndPersist(input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' }));
    // Break audit persistence, then fail the next (resuming) invocation.
    db.exec('DROP TABLE review_workflow_invocation_audit');
    const request = input('implementer', { batchId: BATCH_A, role: 'IMPLEMENTER' });
    await expect(observed.prepare(request)).rejects.toThrow(/failure audit could not be persisted/);
    // Without a durable failure record, the marker is NEVER cleared: the crash stays
    // visible as an unknown outcome instead of disappearing.
    expect(events.filter((event) => event.startsWith('settle:'))).toHaveLength(0);
  });
});
