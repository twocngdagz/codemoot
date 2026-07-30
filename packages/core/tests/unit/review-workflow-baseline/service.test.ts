import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import {
  type ReviewWorkflowPersistenceError,
  ReviewWorkflowStore,
} from '../../../src/memory/review-workflow-store.js';
import {
  type BaselineArtifactStore,
  type BaselineFindingArtifact,
  BiomeJsonFindingNormalizer,
  type ReviewWorkflowBaselineError,
  ReviewWorkflowBaselineService,
  ReviewWorkflowBaselineStore,
  type StoredBaselineArtifact,
  type VerificationLogArtifact,
  type VerificationLogArtifactReader,
  hashBaselineValue,
} from '../../../src/review-workflow-baseline/index.js';
import { canonicalVerificationJson } from '../../../src/review-workflow-verification/index.js';
import type {
  ActorExecutionIdentity,
  AgentAssignment,
  VerificationRecord,
} from '../../../src/review-workflow/types.js';

const NOW = '2026-07-30T00:00:00.000Z';
const LATER = '2026-07-30T00:00:01.000Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const CONFIGURATION_HASH = 'biome-config-v1';
const IMPLEMENTER_ASSIGNMENT_ID = 'assignment-implementer';
const REVIEWER_ASSIGNMENT_ID = 'assignment-reviewer';

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

const IMPLEMENTER: ActorExecutionIdentity = {
  actorExecutionId: 'actor-implementer',
  actorType: 'AGENT',
  assignmentId: IMPLEMENTER_ASSIGNMENT_ID,
  authoritiesExercised: ['IMPLEMENTER', 'VERIFICATION_EXECUTOR'],
  identityAssurance: 'PROCESS_ATTESTED',
  observedEvidence: [],
  startedAt: NOW,
};

const REVIEWER: ActorExecutionIdentity = {
  actorExecutionId: 'actor-reviewer',
  actorType: 'AGENT',
  assignmentId: REVIEWER_ASSIGNMENT_ID,
  authoritiesExercised: ['REVIEWER', 'VERIFICATION_ATTESTOR'],
  identityAssurance: 'PROCESS_ATTESTED',
  observedEvidence: [],
  startedAt: NOW,
};

class MemoryLogReader implements VerificationLogArtifactReader {
  readonly logs = new Map<string, string>();

  read(location: string): string {
    const log = this.logs.get(location);
    if (log === undefined) throw new Error(`Missing log ${location}`);
    return log;
  }
}

class MemoryArtifactStore implements BaselineArtifactStore {
  readonly artifacts = new Map<string, string>();

  store(id: string, artifact: BaselineFindingArtifact): StoredBaselineArtifact {
    const serialized = `${canonicalVerificationJson(artifact)}\n`;
    const existing = this.artifacts.get(id);
    if (existing !== undefined && existing !== serialized) throw new Error('artifact conflict');
    this.artifacts.set(id, serialized);
    return {
      location: `/artifacts/${id}.json`,
      contentHash: createHash('sha256').update(serialized).digest('hex'),
    };
  }
}

class StubRepository {
  constructor(readonly head: string = SHA_B) {}

  readHeadSha(): string {
    return this.head;
  }
}

function biomeReport(ruleId: string, file = 'packages/core/src/example.ts'): string {
  return JSON.stringify({
    summary: {
      changed: 0,
      unchanged: 1,
      matches: 0,
      duration: { secs: 0, nanos: 1 },
      errors: 1,
      warnings: 0,
      skipped: 0,
      suggestedFixesSkipped: 0,
      diagnosticsNotPrinted: 0,
    },
    diagnostics: [
      {
        category: ruleId,
        severity: 'error',
        description: `Diagnostic for ${ruleId}.`,
        location: { path: { file }, span: null, sourceCode: null },
      },
    ],
    command: 'check',
  });
}

describe('ReviewWorkflowBaselineService', () => {
  let db: Database.Database;
  let workflowStore: ReviewWorkflowStore;
  let baselineStore: ReviewWorkflowBaselineStore;
  let logs: MemoryLogReader;
  let artifacts: MemoryArtifactStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    workflowStore = new ReviewWorkflowStore(db);
    baselineStore = new ReviewWorkflowBaselineStore(db);
    logs = new MemoryLogReader();
    artifacts = new MemoryArtifactStore();
    workflowStore.createWorkflow({
      workflowId: 'workflow-1',
      status: 'ACTIVE',
      generalPlanVersionId: 'general-plan-1',
      implementerAssignmentId: IMPLEMENTER_ASSIGNMENT_ID,
      reviewerAssignmentId: REVIEWER_ASSIGNMENT_ID,
      configurationHash: 'workflow-configuration',
      createdAt: NOW,
      updatedAt: NOW,
    });
    workflowStore.createBatch({
      batchId: 'batch-1',
      workflowId: 'workflow-1',
      ordinal: 1,
      persistedState: 'VERIFYING',
      aggregateVersion: 1,
      currentPlanVersionId: 'batch-plan-1',
      implementerAssignmentId: IMPLEMENTER_ASSIGNMENT_ID,
      reviewerAssignmentId: REVIEWER_ASSIGNMENT_ID,
      originalBatchBaseSha: SHA_A,
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (const assignment of [IMPLEMENTER_ASSIGNMENT, REVIEWER_ASSIGNMENT]) {
      workflowStore.saveEntity({ kind: 'AGENT_ASSIGNMENT', value: assignment });
    }
    for (const actor of [IMPLEMENTER, REVIEWER]) {
      workflowStore.saveEntity({ kind: 'ACTOR_EXECUTION', value: actor });
    }
  });

  afterEach(() => db.close());

  function service(repository = new StubRepository()): ReviewWorkflowBaselineService {
    return new ReviewWorkflowBaselineService(
      workflowStore,
      baselineStore,
      new BiomeJsonFindingNormalizer(),
      logs,
      artifacts,
      repository,
    );
  }

  function saveRecord(input: {
    readonly id: string;
    readonly sha: string;
    readonly output: string;
    readonly toolVersion?: string;
    readonly configurationHash?: string;
  }): VerificationRecord {
    const location = `/logs/${input.id}.json`;
    const log: VerificationLogArtifact = {
      schemaVersion: 1,
      command: 'pnpm',
      arguments: ['lint', '--reporter=json'],
      workingDirectory: '/repository',
      startedAt: NOW,
      finishedAt: LATER,
      outcome: { kind: 'EXITED', exitCode: 1 },
      stdout: input.output,
      stderr: '',
    };
    const serialized = `${JSON.stringify(log, null, 2)}\n`;
    logs.logs.set(location, serialized);
    const record: VerificationRecord = {
      verificationRecordId: input.id,
      command: log.command,
      arguments: log.arguments,
      workingDirectory: log.workingDirectory,
      startedAt: log.startedAt,
      finishedAt: log.finishedAt,
      outcome: log.outcome,
      outputSummary: 'Biome findings',
      fullLogLocation: location,
      fullLogHash: createHash('sha256').update(serialized).digest('hex'),
      relatedCriterionIds: ['criterion-lint'],
      relatedFindingIds: [],
      commitSha: input.sha,
      executorActorExecutionId: IMPLEMENTER.actorExecutionId,
      executorActorType: IMPLEMENTER.actorType,
      executorAssignmentId: IMPLEMENTER.assignmentId,
      evidenceSource: 'CODEMOOT_EXECUTED',
      verificationType: 'static_analysis',
      toolVersion: input.toolVersion ?? '1.9.4',
      configurationHash: input.configurationHash ?? CONFIGURATION_HASH,
      observedStatus: 'FAILED',
    };
    workflowStore.saveEntity({
      kind: 'VERIFICATION_RECORD',
      workflowId: 'workflow-1',
      batchId: 'batch-1',
      value: record,
    });
    return record;
  }

  function captureAndApprove(ruleId = 'lint/style/useTemplate') {
    saveRecord({ id: 'record-baseline', sha: SHA_A, output: biomeReport(ruleId) });
    const baseline = service().captureBaseline({
      baselineId: 'baseline-1',
      workflowId: 'workflow-1',
      verificationRecordId: 'record-baseline',
      configurationInputPaths: ['biome.json'],
      captureActorExecutionId: IMPLEMENTER.actorExecutionId,
      createdAt: NOW,
    });
    const approval = service().approveBaseline({
      baselineApprovalId: 'baseline-approval-1',
      baselineId: baseline.baselineId,
      reviewerActorExecutionId: REVIEWER.actorExecutionId,
      decision: 'ACCEPTED',
      rationale: 'The pinned Biome report and normalized findings are trustworthy.',
      createdAt: LATER,
    });
    return { baseline, approval };
  }

  it('captures immutable normalized findings from a hash-bound verification log', () => {
    const { baseline } = captureAndApprove();

    expect(baseline).toMatchObject({
      baselineCommitSha: SHA_A,
      toolName: 'biome',
      toolVersion: '1.9.4',
      configurationInputPaths: ['biome.json'],
      findingCount: 1,
      reviewerApprovalStatus: 'PENDING',
      normalizedFindings: [
        expect.objectContaining({
          ruleId: 'lint/style/useTemplate',
          repositoryRelativePath: 'packages/core/src/example.ts',
        }),
      ],
    });
    expect(baseline.normalizedFindingsHash).toHaveLength(64);
    expect(baselineStore.getBaseline('baseline-1')).toEqual(baseline);
  });

  it('fails a same-count comparison when the current multiset introduces a finding', () => {
    const { baseline, approval } = captureAndApprove();
    saveRecord({
      id: 'record-current',
      sha: SHA_B,
      output: biomeReport('lint/suspicious/noExplicitAny'),
    });

    const comparison = service().compare({
      comparisonId: 'comparison-1',
      baselineId: baseline.baselineId,
      baselineApprovalId: approval.baselineApprovalId,
      currentVerificationRecordId: 'record-current',
      currentConfigurationInputPaths: ['biome.json'],
      captureActorExecutionId: IMPLEMENTER.actorExecutionId,
      createdAt: LATER,
    });

    expect(comparison).toMatchObject({
      result: 'FAILED',
      currentFindingCount: 1,
      introduced: [expect.objectContaining({ ruleId: 'lint/suspicious/noExplicitAny' })],
      resolved: [expect.objectContaining({ ruleId: 'lint/style/useTemplate' })],
      unchanged: [],
    });
    expect(() =>
      baselineStore.saveComparison({
        ...comparison,
        comparisonId: 'forged-comparison',
        result: 'PASSED',
        introduced: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowPersistenceError>>({
        code: 'PERSISTED_DATA_INVALID',
      }),
    );
  });

  it('passes when the current finding multiset contains no introduced findings', () => {
    const { baseline, approval } = captureAndApprove();
    saveRecord({
      id: 'record-current',
      sha: SHA_B,
      output: biomeReport('lint/style/useTemplate'),
    });

    const comparison = service().compare({
      comparisonId: 'comparison-1',
      baselineId: baseline.baselineId,
      baselineApprovalId: approval.baselineApprovalId,
      currentVerificationRecordId: 'record-current',
      currentConfigurationInputPaths: ['biome.json'],
      captureActorExecutionId: IMPLEMENTER.actorExecutionId,
      createdAt: LATER,
    });
    const attestation = service().attestComparison({
      comparisonAttestationId: 'comparison-attestation-1',
      comparisonId: comparison.comparisonId,
      reviewerActorExecutionId: REVIEWER.actorExecutionId,
      decision: 'ACCEPTED',
      rationale: 'The baseline is comparable and no new normalized findings were introduced.',
      baselineTrustworthy: true,
      toolVersionAndConfigurationComparable: true,
      introducedSetEmpty: true,
      normalizationReviewed: true,
      createdAt: LATER,
    });

    expect(comparison).toMatchObject({
      result: 'PASSED',
      introduced: [],
      resolved: [],
      unchanged: [expect.objectContaining({ ruleId: 'lint/style/useTemplate' })],
    });
    expect(attestation).toMatchObject({
      decision: 'ACCEPTED',
      reviewedCommitSha: SHA_B,
      reviewerAssignmentId: REVIEWER_ASSIGNMENT_ID,
    });
  });

  it('records tool, configuration, command, and normalizer drift as non-comparable', () => {
    const { baseline, approval } = captureAndApprove();
    saveRecord({
      id: 'record-current',
      sha: SHA_B,
      output: biomeReport('lint/style/useTemplate'),
      toolVersion: '2.0.0',
      configurationHash: 'biome-config-v2',
    });

    const comparison = service().compare({
      comparisonId: 'comparison-1',
      baselineId: baseline.baselineId,
      baselineApprovalId: approval.baselineApprovalId,
      currentVerificationRecordId: 'record-current',
      currentConfigurationInputPaths: ['biome-v2.json'],
      captureActorExecutionId: IMPLEMENTER.actorExecutionId,
      createdAt: LATER,
    });

    expect(comparison).toEqual(
      expect.objectContaining({
        result: 'INCOMPARABLE',
        incompatibilities: [
          'TOOL_VERSION_MISMATCH',
          'CONFIGURATION_INPUTS_MISMATCH',
          'CONFIGURATION_HASH_MISMATCH',
        ],
      }),
    );
    expect(artifacts.artifacts.has('comparison:comparison-1')).toBe(false);
  });

  it('requires an accepted reviewer approval before comparison', () => {
    saveRecord({
      id: 'record-baseline',
      sha: SHA_A,
      output: biomeReport('lint/style/useTemplate'),
    });
    const baseline = service().captureBaseline({
      baselineId: 'baseline-1',
      workflowId: 'workflow-1',
      verificationRecordId: 'record-baseline',
      configurationInputPaths: ['biome.json'],
      captureActorExecutionId: IMPLEMENTER.actorExecutionId,
      createdAt: NOW,
    });
    const approval = service().approveBaseline({
      baselineApprovalId: 'baseline-approval-1',
      baselineId: baseline.baselineId,
      reviewerActorExecutionId: REVIEWER.actorExecutionId,
      decision: 'REJECTED',
      rationale: 'The capture is not trustworthy.',
      createdAt: LATER,
    });
    saveRecord({
      id: 'record-current',
      sha: SHA_B,
      output: biomeReport('lint/style/useTemplate'),
    });

    expect(() =>
      service().compare({
        comparisonId: 'comparison-1',
        baselineId: baseline.baselineId,
        baselineApprovalId: approval.baselineApprovalId,
        currentVerificationRecordId: 'record-current',
        currentConfigurationInputPaths: ['biome.json'],
        captureActorExecutionId: IMPLEMENTER.actorExecutionId,
        createdAt: LATER,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowBaselineError>>({
        code: 'BASELINE_APPROVAL_REQUIRED',
      }),
    );
  });

  it('refuses acceptance of a comparison that introduced findings', () => {
    const { baseline, approval } = captureAndApprove();
    saveRecord({
      id: 'record-current',
      sha: SHA_B,
      output: biomeReport('lint/suspicious/noExplicitAny'),
    });
    const comparison = service().compare({
      comparisonId: 'comparison-1',
      baselineId: baseline.baselineId,
      baselineApprovalId: approval.baselineApprovalId,
      currentVerificationRecordId: 'record-current',
      currentConfigurationInputPaths: ['biome.json'],
      captureActorExecutionId: IMPLEMENTER.actorExecutionId,
      createdAt: LATER,
    });

    expect(() =>
      service().attestComparison({
        comparisonAttestationId: 'comparison-attestation-1',
        comparisonId: comparison.comparisonId,
        reviewerActorExecutionId: REVIEWER.actorExecutionId,
        decision: 'ACCEPTED',
        rationale: 'Invalid acceptance attempt.',
        baselineTrustworthy: true,
        toolVersionAndConfigurationComparable: true,
        introducedSetEmpty: false,
        normalizationReviewed: true,
        createdAt: LATER,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowBaselineError>>({
        code: 'COMPARISON_NOT_ACCEPTABLE',
      }),
    );
    expect(() =>
      baselineStore.saveComparisonAttestation({
        comparisonAttestationId: 'forged-attestation',
        comparisonId: comparison.comparisonId,
        comparisonEvidenceHash: hashBaselineValue(comparison),
        workflowId: comparison.workflowId,
        batchId: comparison.batchId,
        baselineId: comparison.baselineId,
        baselineApprovalId: comparison.baselineApprovalId,
        decision: 'ACCEPTED',
        rationale: 'Attempt to bypass the service guard.',
        baselineTrustworthy: true,
        toolVersionAndConfigurationComparable: true,
        introducedSetEmpty: true,
        normalizationReviewed: true,
        reviewerActorExecutionId: REVIEWER.actorExecutionId,
        reviewerAssignmentId: REVIEWER_ASSIGNMENT_ID,
        authorityExercised: 'VERIFICATION_ATTESTOR',
        reviewedCommitSha: comparison.currentCommitSha,
        createdAt: LATER,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowPersistenceError>>({
        code: 'PERSISTED_DATA_INVALID',
      }),
    );
  });

  it('refuses acceptance when the compared commit is no longer repository HEAD', () => {
    const { baseline, approval } = captureAndApprove();
    saveRecord({
      id: 'record-current',
      sha: SHA_B,
      output: biomeReport('lint/style/useTemplate'),
    });
    const comparison = service().compare({
      comparisonId: 'comparison-1',
      baselineId: baseline.baselineId,
      baselineApprovalId: approval.baselineApprovalId,
      currentVerificationRecordId: 'record-current',
      currentConfigurationInputPaths: ['biome.json'],
      captureActorExecutionId: IMPLEMENTER.actorExecutionId,
      createdAt: LATER,
    });

    expect(() =>
      service(new StubRepository(SHA_A)).attestComparison({
        comparisonAttestationId: 'comparison-attestation-1',
        comparisonId: comparison.comparisonId,
        reviewerActorExecutionId: REVIEWER.actorExecutionId,
        decision: 'ACCEPTED',
        rationale: 'The finding set is clean, but this evidence is stale.',
        baselineTrustworthy: true,
        toolVersionAndConfigurationComparable: true,
        introducedSetEmpty: true,
        normalizationReviewed: true,
        createdAt: LATER,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowBaselineError>>({
        code: 'HEAD_MISMATCH',
      }),
    );
  });

  it('rejects tampered log content before normalization', () => {
    const record = saveRecord({
      id: 'record-baseline',
      sha: SHA_A,
      output: biomeReport('lint/style/useTemplate'),
    });
    logs.logs.set(record.fullLogLocation, 'tampered');

    expect(() =>
      service().captureBaseline({
        baselineId: 'baseline-1',
        workflowId: 'workflow-1',
        verificationRecordId: record.verificationRecordId,
        configurationInputPaths: ['biome.json'],
        captureActorExecutionId: IMPLEMENTER.actorExecutionId,
        createdAt: NOW,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowBaselineError>>({
        code: 'VERIFICATION_LOG_HASH_MISMATCH',
      }),
    );
  });

  it('enforces immutable baseline and comparison audit rows at the database boundary', () => {
    const { baseline, approval } = captureAndApprove();
    expect(() =>
      baselineStore.saveBaseline({ ...baseline, toolName: 'different-tool' }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowPersistenceError>>({
        code: 'IMMUTABLE_ENTITY_CONFLICT',
      }),
    );
    expect(() =>
      db
        .prepare(
          `UPDATE review_workflow_verification_baselines
           SET tool_version = 'changed'
           WHERE baseline_id = 'baseline-1'`,
        )
        .run(),
    ).toThrow('immutable');
    expect(() =>
      db
        .prepare(
          `DELETE FROM review_workflow_verification_baseline_approvals
           WHERE baseline_approval_id = ?`,
        )
        .run(approval.baselineApprovalId),
    ).toThrow('immutable');
  });
});
