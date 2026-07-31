import type {
  BatchRoleSession,
  ReviewWorkflowStore,
  SessionContinuityEvidence,
} from '../memory/review-workflow-store.js';
import { type BridgeCallResult, type BridgeOptions, callBridge } from '../models/bridge.js';
import {
  actorExecutionIdentitySchema,
  invocationIdentitySchema,
  sessionIdentitySchema,
} from '../review-workflow/schemas.js';
import type {
  ActorExecutionIdentity,
  Authority,
  InvocationIdentity,
  SessionIdentity,
} from '../review-workflow/types.js';
import type { ResolvedRoleAdapter } from './role-manager.js';

export const ROLE_INVOCATION_ERROR_CODES = [
  'ASSIGNMENT_MISMATCH',
  'INVOCATION_EVIDENCE_REQUIRED',
  'INVOCATION_EVIDENCE_MISMATCH',
  'SESSION_EVIDENCE_REQUIRED',
  'SESSION_ROLE_MISMATCH',
  'SESSION_WORKFLOW_MISMATCH',
  'SESSION_ADAPTER_MISMATCH',
  'CROSS_ROLE_SESSION_REUSE',
  'AUTHORITY_NOT_ALLOWED',
  'SESSION_RESUME_REQUIRED',
  'SESSION_RESUME_UNSUPPORTED',
  'SESSION_RESUME_FAILED',
  'SESSION_IDENTITY_MISMATCH',
  'ROLE_SESSION_MISSING',
] as const;

export type RoleInvocationErrorCode = (typeof ROLE_INVOCATION_ERROR_CODES)[number];

/**
 * The stable machine-readable failure vocabulary of mandatory role-session continuity.
 * Coordinators treat any of these as fail-closed: the batch stops (BLOCKED, human decision)
 * with the exact reason, and no fallback session is ever created.
 */
export const SESSION_CONTINUITY_ERROR_CODES = [
  'SESSION_RESUME_REQUIRED',
  'SESSION_RESUME_UNSUPPORTED',
  'SESSION_RESUME_FAILED',
  'SESSION_IDENTITY_MISMATCH',
  'ROLE_SESSION_MISSING',
  'CROSS_ROLE_SESSION_REUSE',
] as const;

export type SessionContinuityErrorCode = (typeof SESSION_CONTINUITY_ERROR_CODES)[number];

export function isSessionContinuityError(error: unknown): error is RoleInvocationError {
  return (
    error instanceof RoleInvocationError &&
    (SESSION_CONTINUITY_ERROR_CODES as readonly string[]).includes(error.code)
  );
}

export class RoleInvocationError extends Error {
  constructor(
    readonly code: RoleInvocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoleInvocationError';
  }
}

/**
 * Binds this invocation to the batch role-session registry: exactly one active vendor
 * session per (batch, role). The first bound invocation creates and persists it; every
 * later bound invocation MUST resume that exact vendor session — the registry, not the
 * caller, decides between create and resume.
 */
export interface RoleSessionBinding {
  readonly batchId: string;
  readonly role: 'IMPLEMENTER' | 'REVIEWER';
  /** The operation requires a prior session (correction, later review rounds, final audit). */
  readonly expectExisting?: boolean;
}

export interface RoleInvocationInput {
  readonly resolution: ResolvedRoleAdapter;
  readonly workflowId: string;
  readonly commandId: string;
  readonly actorExecutionId: string;
  readonly invocationId: string;
  readonly sessionIdentityId: string;
  readonly prompt: string;
  readonly options?: BridgeOptions;
  readonly previousSessionIdentityId?: string;
  readonly additionalAuthorities?: readonly Authority[];
  readonly sessionBinding?: RoleSessionBinding;
}

export interface RoleInvocationResult {
  readonly call: BridgeCallResult;
  readonly execution: ActorExecutionIdentity;
  readonly invocation: InvocationIdentity;
  readonly session: SessionIdentity;
  readonly resumed: boolean;
}

export type PreparedRoleInvocation = RoleInvocationResult & {
  readonly assignment: ResolvedRoleAdapter['assignment'];
  /** Present when the invocation ran under a batch role-session binding. */
  readonly continuity?: SessionContinuityEvidence;
};

const ROLE_AUTHORITIES: Readonly<Record<ResolvedRoleAdapter['role'], readonly Authority[]>> = {
  implementer: ['IMPLEMENTER', 'PLAN_REFINER', 'COMMIT_CREATOR'],
  reviewer: ['REVIEWER'],
};

/**
 * Invokes one resolved role and persists the assignment → execution → invocation/session links.
 *
 * The service only accepts a RoleManager resolution, never an alias supplied with the request.
 * Runtime evidence is taken from the bridge result and checked against the immutable assignment.
 */
export class RoleInvocationService {
  constructor(private readonly store: ReviewWorkflowStore) {}

  async invoke(input: RoleInvocationInput): Promise<RoleInvocationResult> {
    const prepared = await this.prepare(input);
    this.persistPrepared(prepared);
    return prepared;
  }

  /**
   * Performs the external bridge call and validates its evidence without writing it.
   *
   * Coordinators use this split form when the command receipt must name the process-attested
   * actor, while the invocation row itself must reference that receipt.
   */
  async prepare(input: RoleInvocationInput): Promise<PreparedRoleInvocation> {
    const { assignment, adapter } = input.resolution;
    const expectedRole = input.resolution.role === 'implementer' ? 'IMPLEMENTER' : 'REVIEWER';
    if (assignment.assignedRole !== expectedRole || assignment.workflowId !== input.workflowId) {
      throw new RoleInvocationError(
        'ASSIGNMENT_MISMATCH',
        'Resolved role assignment does not match the requested workflow invocation',
      );
    }
    const authoritiesExercised = this.resolveAuthorities(input);

    // Mandatory role-session continuity: when a binding is declared, the persisted registry
    // — never the caller — decides between creating the role session and resuming it.
    const binding = this.resolveBinding(input, expectedRole);
    const previousSession =
      binding === null ? this.loadPreviousSession(input) : this.loadBoundSession(binding, input);

    let call: BridgeCallResult;
    try {
      call =
        previousSession === undefined
          ? await callBridge(adapter, input.prompt, input.options)
          : await callBridge(adapter, input.prompt, {
              ...input.options,
              sessionId: previousSession.vendorSessionId,
              ...(binding === null ? {} : { strictResume: true }),
            });
    } catch (error) {
      if (binding !== null && previousSession !== undefined) {
        throw this.continuityFailure(
          input,
          binding,
          'SESSION_RESUME_FAILED',
          `Adapter could not resume vendor session ${previousSession.vendorSessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          previousSession.vendorSessionId,
          undefined,
        );
      }
      throw error;
    }
    const invocationEvidence = call.invocationEvidence;
    if (invocationEvidence === undefined) {
      throw new RoleInvocationError(
        'INVOCATION_EVIDENCE_REQUIRED',
        'Role-capable bridges must return invocation identity evidence',
      );
    }
    const expectedAdapterKind = adapter.name.toUpperCase();
    if (
      invocationEvidence.adapterKind !== assignment.expectedAdapterKind ||
      invocationEvidence.adapterKind !== expectedAdapterKind ||
      invocationEvidence.configuredModel !== assignment.configuredModel ||
      call.model !== assignment.configuredModel ||
      call.provider !== assignment.provider
    ) {
      throw new RoleInvocationError(
        'INVOCATION_EVIDENCE_MISMATCH',
        'Bridge invocation evidence does not match the resolved role assignment',
      );
    }

    const sessionEvidence = call.sessionEvidence;
    if (sessionEvidence === undefined || call.sessionId === undefined) {
      throw new RoleInvocationError(
        'SESSION_EVIDENCE_REQUIRED',
        'Role-capable bridges must return session identity evidence',
      );
    }
    if (
      sessionEvidence.providerOrAdapter !== adapter.name ||
      sessionEvidence.vendorSessionId !== call.sessionId
    ) {
      throw new RoleInvocationError(
        'SESSION_ADAPTER_MISMATCH',
        'Bridge session evidence does not match the resolved adapter',
      );
    }
    // Bound invocations enforce continuity FIRST so every failure records evidence; the
    // legacy workflow-scoped cross-role check still guards unbound invocations.
    if (binding !== null) {
      this.enforceBoundContinuity(input, binding, previousSession, sessionEvidence);
    }
    this.assertNotUsedByOppositeRole(sessionEvidence, input);

    const resumed =
      previousSession !== undefined &&
      sessionEvidence.vendorSessionId === previousSession.vendorSessionId &&
      sessionEvidence.resumedFromSessionId === previousSession.vendorSessionId;
    if (
      previousSession !== undefined &&
      sessionEvidence.vendorSessionId === previousSession.vendorSessionId &&
      !resumed
    ) {
      throw new RoleInvocationError(
        'SESSION_EVIDENCE_REQUIRED',
        'A reused vendor session must identify the session it resumed',
      );
    }

    const invocation = invocationIdentitySchema.parse({
      invocationId: input.invocationId,
      commandId: input.commandId,
      actorMechanism: `${adapter.name}-cli`,
      adapterKind: invocationEvidence.adapterKind,
      executablePath: invocationEvidence.executablePath,
      ...(invocationEvidence.executableHash === undefined
        ? {}
        : { executableHash: invocationEvidence.executableHash }),
      cliVersion: invocationEvidence.cliVersion,
      configuredModel: invocationEvidence.configuredModel,
      ...(invocationEvidence.reportedModel === undefined
        ? {}
        : { reportedModel: invocationEvidence.reportedModel }),
      workingDirectory: invocationEvidence.workingDirectory,
      processId: invocationEvidence.processId,
      processInstanceFingerprint: invocationEvidence.processInstanceFingerprint,
      startedAt: invocationEvidence.startedAt,
      finishedAt: invocationEvidence.finishedAt,
      resultStatus: invocationEvidence.resultStatus,
    });
    const session = sessionIdentitySchema.parse(
      resumed && previousSession !== undefined
        ? { ...previousSession, lastUsedAt: invocationEvidence.finishedAt }
        : {
            sessionIdentityId: input.sessionIdentityId,
            workflowId: input.workflowId,
            providerOrAdapter: sessionEvidence.providerOrAdapter,
            vendorSessionId: sessionEvidence.vendorSessionId,
            creatingInvocationId: invocation.invocationId,
            ...(previousSession !== undefined &&
            sessionEvidence.resumedFromSessionId === previousSession.vendorSessionId
              ? {
                  resumedFromSessionIdentityId: previousSession.sessionIdentityId,
                  resumeLineage: [
                    ...previousSession.resumeLineage,
                    previousSession.sessionIdentityId,
                  ],
                }
              : { resumeLineage: [] }),
            assignedRole: assignment.assignedRole,
            createdAt: invocationEvidence.startedAt,
            lastUsedAt: invocationEvidence.finishedAt,
          },
    );
    const execution = actorExecutionIdentitySchema.parse({
      actorExecutionId: input.actorExecutionId,
      actorType: 'AGENT',
      assignmentId: assignment.assignmentId,
      invocationIdentityId: invocation.invocationId,
      sessionIdentityId: session.sessionIdentityId,
      authoritiesExercised,
      identityAssurance: invocationEvidence.identityAssurance,
      observedEvidence: buildObservedEvidence(invocation, invocationEvidence),
      startedAt: invocation.startedAt,
      finishedAt: invocation.finishedAt,
    });

    const continuity: SessionContinuityEvidence | undefined =
      binding === null
        ? undefined
        : {
            invocationId: invocation.invocationId,
            workflowId: input.workflowId,
            batchId: binding.batchId,
            role: binding.role,
            adapterKind: assignment.expectedAdapterKind,
            ...(previousSession === undefined
              ? {}
              : { requestedVendorSessionId: previousSession.vendorSessionId }),
            returnedVendorSessionId: sessionEvidence.vendorSessionId,
            outcome: previousSession === undefined ? 'CREATED' : 'RESUMED',
            createdAt: invocation.finishedAt ?? invocation.startedAt,
          };

    return {
      call,
      execution,
      invocation,
      session,
      resumed,
      assignment,
      ...(continuity === undefined ? {} : { continuity }),
    };
  }

  persistPrepared(prepared: PreparedRoleInvocation): void {
    // One transaction: an invocation may never persist without its binding and evidence.
    this.store.runAtomically(() => {
      this.persistPreparedRecords(prepared);
    });
  }

  private persistPreparedRecords(prepared: PreparedRoleInvocation): void {
    this.store.saveRoleInvocation({
      assignment: prepared.assignment,
      invocation: prepared.invocation,
      ...(prepared.resumed
        ? { reusedSessionIdentityId: prepared.session.sessionIdentityId }
        : { session: prepared.session }),
      execution: prepared.execution,
    });
    if (prepared.continuity !== undefined) {
      if (prepared.continuity.outcome === 'CREATED') {
        this.store.bindBatchRoleSession({
          batchId: prepared.continuity.batchId,
          role: prepared.continuity.role,
          workflowId: prepared.continuity.workflowId,
          sessionIdentityId: prepared.session.sessionIdentityId,
          providerOrAdapter: prepared.session.providerOrAdapter,
          vendorSessionId: prepared.session.vendorSessionId,
          createdAt: prepared.continuity.createdAt,
        });
      }
      this.store.recordSessionContinuity(prepared.continuity);
    }
  }

  private assertSessionBelongsToRole(session: SessionIdentity, input: RoleInvocationInput): void {
    if (session.assignedRole !== input.resolution.assignment.assignedRole) {
      throw new RoleInvocationError(
        'SESSION_ROLE_MISMATCH',
        'Cannot resume a session assigned to the other workflow role',
      );
    }
    if (session.workflowId !== input.workflowId) {
      throw new RoleInvocationError(
        'SESSION_WORKFLOW_MISMATCH',
        'Cannot resume a session from another review workflow',
      );
    }
    if (session.providerOrAdapter !== input.resolution.adapter.name) {
      throw new RoleInvocationError(
        'SESSION_ADAPTER_MISMATCH',
        'Cannot resume a session through a different adapter',
      );
    }
  }

  private loadPreviousSession(input: RoleInvocationInput): SessionIdentity | undefined {
    if (input.previousSessionIdentityId === undefined) return undefined;
    const entity = this.store.getEntity('SESSION_IDENTITY', input.previousSessionIdentityId);
    if (entity === null || entity.kind !== 'SESSION_IDENTITY') {
      throw new RoleInvocationError(
        'SESSION_EVIDENCE_REQUIRED',
        `Stored session identity ${input.previousSessionIdentityId} does not exist`,
      );
    }
    this.assertSessionBelongsToRole(entity.value, input);
    return entity.value;
  }

  private assertNotUsedByOppositeRole(
    session: { readonly providerOrAdapter: string; readonly vendorSessionId: string },
    input: RoleInvocationInput,
  ): void {
    const existing = this.store.findSessionIdentity(
      input.workflowId,
      session.providerOrAdapter,
      session.vendorSessionId,
    );
    if (existing !== null && existing.assignedRole !== input.resolution.assignment.assignedRole) {
      throw new RoleInvocationError(
        'CROSS_ROLE_SESSION_REUSE',
        'Implementer and reviewer cannot share a vendor session',
      );
    }
  }

  /** Validates the declared binding and loads the persisted registry row, if any. */
  private resolveBinding(
    input: RoleInvocationInput,
    expectedRole: 'IMPLEMENTER' | 'REVIEWER',
  ): (RoleSessionBinding & { readonly existing: BatchRoleSession | null }) | null {
    if (input.sessionBinding === undefined) return null;
    if (input.sessionBinding.role !== expectedRole) {
      throw this.continuityFailure(
        input,
        input.sessionBinding,
        'CROSS_ROLE_SESSION_REUSE',
        `A ${input.resolution.role} invocation cannot bind the ${input.sessionBinding.role} role session`,
        undefined,
        undefined,
      );
    }
    const existing = this.store.getBatchRoleSession(
      input.sessionBinding.batchId,
      input.sessionBinding.role,
    );
    if (existing === null && input.sessionBinding.expectExisting === true) {
      throw this.continuityFailure(
        input,
        input.sessionBinding,
        'ROLE_SESSION_MISSING',
        `Batch ${input.sessionBinding.batchId} has no persisted ${input.sessionBinding.role} session to resume`,
        undefined,
        undefined,
      );
    }
    return { ...input.sessionBinding, existing };
  }

  /**
   * Loads the session the binding mandates. When a binding exists, resuming it is the ONLY
   * permitted behavior: the adapter must support resume, and a fresh session is forbidden.
   */
  private loadBoundSession(
    binding: RoleSessionBinding & { readonly existing: BatchRoleSession | null },
    input: RoleInvocationInput,
  ): SessionIdentity | undefined {
    if (binding.existing === null) return undefined;
    if (!input.resolution.adapter.capabilities.supportsResume) {
      throw this.continuityFailure(
        input,
        binding,
        'SESSION_RESUME_UNSUPPORTED',
        `Adapter ${input.resolution.adapter.name} cannot resume sessions, but batch ${binding.batchId} requires resuming its ${binding.role} session`,
        binding.existing.vendorSessionId,
        undefined,
      );
    }
    const entity = this.store.getEntity('SESSION_IDENTITY', binding.existing.sessionIdentityId);
    if (entity === null || entity.kind !== 'SESSION_IDENTITY') {
      throw this.continuityFailure(
        input,
        binding,
        'ROLE_SESSION_MISSING',
        `Bound session identity ${binding.existing.sessionIdentityId} is not persisted`,
        binding.existing.vendorSessionId,
        undefined,
      );
    }
    try {
      this.assertSessionBelongsToRole(entity.value, input);
    } catch (error) {
      // Bound-session integrity failures must fail closed like every other continuity
      // violation: stable code, FAILED evidence, batch escalation.
      const original = error instanceof RoleInvocationError ? error : null;
      throw this.continuityFailure(
        input,
        binding,
        original?.code === 'SESSION_ROLE_MISMATCH'
          ? 'CROSS_ROLE_SESSION_REUSE'
          : 'SESSION_IDENTITY_MISMATCH',
        original?.message ?? 'Bound session does not match the invocation identity',
        binding.existing.vendorSessionId,
        undefined,
      );
    }
    return entity.value;
  }

  /**
   * Fail-closed continuity checks after the bridge answered. The returned vendor session
   * must be provably the bound one (resume) or provably new and unclaimed (create); any
   * other answer stops the workflow — never a silent fallback.
   */
  private enforceBoundContinuity(
    input: RoleInvocationInput,
    binding: RoleSessionBinding & { readonly existing: BatchRoleSession | null },
    previousSession: SessionIdentity | undefined,
    sessionEvidence: {
      readonly providerOrAdapter: string;
      readonly vendorSessionId: string;
      readonly resumedFromSessionId?: string;
    },
  ): void {
    if (previousSession !== undefined) {
      if (sessionEvidence.vendorSessionId !== previousSession.vendorSessionId) {
        throw this.continuityFailure(
          input,
          binding,
          'SESSION_IDENTITY_MISMATCH',
          `Adapter returned vendor session ${sessionEvidence.vendorSessionId} instead of the bound session ${previousSession.vendorSessionId}`,
          previousSession.vendorSessionId,
          sessionEvidence.vendorSessionId,
        );
      }
      if (sessionEvidence.resumedFromSessionId !== previousSession.vendorSessionId) {
        throw this.continuityFailure(
          input,
          binding,
          'SESSION_RESUME_REQUIRED',
          `Adapter did not prove it resumed vendor session ${previousSession.vendorSessionId}`,
          previousSession.vendorSessionId,
          sessionEvidence.vendorSessionId,
        );
      }
      return;
    }
    // Create path: the new vendor session must not already serve any batch role anywhere.
    const claimed = this.store.findBatchRoleSessionByVendor(
      sessionEvidence.providerOrAdapter,
      sessionEvidence.vendorSessionId,
    );
    if (claimed !== null) {
      const code =
        claimed.role === binding.role ? 'SESSION_IDENTITY_MISMATCH' : 'CROSS_ROLE_SESSION_REUSE';
      throw this.continuityFailure(
        input,
        binding,
        code,
        `Vendor session ${sessionEvidence.vendorSessionId} is already bound to batch ${claimed.batchId} as ${claimed.role}`,
        undefined,
        sessionEvidence.vendorSessionId,
      );
    }
  }

  /** Records append-only FAILED continuity evidence and returns the typed error to throw. */
  private continuityFailure(
    input: RoleInvocationInput,
    binding: { readonly batchId: string; readonly role: 'IMPLEMENTER' | 'REVIEWER' },
    code: SessionContinuityErrorCode,
    message: string,
    requestedVendorSessionId: string | undefined,
    returnedVendorSessionId: string | undefined,
  ): RoleInvocationError {
    this.store.recordSessionContinuity({
      invocationId: input.invocationId,
      workflowId: input.workflowId,
      batchId: binding.batchId,
      role: binding.role,
      adapterKind: input.resolution.assignment.expectedAdapterKind,
      ...(requestedVendorSessionId === undefined ? {} : { requestedVendorSessionId }),
      ...(returnedVendorSessionId === undefined ? {} : { returnedVendorSessionId }),
      outcome: 'FAILED',
      errorCode: code,
      createdAt: new Date().toISOString(),
    });
    return new RoleInvocationError(code, message);
  }

  private resolveAuthorities(input: RoleInvocationInput): readonly Authority[] {
    const allowed = new Set(ROLE_AUTHORITIES[input.resolution.role]);
    const requested = [
      input.resolution.assignment.assignedRole,
      ...(input.additionalAuthorities ?? []),
    ];
    const commitAuthorityDenied =
      requested.includes('COMMIT_CREATOR') &&
      input.resolution.assignment.commitPermission !== 'AUTHORIZED';
    if (requested.some((authority) => !allowed.has(authority)) || commitAuthorityDenied) {
      throw new RoleInvocationError(
        'AUTHORITY_NOT_ALLOWED',
        `Role ${input.resolution.role} cannot exercise the requested workflow authority`,
      );
    }
    return [...new Set(requested)];
  }
}

function buildObservedEvidence(
  invocation: InvocationIdentity,
  evidence: NonNullable<BridgeCallResult['invocationEvidence']>,
) {
  return [
    {
      kind: 'EXECUTABLE',
      source: invocation.actorMechanism,
      value: invocation.executablePath,
      ...(invocation.executableHash === undefined ? {} : { valueHash: invocation.executableHash }),
      observedAt: invocation.startedAt,
    },
    {
      kind: 'PROCESS_INSTANCE',
      source: invocation.actorMechanism,
      value: String(invocation.processId),
      ...(invocation.processInstanceFingerprint === undefined
        ? {}
        : { valueHash: invocation.processInstanceFingerprint }),
      observedAt: invocation.startedAt,
    },
    {
      kind: 'CLI_VERSION',
      source: invocation.actorMechanism,
      value: invocation.cliVersion,
      observedAt: invocation.startedAt,
    },
    ...(evidence.authenticationSource === undefined
      ? []
      : [
          {
            kind: 'AUTHENTICATION_SOURCE',
            source: invocation.actorMechanism,
            value: evidence.authenticationSource,
            observedAt: invocation.startedAt,
          },
        ]),
    ...(evidence.permissionMode === undefined
      ? []
      : [
          {
            kind: 'PERMISSION_MODE',
            source: invocation.actorMechanism,
            value: evidence.permissionMode,
            observedAt: invocation.startedAt,
          },
        ]),
  ];
}
