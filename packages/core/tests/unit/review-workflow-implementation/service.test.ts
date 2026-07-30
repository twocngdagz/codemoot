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
import { ReviewWorkflowImplementationService } from '../../../src/review-workflow-implementation/service.js';
import { ReviewWorkflowImplementationStore } from '../../../src/review-workflow-implementation/store.js';
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
          cliAdapter: {
            kind: 'claude',
            command: 'claude',
            args: [],
            timeout: 600,
            versionConstraint: '>=2',
          },
        },
        reviewer: {
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
  readonly text: string;
  readonly mutateRepository?: () => void;
}

class FakeRoleInvoker {
  private readonly queue: QueuedInvocation[] = [];

  constructor(private readonly store: ReviewWorkflowImplementationStore) {}

  enqueue(invocation: QueuedInvocation): void {
    this.queue.push(invocation);
  }

  async prepare(input: RoleInvocationInput): Promise<PreparedRoleInvocation> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error('No fake role invocation was queued');
    next.mutateRepository?.();
    const resumed = input.previousSessionIdentityId !== undefined;
    const sessionIdentityId = input.previousSessionIdentityId ?? input.sessionIdentityId;
    const vendorSessionId = 'vendor-implementer-session';
    const call: BridgeCallResult = {
      text: next.text,
      model: input.resolution.assignment.configuredModel,
      provider: 'anthropic',
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
        actorMechanism: 'fake-claude-cli',
        adapterKind: 'CLAUDE',
        configuredModel: input.resolution.assignment.configuredModel,
        workingDirectory: '/repository',
        processId: 111,
        processInstanceFingerprint: 'f'.repeat(64),
        startedAt: NOW,
        finishedAt: LATER,
        resultStatus: 'SUCCEEDED',
      },
      session: {
        sessionIdentityId,
        workflowId: input.workflowId,
        providerOrAdapter: 'claude',
        vendorSessionId,
        creatingInvocationId: resumed ? 'invocation-preflight' : input.invocationId,
        resumeLineage: [],
        assignedRole: 'IMPLEMENTER',
        createdAt: NOW,
        lastUsedAt: LATER,
      },
      execution: {
        actorExecutionId: input.actorExecutionId,
        actorType: 'AGENT',
        assignmentId: input.resolution.assignment.assignmentId,
        invocationIdentityId: input.invocationId,
        sessionIdentityId,
        authoritiesExercised: ['IMPLEMENTER', ...(input.additionalAuthorities ?? [])],
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

function implementationTranscript(
  outcome: 'COMPLETE' | 'BLOCKED',
  changedFiles: readonly string[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    contractKind: 'IMPLEMENTATION_RESULT',
    outcome,
    summary: outcome === 'COMPLETE' ? 'Implemented the approved batch.' : 'Blocked externally.',
    ...(outcome === 'BLOCKED' ? { blockerReason: 'Required external system is unavailable.' } : {}),
    changedFiles,
    verificationRecordIds: [],
  });
}

describe('ReviewWorkflowImplementationService', () => {
  let db: Database.Database;
  let repositoryRoot: string;
  let baseSha: string;
  let snapshot: ReviewWorkflowConfigurationSnapshot;
  let store: ReviewWorkflowImplementationStore;
  let commandStore: ReviewWorkflowCommandStore;
  let repository: LocalGitRepository;
  let roleInvoker: FakeRoleInvoker;
  let service: ReviewWorkflowImplementationService;
  let resolution: ResolvedRoleAdapter;

  beforeEach(() => {
    repositoryRoot = mkdtempSync(join(tmpdir(), 'codemoot-implementation-'));
    git(repositoryRoot, ['init', '-b', 'main']);
    git(repositoryRoot, ['config', 'user.name', 'CodeMoot Test']);
    git(repositoryRoot, ['config', 'user.email', 'codemoot@example.com']);
    baseSha = commitFile(repositoryRoot, 'src/example.txt', 'base\n', 'base');

    db = openDatabase(':memory:');
    snapshot = configuration();
    store = new ReviewWorkflowImplementationStore(db);
    commandStore = new ReviewWorkflowCommandStore(db, () => new Date(LATER));
    repository = new LocalGitRepository(repositoryRoot);
    roleInvoker = new FakeRoleInvoker(store);
    resolution = {
      role: 'implementer',
      assignment: snapshot.assignments.implementer,
      adapter: UNUSED_ADAPTER,
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
      batchId: 'batch-11',
      version: 1,
      contentHash: 'plan-content-hash',
      repositoryContextSha: baseSha,
      objective: 'Implement the complete approved batch.',
      currentRepositoryEvidence: [
        {
          kind: 'FILE',
          location: 'src/example.txt',
          description: 'Current implementation target.',
        },
      ],
      dependencies: [],
      candidateFiles: ['src/example.txt'],
      technicalImplementation: ['Update the implementation target.'],
      userJourney: ['The operator runs the implementation command.'],
      expectedBehaviour: ['The batch reaches implementation complete.'],
      technicalAcceptanceCriteria: [],
      userFacingAcceptanceCriteria: [],
      cliAcceptanceCriteria: [],
      browserAcceptanceCriteria: {
        applicability: 'NOT_APPLICABLE',
        reason: 'No browser behavior.',
      },
      verificationCommands: [],
      manualVerification: [],
      documentationChanges: [],
      outOfScope: ['Code review and merge gating.'],
      rollbackBoundary: 'Revert the implementation commit.',
      addressedFindingIds: [],
      actorExecutionId: planAuthor.actorExecutionId,
      createdAt: NOW,
    };
    const batch: ReviewWorkflowBatch = {
      batchId: plan.batchId,
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
    const gitService = new ReviewWorkflowGitService(repository, {
      storePatch: () => 'unused://patch',
    });
    service = new ReviewWorkflowImplementationService(
      store,
      commandStore,
      new ReviewWorkflowContractService(store.workflowStore),
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

  async function startImplementation() {
    roleInvoker.enqueue({ text: 'READY' });
    return service.start({
      workflowId: snapshot.workflowId,
      batchId: 'batch-11',
      configuration: snapshot,
      resolution,
      commandId: 'batch-11:start-implementation',
      actorExecutionId: 'actor-preflight',
      invocationId: 'invocation-preflight',
      sessionIdentityId: 'session-implementer',
      prompt: 'Return READY.',
    });
  }

  it('runs the human-commit lifecycle through the explicit awaiting-commit boundary', async () => {
    const started = await startImplementation();
    expect(started.batch).toMatchObject({
      persistedState: 'IMPLEMENTING',
      originalBatchBaseSha: baseSha,
    });

    roleInvoker.enqueue({
      text: implementationTranscript('COMPLETE', ['src/example.txt']),
      mutateRepository: () =>
        writeFileSync(join(repositoryRoot, 'src/example.txt'), 'implemented\n'),
    });
    const executed = await service.execute({
      workflowId: snapshot.workflowId,
      batchId: 'batch-11',
      configuration: snapshot,
      resolution,
      commandId: 'batch-11:implementation:1:ready',
      actorExecutionId: 'actor-implementation',
      invocationId: 'invocation-implementation',
      sessionIdentityId: started.implementerSessionIdentityId,
      previousSessionIdentityId: started.implementerSessionIdentityId,
      transcriptId: 'implementation-transcript-1',
      implementationAttemptId: 'batch-11:implementation:1',
      implementationReadyEvidenceId: 'batch-11:implementation:1:ready',
      attemptNumber: 1,
      creationMode: 'HUMAN_CREATED',
      prompt: 'Implement without committing.',
    });

    expect(executed.status).toBe('AWAITING_COMMIT');
    if (executed.status !== 'AWAITING_COMMIT') return;
    expect(executed.implementationReadyEvidence.changedFiles).toEqual(['src/example.txt']);
    expect(repository.readWorktree()).toMatchObject({ headSha: baseSha, clean: false });

    const implementationSha = commitFile(
      repositoryRoot,
      'src/example.txt',
      'implemented\n',
      'implementation',
    );
    const humanCreator: ActorExecutionIdentity = {
      actorExecutionId: 'human-commit-creator',
      actorType: 'HUMAN',
      authoritiesExercised: ['COMMIT_CREATOR'],
      identityAssurance: 'CLI_ASSERTED',
      observedEvidence: [],
      startedAt: LATER,
    };
    const completed = service.complete({
      workflowId: snapshot.workflowId,
      batchId: 'batch-11',
      configuration: snapshot,
      implementationAttemptId: executed.attempt.implementationAttemptId,
      implementationReadyEvidenceId:
        executed.implementationReadyEvidence.implementationReadyEvidenceId,
      providedCommitSha: implementationSha,
      creationMode: 'HUMAN_CREATED',
      humanCreator,
      commandId: `batch-11:complete-implementation:${implementationSha}`,
    });

    expect(completed.batch.persistedState).toBe('IMPLEMENTATION_COMPLETE');
    expect(completed.implementationCommit).toMatchObject({
      resultingCommitSha: implementationSha,
      creatorActorExecutionId: humanCreator.actorExecutionId,
      creationMode: 'HUMAN_CREATED',
    });
    expect(store.workflowStore.getEvents('batch-11').map((event) => event.eventType)).toEqual([
      'IMPLEMENTATION_STARTED',
      'IMPLEMENTATION_READY',
      'IMPLEMENTATION_COMMIT_VALIDATED',
    ]);
  });

  it('validates an agent-created commit against its persisted implementing execution', async () => {
    const started = await startImplementation();
    let implementationSha = '';
    roleInvoker.enqueue({
      text: implementationTranscript('COMPLETE', ['src/example.txt']),
      mutateRepository: () => {
        implementationSha = commitFile(
          repositoryRoot,
          'src/example.txt',
          'agent implementation\n',
          'agent implementation',
        );
      },
    });
    const executed = await service.execute({
      workflowId: snapshot.workflowId,
      batchId: 'batch-11',
      configuration: snapshot,
      resolution,
      commandId: 'batch-11:implementation:1:ready',
      actorExecutionId: 'actor-agent-implementation',
      invocationId: 'invocation-agent-implementation',
      sessionIdentityId: started.implementerSessionIdentityId,
      previousSessionIdentityId: started.implementerSessionIdentityId,
      transcriptId: 'implementation-agent-transcript',
      implementationAttemptId: 'batch-11:implementation:1',
      implementationReadyEvidenceId: 'batch-11:implementation:1:ready',
      attemptNumber: 1,
      creationMode: 'AGENT_AUTHORIZED',
      prompt: 'Implement and commit.',
    });

    expect(executed.status).toBe('AWAITING_COMMIT');
    if (executed.status !== 'AWAITING_COMMIT') return;
    expect(
      store.getActorExecution(executed.attempt.implementerActorExecutionId)?.authoritiesExercised,
    ).toContain('COMMIT_CREATOR');
    const completed = service.complete({
      workflowId: snapshot.workflowId,
      batchId: 'batch-11',
      configuration: snapshot,
      implementationAttemptId: executed.attempt.implementationAttemptId,
      implementationReadyEvidenceId:
        executed.implementationReadyEvidence.implementationReadyEvidenceId,
      providedCommitSha: implementationSha,
      creationMode: 'AGENT_AUTHORIZED',
      commandId: `batch-11:complete-implementation:${implementationSha}`,
    });

    expect(completed.implementationCommit).toMatchObject({
      resultingCommitSha: implementationSha,
      creatorActorExecutionId: executed.attempt.implementerActorExecutionId,
      creationMode: 'AGENT_AUTHORIZED',
    });
  });

  it('returns from awaiting commit to implementation through a stable-session preflight', async () => {
    const started = await startImplementation();
    roleInvoker.enqueue({
      text: implementationTranscript('COMPLETE', ['src/example.txt']),
      mutateRepository: () =>
        writeFileSync(join(repositoryRoot, 'src/example.txt'), 'implemented\n'),
    });
    const executed = await service.execute({
      workflowId: snapshot.workflowId,
      batchId: 'batch-11',
      configuration: snapshot,
      resolution,
      commandId: 'batch-11:implementation:1:ready',
      actorExecutionId: 'actor-implementation',
      invocationId: 'invocation-implementation',
      sessionIdentityId: started.implementerSessionIdentityId,
      previousSessionIdentityId: started.implementerSessionIdentityId,
      transcriptId: 'implementation-transcript-resume',
      implementationAttemptId: 'batch-11:implementation:1',
      implementationReadyEvidenceId: 'batch-11:implementation:1:ready',
      attemptNumber: 1,
      creationMode: 'HUMAN_CREATED',
      prompt: 'Implement without committing.',
    });
    expect(executed.status).toBe('AWAITING_COMMIT');

    roleInvoker.enqueue({ text: 'READY' });
    const resumed = await service.resume({
      workflowId: snapshot.workflowId,
      batchId: 'batch-11',
      configuration: snapshot,
      resolution,
      commandId: 'batch-11:resume-implementation:2',
      actorExecutionId: 'actor-resume',
      invocationId: 'invocation-resume',
      sessionIdentityId: started.implementerSessionIdentityId,
      previousSessionIdentityId: started.implementerSessionIdentityId,
      prompt: 'Return READY.',
    });

    expect(resumed.batch.persistedState).toBe('IMPLEMENTING');
    expect(resumed.repository).toMatchObject({
      headSha: baseSha,
      clean: false,
      changedPaths: ['src/example.txt'],
    });
    expect(store.workflowStore.getEvents('batch-11').at(-1)?.eventType).toBe(
      'IMPLEMENTATION_RESUMED',
    );
  });

  it('fails a preflight that mutates the repository without starting implementation', async () => {
    roleInvoker.enqueue({
      text: 'READY',
      mutateRepository: () => writeFileSync(join(repositoryRoot, 'unexpected.txt'), 'changed\n'),
    });

    await expect(
      service.start({
        workflowId: snapshot.workflowId,
        batchId: 'batch-11',
        configuration: snapshot,
        resolution,
        commandId: 'batch-11:start-implementation',
        actorExecutionId: 'actor-preflight',
        invocationId: 'invocation-preflight',
        sessionIdentityId: 'session-implementer',
        prompt: 'Return READY.',
      }),
    ).rejects.toMatchObject({ code: 'PREFLIGHT_INVALID' });
    expect(store.getBatch('batch-11')?.persistedState).toBe('APPROVED_FOR_IMPLEMENTATION');
    expect(commandStore.get('batch-11:start-implementation')?.receipt).toMatchObject({
      status: 'FAILED_FINAL',
      errorCode: 'PREFLIGHT_REPOSITORY_CHANGED',
    });
  });

  it('persists a rejected handoff when claimed files disagree with repository evidence', async () => {
    const started = await startImplementation();
    roleInvoker.enqueue({
      text: implementationTranscript('COMPLETE', ['src/not-changed.txt']),
      mutateRepository: () =>
        writeFileSync(join(repositoryRoot, 'src/example.txt'), 'implemented\n'),
    });
    const result = await service.execute({
      workflowId: snapshot.workflowId,
      batchId: 'batch-11',
      configuration: snapshot,
      resolution,
      commandId: 'batch-11:implementation:1:ready',
      actorExecutionId: 'actor-implementation',
      invocationId: 'invocation-implementation',
      sessionIdentityId: started.implementerSessionIdentityId,
      previousSessionIdentityId: started.implementerSessionIdentityId,
      transcriptId: 'implementation-transcript-mismatch',
      implementationAttemptId: 'batch-11:implementation:1',
      implementationReadyEvidenceId: 'batch-11:implementation:1:ready',
      attemptNumber: 1,
      creationMode: 'HUMAN_CREATED',
      prompt: 'Implement without committing.',
    });

    expect(result).toMatchObject({
      status: 'REJECTED',
      errorCode: 'CHANGED_FILES_MISMATCH',
      batch: { persistedState: 'IMPLEMENTING' },
    });
    expect(store.getImplementationAttempt('batch-11:implementation:1')).not.toBeNull();
    expect(store.getImplementationReadyEvidence('batch-11:implementation:1:ready')).toBeNull();
    expect(commandStore.get('batch-11:implementation:1:ready')?.receipt.status).toBe(
      'FAILED_FINAL',
    );

    roleInvoker.enqueue({
      text: implementationTranscript('COMPLETE', ['src/example.txt']),
    });
    const corrected = await service.execute({
      workflowId: snapshot.workflowId,
      batchId: 'batch-11',
      configuration: snapshot,
      resolution,
      commandId: 'batch-11:implementation:2:ready',
      actorExecutionId: 'actor-implementation-correction',
      invocationId: 'invocation-implementation-correction',
      sessionIdentityId: started.implementerSessionIdentityId,
      previousSessionIdentityId: started.implementerSessionIdentityId,
      transcriptId: 'implementation-transcript-correction',
      implementationAttemptId: 'batch-11:implementation:2',
      implementationReadyEvidenceId: 'batch-11:implementation:2:ready',
      attemptNumber: 2,
      creationMode: 'HUMAN_CREATED',
      prompt: 'Correct the complete implementation handoff without committing.',
    });

    expect(corrected).toMatchObject({
      status: 'AWAITING_COMMIT',
      attempt: { attemptNumber: 2 },
      implementationReadyEvidence: { changedFiles: ['src/example.txt'] },
    });
  });

  it('records a genuine model-reported external blocker as a conservative batch block', async () => {
    const started = await startImplementation();
    roleInvoker.enqueue({ text: implementationTranscript('BLOCKED', []) });
    const result = await service.execute({
      workflowId: snapshot.workflowId,
      batchId: 'batch-11',
      configuration: snapshot,
      resolution,
      commandId: 'batch-11:implementation:1:ready',
      actorExecutionId: 'actor-blocked-implementation',
      invocationId: 'invocation-blocked-implementation',
      sessionIdentityId: started.implementerSessionIdentityId,
      previousSessionIdentityId: started.implementerSessionIdentityId,
      transcriptId: 'implementation-blocked-transcript',
      implementationAttemptId: 'batch-11:implementation:1',
      implementationReadyEvidenceId: 'batch-11:implementation:1:ready',
      attemptNumber: 1,
      creationMode: 'HUMAN_CREATED',
      prompt: 'Implement without committing.',
    });

    expect(result).toMatchObject({
      status: 'BLOCKED',
      batch: {
        persistedState: 'BLOCKED',
        blockedFromState: 'IMPLEMENTING',
        blockedResumeState: 'IMPLEMENTING',
      },
    });
  });
});
