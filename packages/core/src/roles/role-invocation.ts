import type { ReviewWorkflowStore } from '../memory/review-workflow-store.js';
import { type BridgeCallResult, type BridgeOptions, callBridge } from '../models/bridge.js';
import {
  actorExecutionIdentitySchema,
  invocationIdentitySchema,
  sessionIdentitySchema,
} from '../review-workflow/schemas.js';
import type {
  ActorExecutionIdentity,
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
] as const;

export type RoleInvocationErrorCode = (typeof ROLE_INVOCATION_ERROR_CODES)[number];

export class RoleInvocationError extends Error {
  constructor(
    readonly code: RoleInvocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoleInvocationError';
  }
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
}

export interface RoleInvocationResult {
  readonly call: BridgeCallResult;
  readonly execution: ActorExecutionIdentity;
  readonly invocation: InvocationIdentity;
  readonly session: SessionIdentity;
  readonly resumed: boolean;
}

/**
 * Invokes one resolved role and persists the assignment → execution → invocation/session links.
 *
 * The service only accepts a RoleManager resolution, never an alias supplied with the request.
 * Runtime evidence is taken from the bridge result and checked against the immutable assignment.
 */
export class RoleInvocationService {
  constructor(private readonly store: ReviewWorkflowStore) {}

  async invoke(input: RoleInvocationInput): Promise<RoleInvocationResult> {
    const { assignment, adapter } = input.resolution;
    const expectedRole = input.resolution.role === 'implementer' ? 'IMPLEMENTER' : 'REVIEWER';
    if (assignment.assignedRole !== expectedRole || assignment.workflowId !== input.workflowId) {
      throw new RoleInvocationError(
        'ASSIGNMENT_MISMATCH',
        'Resolved role assignment does not match the requested workflow invocation',
      );
    }

    const previousSession = this.loadPreviousSession(input);

    const call =
      previousSession === undefined
        ? await callBridge(adapter, input.prompt, input.options)
        : await callBridge(adapter, input.prompt, {
            ...input.options,
            sessionId: previousSession.vendorSessionId,
          });
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
      authoritiesExercised: [assignment.assignedRole],
      identityAssurance: invocationEvidence.identityAssurance,
      observedEvidence: buildObservedEvidence(invocation, invocationEvidence),
      startedAt: invocation.startedAt,
      finishedAt: invocation.finishedAt,
    });

    this.store.saveRoleInvocation({
      assignment,
      invocation,
      ...(resumed ? { reusedSessionIdentityId: session.sessionIdentityId } : { session }),
      execution,
    });
    return { call, execution, invocation, session, resumed };
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
