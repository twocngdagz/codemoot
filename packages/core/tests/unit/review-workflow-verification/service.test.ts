import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import {
  type ReviewWorkflowPersistenceError,
  ReviewWorkflowStore,
} from '../../../src/memory/review-workflow-store.js';
import {
  type ReviewWorkflowVerificationError,
  ReviewWorkflowVerificationService,
  verificationAttestationPolicySchema,
} from '../../../src/review-workflow-verification/index.js';
import type {
  StoredVerificationLog,
  VerificationAttestationPolicy,
  VerificationCommandExecution,
  VerificationCommandRunner,
  VerificationLogContent,
  VerificationLogStore,
  VerificationRepository,
} from '../../../src/review-workflow-verification/index.js';
import type {
  ActorExecutionIdentity,
  AgentAssignment,
  BatchPlanVersion,
  VerificationCommandSpec,
} from '../../../src/review-workflow/types.js';

const NOW = '2026-07-30T00:00:00.000Z';
const LATER = '2026-07-30T00:00:01.000Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const CONFIGURATION_HASH = 'verification-configuration';
const POLICY_HASH = 'verification-policy';
const IMPLEMENTER_ASSIGNMENT_ID = 'assignment-implementer';
const REVIEWER_ASSIGNMENT_ID = 'assignment-reviewer';

const COMMAND: VerificationCommandSpec = {
  executable: 'pnpm',
  arguments: ['test'],
  workingDirectory: '/repository',
  verificationType: 'test',
  relatedCriterionIds: ['criterion-tests'],
};

const BROWSER_COMMAND: VerificationCommandSpec = {
  ...COMMAND,
  verificationType: 'browser',
  relatedCriterionIds: ['criterion-browser'],
};

const BATCH_PLAN: BatchPlanVersion = {
  batchPlanVersionId: 'batch-plan-1',
  workflowId: 'workflow-1',
  batchId: 'batch-1',
  version: 1,
  contentHash: 'batch-plan-content',
  repositoryContextSha: SHA_B,
  objective: 'Verify the implementation separately from acceptance.',
  currentRepositoryEvidence: [
    {
      kind: 'FILE',
      location: 'docs/review-workflow-verification.md',
      description: 'Verification policy.',
    },
  ],
  dependencies: [],
  candidateFiles: ['packages/core/src/review-workflow-verification'],
  technicalImplementation: ['Execute exact commands and persist immutable evidence.'],
  userJourney: ['Run evidence and attest it separately.'],
  expectedBehaviour: ['Successful execution is not automatically accepted.'],
  technicalAcceptanceCriteria: ['criterion-tests'],
  userFacingAcceptanceCriteria: [],
  cliAcceptanceCriteria: [],
  browserAcceptanceCriteria: {
    applicability: 'APPLICABLE',
    criterionIds: ['criterion-browser'],
  },
  verificationCommands: [COMMAND, BROWSER_COMMAND],
  manualVerification: ['Inspect the stored record and attestation.'],
  documentationChanges: ['Document verification versus acceptance.'],
  outOfScope: ['Baseline normalization.'],
  rollbackBoundary: 'Disable runner and attestor invocation while preserving records.',
  addressedFindingIds: [],
  actorExecutionId: 'actor-owner',
  createdAt: NOW,
};

const IMPLEMENTER_ASSIGNMENT: AgentAssignment = {
  assignmentId: IMPLEMENTER_ASSIGNMENT_ID,
  workflowId: 'workflow-1',
  batchId: 'batch-1',
  assignedRole: 'IMPLEMENTER',
  configuredAgentKey: 'claude-implementer',
  configuredModelAlias: 'claude',
  expectedAdapterKind: 'CLAUDE',
  provider: 'anthropic',
  configuredModel: 'claude-model',
  commitPermission: 'DENIED',
  configurationHash: 'workflow-configuration',
  assignedAt: NOW,
};

const REVIEWER_ASSIGNMENT: AgentAssignment = {
  assignmentId: REVIEWER_ASSIGNMENT_ID,
  workflowId: 'workflow-1',
  batchId: 'batch-1',
  assignedRole: 'REVIEWER',
  configuredAgentKey: 'codex-reviewer',
  configuredModelAlias: 'codex',
  expectedAdapterKind: 'CODEX',
  provider: 'openai',
  configuredModel: 'codex-model',
  commitPermission: 'DENIED',
  configurationHash: 'workflow-configuration',
  assignedAt: NOW,
};

const HUMAN_EXECUTOR: ActorExecutionIdentity = {
  actorExecutionId: 'actor-human-executor',
  actorType: 'HUMAN',
  authoritiesExercised: ['VERIFICATION_EXECUTOR'],
  identityAssurance: 'CLI_ASSERTED',
  observedEvidence: [],
  startedAt: NOW,
};

const IMPLEMENTER_EXECUTOR: ActorExecutionIdentity = {
  actorExecutionId: 'actor-implementer',
  actorType: 'AGENT',
  assignmentId: IMPLEMENTER_ASSIGNMENT_ID,
  authoritiesExercised: ['IMPLEMENTER', 'VERIFICATION_EXECUTOR'],
  identityAssurance: 'PROCESS_ATTESTED',
  observedEvidence: [],
  startedAt: NOW,
};

const REVIEWER_ATTESTOR: ActorExecutionIdentity = {
  actorExecutionId: 'actor-reviewer',
  actorType: 'AGENT',
  assignmentId: REVIEWER_ASSIGNMENT_ID,
  authoritiesExercised: ['REVIEWER', 'VERIFICATION_EXECUTOR', 'VERIFICATION_ATTESTOR'],
  identityAssurance: 'PROCESS_ATTESTED',
  observedEvidence: [],
  startedAt: NOW,
};

const SYSTEM_ATTESTOR: ActorExecutionIdentity = {
  actorExecutionId: 'actor-system',
  actorType: 'SYSTEM',
  authoritiesExercised: ['VERIFICATION_ATTESTOR'],
  identityAssurance: 'PROCESS_ATTESTED',
  observedEvidence: [],
  startedAt: NOW,
};

const HUMAN_ATTESTOR: ActorExecutionIdentity = {
  actorExecutionId: 'actor-human-attestor',
  actorType: 'HUMAN',
  authoritiesExercised: ['VERIFICATION_ATTESTOR'],
  identityAssurance: 'CLI_ASSERTED',
  observedEvidence: [],
  startedAt: NOW,
};

const CI_EXECUTOR: ActorExecutionIdentity = {
  actorExecutionId: 'actor-ci-executor',
  actorType: 'CI',
  authoritiesExercised: ['VERIFICATION_EXECUTOR'],
  identityAssurance: 'PROCESS_ATTESTED',
  observedEvidence: [],
  startedAt: NOW,
};

class StubRepository {
  readonly repositoryRoot = '/repository';
  readonly heads: string[];

  constructor(...heads: string[]) {
    this.heads = [...heads];
  }

  readHeadSha(): string {
    const head = this.heads.shift();
    if (head === undefined) throw new Error('Unexpected HEAD read');
    return head;
  }
}

class StubRunner implements VerificationCommandRunner {
  calls = 0;

  constructor(
    readonly result: VerificationCommandExecution = {
      startedAt: NOW,
      finishedAt: LATER,
      outcome: { kind: 'EXITED', exitCode: 0 },
      stdout: '876 tests passed',
      stderr: '',
    },
  ) {}

  execute(): Promise<VerificationCommandExecution> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

class MemoryLogStore implements VerificationLogStore {
  readonly contents = new Map<string, VerificationLogContent>();

  store(id: string, content: VerificationLogContent): StoredVerificationLog {
    const serialized = JSON.stringify(content);
    const existing = this.contents.get(id);
    if (existing !== undefined && JSON.stringify(existing) !== serialized) {
      throw new Error('immutable log conflict');
    }
    this.contents.set(id, content);
    return {
      location: `/logs/${id}.json`,
      contentHash: createHash('sha256').update(serialized).digest('hex'),
    };
  }
}

function policy(
  overrides: Partial<VerificationAttestationPolicy> = {},
): VerificationAttestationPolicy {
  return {
    policyConfigurationHash: POLICY_HASH,
    expectedVerificationConfigurationHash: CONFIGURATION_HASH,
    expectedCommitSha: SHA_A,
    approvedCommand: COMMAND,
    expectedToolVersion: 'pnpm 9.15.9',
    criterionPolicies: [
      {
        criterionId: 'criterion-tests',
        allowsAutomaticAcceptance: true,
        requiresIndependentAttestation: false,
      },
    ],
    parserAmbiguityRequiresJudgment: false,
    baselineComparison: false,
    ...overrides,
  };
}

describe('ReviewWorkflowVerificationService', () => {
  let db: Database.Database;
  let store: ReviewWorkflowStore;
  let runner: StubRunner;
  let logs: MemoryLogStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new ReviewWorkflowStore(db);
    runner = new StubRunner();
    logs = new MemoryLogStore();
    store.createWorkflow({
      workflowId: 'workflow-1',
      status: 'ACTIVE',
      generalPlanVersionId: 'general-plan-1',
      implementerAssignmentId: IMPLEMENTER_ASSIGNMENT_ID,
      reviewerAssignmentId: REVIEWER_ASSIGNMENT_ID,
      configurationHash: POLICY_HASH,
      createdAt: NOW,
      updatedAt: NOW,
    });
    store.createBatch({
      batchId: 'batch-1',
      workflowId: 'workflow-1',
      ordinal: 1,
      persistedState: 'VERIFYING',
      aggregateVersion: 1,
      currentPlanVersionId: 'batch-plan-1',
      implementerAssignmentId: IMPLEMENTER_ASSIGNMENT_ID,
      reviewerAssignmentId: REVIEWER_ASSIGNMENT_ID,
      originalBatchBaseSha: SHA_B,
      createdAt: NOW,
      updatedAt: NOW,
    });
    store.saveEntity({ kind: 'BATCH_PLAN_VERSION', value: BATCH_PLAN });
    for (const assignment of [IMPLEMENTER_ASSIGNMENT, REVIEWER_ASSIGNMENT]) {
      store.saveEntity({ kind: 'AGENT_ASSIGNMENT', value: assignment });
    }
    for (const actor of [
      HUMAN_EXECUTOR,
      IMPLEMENTER_EXECUTOR,
      REVIEWER_ATTESTOR,
      SYSTEM_ATTESTOR,
      HUMAN_ATTESTOR,
      CI_EXECUTOR,
    ]) {
      store.saveEntity({ kind: 'ACTOR_EXECUTION', value: actor });
    }
  });

  afterEach(() => db.close());

  function service(
    repository: VerificationRepository = new StubRepository(SHA_A, SHA_A),
  ): ReviewWorkflowVerificationService {
    return new ReviewWorkflowVerificationService(store, repository, runner, logs);
  }

  async function execute(
    executorActorExecutionId = HUMAN_EXECUTOR.actorExecutionId,
    repository: VerificationRepository = new StubRepository(SHA_A, SHA_A),
  ) {
    return service(repository).execute({
      verificationRecordId: `record-${executorActorExecutionId}`,
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      executorActorExecutionId,
      relatedFindingIds: [],
      configurationHash: CONFIGURATION_HASH,
      toolVersion: 'pnpm 9.15.9',
      command: COMMAND,
      expectedCommitSha: SHA_A,
      timeoutMs: 5_000,
    });
  }

  function attest(
    verificationRecordId: string,
    overrides: Partial<Parameters<ReviewWorkflowVerificationService['attest']>[0]> = {},
  ) {
    return service(new StubRepository()).attest({
      verificationAttestationId: `attestation-${verificationRecordId}`,
      verificationRecordId,
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      decision: 'ACCEPTED',
      acceptanceMode: 'AUTOMATIC_POLICY',
      rationale: 'The exact approved command passed.',
      attestorActorExecutionId: SYSTEM_ATTESTOR.actorExecutionId,
      currentHeadSha: SHA_A,
      policy: policy(),
      createdAt: LATER,
      ...overrides,
    });
  }

  it('persists a factual successful record and immutable full log without self-accepting it', async () => {
    const result = await execute();

    expect(result).toMatchObject({
      headShaBefore: SHA_A,
      headShaAfter: SHA_A,
      headUnchanged: true,
      record: {
        evidenceSource: 'CODEMOOT_EXECUTED',
        observedStatus: 'SUCCEEDED',
        commitSha: SHA_A,
        executorActorExecutionId: HUMAN_EXECUTOR.actorExecutionId,
        toolVersion: 'pnpm 9.15.9',
      },
    });
    expect(logs.contents.get(result.record.verificationRecordId)).toMatchObject({
      stdout: '876 tests passed',
      stderr: '',
    });
    expect(store.getEntity('VERIFICATION_ATTESTATION', 'anything')).toBeNull();
  });

  it('refuses to execute when a fresh repository read does not match the expected SHA', async () => {
    await expect(
      execute(HUMAN_EXECUTOR.actorExecutionId, new StubRepository(SHA_B)),
    ).rejects.toMatchObject({
      code: 'HEAD_MISMATCH',
    });
    expect(runner.calls).toBe(0);
  });

  it('retains a factual record if HEAD changes during execution but refuses stale acceptance', async () => {
    const result = await execute(HUMAN_EXECUTOR.actorExecutionId, new StubRepository(SHA_A, SHA_B));
    expect(result.headUnchanged).toBe(false);
    expect(() =>
      attest(result.record.verificationRecordId, { currentHeadSha: SHA_B }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowVerificationError>>({
        code: 'HEAD_MISMATCH',
      }),
    );
  });

  it('automatically accepts only exact, successful, CodeMoot-executed evidence', async () => {
    const result = await execute();
    const attestation = attest(result.record.verificationRecordId);

    expect(attestation).toMatchObject({
      decision: 'ACCEPTED',
      acceptanceMode: 'AUTOMATIC_POLICY',
      reviewedCommitSha: SHA_A,
      recordExecutorActorExecutionId: HUMAN_EXECUTOR.actorExecutionId,
    });
    expect(attestation.evidenceHash).toHaveLength(64);
  });

  it('denies automatic acceptance for external evidence', () => {
    const result = service(new StubRepository()).ingest({
      verificationRecordId: 'record-external',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      executorActorExecutionId: HUMAN_EXECUTOR.actorExecutionId,
      evidenceSource: 'EXTERNAL',
      command: COMMAND,
      commitSha: SHA_A,
      startedAt: NOW,
      finishedAt: LATER,
      outcome: { kind: 'EXITED', exitCode: 0 },
      stdout: 'external pass',
      stderr: '',
      relatedFindingIds: [],
      configurationHash: CONFIGURATION_HASH,
      toolVersion: 'pnpm 9.15.9',
    });

    expect(() => attest(result.record.verificationRecordId)).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowVerificationError>>({
        code: 'AUTOMATIC_ACCEPTANCE_DENIED',
      }),
    );
  });

  it('does not let an untyped ingest caller claim CodeMoot-executed provenance', () => {
    const verificationService = service(new StubRepository());
    expect(() =>
      Reflect.apply(verificationService.ingest, verificationService, [
        {
          verificationRecordId: 'record-forged-provenance',
          workflowId: 'workflow-1',
          batchId: 'batch-1',
          executorActorExecutionId: HUMAN_EXECUTOR.actorExecutionId,
          evidenceSource: 'CODEMOOT_EXECUTED',
          command: COMMAND,
          commitSha: SHA_A,
          startedAt: NOW,
          finishedAt: LATER,
          outcome: { kind: 'EXITED', exitCode: 0 },
          stdout: 'forged pass',
          stderr: '',
          relatedFindingIds: [],
          configurationHash: CONFIGURATION_HASH,
          toolVersion: 'pnpm 9.15.9',
        },
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowVerificationError>>({
        code: 'WORKFLOW_CONTEXT_INVALID',
      }),
    );
  });

  it('allows exact successful trusted-CI evidence to receive system policy acceptance', () => {
    const result = service(new StubRepository()).ingest({
      verificationRecordId: 'record-trusted-ci',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      executorActorExecutionId: CI_EXECUTOR.actorExecutionId,
      evidenceSource: 'TRUSTED_CI',
      command: COMMAND,
      commitSha: SHA_A,
      startedAt: NOW,
      finishedAt: LATER,
      outcome: { kind: 'EXITED', exitCode: 0 },
      stdout: 'trusted CI pass',
      stderr: '',
      relatedFindingIds: [],
      configurationHash: CONFIGURATION_HASH,
      toolVersion: 'pnpm 9.15.9',
    });

    expect(attest(result.record.verificationRecordId).acceptanceMode).toBe('AUTOMATIC_POLICY');
  });

  it('requires independent reviewer acceptance for implementer-only claims', async () => {
    const result = await execute(IMPLEMENTER_EXECUTOR.actorExecutionId);

    expect(() => attest(result.record.verificationRecordId)).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowVerificationError>>({
        code: 'AUTOMATIC_ACCEPTANCE_DENIED',
      }),
    );
    const reviewed = attest(result.record.verificationRecordId, {
      verificationAttestationId: 'attestation-reviewed-implementer',
      acceptanceMode: 'REVIEWER',
      attestorActorExecutionId: REVIEWER_ATTESTOR.actorExecutionId,
      rationale: 'Reviewer inspected the implementer-produced test evidence.',
    });
    expect(reviewed.decision).toBe('ACCEPTED');
  });

  it('never lets a browser executor accept its own evidence', () => {
    const result = service(new StubRepository()).ingest({
      verificationRecordId: 'record-browser',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      executorActorExecutionId: REVIEWER_ATTESTOR.actorExecutionId,
      evidenceSource: 'EXTERNAL',
      command: BROWSER_COMMAND,
      commitSha: SHA_A,
      startedAt: NOW,
      finishedAt: LATER,
      outcome: { kind: 'EXITED', exitCode: 0 },
      stdout: 'browser observation',
      stderr: '',
      relatedFindingIds: [],
      configurationHash: CONFIGURATION_HASH,
      toolVersion: 'browser 1',
    });

    expect(() =>
      attest(result.record.verificationRecordId, {
        acceptanceMode: 'REVIEWER',
        attestorActorExecutionId: REVIEWER_ATTESTOR.actorExecutionId,
        policy: policy({
          approvedCommand: BROWSER_COMMAND,
          expectedToolVersion: 'browser 1',
          criterionPolicies: [
            {
              criterionId: 'criterion-browser',
              allowsAutomaticAcceptance: false,
              requiresIndependentAttestation: true,
            },
          ],
        }),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowVerificationError>>({
        code: 'INDEPENDENT_ATTESTOR_REQUIRED',
      }),
    );
  });

  it('permits an independent human to accept a nonzero result with explicit judgment', () => {
    const result = service(new StubRepository()).ingest({
      verificationRecordId: 'record-failed',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      executorActorExecutionId: HUMAN_EXECUTOR.actorExecutionId,
      evidenceSource: 'EXTERNAL',
      command: COMMAND,
      commitSha: SHA_A,
      startedAt: NOW,
      finishedAt: LATER,
      outcome: { kind: 'EXITED', exitCode: 1 },
      stdout: '',
      stderr: 'known baseline failure',
      relatedFindingIds: [],
      configurationHash: CONFIGURATION_HASH,
      toolVersion: 'pnpm 9.15.9',
    });

    const attestation = attest(result.record.verificationRecordId, {
      acceptanceMode: 'HUMAN',
      attestorActorExecutionId: HUMAN_ATTESTOR.actorExecutionId,
      rationale: 'The failure is accepted after independent inspection.',
    });
    expect(attestation.decision).toBe('ACCEPTED');
  });

  it('rejects command, criterion, configuration, and commit policy mismatches', async () => {
    const result = await execute();
    for (const mismatchedPolicy of [
      policy({
        approvedCommand: BROWSER_COMMAND,
        expectedToolVersion: 'browser 1',
        criterionPolicies: [
          {
            criterionId: 'criterion-browser',
            allowsAutomaticAcceptance: false,
            requiresIndependentAttestation: true,
          },
        ],
      }),
      policy({ criterionPolicies: [] }),
      policy({ policyConfigurationHash: 'other-policy' }),
      policy({ expectedVerificationConfigurationHash: 'other-configuration' }),
      policy({ expectedCommitSha: SHA_B }),
    ]) {
      expect(() =>
        attest(result.record.verificationRecordId, { policy: mismatchedPolicy }),
      ).toThrowError(
        expect.objectContaining<Partial<ReviewWorkflowVerificationError>>({
          code: 'ATTESTATION_POLICY_MISMATCH',
        }),
      );
    }
  });

  it('rejects contradictory criterion acceptance policy', () => {
    expect(
      verificationAttestationPolicySchema.safeParse(
        policy({
          criterionPolicies: [
            {
              criterionId: 'criterion-tests',
              allowsAutomaticAcceptance: true,
              requiresIndependentAttestation: true,
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('refuses to execute a command that is absent from the durable batch plan', async () => {
    await expect(
      service().execute({
        verificationRecordId: 'record-unapproved',
        workflowId: 'workflow-1',
        batchId: 'batch-1',
        executorActorExecutionId: HUMAN_EXECUTOR.actorExecutionId,
        relatedFindingIds: [],
        configurationHash: CONFIGURATION_HASH,
        toolVersion: 'pnpm 9.15.9',
        command: { ...COMMAND, arguments: ['unapproved-command'] },
        expectedCommitSha: SHA_A,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_NOT_APPROVED' });
    expect(runner.calls).toBe(0);
  });

  it('requires durable executor and attestor authority evidence', async () => {
    store.saveEntity({
      kind: 'ACTOR_EXECUTION',
      value: {
        ...HUMAN_EXECUTOR,
        actorExecutionId: 'actor-without-authority',
        authoritiesExercised: ['WORKFLOW_OWNER'],
      },
    });
    await expect(execute('actor-without-authority')).rejects.toMatchObject({
      code: 'EXECUTOR_AUTHORITY_MISSING',
    });

    const result = await execute();
    expect(() =>
      attest(result.record.verificationRecordId, {
        acceptanceMode: 'HUMAN',
        attestorActorExecutionId: 'actor-without-authority',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowVerificationError>>({
        code: 'ATTESTOR_AUTHORITY_MISSING',
      }),
    );
  });

  it('has the persistence layer reject attestations that do not match their record', async () => {
    const result = await execute();
    const attestation = attest(result.record.verificationRecordId);

    expect(() =>
      store.saveEntity({
        kind: 'VERIFICATION_ATTESTATION',
        value: {
          ...attestation,
          verificationAttestationId: 'attestation-tampered',
          evidenceHash: 'tampered-record-hash',
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowPersistenceError>>({
        code: 'PERSISTED_DATA_INVALID',
      }),
    );
  });
});
