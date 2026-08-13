import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/schema.js';
import { reviewWorkflowConfigurationSnapshotSchema } from '../../../src/review-workflow-identity/schemas.js';
import {
  ReviewWorkflowIdentityError,
  createReviewWorkflowConfigurationSnapshot,
  evaluateIdentityAssurance,
  hashReviewWorkflowConfiguration,
} from '../../../src/review-workflow-identity/service.js';
import type {
  AgentExecutionEvidence,
  ReviewWorkflowConfigurationSnapshot,
} from '../../../src/review-workflow-identity/types.js';
import type {
  ActorExecutionIdentity,
  AgentAssignment,
  InvocationIdentity,
  SessionIdentity,
} from '../../../src/review-workflow/types.js';

const NOW = '2026-07-29T10:00:00.000Z';

function reviewGatedConfig(
  commitMode: 'human_required' | 'agent_authorized' | 'either' = 'either',
) {
  return validateConfig({
    configVersion: 3,
    workflow: 'review-gated-batches',
    models: {
      'claude-agent': {
        provider: 'anthropic',
        model: 'claude-supported',
        cliAdapter: {
          kind: 'claude',
          command: 'claude',
          args: [],
          timeout: 600,
          versionConstraint: '>=2',
        },
      },
      'codex-agent': {
        provider: 'openai',
        model: 'codex-supported',
        cliAdapter: {
          kind: 'codex',
          command: 'codex',
          args: ['exec'],
          timeout: 600,
          versionConstraint: '>=1',
        },
      },
    },
    roles: {
      implementer: { model: 'claude-agent' },
      reviewer: { model: 'codex-agent' },
    },
    reviewGated: {
      identity: {
        minimumAssurance: 'process_attested',
        requireDifferentAdapterKinds: true,
        prohibitSharedSessions: true,
      },
      commit: {
        mode: commitMode,
        agentMayCommit: commitMode !== 'human_required',
      },
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

function snapshot(
  commitMode: 'human_required' | 'agent_authorized' | 'either' = 'either',
): ReviewWorkflowConfigurationSnapshot {
  return createReviewWorkflowConfigurationSnapshot(reviewGatedConfig(commitMode), {
    workflowId: 'workflow-1',
    batchId: 'batch-4',
    implementerAssignmentId: 'assignment-implementer',
    reviewerAssignmentId: 'assignment-reviewer',
    assignedAt: NOW,
  });
}

function invocation(
  assignment: AgentAssignment,
  role: 'IMPLEMENTER' | 'REVIEWER',
  authenticatedSubjectHash?: string,
): InvocationIdentity {
  const isImplementer = role === 'IMPLEMENTER';
  return {
    invocationId: isImplementer ? 'invocation-implementer' : 'invocation-reviewer',
    commandId: isImplementer ? 'command-implementer' : 'command-reviewer',
    actorMechanism: isImplementer ? 'claude-cli' : 'codex-cli',
    adapterKind: assignment.expectedAdapterKind,
    executablePath: isImplementer ? '/usr/local/bin/claude' : '/usr/local/bin/codex',
    cliVersion: isImplementer ? '2.1.0' : '1.0.0',
    configuredModel: assignment.configuredModel,
    reportedModel: assignment.configuredModel,
    workingDirectory: '/repository',
    processId: isImplementer ? 1001 : 1002,
    ...(authenticatedSubjectHash === undefined
      ? {}
      : {
          authenticatedSubject: {
            source: isImplementer ? 'claude-cli' : 'codex-cli',
            subjectIdHash: authenticatedSubjectHash,
            assertedByCli: true,
          },
        }),
    startedAt: NOW,
    resultStatus: 'SUCCEEDED',
  };
}

function session(role: 'IMPLEMENTER' | 'REVIEWER', vendorSessionId?: string): SessionIdentity {
  const isImplementer = role === 'IMPLEMENTER';
  return {
    sessionIdentityId: isImplementer ? 'session-implementer' : 'session-reviewer',
    workflowId: 'workflow-1',
    providerOrAdapter: isImplementer ? 'claude' : 'codex',
    vendorSessionId: vendorSessionId ?? (isImplementer ? 'claude-session-1' : 'codex-session-1'),
    creatingInvocationId: isImplementer ? 'invocation-implementer' : 'invocation-reviewer',
    resumeLineage: [],
    assignedRole: role,
    createdAt: NOW,
    lastUsedAt: NOW,
  };
}

function executionEvidence(
  assignment: AgentAssignment,
  role: 'IMPLEMENTER' | 'REVIEWER',
  assurance: ActorExecutionIdentity['identityAssurance'] = 'PROCESS_ATTESTED',
  authenticatedSubjectHash?: string,
): AgentExecutionEvidence {
  const isImplementer = role === 'IMPLEMENTER';
  const invocationIdentity = invocation(assignment, role, authenticatedSubjectHash);
  const sessionIdentity = session(role);
  return {
    execution: {
      actorExecutionId: isImplementer ? 'execution-implementer' : 'execution-reviewer',
      actorType: 'AGENT',
      assignmentId: assignment.assignmentId,
      invocationIdentityId: invocationIdentity.invocationId,
      sessionIdentityId: sessionIdentity.sessionIdentityId,
      authoritiesExercised: [role],
      identityAssurance: assurance,
      observedEvidence: [],
      startedAt: NOW,
    },
    invocation: invocationIdentity,
    session: sessionIdentity,
  };
}

describe('review-workflow identity configuration snapshots', () => {
  it('resolves immutable assignments, commit policy, gates, and independent authorities', () => {
    const result = snapshot('either');

    expect(result.commitPolicy).toBe('EITHER');
    expect(result.assignments.implementer).toMatchObject({
      assignedRole: 'IMPLEMENTER',
      expectedAdapterKind: 'CLAUDE',
      provider: 'anthropic',
      commitPermission: 'AUTHORIZED',
      executable: 'claude',
      versionConstraint: '>=2',
    });
    expect(result.assignments.reviewer).toMatchObject({
      assignedRole: 'REVIEWER',
      expectedAdapterKind: 'CODEX',
      provider: 'openai',
      commitPermission: 'DENIED',
    });
    expect(result.authorityGrants.map((grant) => grant.authority)).toHaveLength(9);
    expect(result.authorityGrants.find((grant) => grant.authority === 'COMMIT_CREATOR')).toEqual({
      authority: 'COMMIT_CREATOR',
      permittedActorTypes: ['AGENT', 'HUMAN'],
    });
    expect(result.gates.blockingSeverities).toEqual(['critical', 'high']);
    expect(result.configurationHash).toHaveLength(64);
    expect(result.assignments.implementer.configurationHash).toBe(result.configurationHash);
    expect(result.assignments.reviewer.configurationHash).toBe(result.configurationHash);
  });

  it('limits commit-creator authority and assignment permission for human-required commits', () => {
    const result = snapshot('human_required');

    expect(result.assignments.implementer.commitPermission).toBe('DENIED');
    expect(
      result.authorityGrants.find((grant) => grant.authority === 'COMMIT_CREATOR')
        ?.permittedActorTypes,
    ).toEqual(['HUMAN']);
  });

  it('records plan-as-is in the snapshot and round-trips it through the schema', () => {
    const config = reviewGatedConfig();
    const withMode = {
      ...config,
      reviewGated: { ...(config.reviewGated ?? {}), planAsIs: true },
    } as typeof config;
    const result = createReviewWorkflowConfigurationSnapshot(withMode, {
      workflowId: 'workflow-1',
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      assignedAt: NOW,
    });
    expect(result.gates.planAsIs).toBe(true);
    expect(reviewWorkflowConfigurationSnapshotSchema.safeParse(result).success).toBe(true);
    // Default: refined mode, recorded as false.
    expect(snapshot().gates.planAsIs).toBe(false);
  });

  it('excludes plan-as-is from the assignment hash — the mode never invalidates roles', () => {
    // Same reason operatorMode is excluded: the mode says nothing about which model holds
    // which role, and including it would shift every existing workflow's hash.
    const config = reviewGatedConfig();
    const withMode = {
      ...config,
      reviewGated: { ...(config.reviewGated ?? {}), planAsIs: true },
    } as typeof config;
    expect(hashReviewWorkflowConfiguration(withMode)).toBe(
      hashReviewWorkflowConfiguration(config),
    );
  });

  it('hashes equivalent configuration independently of object key order', () => {
    const config = reviewGatedConfig();
    const reordered = {
      ...config,
      models: Object.fromEntries(Object.entries(config.models).reverse()),
      roles: Object.fromEntries(Object.entries(config.roles).reverse()),
    };

    expect(hashReviewWorkflowConfiguration(config)).toBe(
      hashReviewWorkflowConfiguration(reordered),
    );
  });

  it('rejects reused assignment IDs even when configured agents differ', () => {
    expect(() =>
      createReviewWorkflowConfigurationSnapshot(reviewGatedConfig(), {
        workflowId: 'workflow-1',
        implementerAssignmentId: 'assignment-reused',
        reviewerAssignmentId: 'assignment-reused',
        assignedAt: NOW,
      }),
    ).toThrow(ReviewWorkflowIdentityError);
  });

  it('rejects an authority snapshot that grants merge recording to an agent', () => {
    const configuration = snapshot();
    const forged = {
      ...configuration,
      authorityGrants: configuration.authorityGrants.map((grant) =>
        grant.authority === 'MERGE_RECORDER' ? { ...grant, permittedActorTypes: ['AGENT'] } : grant,
      ),
    };

    const result = reviewWorkflowConfigurationSnapshotSchema.safeParse(forged);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('actor-authority'))).toBe(
        true,
      );
    }
  });
});

describe('evaluateIdentityAssurance', () => {
  it('accepts distinct process-attested executions while disclosing unknown account identity', () => {
    const configuration = snapshot();
    const result = evaluateIdentityAssurance({
      policy: configuration.identityPolicy,
      implementerAssignment: configuration.assignments.implementer,
      reviewerAssignment: configuration.assignments.reviewer,
      implementer: executionEvidence(configuration.assignments.implementer, 'IMPLEMENTER'),
      reviewer: executionEvidence(configuration.assignments.reviewer, 'REVIEWER'),
    });

    expect(result).toEqual({
      valid: true,
      effectiveAssurance: 'PROCESS_ATTESTED',
      minimumAssuranceSatisfied: true,
      authenticatedSubjectSeparation: 'UNAVAILABLE',
      violations: [],
    });
  });

  it('rejects shared vendor sessions even when local session IDs differ', () => {
    const configuration = snapshot();
    const implementer = executionEvidence(configuration.assignments.implementer, 'IMPLEMENTER');
    const reviewer = executionEvidence(configuration.assignments.reviewer, 'REVIEWER');
    const sharedVendorSession = 'shared-vendor-session';

    const result = evaluateIdentityAssurance({
      policy: configuration.identityPolicy,
      implementerAssignment: configuration.assignments.implementer,
      reviewerAssignment: configuration.assignments.reviewer,
      implementer: {
        ...implementer,
        session: {
          ...session('IMPLEMENTER', sharedVendorSession),
          providerOrAdapter: 'shared-provider',
        },
      },
      reviewer: {
        ...reviewer,
        session: {
          ...session('REVIEWER', sharedVendorSession),
          providerOrAdapter: 'shared-provider',
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain('VENDOR_SESSION_REUSED');
  });

  it('rejects assignment scope drift and session evidence from another workflow', () => {
    const configuration = snapshot();
    const reviewer = executionEvidence(configuration.assignments.reviewer, 'REVIEWER');
    if (reviewer.session === undefined) {
      throw new Error('Test fixture must include session evidence');
    }
    const result = evaluateIdentityAssurance({
      policy: configuration.identityPolicy,
      implementerAssignment: configuration.assignments.implementer,
      reviewerAssignment: {
        ...configuration.assignments.reviewer,
        batchId: undefined,
        configurationHash: 'different-configuration-hash',
      },
      implementer: executionEvidence(configuration.assignments.implementer, 'IMPLEMENTER'),
      reviewer: {
        ...reviewer,
        session: {
          ...reviewer.session,
          workflowId: 'different-workflow',
          creatingInvocationId: 'different-invocation',
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'BATCH_SCOPE_MISMATCH',
        'CONFIGURATION_HASH_MISMATCH',
        'SESSION_WORKFLOW_MISMATCH',
        'SESSION_INVOCATION_MISMATCH',
      ]),
    );
  });

  it('rejects insufficient execution assurance', () => {
    const configuration = snapshot();
    const result = evaluateIdentityAssurance({
      policy: configuration.identityPolicy,
      implementerAssignment: configuration.assignments.implementer,
      reviewerAssignment: configuration.assignments.reviewer,
      implementer: executionEvidence(
        configuration.assignments.implementer,
        'IMPLEMENTER',
        'CONFIG_ONLY',
      ),
      reviewer: executionEvidence(configuration.assignments.reviewer, 'REVIEWER', 'CONFIG_ONLY'),
    });

    expect(result.valid).toBe(false);
    expect(result.minimumAssuranceSatisfied).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(
      'IDENTITY_ASSURANCE_INSUFFICIENT',
    );
  });

  it('does not accept a process-attested label without process and session evidence', () => {
    const configuration = snapshot();
    const implementer = executionEvidence(configuration.assignments.implementer, 'IMPLEMENTER');
    const reviewer = executionEvidence(configuration.assignments.reviewer, 'REVIEWER');
    if (implementer.invocation === undefined) {
      throw new Error('Test fixture must include invocation evidence');
    }
    const result = evaluateIdentityAssurance({
      policy: configuration.identityPolicy,
      implementerAssignment: configuration.assignments.implementer,
      reviewerAssignment: configuration.assignments.reviewer,
      implementer: {
        execution: implementer.execution,
        invocation: {
          ...implementer.invocation,
          executablePath: undefined,
          processId: undefined,
        },
      },
      reviewer,
    });

    expect(result.valid).toBe(false);
    expect(result.effectiveAssurance).toBe('CONFIG_ONLY');
    expect(result.violations.map((violation) => violation.code)).toContain(
      'ASSURANCE_EVIDENCE_INCOMPLETE',
    );
  });

  it('rejects the same authenticated subject and never persists its raw identifier', () => {
    const configuration = snapshot();
    const subjectHash = 'sha256:shared-subject';
    const result = evaluateIdentityAssurance({
      policy: {
        ...configuration.identityPolicy,
        minimumAssurance: 'AUTHENTICATED_SUBJECT',
      },
      implementerAssignment: configuration.assignments.implementer,
      reviewerAssignment: configuration.assignments.reviewer,
      implementer: executionEvidence(
        configuration.assignments.implementer,
        'IMPLEMENTER',
        'AUTHENTICATED_SUBJECT',
        subjectHash,
      ),
      reviewer: executionEvidence(
        configuration.assignments.reviewer,
        'REVIEWER',
        'AUTHENTICATED_SUBJECT',
        subjectHash,
      ),
    });

    expect(result.valid).toBe(false);
    expect(result.authenticatedSubjectSeparation).toBe('REUSED');
    expect(result.violations.map((violation) => violation.code)).toContain(
      'AUTHENTICATED_SUBJECT_REUSED',
    );
    expect(JSON.stringify(result)).not.toContain('account@example.com');
  });

  it('rejects authenticated-subject assurance without subject evidence', () => {
    const configuration = snapshot();
    const result = evaluateIdentityAssurance({
      policy: {
        ...configuration.identityPolicy,
        minimumAssurance: 'AUTHENTICATED_SUBJECT',
      },
      implementerAssignment: configuration.assignments.implementer,
      reviewerAssignment: configuration.assignments.reviewer,
      implementer: executionEvidence(
        configuration.assignments.implementer,
        'IMPLEMENTER',
        'AUTHENTICATED_SUBJECT',
      ),
      reviewer: executionEvidence(
        configuration.assignments.reviewer,
        'REVIEWER',
        'AUTHENTICATED_SUBJECT',
      ),
    });

    expect(result.valid).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(
      'AUTHENTICATED_SUBJECT_REQUIRED',
    );
  });
});
