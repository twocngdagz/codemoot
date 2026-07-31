// End-to-end proof of mandatory role-session continuity through the REAL coordinators and
// the REAL RoleInvocationService: the correction pass resumes the initial implementation
// session, the bounded final review and the final audit resume the initial reviewer
// session, the two roles never share a vendor session, and command replay never re-invokes.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/schema.js';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowCommandStore } from '../../../src/memory/review-workflow-command-store.js';
import type { BridgeCallResult, BridgeOptions, CliBridge } from '../../../src/models/bridge.js';
import { ReviewWorkflowContractService } from '../../../src/review-workflow-contracts/service.js';
import { ReviewWorkflowGateService } from '../../../src/review-workflow-gate/service.js';
import { ReviewWorkflowGateStore } from '../../../src/review-workflow-gate/store.js';
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
import type {
  ActorExecutionIdentity,
  BatchPlanVersion,
  ReviewWorkflowBatch,
  WorkflowRun,
} from '../../../src/review-workflow/types.js';
import { RoleInvocationService } from '../../../src/roles/role-invocation.js';
import type { ResolvedRoleAdapter } from '../../../src/roles/role-manager.js';

const NOW = '2026-08-01T12:00:00.000Z';
const LATER = '2026-08-01T12:01:00.000Z';
const BATCH_ID = 'batch-16';

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
      workflowId: 'workflow-16',
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      assignedAt: NOW,
    },
  );
}

interface QueuedResponse {
  readonly text?: string;
  readonly fromPrompt?: (prompt: string) => string;
  readonly mutateRepository?: () => void;
}

interface LoggedBridgeCall {
  readonly kind: 'send' | 'resume';
  readonly sessionId?: string;
}

/** A role-capable bridge that proves resumes by echoing the requested vendor session. */
class QueueBridge implements CliBridge {
  readonly calls: LoggedBridgeCall[] = [];
  private readonly queue: QueuedResponse[] = [];
  private counter = 0;
  private processCounter = 100;

  constructor(
    readonly name: string,
    readonly model: string,
    private readonly provider: string,
  ) {}

  readonly capabilities = {
    supportsResume: true,
    supportsStream: false,
    maxContextTokens: 100_000,
    supportsTools: true,
    supportsCwd: true,
  };

  enqueue(response: QueuedResponse): void {
    this.queue.push(response);
  }

  async send(prompt: string, _options?: BridgeOptions): Promise<BridgeCallResult> {
    this.calls.push({ kind: 'send' });
    this.counter += 1;
    return this.respond(prompt, `${this.name}-thread-${this.counter}`, undefined);
  }

  async resume(
    sessionId: string,
    prompt: string,
    _options?: BridgeOptions,
  ): Promise<BridgeCallResult> {
    this.calls.push({ kind: 'resume', sessionId });
    return this.respond(prompt, sessionId, sessionId);
  }

  private respond(
    prompt: string,
    vendorId: string,
    resumedFrom: string | undefined,
  ): BridgeCallResult {
    const next = this.queue.shift();
    if (next === undefined) throw new Error(`No queued response for bridge ${this.name}`);
    next.mutateRepository?.();
    const text = next.fromPrompt !== undefined ? next.fromPrompt(prompt) : (next.text ?? '');
    this.processCounter += 1;
    return {
      text,
      model: this.model,
      provider: this.provider,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0 },
      finishReason: 'stop',
      durationMs: 50,
      meteringSource: 'sdk',
      sessionId: vendorId,
      invocationEvidence: {
        adapterKind: this.name === 'claude' ? 'CLAUDE' : 'CODEX',
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
  readonly verdict: 'APPROVED' | 'NEEDS_REVISION';
  readonly findings: readonly { readonly key: string; readonly severity: string }[];
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
    verdict: input.verdict,
    summary: 'Complete consolidated review.',
    findings: input.findings.map((finding) => ({
      findingKey: finding.key,
      severity: finding.severity,
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

function finalAuditTranscript(target: unknown, criterionIds: readonly string[]): string {
  const check = (subjectId: string) => ({
    subjectId,
    status: 'PASSED',
    explanation: 'Verified against the final-gate diff.',
    evidence: [{ kind: 'FILE', location: 'src/example.txt', description: 'Audited evidence.' }],
  });
  return JSON.stringify({
    schemaVersion: 1,
    contractKind: 'FINAL_AUDIT_RESULT',
    target,
    verdict: 'APPROVED',
    summary: 'Complete final completeness audit.',
    findings: [],
    requirementChecks: [],
    acceptanceCriterionChecks: criterionIds.map(check),
    scopeComplete: true,
    documentationComplete: true,
  });
}

describe('role-session continuity across the bounded batch lifecycle', () => {
  let db: Database.Database;
  let repositoryRoot: string;
  let baseSha: string;
  let snapshot: ReviewWorkflowConfigurationSnapshot;
  let store: ReviewWorkflowGateStore;
  let commandStore: ReviewWorkflowCommandStore;
  let roleInvoker: RoleInvocationService;
  let implementerBridge: QueueBridge;
  let reviewerBridge: QueueBridge;
  let implementationService: ReviewWorkflowImplementationService;
  let codeReviewService: ReviewWorkflowCodeReviewService;
  let gateService: ReviewWorkflowGateService;
  let implementerResolution: ResolvedRoleAdapter;
  let reviewerResolution: ResolvedRoleAdapter;

  beforeEach(() => {
    repositoryRoot = mkdtempSync(join(tmpdir(), 'codemoot-continuity-'));
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.name', 'CodeMoot Test']);
    git(repositoryRoot, ['config', 'user.email', 'codemoot@example.com']);
    baseSha = commitFile(repositoryRoot, 'src/example.txt', 'base\n', 'base');
    db = openDatabase(':memory:');
    snapshot = configuration();
    store = new ReviewWorkflowGateStore(db);
    commandStore = new ReviewWorkflowCommandStore(db, () => new Date(LATER));
    roleInvoker = new RoleInvocationService(store.workflowStore);
    implementerBridge = new QueueBridge('claude', 'claude-supported', 'anthropic');
    reviewerBridge = new QueueBridge('codex', 'codex-supported', 'openai');
    implementerResolution = {
      role: 'implementer',
      assignment: snapshot.assignments.implementer,
      adapter: implementerBridge,
    };
    reviewerResolution = {
      role: 'reviewer',
      assignment: snapshot.assignments.reviewer,
      adapter: reviewerBridge,
    };
    const workflow: WorkflowRun = {
      workflowId: snapshot.workflowId,
      status: 'ACTIVE',
      generalPlanVersionId: 'general-plan-16',
      implementerAssignmentId: snapshot.assignments.implementer.assignmentId,
      reviewerAssignmentId: snapshot.assignments.reviewer.assignmentId,
      configurationHash: snapshot.configurationHash,
      refinedPlanVersionId: 'refined-plan-16',
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
      batchPlanVersionId: 'batch-plan-16',
      workflowId: workflow.workflowId,
      batchId: BATCH_ID,
      version: 1,
      contentHash: 'plan-content-hash',
      repositoryContextSha: baseSha,
      objective: 'Prove role-session continuity across the bounded lifecycle.',
      currentRepositoryEvidence: [
        { kind: 'FILE', location: 'src/example.txt', description: 'Current target.' },
      ],
      dependencies: [],
      candidateFiles: ['src/example.txt'],
      technicalImplementation: ['Update the implementation target.'],
      userJourney: ['The operator runs the batch lifecycle.'],
      expectedBehaviour: ['Sessions persist per role across the batch.'],
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
      outOfScope: ['Anything beyond continuity.'],
      rollbackBoundary: 'Revert the implementation commit.',
      addressedFindingIds: [],
      actorExecutionId: planAuthor.actorExecutionId,
      createdAt: NOW,
    };
    const batch: ReviewWorkflowBatch = {
      batchId: BATCH_ID,
      workflowId: workflow.workflowId,
      ordinal: 16,
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
    const repository = new LocalGitRepository(repositoryRoot);
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
  });

  afterEach(() => {
    db.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  });

  async function implementAttempt(attemptNumber: number, content: string): Promise<string> {
    implementerBridge.enqueue({ text: 'READY' });
    if (attemptNumber === 1) {
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
      await implementationService.resume({
        workflowId: snapshot.workflowId,
        batchId: BATCH_ID,
        configuration: snapshot,
        resolution: implementerResolution,
        commandId: `${BATCH_ID}:resume-implementation-${attemptNumber}`,
        actorExecutionId: `actor-resume-${attemptNumber}`,
        invocationId: `invocation-resume-${attemptNumber}`,
        sessionIdentityId: `session-resume-${attemptNumber}`,
        previousSessionIdentityId: 'session-implementer',
        prompt: 'Return READY.',
      });
    }
    const attemptId = deriveImplementationAttemptId(BATCH_ID, attemptNumber);
    implementerBridge.enqueue({
      text: implementationTranscript(['src/example.txt']),
      mutateRepository: () => {
        commitFile(repositoryRoot, 'src/example.txt', content, `implementation ${attemptNumber}`);
      },
    });
    await implementationService.execute({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      resolution: implementerResolution,
      commandId: `${attemptId}:ready`,
      actorExecutionId: `actor-implementation-${attemptNumber}`,
      invocationId: `invocation-implementation-${attemptNumber}`,
      sessionIdentityId: `session-execute-${attemptNumber}`,
      previousSessionIdentityId: 'session-implementer',
      transcriptId: `implementation-transcript-${attemptNumber}`,
      implementationAttemptId: attemptId,
      implementationReadyEvidenceId: deriveImplementationReadyEvidenceId(attemptId),
      attemptNumber,
      creationMode: 'AGENT_AUTHORIZED',
      prompt: 'Implement the batch.',
    });
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
    return head;
  }

  async function runReview(
    round: number,
    verdict: 'APPROVED' | 'NEEDS_REVISION',
    findings: readonly { readonly key: string; readonly severity: string }[],
  ) {
    reviewerBridge.enqueue({
      fromPrompt: (prompt) => {
        const parsed = JSON.parse(prompt) as {
          target: { reviewedCommitSha: string; reviewRangeEvidenceId: string; patchHash: string };
        };
        return reviewTranscript({ ...parsed.target, verdict, findings });
      },
    });
    return codeReviewService.review({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      resolution: reviewerResolution,
      commandId: `${BATCH_ID}:code-review-${round}`,
      actorExecutionId: `actor-review-${round}`,
      invocationId: `invocation-review-${round}`,
      sessionIdentityId: `session-review-${round}`,
      transcriptId: `review-transcript-${round}`,
      reviewRoundId: deriveCodeReviewRoundId(BATCH_ID, round),
      buildPrompt: (evidence) => JSON.stringify({ target: evidence.target }),
    });
  }

  it('holds one session per role across implementation, correction, final review, and audit', async () => {
    // Attempt 1 creates the implementer session; execute must resume it.
    await implementAttempt(1, 'implemented\n');
    const implementerBinding = store.workflowStore.getBatchRoleSession(BATCH_ID, 'IMPLEMENTER');
    expect(implementerBinding?.vendorSessionId).toBe('claude-thread-1');

    // Round 1 creates the reviewer session.
    const round1 = await runReview(1, 'NEEDS_REVISION', [{ key: 'high-defect', severity: 'high' }]);
    expect(round1.status).toBe('NEEDS_REVISION');
    if (round1.status !== 'NEEDS_REVISION') return;
    const reviewerBinding = store.workflowStore.getBatchRoleSession(BATCH_ID, 'REVIEWER');
    expect(reviewerBinding?.vendorSessionId).toBe('codex-thread-1');
    // Implementer and reviewer vendor sessions are always different.
    expect(implementerBinding?.vendorSessionId).not.toBe(reviewerBinding?.vendorSessionId);

    // The correction resumes the initial implementation session for every invocation.
    const correctedHead = await implementAttempt(2, 'corrected\n');
    expect(implementerBridge.calls).toEqual([
      { kind: 'send' },
      { kind: 'resume', sessionId: 'claude-thread-1' },
      { kind: 'resume', sessionId: 'claude-thread-1' },
      { kind: 'resume', sessionId: 'claude-thread-1' },
    ]);

    const dispositions = codeReviewService.submitDispositions({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      transcriptId: 'disposition-transcript-1',
      actorExecutionId: 'actor-implementation-2',
      rawTranscript: dispositionTranscript(correctedHead, round1.blockingFindingIds),
      createdAt: LATER,
    });
    expect(dispositions.accepted).toBe(true);

    // The bounded final review resumes the initial reviewer session.
    const round2 = await runReview(2, 'APPROVED', []);
    expect(round2.status).toBe('VERIFYING');
    expect(reviewerBridge.calls).toEqual([
      { kind: 'send' },
      { kind: 'resume', sessionId: 'codex-thread-1' },
    ]);

    // The final audit also resumes the initial reviewer session.
    reviewerBridge.enqueue({
      fromPrompt: (prompt) => {
        const evidence = JSON.parse(prompt) as {
          target: unknown;
          acceptanceCriterionIds: readonly string[];
        };
        return finalAuditTranscript(evidence.target, evidence.acceptanceCriterionIds);
      },
    });
    const audit = await gateService.finalAudit({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      resolution: reviewerResolution,
      commandId: `${BATCH_ID}:final-audit`,
      actorExecutionId: 'actor-final-audit',
      invocationId: 'invocation-final-audit',
      sessionIdentityId: 'session-final-audit',
      transcriptId: 'final-audit-transcript',
      buildPrompt: (evidence) =>
        JSON.stringify({
          target: evidence.target,
          acceptanceCriterionIds: evidence.acceptanceCriterionIds,
        }),
    });
    expect(audit.capture.accepted).toBe(true);
    expect(reviewerBridge.calls).toEqual([
      { kind: 'send' },
      { kind: 'resume', sessionId: 'codex-thread-1' },
      { kind: 'resume', sessionId: 'codex-thread-1' },
    ]);

    // Command replay returns the stored result without invoking or resuming again.
    const replayed = await gateService.finalAudit({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      resolution: reviewerResolution,
      commandId: `${BATCH_ID}:final-audit`,
      actorExecutionId: 'actor-final-audit-replay',
      invocationId: 'invocation-final-audit-replay',
      sessionIdentityId: 'session-final-audit-replay',
      transcriptId: 'final-audit-transcript-replay',
      buildPrompt: () => 'unused',
    });
    expect(replayed.replayed).toBe(true);
    expect(reviewerBridge.calls).toHaveLength(3);

    // Complete continuity evidence: every invocation recorded with role, adapter, and IDs.
    const evidence = store.workflowStore.listSessionContinuity(BATCH_ID);
    const outcomes = (role: string) =>
      evidence
        .filter((row) => row.role === role)
        .map((row) => row.outcome)
        .sort();
    // One creation per role, every later invocation resumed (fixture timestamps are
    // identical, so ordering is by ID — count outcomes instead).
    expect(outcomes('IMPLEMENTER')).toEqual(['CREATED', 'RESUMED', 'RESUMED', 'RESUMED']);
    expect(outcomes('REVIEWER')).toEqual(['CREATED', 'RESUMED', 'RESUMED']);
    for (const row of evidence) {
      expect(row.workflowId).toBe(snapshot.workflowId);
      expect(row.batchId).toBe(BATCH_ID);
      expect(row.invocationId.length).toBeGreaterThan(0);
      expect(['CLAUDE', 'CODEX']).toContain(row.adapterKind);
      expect(row.returnedVendorSessionId).toBeDefined();
    }
  });

  it('blocks the batch when the reviewer session cannot be resumed for the final review', async () => {
    await implementAttempt(1, 'implemented\n');
    const round1 = await runReview(1, 'NEEDS_REVISION', [{ key: 'high-defect', severity: 'high' }]);
    expect(round1.status).toBe('NEEDS_REVISION');
    if (round1.status !== 'NEEDS_REVISION') return;
    const correctedHead = await implementAttempt(2, 'corrected\n');
    codeReviewService.submitDispositions({
      workflowId: snapshot.workflowId,
      batchId: BATCH_ID,
      configuration: snapshot,
      transcriptId: 'disposition-transcript-1',
      actorExecutionId: 'actor-implementation-2',
      rawTranscript: dispositionTranscript(correctedHead, round1.blockingFindingIds),
      createdAt: LATER,
    });

    // The vendor rejects the resume: the round-2 review must fail closed and block.
    reviewerBridge.resume = async () => {
      reviewerBridge.calls.push({ kind: 'resume', sessionId: 'codex-thread-1' });
      throw new Error('vendor rejected or expired the session');
    };
    await expect(runReview(2, 'APPROVED', [])).rejects.toMatchObject({
      code: 'SESSION_RESUME_FAILED',
    });
    const batch = store.getBatch(BATCH_ID);
    expect(batch?.persistedState).toBe('BLOCKED');
    const blockedEvent = store
      .getEvents(BATCH_ID)
      .filter((event) => event.eventType === 'BATCH_BLOCKED')
      .at(-1);
    expect(String(blockedEvent?.payload.reason)).toContain(
      'SESSION_CONTINUITY_FAILURE:SESSION_RESUME_FAILED',
    );
    // No fallback: the reviewer bridge was never asked for a fresh session afterwards.
    expect(reviewerBridge.calls.filter((call) => call.kind === 'send')).toHaveLength(1);
  });
});
