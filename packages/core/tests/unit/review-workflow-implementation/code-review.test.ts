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
import { LocalGitRepository } from '../../../src/review-workflow-git/local-git-repository.js';
import { ReviewWorkflowGitService } from '../../../src/review-workflow-git/service.js';
import { createReviewWorkflowConfigurationSnapshot } from '../../../src/review-workflow-identity/service.js';
import type { ReviewWorkflowConfigurationSnapshot } from '../../../src/review-workflow-identity/types.js';
import {
  ReviewWorkflowCodeReviewService,
  deriveCodeReviewRoundId,
} from '../../../src/review-workflow-implementation/code-review.js';
import {
  ReviewWorkflowImplementationService,
  deriveImplementationAttemptId,
  deriveImplementationReadyEvidenceId,
} from '../../../src/review-workflow-implementation/service.js';
import { ReviewWorkflowImplementationStore } from '../../../src/review-workflow-implementation/store.js';
import { ReviewWorkflowImplementationError } from '../../../src/review-workflow-implementation/types.js';
import type {
  ActorExecutionIdentity,
  BatchPlanVersion,
  ReviewWorkflowBatch,
  WorkflowRun,
} from '../../../src/review-workflow/types.js';
import type {
  PreparedRoleInvocation,
  RoleInvocationInput,
} from '../../../src/roles/role-invocation.js';
import type { ResolvedRoleAdapter } from '../../../src/roles/role-manager.js';

const NOW = '2026-07-30T12:00:00.000Z';
const LATER = '2026-07-30T12:01:00.000Z';
const BATCH_ID = 'batch-11';

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

function configuration(pacing?: Record<string, unknown>): ReviewWorkflowConfigurationSnapshot {
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
        ...(pacing === undefined ? {} : { pacing }),
      },
      debate: { enabled: false },
    }),
    {
      workflowId: 'workflow-11',
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
  readonly text?: string | (() => string);
  readonly fromPrompt?: (prompt: string) => string;
  readonly mutateRepository?: () => void;
  readonly onInvoke?: () => void;
  readonly fail?: boolean;
}

class FakeRoleInvoker {
  private readonly queue: QueuedInvocation[] = [];
  private invocationCounter = 0;

  constructor(private readonly store: ReviewWorkflowImplementationStore) {}

  enqueue(invocation: QueuedInvocation): void {
    this.queue.push(invocation);
  }

  invocationsPerformed = 0;

  queueLength(): number {
    return this.queue.length;
  }

  async prepare(input: RoleInvocationInput): Promise<PreparedRoleInvocation> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error('No fake role invocation was queued');
    this.invocationsPerformed += 1;
    next.onInvoke?.();
    if (next.fail === true) throw new Error('Simulated bridge crash during invocation');
    next.mutateRepository?.();
    this.invocationCounter += 1;
    const role = input.resolution.role === 'implementer' ? 'IMPLEMENTER' : 'REVIEWER';
    const resumed = input.previousSessionIdentityId !== undefined;
    const sessionIdentityId = input.previousSessionIdentityId ?? input.sessionIdentityId;
    const vendorSessionId = `vendor-${input.resolution.role}-session`;
    const providerOrAdapter = input.resolution.role === 'implementer' ? 'claude' : 'codex';
    const responseText =
      next.fromPrompt !== undefined
        ? next.fromPrompt(input.prompt)
        : typeof next.text === 'function'
          ? next.text()
          : (next.text ?? '');
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

interface ReviewTranscriptInput {
  readonly reviewedCommitSha: string;
  readonly reviewRangeEvidenceId: string;
  readonly patchHash: string;
  readonly verdict: 'APPROVED' | 'NEEDS_REVISION';
  readonly findings: readonly {
    readonly key: string;
    readonly severity: string;
    readonly acceptanceCriterionId?: string;
  }[];
}

function reviewTranscript(input: ReviewTranscriptInput): string {
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
    verdict: input.verdict,
    summary: 'Complete consolidated review.',
    findings: input.findings.map((finding) => ({
      findingKey: finding.key,
      severity: finding.severity,
      ...(finding.acceptanceCriterionId === undefined
        ? {}
        : { acceptanceCriterionId: finding.acceptanceCriterionId }),
      category: 'correctness',
      title: `Finding ${finding.key}`,
      description: 'A complete reviewed defect description.',
      repositoryEvidence: [
        { kind: 'FILE', location: 'src/example.txt', description: 'Reviewed evidence.' },
      ],
      affectedFiles: ['src/example.txt'],
      expectedResult: 'Expected behaviour holds.',
      observedResult: 'Observed behaviour differs.',
      requiredAction: 'Correct the defect.',
    })),
  });
}

function dispositionTranscript(resultingCommitSha: string, findingIds: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    contractKind: 'DISPOSITION_RESULT',
    target: { kind: 'CODE', resultingCommitSha },
    summary: 'Addressed every blocking finding.',
    dispositions: findingIds.map((findingId) => ({
      findingId,
      disposition: 'FIXED',
      explanation: 'The defect was corrected in the correction pass.',
      filesChanged: ['src/example.txt'],
      verificationRecordIds: [],
      evidence: [
        { kind: 'DIFF', location: 'src/example.txt', description: 'Correction diff evidence.' },
      ],
    })),
  });
}

describe('ReviewWorkflowCodeReviewService', () => {
  let db: Database.Database;
  let repositoryRoot: string;
  let baseSha: string;
  let snapshot: ReviewWorkflowConfigurationSnapshot;
  let store: ReviewWorkflowImplementationStore;
  let commandStore: ReviewWorkflowCommandStore;
  let repository: LocalGitRepository;
  let roleInvoker: FakeRoleInvoker;
  let implementationService: ReviewWorkflowImplementationService;
  let codeReviewService: ReviewWorkflowCodeReviewService;
  let implementerResolution: ResolvedRoleAdapter;
  let reviewerResolution: ResolvedRoleAdapter;

  function build(customSnapshot?: ReviewWorkflowConfigurationSnapshot): void {
    snapshot = customSnapshot ?? configuration();
    store = new ReviewWorkflowImplementationStore(db);
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
      generalPlanVersionId: 'general-plan-11',
      implementerAssignmentId: snapshot.assignments.implementer.assignmentId,
      reviewerAssignmentId: snapshot.assignments.reviewer.assignmentId,
      configurationHash: snapshot.configurationHash,
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
      batchPlanVersionId: 'batch-plan-11',
      workflowId: workflow.workflowId,
      batchId: BATCH_ID,
      version: 1,
      contentHash: 'plan-content-hash',
      repositoryContextSha: baseSha,
      objective: 'Implement and review the complete approved batch.',
      currentRepositoryEvidence: [
        { kind: 'FILE', location: 'src/example.txt', description: 'Current target.' },
      ],
      dependencies: [],
      candidateFiles: ['src/example.txt'],
      technicalImplementation: ['Update the implementation target.'],
      userJourney: ['The operator runs the batch lifecycle.'],
      expectedBehaviour: ['The batch reaches VERIFYING through bounded review.'],
      technicalAcceptanceCriteria: ['criterion-required'],
      userFacingAcceptanceCriteria: [],
      cliAcceptanceCriteria: [],
      browserAcceptanceCriteria: {
        applicability: 'NOT_APPLICABLE',
        reason: 'No browser behavior.',
      },
      verificationCommands: [],
      manualVerification: [],
      documentationChanges: [],
      outOfScope: ['Merge gating.'],
      rollbackBoundary: 'Revert the implementation commit.',
      addressedFindingIds: [],
      actorExecutionId: planAuthor.actorExecutionId,
      createdAt: NOW,
    };
    const batch: ReviewWorkflowBatch = {
      batchId: BATCH_ID,
      workflowId: workflow.workflowId,
      ordinal: 11,
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
        passCondition: 'Verified by review.',
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
  }

  beforeEach(() => {
    reviewAttempt = 0;
    reviewerSessionCreated = false;
    repositoryRoot = mkdtempSync(join(tmpdir(), 'codemoot-code-review-'));
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

  async function reachImplementationComplete(attemptNumber: number, content: string) {
    if (attemptNumber === 1) {
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
    } else {
      roleInvoker.enqueue({ text: 'READY' });
      await implementationService.resume({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        configuration: snapshot,
        resolution: implementerResolution,
        commandId: `${BATCH_ID}:resume-implementation-${attemptNumber}`,
        actorExecutionId: `actor-resume-${attemptNumber}`,
        invocationId: `invocation-resume-${attemptNumber}`,
        sessionIdentityId: 'session-implementer',
        previousSessionIdentityId: 'session-implementer',
        prompt: 'Return READY.',
      });
    }
    const attemptId = deriveImplementationAttemptId(BATCH_ID, attemptNumber);
    roleInvoker.enqueue({
      text: implementationTranscript(['src/example.txt']),
      mutateRepository: () => {
        commitFile(repositoryRoot, 'src/example.txt', content, `implementation ${attemptNumber}`);
      },
    });
    const executed = await implementationService.execute({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      resolution: implementerResolution,
      commandId: `${attemptId}:ready`,
      actorExecutionId: `actor-implementation-${attemptNumber}`,
      invocationId: `invocation-implementation-${attemptNumber}`,
      sessionIdentityId: 'session-implementer',
      previousSessionIdentityId: 'session-implementer',
      transcriptId: `implementation-transcript-${attemptNumber}`,
      implementationAttemptId: attemptId,
      implementationReadyEvidenceId: deriveImplementationReadyEvidenceId(attemptId),
      attemptNumber,
      creationMode: 'AGENT_AUTHORIZED',
      prompt: 'Implement the batch.',
    });
    expect(executed.status).toBe('AWAITING_COMMIT');
    const head = git(repositoryRoot, ['rev-parse', 'HEAD']);
    const completed = implementationService.complete({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      implementationAttemptId: attemptId,
      implementationReadyEvidenceId: deriveImplementationReadyEvidenceId(attemptId),
      providedCommitSha: head,
      creationMode: 'AGENT_AUTHORIZED',
      commandId: `${attemptId}:complete`,
    });
    expect(completed.batch.persistedState).toBe('IMPLEMENTATION_COMPLETE');
    return head;
  }

  let reviewAttempt = 0;
  let reviewerSessionCreated = false;

  async function runReview(
    round: number,
    verdict: 'APPROVED' | 'NEEDS_REVISION',
    findings: readonly {
      readonly key: string;
      readonly severity: string;
      readonly acceptanceCriterionId?: string;
    }[],
  ) {
    reviewAttempt += 1;
    // The fake reviewer answers using ONLY the authoritative evidence in its prompt.
    roleInvoker.enqueue({
      fromPrompt: (prompt) => {
        const parsed = JSON.parse(prompt) as {
          target: {
            reviewedCommitSha: string;
            reviewRangeEvidenceId: string;
            patchHash: string;
          };
        };
        return reviewTranscript({
          reviewedCommitSha: parsed.target.reviewedCommitSha,
          reviewRangeEvidenceId: parsed.target.reviewRangeEvidenceId,
          patchHash: parsed.target.patchHash,
          verdict,
          findings,
        });
      },
    });
    const invoke = codeReviewService.review({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      resolution: reviewerResolution,
      commandId: `${BATCH_ID}:code-review-${round}:${reviewAttempt}`,
      actorExecutionId: `actor-review-${reviewAttempt}`,
      invocationId: `invocation-review-${reviewAttempt}`,
      sessionIdentityId: 'session-reviewer',
      ...(reviewerSessionCreated ? { previousSessionIdentityId: 'session-reviewer' } : {}),
      transcriptId: `review-transcript-${reviewAttempt}`,
      reviewRoundId: deriveCodeReviewRoundId(BATCH_ID, round),
      buildPrompt: (evidence) => JSON.stringify({ target: evidence.target, round: evidence.round }),
    });
    const result = await invoke;
    reviewerSessionCreated = true;
    return result;
  }

  function submitDispositions(findingIds: readonly string[]): void {
    const head = git(repositoryRoot, ['rev-parse', 'HEAD']);
    const capture = codeReviewService.submitDispositions({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      transcriptId: `disposition-transcript-${head.slice(0, 8)}`,
      actorExecutionId: 'actor-implementation-2',
      rawTranscript: dispositionTranscript(head, findingIds),
      createdAt: LATER,
    });
    expect(capture.accepted).toBe(true);
  }

  it('approves a clean round-1 review and defers non-blocking findings', async () => {
    await reachImplementationComplete(1, 'implemented\n');
    const result = await runReview(1, 'APPROVED', [{ key: 'style-nit', severity: 'low' }]);
    expect(result.status).toBe('VERIFYING');
    if (result.status !== 'VERIFYING') return;
    expect(result.batch.persistedState).toBe('VERIFYING');
    expect(result.deferredFindingIds).toHaveLength(1);
    expect(store.listCodeReviews(BATCH_ID)).toHaveLength(1);
  });

  it('runs the full bounded loop: reject, one correction, dispositions, final approval', async () => {
    await reachImplementationComplete(1, 'implemented\n');
    const round1 = await runReview(1, 'NEEDS_REVISION', [{ key: 'high-defect', severity: 'high' }]);
    expect(round1.status).toBe('NEEDS_REVISION');
    if (round1.status !== 'NEEDS_REVISION') return;
    expect(round1.batch.persistedState).toBe('NEEDS_REVISION');

    await reachImplementationComplete(2, 'corrected\n');
    submitDispositions(round1.blockingFindingIds);
    const round2 = await runReview(2, 'APPROVED', []);
    expect(round2.status).toBe('VERIFYING');
    if (round2.status !== 'VERIFYING') return;
    expect(round2.round).toBe(2);
    expect(round2.batch.persistedState).toBe('VERIFYING');
    // The final review's approval IS the reviewer decision on each disposition.
    for (const findingId of round1.blockingFindingIds) {
      const decisions = store
        .listDispositionsForFinding(findingId)
        .map((disposition) => disposition.reviewerDecision.decision);
      expect(decisions).toContain('ACCEPTED');
    }
  });

  it('escalates an unresolved final round to a human decision instead of a third review', async () => {
    await reachImplementationComplete(1, 'implemented\n');
    const round1 = await runReview(1, 'NEEDS_REVISION', [{ key: 'high-defect', severity: 'high' }]);
    expect(round1.status).toBe('NEEDS_REVISION');
    if (round1.status !== 'NEEDS_REVISION') return;

    await reachImplementationComplete(2, 'still-broken\n');
    submitDispositions(round1.blockingFindingIds);
    const round2 = await runReview(2, 'NEEDS_REVISION', [
      { key: 'regression', severity: 'critical' },
    ]);
    expect(round2.status).toBe('HUMAN_DECISION_REQUIRED');
    if (round2.status !== 'HUMAN_DECISION_REQUIRED') return;
    expect(round2.batch.persistedState).toBe('BLOCKED');
    expect(round2.batch.blockedResumeState).toBe('NEEDS_REVISION');
    // A rejecting final review rejects the pending dispositions; nothing was accepted.
    for (const findingId of round1.blockingFindingIds) {
      const decisions = store
        .listDispositionsForFinding(findingId)
        .map((disposition) => disposition.reviewerDecision.decision);
      expect(decisions).toContain('REJECTED');
      expect(decisions).not.toContain('ACCEPTED');
    }
  });

  it('escalates immediately when configuration allows only one review round', async () => {
    db.close();
    db = openDatabase(':memory:');
    build(
      configuration({
        maxCodeReviewRounds: 1,
        maxCorrectionPasses: 0,
        deferNonBlockingFindings: true,
        unresolvedAfterFinalReview: 'human_decision_required',
      }),
    );
    await reachImplementationComplete(1, 'implemented\n');
    const round1 = await runReview(1, 'NEEDS_REVISION', [{ key: 'high-defect', severity: 'high' }]);
    expect(round1.status).toBe('HUMAN_DECISION_REQUIRED');
    if (round1.status !== 'HUMAN_DECISION_REQUIRED') return;
    expect(round1.batch.persistedState).toBe('BLOCKED');
  });

  it('requires dispositions targeting the corrected commit before the final review', async () => {
    await reachImplementationComplete(1, 'implemented\n');
    const round1 = await runReview(1, 'NEEDS_REVISION', [{ key: 'high-defect', severity: 'high' }]);
    expect(round1.status).toBe('NEEDS_REVISION');
    await reachImplementationComplete(2, 'corrected\n');

    await expect(runReview(2, 'APPROVED', [])).rejects.toMatchObject({
      code: 'DISPOSITIONS_REQUIRED',
    });
  });

  it('rejects a contradicting verdict without consuming the review round', async () => {
    await reachImplementationComplete(1, 'implemented\n');
    const mismatch = await runReview(1, 'NEEDS_REVISION', [{ key: 'style-nit', severity: 'low' }]);
    expect(mismatch.status).toBe('REJECTED');
    if (mismatch.status !== 'REJECTED') return;
    expect(mismatch.errorCode).toBe('POLICY_MISMATCH');
    expect(store.getBatch(BATCH_ID)?.persistedState).toBe('IMPLEMENTATION_COMPLETE');
    expect(store.listCodeReviews(BATCH_ID)).toHaveLength(0);

    // The same round retries and succeeds; the mismatch did not spend pacing budget.
    const retried = await runReview(1, 'APPROVED', []);
    expect(retried.status).toBe('VERIFYING');
    if (retried.status !== 'VERIFYING') return;
    expect(retried.round).toBe(1);
  });

  it('rejects a reviewer that mutates the repository during a read-only review', async () => {
    await reachImplementationComplete(1, 'implemented\n');
    roleInvoker.enqueue({
      text: 'irrelevant',
      mutateRepository: () => {
        commitFile(repositoryRoot, 'src/example.txt', 'reviewer-tampered\n', 'tamper');
      },
    });
    const result = await codeReviewService.review({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      resolution: reviewerResolution,
      commandId: `${BATCH_ID}:code-review-tamper`,
      actorExecutionId: 'actor-review-tamper',
      invocationId: 'invocation-review-tamper',
      sessionIdentityId: 'session-reviewer',
      transcriptId: 'review-transcript-tamper',
      reviewRoundId: deriveCodeReviewRoundId(BATCH_ID, 1),
      buildPrompt: () => 'Review the complete batch.',
    });
    expect(result.status).toBe('REJECTED');
    if (result.status !== 'REJECTED') return;
    expect(result.errorCode).toBe('REVIEWER_MODIFIED_WORKTREE');
  });

  it('reserves and claims the invocation durably before the reviewer runs', async () => {
    await reachImplementationComplete(1, 'implemented\n');
    const commandId = `${BATCH_ID}:code-review-crash`;
    let observedDuringInvocation: readonly [string, string] | undefined;
    roleInvoker.enqueue({
      fail: true,
      onInvoke: () => {
        const stored = commandStore.get(commandId);
        observedDuringInvocation = [
          stored?.receipt.status ?? 'missing',
          stored?.sideEffect?.state ?? 'missing',
        ];
      },
    });
    await expect(
      codeReviewService.review({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        configuration: snapshot,
        resolution: reviewerResolution,
        commandId,
        actorExecutionId: 'actor-review-crash',
        invocationId: 'invocation-review-crash',
        sessionIdentityId: 'session-reviewer',
        transcriptId: 'review-transcript-crash',
        reviewRoundId: deriveCodeReviewRoundId(BATCH_ID, 1),
        buildPrompt: () => 'irrelevant',
      }),
    ).rejects.toThrow('Simulated bridge crash');
    // The receipt and side effect were durable BEFORE the bridge ran.
    expect(observedDuringInvocation).toEqual(['RUNNING', 'STARTING']);

    // A retry of the same command never re-invokes the reviewer.
    const invocationsBefore = roleInvoker.invocationsPerformed;
    await expect(
      codeReviewService.review({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        configuration: snapshot,
        resolution: reviewerResolution,
        commandId,
        actorExecutionId: 'actor-review-crash-retry',
        invocationId: 'invocation-review-crash-retry',
        sessionIdentityId: 'session-reviewer',
        transcriptId: 'review-transcript-crash-retry',
        reviewRoundId: deriveCodeReviewRoundId(BATCH_ID, 1),
        buildPrompt: () => 'irrelevant',
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_ALREADY_RESERVED' });
    expect(roleInvoker.invocationsPerformed).toBe(invocationsBefore);
  });

  it('reserves the implementation invocation durably and never re-invokes on retry', async () => {
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
    const commandId = `${attemptId}:ready`;
    let observedDuringInvocation: readonly [string, string] | undefined;
    roleInvoker.enqueue({
      fail: true,
      onInvoke: () => {
        const stored = commandStore.get(commandId);
        observedDuringInvocation = [
          stored?.receipt.status ?? 'missing',
          stored?.sideEffect?.state ?? 'missing',
        ];
      },
    });
    const executeInput = {
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      resolution: implementerResolution,
      commandId,
      actorExecutionId: 'actor-implementation-crash',
      invocationId: 'invocation-implementation-crash',
      sessionIdentityId: 'session-implementer',
      previousSessionIdentityId: 'session-implementer',
      transcriptId: 'implementation-transcript-crash',
      implementationAttemptId: attemptId,
      implementationReadyEvidenceId: deriveImplementationReadyEvidenceId(attemptId),
      attemptNumber: 1,
      creationMode: 'AGENT_AUTHORIZED',
      prompt: 'Implement the batch.',
    } as const;
    await expect(implementationService.execute(executeInput)).rejects.toThrow(
      'Simulated bridge crash',
    );
    expect(observedDuringInvocation).toEqual(['RUNNING', 'STARTING']);

    const invocationsBefore = roleInvoker.invocationsPerformed;
    await expect(implementationService.execute(executeInput)).rejects.toMatchObject({
      code: 'COMMAND_ALREADY_RESERVED',
    });
    expect(roleInvoker.invocationsPerformed).toBe(invocationsBefore);
  });

  it('binds commit creation mode to the durable ready evidence', async () => {
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
    // The agent-created attempt cannot be relabelled as human-created at completion.
    expect(() =>
      implementationService.complete({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        configuration: snapshot,
        implementationAttemptId: attemptId,
        implementationReadyEvidenceId: deriveImplementationReadyEvidenceId(attemptId),
        providedCommitSha: git(repositoryRoot, ['rev-parse', 'HEAD']),
        creationMode: 'HUMAN_CREATED',
        humanCreator: {
          actorExecutionId: 'human-commit-creator',
          actorType: 'HUMAN',
          authoritiesExercised: ['COMMIT_CREATOR'],
          identityAssurance: 'CLI_ASSERTED',
          observedEvidence: [],
          startedAt: NOW,
        },
        commandId: `${attemptId}:complete-as-human`,
      }),
    ).toThrow(/CREATION_MODE_MISMATCH|records a AGENT_AUTHORIZED/);
  });

  it('blocks a criterion-bound medium finding and defers an unlinked one', async () => {
    await reachImplementationComplete(1, 'implemented\n');
    const linked = await runReview(1, 'NEEDS_REVISION', [
      { key: 'medium-linked', severity: 'medium', acceptanceCriterionId: 'criterion-required' },
      { key: 'medium-unlinked', severity: 'medium' },
    ]);
    expect(linked.status).toBe('NEEDS_REVISION');
    if (linked.status !== 'NEEDS_REVISION') return;
    expect(linked.blockingFindingCount).toBe(1);
    expect(linked.deferredFindingIds).toHaveLength(1);
  });

  it('rejects a second correction pass after the single permitted attempt', async () => {
    await reachImplementationComplete(1, 'implemented\n');
    const round1 = await runReview(1, 'NEEDS_REVISION', [{ key: 'high-defect', severity: 'high' }]);
    expect(round1.status).toBe('NEEDS_REVISION');
    await reachImplementationComplete(2, 'corrected\n');
    if (round1.status !== 'NEEDS_REVISION') return;
    submitDispositions(round1.blockingFindingIds);
    const round2 = await runReview(2, 'NEEDS_REVISION', [
      { key: 'regression', severity: 'critical' },
    ]);
    expect(round2.status).toBe('HUMAN_DECISION_REQUIRED');

    // A human resume back to NEEDS_REVISION cannot buy a third automatic correction.
    await expect(
      implementationService.resume({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        configuration: snapshot,
        resolution: implementerResolution,
        commandId: `${BATCH_ID}:resume-implementation-3`,
        actorExecutionId: 'actor-resume-3',
        invocationId: 'invocation-resume-3',
        sessionIdentityId: 'session-implementer',
        previousSessionIdentityId: 'session-implementer',
        prompt: 'Return READY.',
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/PACING_EXHAUSTED|INVALID_STATE/) });
  });

  it('refuses a third review round outright', async () => {
    await reachImplementationComplete(1, 'implemented\n');
    const round1 = await runReview(1, 'NEEDS_REVISION', [{ key: 'high-defect', severity: 'high' }]);
    expect(round1.status).toBe('NEEDS_REVISION');
    if (round1.status !== 'NEEDS_REVISION') return;
    await reachImplementationComplete(2, 'corrected\n');
    submitDispositions(round1.blockingFindingIds);
    const round2 = await runReview(2, 'APPROVED', []);
    expect(round2.status).toBe('VERIFYING');

    await expect(runReview(3, 'APPROVED', [])).rejects.toBeInstanceOf(
      ReviewWorkflowImplementationError,
    );
  });
});
