import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/schema.js';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowCommandStore } from '../../../src/memory/review-workflow-command-store.js';
import type { BridgeCallResult, CliBridge } from '../../../src/models/bridge.js';
import { ReviewWorkflowContractService } from '../../../src/review-workflow-contracts/service.js';
import {
  ReviewWorkflowGateService,
  deriveFinalAuditRangeEvidenceId,
} from '../../../src/review-workflow-gate/service.js';
import { ReviewWorkflowGateStore } from '../../../src/review-workflow-gate/store.js';
import { ReviewWorkflowGateError } from '../../../src/review-workflow-gate/types.js';
import { LocalGitRepository } from '../../../src/review-workflow-git/local-git-repository.js';
import { ReviewWorkflowGitService } from '../../../src/review-workflow-git/service.js';
import { createReviewWorkflowConfigurationSnapshot } from '../../../src/review-workflow-identity/service.js';
import type { ReviewWorkflowConfigurationSnapshot } from '../../../src/review-workflow-identity/types.js';
import { deriveCodeReviewRoundId } from '../../../src/review-workflow-implementation/code-review.js';
import { ReviewWorkflowCodeReviewService } from '../../../src/review-workflow-implementation/code-review.js';
import {
  ReviewWorkflowImplementationService,
  deriveImplementationAttemptId,
  deriveImplementationReadyEvidenceId,
} from '../../../src/review-workflow-implementation/service.js';
import { hashVerificationRecord } from '../../../src/review-workflow-verification/hash.js';
import type {
  ActorExecutionIdentity,
  BatchPlanVersion,
  ReviewWorkflowBatch,
  VerificationRecord,
  WorkflowRun,
} from '../../../src/review-workflow/types.js';
import type {
  PreparedRoleInvocation,
  RoleInvocationInput,
} from '../../../src/roles/role-invocation.js';
import type { ResolvedRoleAdapter } from '../../../src/roles/role-manager.js';

const NOW = '2026-07-30T12:00:00.000Z';
const LATER = '2026-07-30T12:01:00.000Z';
const BATCH_ID = 'batch-12';
const MERGE_SHA = 'a'.repeat(40);

function git(repositoryRoot: string, arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFile(
  repositoryRoot: string,
  path: string,
  content: string,
  message: string,
): string {
  const absolutePath = join(repositoryRoot, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  git(repositoryRoot, ['add', '--', path]);
  git(repositoryRoot, ['commit', '-m', message]);
  return git(repositoryRoot, ['rev-parse', 'HEAD']);
}

function configuration(): ReviewWorkflowConfigurationSnapshot {
  return createReviewWorkflowConfigurationSnapshot(
    validateConfig({
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
    }),
    {
      workflowId: 'workflow-12',
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      assignedAt: NOW,
    },
  );
}

const UNUSED_ADAPTER: CliBridge = {
  name: 'claude',
  model: 'claude-supported',
  capabilities: {
    supportsResume: true,
    supportsStream: false,
    maxContextTokens: 100_000,
    supportsTools: true,
    supportsCwd: true,
  },
  async send() {
    throw new Error('The fake role invoker does not call the adapter');
  },
  async resume() {
    throw new Error('The fake role invoker does not call the adapter');
  },
};

interface QueuedInvocation {
  readonly text?: string;
  readonly fromPrompt?: (prompt: string) => string;
  readonly mutateRepository?: () => void;
}

class FakeRoleInvoker {
  private readonly queue: QueuedInvocation[] = [];
  private invocationCounter = 0;

  constructor(private readonly store: ReviewWorkflowGateStore) {}

  enqueue(invocation: QueuedInvocation): void {
    this.queue.push(invocation);
  }

  async prepare(input: RoleInvocationInput): Promise<PreparedRoleInvocation> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error('No fake role invocation was queued');
    next.mutateRepository?.();
    this.invocationCounter += 1;
    const role = input.resolution.role === 'implementer' ? 'IMPLEMENTER' : 'REVIEWER';
    const resumed = input.previousSessionIdentityId !== undefined;
    const sessionIdentityId = input.previousSessionIdentityId ?? input.sessionIdentityId;
    const vendorSessionId = `vendor-${input.resolution.role}-session`;
    const providerOrAdapter = input.resolution.role === 'implementer' ? 'claude' : 'codex';
    const responseText =
      next.fromPrompt !== undefined ? next.fromPrompt(input.prompt) : (next.text ?? '');
    const call: BridgeCallResult = {
      text: responseText,
      model: input.resolution.assignment.configuredModel,
      provider: input.resolution.assignment.provider,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0 },
      finishReason: 'stop',
      durationMs: 100,
      meteringSource: 'sdk',
      sessionId: vendorSessionId,
    };
    return {
      call,
      assignment: input.resolution.assignment,
      resumed,
      invocation: {
        invocationId: input.invocationId,
        commandId: input.commandId,
        actorMechanism: `fake-${providerOrAdapter}-cli`,
        adapterKind: input.resolution.assignment.expectedAdapterKind,
        configuredModel: input.resolution.assignment.configuredModel,
        workingDirectory: '/repository',
        processId: 100 + this.invocationCounter,
        processInstanceFingerprint: 'f'.repeat(64),
        startedAt: NOW,
        finishedAt: LATER,
        resultStatus: 'SUCCEEDED',
      },
      session: {
        sessionIdentityId,
        workflowId: input.workflowId,
        providerOrAdapter,
        vendorSessionId,
        creatingInvocationId: resumed ? `${sessionIdentityId}:creator` : input.invocationId,
        resumeLineage: [],
        assignedRole: role,
        createdAt: NOW,
        lastUsedAt: LATER,
      },
      execution: {
        actorExecutionId: input.actorExecutionId,
        actorType: 'AGENT',
        assignmentId: input.resolution.assignment.assignmentId,
        invocationIdentityId: input.invocationId,
        sessionIdentityId,
        authoritiesExercised: [role, ...(input.additionalAuthorities ?? [])],
        identityAssurance: 'PROCESS_ATTESTED',
        observedEvidence: [],
        startedAt: NOW,
        finishedAt: LATER,
      },
    };
  }

  persistPrepared(prepared: PreparedRoleInvocation): void {
    this.store.workflowStore.saveRoleInvocation({
      assignment: prepared.assignment,
      invocation: prepared.invocation,
      ...(prepared.resumed
        ? { reusedSessionIdentityId: prepared.session.sessionIdentityId }
        : { session: prepared.session }),
      execution: prepared.execution,
    });
  }
}

function createExternalMergeCommit(repositoryRoot: string, parentSha: string): string {
  const tree = git(repositoryRoot, ['rev-parse', `${parentSha}^{tree}`]);
  return git(repositoryRoot, ['commit-tree', tree, '-p', parentSha, '-m', 'external merge']);
}

function implementationTranscript(changedFiles: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    contractKind: 'IMPLEMENTATION_RESULT',
    outcome: 'COMPLETE',
    summary: 'Implemented the approved batch.',
    changedFiles,
    verificationRecordIds: [],
  });
}

function reviewTranscript(input: {
  readonly reviewedCommitSha: string;
  readonly reviewRangeEvidenceId: string;
  readonly patchHash: string;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    contractKind: 'REVIEW_RESULT',
    target: {
      kind: 'CODE',
      reviewedCommitSha: input.reviewedCommitSha,
      repositoryContextSha: input.reviewedCommitSha,
      reviewRangeEvidenceId: input.reviewRangeEvidenceId,
      patchHash: input.patchHash,
    },
    verdict: 'APPROVED',
    summary: 'Complete consolidated review.',
    findings: [],
  });
}

interface FinalAuditTranscriptInput {
  readonly target: unknown;
  readonly acceptanceCriterionIds: readonly string[];
  readonly verdict?: 'APPROVED' | 'NEEDS_REVISION';
  readonly scopeComplete?: boolean;
  readonly documentationComplete?: boolean;
  readonly highFindingKeys?: readonly string[];
}

function finalAuditTranscript(input: FinalAuditTranscriptInput): string {
  const check = (subjectId: string) => ({
    subjectId,
    status: 'PASSED',
    explanation: 'Verified against the final-gate diff.',
    evidence: [{ kind: 'FILE', location: 'src/example.txt', description: 'Audited evidence.' }],
  });
  return JSON.stringify({
    schemaVersion: 1,
    contractKind: 'FINAL_AUDIT_RESULT',
    target: input.target,
    verdict: input.verdict ?? 'APPROVED',
    summary: 'Complete final completeness audit.',
    findings: (input.highFindingKeys ?? []).map((key) => ({
      findingKey: key,
      severity: 'high',
      category: 'correctness',
      title: `Finding ${key}`,
      description: 'A complete audited defect description.',
      repositoryEvidence: [
        { kind: 'FILE', location: 'src/example.txt', description: 'Audit evidence.' },
      ],
      affectedFiles: ['src/example.txt'],
      expectedResult: 'Expected behaviour holds.',
      observedResult: 'Observed behaviour differs.',
      requiredAction: 'Correct the defect.',
    })),
    requirementChecks: [],
    acceptanceCriterionChecks: input.acceptanceCriterionIds.map(check),
    scopeComplete: input.scopeComplete ?? true,
    documentationComplete: input.documentationComplete ?? true,
  });
}

describe('ReviewWorkflowGateService', () => {
  let db: Database.Database;
  let repositoryRoot: string;
  let baseSha: string;
  let snapshot: ReviewWorkflowConfigurationSnapshot;
  let store: ReviewWorkflowGateStore;
  let commandStore: ReviewWorkflowCommandStore;
  let repository: LocalGitRepository;
  let roleInvoker: FakeRoleInvoker;
  let implementationService: ReviewWorkflowImplementationService;
  let codeReviewService: ReviewWorkflowCodeReviewService;
  let gateService: ReviewWorkflowGateService;
  let implementerResolution: ResolvedRoleAdapter;
  let reviewerResolution: ResolvedRoleAdapter;
  let planVerificationCommands: BatchPlanVersion['verificationCommands'];
  let auditCounter: number;

  function build(): void {
    snapshot = configuration();
    store = new ReviewWorkflowGateStore(db);
    commandStore = new ReviewWorkflowCommandStore(db, () => new Date(LATER));
    repository = new LocalGitRepository(repositoryRoot);
    roleInvoker = new FakeRoleInvoker(store);
    implementerResolution = {
      role: 'implementer',
      assignment: snapshot.assignments.implementer,
      adapter: UNUSED_ADAPTER,
    };
    reviewerResolution = {
      role: 'reviewer',
      assignment: snapshot.assignments.reviewer,
      adapter: { ...UNUSED_ADAPTER, name: 'codex', model: 'codex-supported' },
    };
    const workflow: WorkflowRun = {
      workflowId: snapshot.workflowId,
      status: 'ACTIVE',
      generalPlanVersionId: 'general-plan-12',
      implementerAssignmentId: snapshot.assignments.implementer.assignmentId,
      reviewerAssignmentId: snapshot.assignments.reviewer.assignmentId,
      configurationHash: snapshot.configurationHash,
      refinedPlanVersionId: 'refined-plan-12',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const planAuthor: ActorExecutionIdentity = {
      actorExecutionId: 'plan-author',
      actorType: 'HUMAN',
      authoritiesExercised: ['PLAN_REFINER'],
      identityAssurance: 'CLI_ASSERTED',
      observedEvidence: [],
      startedAt: NOW,
    };
    const plan: BatchPlanVersion = {
      batchPlanVersionId: 'batch-plan-12',
      workflowId: workflow.workflowId,
      batchId: BATCH_ID,
      version: 1,
      contentHash: 'plan-content-hash',
      repositoryContextSha: baseSha,
      objective: 'Implement and gate the complete approved batch.',
      currentRepositoryEvidence: [
        { kind: 'FILE', location: 'src/example.txt', description: 'Current target.' },
      ],
      dependencies: [],
      candidateFiles: ['src/example.txt'],
      technicalImplementation: ['Update the implementation target.'],
      userJourney: ['The operator runs the batch lifecycle through the merge gate.'],
      expectedBehaviour: ['The batch reaches MERGED only through the full gate.'],
      technicalAcceptanceCriteria: ['criterion-required'],
      userFacingAcceptanceCriteria: [],
      cliAcceptanceCriteria: [],
      browserAcceptanceCriteria: {
        applicability: 'NOT_APPLICABLE',
        reason: 'No browser behavior.',
      },
      verificationCommands: planVerificationCommands,
      manualVerification: [],
      documentationChanges: [],
      outOfScope: ['Hosting-provider merge automation.'],
      rollbackBoundary: 'Revert the implementation commit.',
      addressedFindingIds: [],
      actorExecutionId: planAuthor.actorExecutionId,
      createdAt: NOW,
    };
    const batch: ReviewWorkflowBatch = {
      batchId: BATCH_ID,
      workflowId: workflow.workflowId,
      ordinal: 12,
      persistedState: 'APPROVED_FOR_IMPLEMENTATION',
      aggregateVersion: 0,
      currentPlanVersionId: plan.batchPlanVersionId,
      implementerAssignmentId: workflow.implementerAssignmentId,
      reviewerAssignmentId: workflow.reviewerAssignmentId,
      createdAt: NOW,
      updatedAt: NOW,
    };
    store.workflowStore.createWorkflow(workflow);
    store.workflowStore.saveEntity({
      kind: 'AGENT_ASSIGNMENT',
      value: snapshot.assignments.implementer,
    });
    store.workflowStore.saveEntity({
      kind: 'AGENT_ASSIGNMENT',
      value: snapshot.assignments.reviewer,
    });
    store.workflowStore.saveEntity({ kind: 'ACTOR_EXECUTION', value: planAuthor });
    store.workflowStore.createBatch(batch);
    store.workflowStore.saveEntity({ kind: 'BATCH_PLAN_VERSION', value: plan });
    store.workflowStore.saveEntity({
      kind: 'ACCEPTANCE_CRITERION',
      value: {
        acceptanceCriterionId: 'criterion-required',
        batchPlanVersionId: plan.batchPlanVersionId,
        kind: 'TECHNICAL',
        statement: 'The merge-blocking technical criterion holds.',
        required: true,
        passCondition: 'Verified by an accepted verification record.',
        status: 'PENDING',
        sourceRequirementIds: [],
        createdAt: NOW,
      },
    });
    const gitService = new ReviewWorkflowGitService(repository, {
      storePatch: (artifact) => `memory://patch/${artifact.kind}/${artifact.patchHash}`,
    });
    const contractService = new ReviewWorkflowContractService(store.workflowStore);
    implementationService = new ReviewWorkflowImplementationService(
      store,
      commandStore,
      contractService,
      gitService,
      repository,
      roleInvoker,
      () => new Date(LATER),
    );
    codeReviewService = new ReviewWorkflowCodeReviewService(
      store,
      commandStore,
      contractService,
      gitService,
      repository,
      roleInvoker,
      () => new Date(LATER),
    );
    gateService = new ReviewWorkflowGateService(
      store,
      commandStore,
      contractService,
      gitService,
      repository,
      roleInvoker,
      () => new Date(LATER),
    );
  }

  beforeEach(() => {
    planVerificationCommands = [];
    auditCounter = 0;
    repositoryRoot = mkdtempSync(join(tmpdir(), 'codemoot-gate-'));
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.name', 'CodeMoot Test']);
    git(repositoryRoot, ['config', 'user.email', 'codemoot@example.com']);
    baseSha = commitFile(repositoryRoot, 'src/example.txt', 'base\n', 'base');
    db = openDatabase(':memory:');
    build();
  });

  afterEach(() => {
    db.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  });

  async function reachVerifying(): Promise<string> {
    roleInvoker.enqueue({ text: 'READY' });
    await implementationService.start({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      resolution: implementerResolution,
      commandId: `${BATCH_ID}:start-implementation`,
      actorExecutionId: 'actor-preflight',
      invocationId: 'invocation-preflight',
      sessionIdentityId: 'session-implementer',
      prompt: 'Return READY.',
    });
    const attemptId = deriveImplementationAttemptId(BATCH_ID, 1);
    roleInvoker.enqueue({
      text: implementationTranscript(['src/example.txt']),
      mutateRepository: () => {
        commitFile(repositoryRoot, 'src/example.txt', 'implemented\n', 'implementation 1');
      },
    });
    const executed = await implementationService.execute({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      resolution: implementerResolution,
      commandId: `${attemptId}:ready`,
      actorExecutionId: 'actor-implementation-1',
      invocationId: 'invocation-implementation-1',
      sessionIdentityId: 'session-implementer',
      previousSessionIdentityId: 'session-implementer',
      transcriptId: 'implementation-transcript-1',
      implementationAttemptId: attemptId,
      implementationReadyEvidenceId: deriveImplementationReadyEvidenceId(attemptId),
      attemptNumber: 1,
      creationMode: 'AGENT_AUTHORIZED',
      prompt: 'Implement the batch.',
    });
    expect(executed.status).toBe('AWAITING_COMMIT');
    const head = git(repositoryRoot, ['rev-parse', 'HEAD']);
    implementationService.complete({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      implementationAttemptId: attemptId,
      implementationReadyEvidenceId: deriveImplementationReadyEvidenceId(attemptId),
      providedCommitSha: head,
      creationMode: 'AGENT_AUTHORIZED',
      commandId: `${attemptId}:complete`,
    });
    roleInvoker.enqueue({
      fromPrompt: (prompt) => {
        const parsed = JSON.parse(prompt) as {
          target: { reviewedCommitSha: string; reviewRangeEvidenceId: string; patchHash: string };
        };
        return reviewTranscript(parsed.target);
      },
    });
    const review = await codeReviewService.review({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      resolution: reviewerResolution,
      commandId: `${BATCH_ID}:code-review-1`,
      actorExecutionId: 'actor-review-1',
      invocationId: 'invocation-review-1',
      sessionIdentityId: 'session-reviewer',
      transcriptId: 'review-transcript-1',
      reviewRoundId: deriveCodeReviewRoundId(BATCH_ID, 1),
      buildPrompt: (evidence) => JSON.stringify({ target: evidence.target }),
    });
    expect(review.status).toBe('VERIFYING');
    return head;
  }

  function persistAcceptedVerification(
    commitSha: string,
    options?: {
      readonly decision?: 'ACCEPTED' | 'REJECTED';
      readonly criterionIds?: readonly string[];
      readonly command?: { readonly executable: string; readonly arguments: readonly string[] };
      readonly acceptanceMode?: 'HUMAN' | 'AUTOMATIC_POLICY';
    },
  ): VerificationRecord {
    const record: VerificationRecord = {
      verificationRecordId: `record-${commitSha.slice(0, 8)}-${options?.decision ?? 'ACCEPTED'}`,
      command: options?.command?.executable ?? 'pnpm',
      arguments: [...(options?.command?.arguments ?? ['test'])],
      workingDirectory: '.',
      startedAt: NOW,
      finishedAt: LATER,
      outcome: { kind: 'EXITED', exitCode: 0 },
      outputSummary: 'All checks passed.',
      fullLogLocation: 'memory://verification/log',
      fullLogHash: 'b'.repeat(64),
      relatedCriterionIds: [...(options?.criterionIds ?? ['criterion-required'])],
      relatedFindingIds: [],
      commitSha,
      executorActorExecutionId: 'plan-author',
      executorActorType: 'HUMAN',
      verificationType: 'test',
      configurationHash: snapshot.configurationHash,
      observedStatus: 'SUCCEEDED',
    };
    store.workflowStore.saveEntity({
      kind: 'VERIFICATION_RECORD',
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      value: record,
    });
    store.workflowStore.saveEntity({
      kind: 'VERIFICATION_ATTESTATION',
      value: {
        verificationAttestationId: `${record.verificationRecordId}:attestation`,
        verificationRecordId: record.verificationRecordId,
        evidenceHash: hashVerificationRecord(record),
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        relatedCriterionIds: record.relatedCriterionIds,
        relatedFindingIds: [],
        decision: options?.decision ?? 'ACCEPTED',
        acceptanceMode: options?.acceptanceMode ?? 'HUMAN',
        rationale: 'Independently verified the observed evidence.',
        attestorActorExecutionId: 'plan-author',
        attestorActorType: options?.acceptanceMode === 'AUTOMATIC_POLICY' ? 'SYSTEM' : 'HUMAN',
        authorityExercised: 'VERIFICATION_ATTESTOR',
        recordVerificationType: record.verificationType,
        recordExecutorActorExecutionId: record.executorActorExecutionId,
        recordExecutorActorType: record.executorActorType,
        reviewedCommitSha: commitSha,
        policyConfigurationHash: snapshot.configurationHash,
        createdAt: LATER,
      },
    });
    return record;
  }

  function persistOpenHighFinding(
    head: string,
    options?: { readonly withRejectedDisposition?: boolean },
  ): void {
    const findingId = 'finding-direct-high';
    store.workflowStore.saveEntity({
      kind: 'FINDING',
      value: {
        findingId,
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        reviewRoundId: deriveCodeReviewRoundId(BATCH_ID, 1),
        reviewRoundNumber: 1,
        reviewKind: 'CODE',
        severity: 'high',
        category: 'correctness',
        title: 'Directly persisted high defect',
        description: 'A persisted high defect awaiting resolution.',
        repositoryEvidence: [
          { kind: 'FILE', location: 'src/example.txt', description: 'Evidence.' },
        ],
        affectedFiles: ['src/example.txt'],
        expectedResult: 'Expected behaviour holds.',
        observedResult: 'Observed behaviour differs.',
        requiredAction: 'Correct the defect.',
        reviewerActorExecutionId: 'actor-review-1',
        reviewedArtifact: { contentHash: 'c'.repeat(64) },
        repositoryContextSha: head,
        reviewedCommitSha: head,
        status: 'OPEN',
        occurrenceLinks: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    if (options?.withRejectedDisposition === true) {
      store.workflowStore.saveEntity({
        kind: 'FINDING_DISPOSITION',
        value: {
          dispositionId: `${findingId}:disposition`,
          findingId,
          disposition: 'FIXED',
          explanation: 'Claimed fixed in the correction pass.',
          actorExecutionId: 'actor-implementation-1',
          filesChanged: ['src/example.txt'],
          verificationRecordIds: [],
          evidence: [{ kind: 'DIFF', location: 'src/example.txt', description: 'Diff evidence.' }],
          resultTarget: { kind: 'CODE', resultingCommitSha: head },
          reviewerDecision: {
            decision: 'REJECTED',
            reviewerActorExecutionId: 'actor-review-1',
            rationale: 'The correction is insufficient.',
            decidedAt: LATER,
          },
          createdAt: NOW,
          updatedAt: LATER,
        },
      });
    }
  }

  async function runFinalAudit(overrides?: {
    readonly verdict?: 'APPROVED' | 'NEEDS_REVISION';
    readonly scopeComplete?: boolean;
    readonly documentationComplete?: boolean;
    readonly highFindingKeys?: readonly string[];
    readonly mutateRepository?: () => void;
    readonly commandId?: string;
  }) {
    auditCounter += 1;
    roleInvoker.enqueue({
      fromPrompt: (prompt) => {
        const evidence = JSON.parse(prompt) as {
          target: unknown;
          acceptanceCriterionIds: readonly string[];
        };
        return finalAuditTranscript({
          target: evidence.target,
          acceptanceCriterionIds: evidence.acceptanceCriterionIds,
          ...(overrides?.verdict === undefined ? {} : { verdict: overrides.verdict }),
          ...(overrides?.scopeComplete === undefined
            ? {}
            : { scopeComplete: overrides.scopeComplete }),
          ...(overrides?.documentationComplete === undefined
            ? {}
            : { documentationComplete: overrides.documentationComplete }),
          ...(overrides?.highFindingKeys === undefined
            ? {}
            : { highFindingKeys: overrides.highFindingKeys }),
        });
      },
      ...(overrides?.mutateRepository === undefined
        ? {}
        : { mutateRepository: overrides.mutateRepository }),
    });
    return gateService.finalAudit({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      resolution: reviewerResolution,
      commandId: overrides?.commandId ?? `${BATCH_ID}:final-audit-${auditCounter}`,
      actorExecutionId: `actor-final-audit-${auditCounter}`,
      invocationId: `invocation-final-audit-${auditCounter}`,
      sessionIdentityId: 'session-reviewer',
      previousSessionIdentityId: 'session-reviewer',
      transcriptId: `final-audit-transcript-${auditCounter}`,
      buildPrompt: (evidence) =>
        JSON.stringify({
          target: evidence.target,
          acceptanceCriterionIds: evidence.acceptanceCriterionIds,
        }),
    });
  }

  function evaluateGate(commandSuffix = '1') {
    return gateService.evaluateGate({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      commandId: `${BATCH_ID}:gate-${commandSuffix}`,
      createdAt: LATER,
    });
  }

  it('walks the complete gate lifecycle to MERGED', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    const audit = await runFinalAudit();
    expect(audit.capture.accepted).toBe(true);
    expect(audit.batch.persistedState).toBe('VERIFYING');

    const gate = evaluateGate();
    expect(gate.approved).toBe(true);
    if (!gate.approved) return;
    expect(gate.batch.persistedState).toBe('APPROVED_FOR_MERGE');
    expect(gate.conditions.reviewedCommitSha).toBe(head);
    const approvalEvents = store
      .getEvents(BATCH_ID)
      .filter((event) => event.eventType === 'BATCH_GATE_APPROVED');
    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0]?.payload.approvedCommitSha).toBe(head);

    const effective = gateService.effectiveState(BATCH_ID);
    expect(effective.effectiveState).toBe('APPROVED_FOR_MERGE');
    expect(effective.approvalValid).toBe(true);
    expect(effective.persistedApprovalSha).toBe(head);

    const mergeSha = createExternalMergeCommit(repositoryRoot, head);
    const merged = gateService.markMerged({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      mergeCommitSha: mergeSha,
      recorder: { actorExecutionId: 'merge-recorder-1', actorType: 'HUMAN' },
      commandId: `${BATCH_ID}:mark-merged`,
      createdAt: LATER,
    });
    expect(merged.persistedState).toBe('MERGED');
    const mergedEvents = store
      .getEvents(BATCH_ID)
      .filter((event) => event.eventType === 'BATCH_MERGED');
    expect(mergedEvents).toHaveLength(1);
    expect(mergedEvents[0]?.payload.mergeCommitSha).toBe(mergeSha);

    // A same-ID retry replays the recorded merge without a second transition or event.
    const replayed = gateService.markMerged({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      mergeCommitSha: mergeSha,
      recorder: { actorExecutionId: 'merge-recorder-1', actorType: 'HUMAN' },
      commandId: `${BATCH_ID}:mark-merged`,
      createdAt: LATER,
    });
    expect(replayed.persistedState).toBe('MERGED');
    expect(
      store.getEvents(BATCH_ID).filter((event) => event.eventType === 'BATCH_MERGED'),
    ).toHaveLength(1);
  });

  it('rejects the gate outside VERIFYING', async () => {
    expect(() => evaluateGate()).toThrowError(ReviewWorkflowGateError);
    try {
      evaluateGate('2');
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewWorkflowGateError);
      if (error instanceof ReviewWorkflowGateError) expect(error.code).toBe('INVALID_STATE');
    }
  });

  it('fails the audit conditions when no final audit exists', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    const gate = evaluateGate();
    expect(gate.approved).toBe(false);
    if (gate.approved) return;
    expect(gate.failedConditions).toContain('SCOPE_MATCHES_APPROVED_PLAN');
    expect(gate.failedConditions).toContain('DOCUMENTATION_COMPLETE');
    expect(gate.batch.persistedState).toBe('VERIFYING');
  });

  it('fails the verification conditions without any accepted record', async () => {
    await reachVerifying();
    await runFinalAudit();
    const gate = evaluateGate();
    expect(gate.approved).toBe(false);
    if (gate.approved) return;
    expect(gate.failedConditions).toContain('REQUIRED_CRITERIA_PASSED');
    expect(gate.failedConditions).toContain('REQUIRED_ATTESTATIONS_ACCEPTED');
  });

  it('does not count a rejected attestation as acceptance', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head, { decision: 'REJECTED' });
    await runFinalAudit();
    const gate = evaluateGate();
    expect(gate.approved).toBe(false);
    if (gate.approved) return;
    expect(gate.failedConditions).toContain('REQUIRED_CRITERIA_PASSED');
    expect(gate.failedConditions).toContain('REQUIRED_ATTESTATIONS_ACCEPTED');
  });

  it('requires every plan verification command to be satisfied', async () => {
    planVerificationCommands = [
      {
        executable: 'pnpm',
        arguments: ['test'],
        workingDirectory: '.',
        verificationType: 'test',
        relatedCriterionIds: ['criterion-required'],
      },
      {
        executable: 'pnpm',
        arguments: ['lint'],
        workingDirectory: '.',
        verificationType: 'lint',
        relatedCriterionIds: [],
      },
    ];
    db.close();
    db = openDatabase(':memory:');
    rmSync(repositoryRoot, { recursive: true, force: true });
    repositoryRoot = mkdtempSync(join(tmpdir(), 'codemoot-gate-'));
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.name', 'CodeMoot Test']);
    git(repositoryRoot, ['config', 'user.email', 'codemoot@example.com']);
    baseSha = commitFile(repositoryRoot, 'src/example.txt', 'base\n', 'base');
    build();
    const head = await reachVerifying();
    persistAcceptedVerification(head, { command: { executable: 'pnpm', arguments: ['test'] } });
    await runFinalAudit();
    const gate = evaluateGate();
    expect(gate.approved).toBe(false);
    if (gate.approved) return;
    expect(gate.failedConditions).toContain('REQUIRED_VERIFICATION_COMPLETE');
  });

  it('fails on a dirty worktree', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    writeFileSync(join(repositoryRoot, 'src/example.txt'), 'dirty\n');
    const gate = evaluateGate();
    expect(gate.approved).toBe(false);
    if (gate.approved) return;
    expect(gate.failedConditions).toContain('CLEAN_WORKTREE');
  });

  it('fails when HEAD moved past the reviewed commit', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    commitFile(repositoryRoot, 'src/other.txt', 'later\n', 'unrelated commit');
    const gate = evaluateGate();
    expect(gate.approved).toBe(false);
    if (gate.approved) return;
    expect(gate.failedConditions).toContain('HEAD_MATCHES_REVIEWED_COMMIT');
  });

  it('escalates a NEEDS_REVISION final audit to BLOCKED for a human decision', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    const audit = await runFinalAudit({
      verdict: 'NEEDS_REVISION',
      highFindingKeys: ['late-high-defect'],
    });
    expect(audit.capture.accepted).toBe(true);
    expect(audit.batch.persistedState).toBe('BLOCKED');
    expect(audit.batch.blockedResumeState).toBe('VERIFYING');
    const blockedEvents = store
      .getEvents(BATCH_ID)
      .filter((event) => event.eventType === 'BATCH_BLOCKED');
    expect(blockedEvents).toHaveLength(1);
    // No further automatic gate evaluation is possible without a human decision.
    expect(() => evaluateGate()).toThrowError(/must be VERIFYING/);
  });

  it('blocks the gate on an open critical or high finding without accepted resolution', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    persistOpenHighFinding(head);
    const gate = evaluateGate();
    expect(gate.approved).toBe(false);
    if (gate.approved) return;
    expect(gate.conditions.unresolvedCriticalOrHighFindingCount).toBe(1);
    expect(gate.failedConditions).toContain('UNRESOLVED_CRITICAL_OR_HIGH_FINDINGS');
  });

  it('reports incomplete dispositions when a blocking finding was rejected by review', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    persistOpenHighFinding(head, { withRejectedDisposition: true });
    const gate = evaluateGate();
    expect(gate.approved).toBe(false);
    if (gate.approved) return;
    expect(gate.conditions.incompleteDispositionCount).toBe(1);
    expect(gate.failedConditions).toContain('INCOMPLETE_DISPOSITIONS');
    expect(gate.failedConditions).toContain('UNRESOLVED_CRITICAL_OR_HIGH_FINDINGS');
  });

  it('requires independent attestation for manual and browser criteria', async () => {
    const head = await reachVerifying();
    store.workflowStore.saveEntity({
      kind: 'ACCEPTANCE_CRITERION',
      value: {
        acceptanceCriterionId: 'criterion-manual',
        batchPlanVersionId: 'batch-plan-12',
        kind: 'MANUAL',
        statement: 'The manual behaviour is confirmed.',
        required: true,
        passCondition: 'Confirmed by an independent human or reviewer.',
        status: 'PENDING',
        sourceRequirementIds: [],
        createdAt: NOW,
      },
    });
    persistAcceptedVerification(head, {
      criterionIds: ['criterion-required', 'criterion-manual'],
      acceptanceMode: 'AUTOMATIC_POLICY',
    });
    await runFinalAudit();
    const gate = evaluateGate();
    expect(gate.approved).toBe(false);
    if (gate.approved) return;
    expect(gate.conditions.manualAndBrowserEvidenceIndependentlyAttested).toBe(false);
    expect(gate.failedConditions).toContain('MANUAL_BROWSER_INDEPENDENT_ATTESTATION');
  });

  it('fails the final-diff condition when the reviewed range is no longer derivable', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    git(repositoryRoot, ['reset', '--hard', baseSha]);
    git(repositoryRoot, ['reflog', 'expire', '--expire=now', '--all']);
    git(repositoryRoot, ['gc', '--prune=now', '--quiet']);
    const gate = evaluateGate();
    expect(gate.approved).toBe(false);
    if (gate.approved) return;
    expect(gate.conditions.finalDiffReviewed).toBe(false);
    expect(gate.failedConditions).toContain('FINAL_DIFF_REVIEWED');
    void head;
  });

  it('permits exactly one final audit per batch', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    await expect(runFinalAudit()).rejects.toMatchObject({ code: 'FINAL_AUDIT_EXISTS' });
  });

  it('rejects a final audit whose reviewer mutated the repository', async () => {
    await reachVerifying();
    const result = await runFinalAudit({
      mutateRepository: () => {
        commitFile(repositoryRoot, 'src/example.txt', 'tampered\n', 'reviewer tamper');
      },
    });
    expect(result.capture.accepted).toBe(false);
    if (result.capture.accepted) return;
    expect(result.capture.error.message).toContain('read-only audit');
    expect(store.listFinalAudits(BATCH_ID)).toHaveLength(0);
  });

  it('reports, reconciles, and enforces stale approvals', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    const gate = evaluateGate();
    expect(gate.approved).toBe(true);

    expect(() =>
      gateService.reconcileStaleApproval({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        commandId: `${BATCH_ID}:reconcile-early`,
        createdAt: LATER,
      }),
    ).toThrowError(/not stale/);

    commitFile(repositoryRoot, 'src/other.txt', 'drift\n', 'post-approval drift');
    const effective = gateService.effectiveState(BATCH_ID);
    expect(effective.persistedState).toBe('APPROVED_FOR_MERGE');
    expect(effective.effectiveState).toBe('APPROVAL_STALE');
    expect(effective.approvalValid).toBe(false);

    expect(() =>
      gateService.markMerged({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        mergeCommitSha: MERGE_SHA,
        recorder: { actorExecutionId: 'merge-recorder-1', actorType: 'HUMAN' },
        commandId: `${BATCH_ID}:mark-merged-stale`,
        createdAt: LATER,
      }),
    ).toThrowError(/no longer effective/);

    const reconciled = gateService.reconcileStaleApproval({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      commandId: `${BATCH_ID}:reconcile`,
      createdAt: LATER,
    });
    expect(reconciled.persistedState).toBe('APPROVAL_STALE');
    const staleEvents = store
      .getEvents(BATCH_ID)
      .filter((event) => event.eventType === 'APPROVAL_STALE_RECONCILED');
    expect(staleEvents).toHaveLength(1);

    expect(() =>
      gateService.markMerged({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        mergeCommitSha: MERGE_SHA,
        recorder: { actorExecutionId: 'merge-recorder-1', actorType: 'HUMAN' },
        commandId: `${BATCH_ID}:mark-merged-after-stale`,
        createdAt: LATER,
      }),
    ).toThrowError(ReviewWorkflowGateError);

    // Reconciliation replays idempotently for the same command ID.
    const replayed = gateService.reconcileStaleApproval({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      commandId: `${BATCH_ID}:reconcile`,
      createdAt: LATER,
    });
    expect(replayed.persistedState).toBe('APPROVAL_STALE');
    expect(
      store.getEvents(BATCH_ID).filter((event) => event.eventType === 'APPROVAL_STALE_RECONCILED'),
    ).toHaveLength(1);
  });

  it('replays a completed gate approval for the same command ID without new events', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    const first = evaluateGate('same');
    expect(first.approved).toBe(true);
    const second = evaluateGate('same');
    expect(second.approved).toBe(true);
    if (!second.approved) return;
    expect(second.conditions.reviewedCommitSha).toBe(head);
    expect(
      store.getEvents(BATCH_ID).filter((event) => event.eventType === 'BATCH_GATE_APPROVED'),
    ).toHaveLength(1);
  });

  it('rejects reusing a command ID for a different operation', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    const gate = evaluateGate('reused');
    expect(gate.approved).toBe(true);
    expect(() =>
      gateService.markMerged({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        mergeCommitSha: createExternalMergeCommit(repositoryRoot, head),
        recorder: { actorExecutionId: 'merge-recorder-1', actorType: 'HUMAN' },
        commandId: `${BATCH_ID}:gate-reused`,
        createdAt: LATER,
      }),
    ).toThrowError(/only a completed identical command can be replayed/);
  });

  it('replays the persisted final audit for the same command ID', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    const first = await runFinalAudit({ commandId: `${BATCH_ID}:final-audit-stable` });
    expect(first.capture.accepted).toBe(true);
    expect(first.replayed).toBe(false);
    const second = await runFinalAudit({ commandId: `${BATCH_ID}:final-audit-stable` });
    expect(second.replayed).toBe(true);
    expect(second.capture.accepted).toBe(true);
    if (!second.capture.accepted || !first.capture.accepted) return;
    expect(second.capture.value.review.reviewRoundId).toBe(
      first.capture.value.review.reviewRoundId,
    );
    expect(store.listFinalAudits(BATCH_ID)).toHaveLength(1);
    void head;
  });

  it('reserves verification execution before running and replays the same command ID', async () => {
    const head = await reachVerifying();
    let executions = 0;
    const record = () => {
      executions += 1;
      const persisted = persistAcceptedVerification(head);
      return persisted;
    };
    const first = await gateService.executeVerification({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      commandId: `${BATCH_ID}:verify:1`,
      verificationRecordId: `record-${head.slice(0, 8)}-ACCEPTED`,
      run: async () => record(),
    });
    expect(first.replayed).toBe(false);
    expect(executions).toBe(1);
    const second = await gateService.executeVerification({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      commandId: `${BATCH_ID}:verify:1`,
      verificationRecordId: `record-${head.slice(0, 8)}-ACCEPTED`,
      run: async () => record(),
    });
    expect(second.replayed).toBe(true);
    expect(executions).toBe(1);
    expect(second.record.verificationRecordId).toBe(first.record.verificationRecordId);
  });

  it('refuses to record a merge commit that is missing or does not contain the approval', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    expect(evaluateGate().approved).toBe(true);
    expect(() =>
      gateService.markMerged({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        mergeCommitSha: MERGE_SHA,
        recorder: { actorExecutionId: 'merge-recorder-1', actorType: 'HUMAN' },
        commandId: `${BATCH_ID}:mark-merged-missing`,
        createdAt: LATER,
      }),
    ).toThrowError(/does not exist in this repository or does not contain/);
    const sibling = createExternalMergeCommit(repositoryRoot, baseSha);
    expect(() =>
      gateService.markMerged({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        mergeCommitSha: sibling,
        recorder: { actorExecutionId: 'merge-recorder-1', actorType: 'HUMAN' },
        commandId: `${BATCH_ID}:mark-merged-sibling`,
        createdAt: LATER,
      }),
    ).toThrowError(/does not contain approved commit/);
    expect(gateService.effectiveState(BATCH_ID).persistedState).toBe('APPROVED_FOR_MERGE');
  });

  it('keeps gate state isolated between batches of the same workflow', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    store.workflowStore.createBatch({
      batchId: 'batch-13',
      workflowId: snapshot.workflowId,
      ordinal: 13,
      persistedState: 'VERIFYING',
      aggregateVersion: 0,
      currentPlanVersionId: 'batch-plan-12',
      implementerAssignmentId: snapshot.assignments.implementer.assignmentId,
      reviewerAssignmentId: snapshot.assignments.reviewer.assignmentId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(evaluateGate().approved).toBe(true);
    // The sibling batch sees neither the approval event nor the approved review.
    const sibling = gateService.effectiveState('batch-13');
    expect(sibling.persistedState).toBe('VERIFYING');
    expect(sibling.approvalValid).toBe(false);
    expect(sibling.persistedApprovalSha).toBeUndefined();
    expect(() =>
      gateService.evaluateGate({
        workflowId: snapshot.workflowId,
        batchId: 'batch-13',
        configuration: snapshot,
        commandId: 'batch-13:gate',
        createdAt: LATER,
      }),
    ).toThrowError(/no approved code review/);
    expect(gateService.effectiveState(BATCH_ID).persistedState).toBe('APPROVED_FOR_MERGE');
  });

  it('rejects replaying a gate command that belongs to another batch', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    const gate = evaluateGate('cross');
    expect(gate.approved).toBe(true);
    store.workflowStore.createBatch({
      batchId: 'batch-13',
      workflowId: snapshot.workflowId,
      ordinal: 13,
      persistedState: 'VERIFYING',
      aggregateVersion: 0,
      currentPlanVersionId: 'batch-plan-12',
      implementerAssignmentId: snapshot.assignments.implementer.assignmentId,
      reviewerAssignmentId: snapshot.assignments.reviewer.assignmentId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Batch 13 presenting batch 12's completed gate command must never receive batch 12's
    // stored approval.
    expect(() =>
      gateService.evaluateGate({
        workflowId: snapshot.workflowId,
        batchId: 'batch-13',
        configuration: snapshot,
        commandId: `${BATCH_ID}:gate-cross`,
        createdAt: LATER,
      }),
    ).toThrowError(/only a completed identical command can be replayed/);
  });

  it('rejects replay collisions between the final audit and verification execution', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head, { decision: 'REJECTED' });
    const audit = await runFinalAudit({ commandId: `${BATCH_ID}:shared-id` });
    expect(audit.capture.accepted).toBe(true);
    // Verification presenting the completed final-audit command must not replay the audit
    // payload as a verification record: the side-effect kinds differ.
    await expect(
      gateService.executeVerification({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        configuration: snapshot,
        commandId: `${BATCH_ID}:shared-id`,
        verificationRecordId: `${BATCH_ID}:shared-id:record`,
        run: async () => persistAcceptedVerification(head),
      }),
    ).rejects.toThrowError(/only a completed identical command can be replayed/);
    // And the final audit refuses a completed verification command in the other direction.
    const verified = await gateService.executeVerification({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      commandId: `${BATCH_ID}:verify:9`,
      verificationRecordId: `record-${head.slice(0, 8)}-ACCEPTED`,
      run: async () => persistAcceptedVerification(head),
    });
    expect(verified.replayed).toBe(false);
    await expect(runFinalAudit({ commandId: `${BATCH_ID}:verify:9` })).rejects.toThrowError(
      /only a completed identical command can be replayed/,
    );
  });

  it('rejects a mark-merged replay that names a different merge commit', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    expect(evaluateGate().approved).toBe(true);
    const mergeSha = createExternalMergeCommit(repositoryRoot, head);
    gateService.markMerged({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      mergeCommitSha: mergeSha,
      recorder: { actorExecutionId: 'merge-recorder-1', actorType: 'HUMAN' },
      commandId: `${BATCH_ID}:mark-merged`,
      createdAt: LATER,
    });
    const otherSha = createExternalMergeCommit(repositoryRoot, mergeSha);
    expect(() =>
      gateService.markMerged({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        mergeCommitSha: otherSha,
        recorder: { actorExecutionId: 'merge-recorder-1', actorType: 'HUMAN' },
        commandId: `${BATCH_ID}:mark-merged`,
        createdAt: LATER,
      }),
    ).toThrowError(/recorded a different merge commit/);
  });

  it('persists the final-gate range evidence once with a stable identifier', async () => {
    const head = await reachVerifying();
    persistAcceptedVerification(head);
    await runFinalAudit();
    const evidence = store.workflowStore.getEntity(
      'REVIEW_RANGE_EVIDENCE',
      deriveFinalAuditRangeEvidenceId(BATCH_ID),
    );
    expect(evidence?.kind).toBe('REVIEW_RANGE_EVIDENCE');
  });
});
