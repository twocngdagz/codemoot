// Real-command integration coverage for `codemoot workflow run`: a temporary Git project
// with a remote, the REAL coordinators and SQLite store, and scripted adapter executables.
// This is the regression net for the startup-order defect (the repository audit must be
// captured on the workflow branch) and for failed-invocation auditing and classification.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDatabase,
  reviewWorkflowPersistence,
  reviewWorkflowPlan,
  reviewWorkflowRunner,
} from '@codemoot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installGitGuard,
  resolveInvocationTimeoutSeconds,
  reviewWorkflowPauseCommand,
  reviewWorkflowResumeCommand,
  reviewWorkflowRunCommand,
  uninstallGitGuard,
} from '../src/commands/review-workflow.js';
import { getDbPath } from '../src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-scripted.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex-authfail.mjs', import.meta.url));

const WORKFLOW_ID = 'workflow-auto-integration';
const PLAN_CONTENT = '## Deliver the sample feature\n\nWrite the sample output file.\n';

function git(projectDir: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: projectDir, encoding: 'utf8' }).trim();
}

function buildConfig(): string {
  return JSON.stringify({
    configVersion: 3,
    workflow: 'review-gated-batches',
    models: {
      implementer: {
        provider: 'anthropic',
        model: 'claude-supported',
        cliAdapter: {
          kind: 'claude',
          command: process.execPath,
          args: [FAKE_CLAUDE],
          timeout: 120,
          envAllowlist: ['CODEMOOT_FAKE_RESPONSE_FILE'],
        },
      },
      reviewer: {
        provider: 'openai',
        model: 'codex-supported',
        cliAdapter: {
          kind: 'codex',
          command: FAKE_CODEX,
          args: ['exec'],
          timeout: 60,
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
  });
}

/** The exact lifecycle refinement contract the scripted implementer returns. */
function buildRefinementContract(): string {
  const imported = reviewWorkflowPlan.importGeneralPlan({
    workflowId: WORKFLOW_ID,
    content: PLAN_CONTENT,
    sourceType: 'MARKDOWN_FILE',
    authorEvidence: [
      {
        kind: 'LOCAL_CLI',
        source: 'codemoot workflow run',
        observedAt: '2026-08-02T12:00:00.000Z',
      },
    ],
    createdAt: '2026-08-02T12:00:00.000Z',
  });
  const requirementId = imported.requirements[0]?.requirementId;
  if (requirementId === undefined) throw new Error('Plan fixture produced no requirement');
  const batchId = `${WORKFLOW_ID}:batch:1`;
  const planVersionId = `${batchId}:plan:1`;
  const criterionId = 'criterion-sample-output';
  return JSON.stringify({
    schemaVersion: 1,
    contractKind: 'REFINEMENT_RESULT',
    summary: 'One batch delivering the sample output file.',
    refinedPlanContent: 'Refined plan: implement the sample output file in a single batch.',
    batchPlanVersionIds: [planVersionId],
    requirementCoverage: [
      {
        requirementId,
        batchPlanVersionIds: [planVersionId],
        acceptanceCriterionIds: [criterionId],
      },
    ],
    batchPlans: [
      {
        batchPlanVersionId: planVersionId,
        batchId,
        ordinal: 1,
        objective: 'Write the sample output file.',
        currentRepositoryEvidence: [
          { kind: 'FILE', location: 'README.md', description: 'Current repository entry point.' },
        ],
        dependencies: [],
        candidateFiles: ['sample.txt'],
        technicalImplementation: ['Create sample.txt with the expected content.'],
        userJourney: ['The operator sees sample.txt after the batch lands.'],
        expectedBehaviour: ['sample.txt exists with the expected content.'],
        acceptanceCriteria: [
          {
            acceptanceCriterionId: criterionId,
            kind: 'TECHNICAL',
            statement: 'sample.txt exists.',
            required: true,
            passCondition: 'test -f sample.txt exits 0',
            sourceRequirementIds: [requirementId],
          },
        ],
        technicalAcceptanceCriteria: [criterionId],
        userFacingAcceptanceCriteria: [],
        cliAcceptanceCriteria: [],
        browserAcceptanceCriteria: { applicability: 'NOT_APPLICABLE', reason: 'CLI-only change.' },
        verificationCommands: [
          {
            executable: 'test',
            arguments: ['-f', 'sample.txt'],
            workingDirectory: '.',
            verificationType: 'test',
            relatedCriterionIds: [criterionId],
          },
        ],
        manualVerification: [],
        documentationChanges: [],
        outOfScope: ['Everything else.'],
        rollbackBoundary: 'Revert the batch commit.',
      },
    ],
  });
}

describe('codemoot workflow run (real command, scripted adapters)', () => {
  let projectDir: string;
  let remoteDir: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'codemoot-workflow-run-'));
    remoteDir = mkdtempSync(join(tmpdir(), 'codemoot-workflow-remote-'));
    execFileSync('git', ['init', '--bare'], { cwd: remoteDir });
    git(projectDir, ['init', '-b', 'main']);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    writeFileSync(join(projectDir, 'README.md'), '# Sample project\n');
    writeFileSync(join(projectDir, 'plan.md'), PLAN_CONTENT);
    writeFileSync(join(projectDir, '.cowork.yml'), buildConfig());
    writeFileSync(join(projectDir, '.gitignore'), '.cowork/\n');
    const responseFile = join(projectDir, 'refinement-response.json');
    writeFileSync(responseFile, buildRefinementContract());
    process.env.CODEMOOT_FAKE_RESPONSE_FILE = responseFile;
    git(projectDir, ['add', '-A']);
    git(projectDir, ['commit', '-m', 'initial']);
    git(projectDir, ['remote', 'add', 'origin', remoteDir]);
    git(projectDir, ['push', '-u', 'origin', 'main']);
    // A pre-existing custom push URL must survive the whole run untouched.
    git(projectDir, ['config', 'remote.origin.pushurl', remoteDir]);
    process.chdir(projectDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.env.CODEMOOT_FAKE_RESPONSE_FILE = undefined;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  });

  it(
    'creates the workflow branch before the audit, completes refinement, audits the failed reviewer invocation, and stops with a stable reason',
    { timeout: 60_000 },
    async () => {
      const baseShaBefore = git(projectDir, ['rev-parse', 'main']);
      await reviewWorkflowRunCommand({ plan: 'plan.md', timeout: 60, id: WORKFLOW_ID });

      const db = openDatabase(getDbPath(projectDir));
      try {
        const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);
        const state = runnerStore.require(WORKFLOW_ID);
        const planStore = new reviewWorkflowPlan.ReviewWorkflowPlanStore(db);

        // AWR-001 regression: refinement ran on the workflow branch — startup never
        // invalidates its own repository audit, and the frozen batch count is recorded.
        expect(state.stopDetails ?? '').not.toContain('Repository state changed');
        expect(state.branch.startsWith('codemoot/plan-')).toBe(true);
        expect(state.totalBatches).toBe(1);
        const batches = planStore.listBatches(WORKFLOW_ID);
        expect(batches).toHaveLength(1);
        expect(batches[0]?.batchId).toBe(`${WORKFLOW_ID}:batch:1`);

        // Branch lifecycle: the worktree is on the workflow branch and the base branch is
        // exactly where it started, locally and on the remote.
        expect(git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(state.branch);
        expect(state.baseBranch).toBe('main');
        expect(git(projectDir, ['rev-parse', 'main'])).toBe(baseShaBefore);
        expect(state.baseSha).toBe(baseShaBefore);

        // The successful refinement invocation is fully audited with hashes and tokens.
        const audit = planStore.workflowStore.listInvocationAudit(WORKFLOW_ID);
        const refinementRows = audit.filter((row) => row.phase === 'PLAN_REFINEMENT');
        expect(refinementRows.length).toBeGreaterThanOrEqual(1);
        expect(refinementRows[0]?.responseHash).toMatch(/^[0-9a-f]{64}$/);
        expect(refinementRows[0]?.inputTokens).toBeGreaterThan(0);

        // The reviewer CLI failure is audited too (FAILED row, stderr captured, classified)
        // and consumes the invocation budget rather than vanishing.
        const failedRows = audit.filter((row) => row.resultStatus === 'FAILED');
        expect(failedRows.length).toBeGreaterThanOrEqual(1);
        expect(failedRows[0]?.failure?.classification).toBe('AUTHENTICATION');
        expect(failedRows[0]?.failure?.message ?? '').toContain('not logged in');

        // The refinement audit row carries the full raw stdout and repository before/after
        // state — the invocation-layer audit contract, proven through the real path.
        expect(refinementRows[0]?.rawStdout ?? '').toContain('"type":"result"');
        expect(refinementRows[0]?.gitBefore?.branch).toBe(state.branch);
        expect(refinementRows[0]?.gitAfter?.headSha).toMatch(/^[0-9a-f]{40}$/);

        // The frozen limits are persisted in the runner state — later config edits can
        // never change enforcement.
        expect(state.limits?.maxCodeReviewRoundsPerBatch).toBe(3);
        expect(state.limits?.maxCorrectionPassesPerBatch).toBe(2);

        // The git guard is deny-by-default and parses global options, so option-prefixed
        // bypasses and plumbing mutations are refused too; allowed reads pass through.
        const guardPath = join(projectDir, '.cowork', 'git-guard', 'git');
        for (const attempt of [
          ['push'],
          ['reset', '--hard'],
          ['-C', '.', 'push'],
          ['-c', 'user.name=x', 'push', 'origin'],
          ['update-ref', 'refs/heads/main', 'HEAD'],
          ['symbolic-ref', 'HEAD', 'refs/heads/main'],
          ['cherry-pick', 'HEAD'],
          ['stash'],
          ['checkout', '-b', 'escape'],
        ]) {
          expect(
            () => execFileSync(guardPath, attempt, { cwd: projectDir }),
            attempt.join(' '),
          ).toThrow();
        }
        expect(
          execFileSync(guardPath, ['rev-parse', 'HEAD'], {
            cwd: projectDir,
            encoding: 'utf8',
          }).trim(),
        ).toMatch(/^[0-9a-f]{40}$/);
        expect(
          execFileSync(guardPath, ['-C', '.', 'status', '--porcelain'], {
            cwd: projectDir,
            encoding: 'utf8',
          }),
        ).toBeDefined();

        // The run restored the user's ORIGINAL custom push URL when it ended.
        expect(git(projectDir, ['config', '--get', 'remote.origin.pushurl'])).toBe(remoteDir);

        // While the guard is installed, even an ABSOLUTE-PATH git cannot push: origin's
        // push URL is sentinel-blocked; uninstalling restores the preserved original.
        installGitGuard(projectDir);
        expect(git(projectDir, ['config', '--get', 'remote.origin.pushurl'])).toBe(
          'file:///codemoot-push-blocked',
        );
        expect(() =>
          execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: projectDir, stdio: 'pipe' }),
        ).toThrow();
        uninstallGitGuard(projectDir);
        expect(git(projectDir, ['config', '--get', 'remote.origin.pushurl'])).toBe(remoteDir);

        // The stop is durable, machine-readable, and notified durably (NOTIFICATION log).
        expect(state.status).toBe('HUMAN_DECISION_REQUIRED');
        expect(state.stopReason).toBe('AUTHENTICATION_REQUIRED');
        const notifications = runnerStore.listLog(WORKFLOW_ID, { types: ['NOTIFICATION'] });
        expect(notifications).toHaveLength(1);
      } finally {
        db.close();
      }
    },
  );

  it('never touches the push URL when startup validation fails on a dirty worktree', async () => {
    writeFileSync(join(projectDir, 'dirty.txt'), 'uncommitted\n');
    await expect(
      reviewWorkflowRunCommand({ plan: 'plan.md', timeout: 60, id: `${WORKFLOW_ID}-dirty` }),
    ).rejects.toThrow(/clean worktree/);
    // The custom push URL is exactly as configured — no sentinel was ever installed.
    expect(git(projectDir, ['config', '--get', 'remote.origin.pushurl'])).toBe(remoteDir);
  });

  it('restores the push URL when initialization fails after guard installation', async () => {
    await expect(
      reviewWorkflowRunCommand({
        plan: 'missing-plan.md',
        timeout: 60,
        id: `${WORKFLOW_ID}-noplan`,
      }),
    ).rejects.toThrow();
    expect(git(projectDir, ['config', '--get', 'remote.origin.pushurl'])).toBe(remoteDir);
  });

  it('blocks SSH pushes from the agent environment regardless of ~/.ssh keys', () => {
    // The exact variables injected into every agent subprocess.
    const agentEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      GIT_SSH_COMMAND: '/usr/bin/false',
    };
    expect(() =>
      execFileSync('git', ['push', 'ssh://git@localhost/nowhere.git', 'HEAD'], {
        cwd: projectDir,
        env: agentEnv,
        stdio: 'pipe',
        timeout: 15_000,
      }),
    ).toThrow();
  });

  function seedRunnerState(status: 'RUNNING' | 'PAUSED_BY_USER', leaseLiveMs?: number): void {
    const db = openDatabase(getDbPath(projectDir));
    try {
      new reviewWorkflowPersistence.ReviewWorkflowStore(db).createWorkflow({
        workflowId: WORKFLOW_ID,
        status: 'ACTIVE',
        generalPlanVersionId: `${WORKFLOW_ID}:general-plan`,
        implementerAssignmentId: 'assignment-implementer',
        reviewerAssignmentId: 'assignment-reviewer',
        configurationHash: 'configuration-hash',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      });
      const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);
      runnerStore.initState({
        workflowId: WORKFLOW_ID,
        branch: 'codemoot/x',
        baseBranch: 'main',
        baseSha: 'a'.repeat(40),
      });
      runnerStore.update(WORKFLOW_ID, {
        status,
        ...(leaseLiveMs === undefined
          ? {}
          : {
              workerId: 'live-worker',
              leaseExpiresAt: new Date(Date.now() + leaseLiveMs).toISOString(),
            }),
      });
    } finally {
      db.close();
    }
  }

  it('pause on a live worker requests a graceful pause; resume mid-pause is refused', async () => {
    seedRunnerState('RUNNING', 60_000);
    await reviewWorkflowPauseCommand(WORKFLOW_ID);
    const db = openDatabase(getDbPath(projectDir));
    try {
      const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);
      expect(runnerStore.require(WORKFLOW_ID).status).toBe('PAUSE_REQUESTED');
      // Repeated pause is a no-op.
      await reviewWorkflowPauseCommand(WORKFLOW_ID);
      expect(runnerStore.require(WORKFLOW_ID).status).toBe('PAUSE_REQUESTED');
    } finally {
      db.close();
    }
    // Resuming an in-flight graceful pause would cancel it mid-settlement — refused.
    await expect(reviewWorkflowResumeCommand(WORKFLOW_ID, { timeout: 60 })).rejects.toThrow(
      /still pausing/,
    );
  });

  it('resume is atomically claimed: a second resume can never start another worker', async () => {
    seedRunnerState('PAUSED_BY_USER');
    const db = openDatabase(getDbPath(projectDir));
    try {
      const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);
      // The durable claim: exactly one caller wins.
      expect(runnerStore.claimResume(WORKFLOW_ID)).toBe(true);
      expect(runnerStore.claimResume(WORKFLOW_ID)).toBe(false);
    } finally {
      db.close();
    }
    // The losing (repeated/concurrent) resume command is refused outright.
    await expect(reviewWorkflowResumeCommand(WORKFLOW_ID, { timeout: 60 })).rejects.toThrow(
      /is RUNNING/,
    );
  });

  it('resume refuses non-paused workflows', async () => {
    seedRunnerState('RUNNING', 60_000);
    await expect(reviewWorkflowResumeCommand(WORKFLOW_ID, { timeout: 60 })).rejects.toThrow(
      /resume only continues a paused workflow/,
    );
  });

  it('settles and claims dead-worker states atomically; live workers are never disturbed', () => {
    seedRunnerState('RUNNING');
    const db = openDatabase(getDbPath(projectDir));
    try {
      const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);
      // Live worker still settling its graceful pause: neither settle nor claim may touch it.
      runnerStore.update(WORKFLOW_ID, {
        status: 'PAUSE_REQUESTED',
        workerId: 'live',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const capture = { headSha: 'a'.repeat(40), clean: true, statusFingerprint: 'fp' };
      expect(
        runnerStore.settleRequestedPause(WORKFLOW_ID, capture, { requireDeadLease: true }),
      ).toBe(false);
      expect(runnerStore.claimResume(WORKFLOW_ID)).toBe(false);
      // The pausing worker died: the settle captures the repository state (dead-lease
      // conditional), then exactly one resume claims — the winner stamps a launch lease.
      runnerStore.update(WORKFLOW_ID, {
        leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      expect(
        runnerStore.settleRequestedPause(WORKFLOW_ID, capture, { requireDeadLease: true }),
      ).toBe(true);
      expect(runnerStore.require(WORKFLOW_ID).pausedRepo?.headSha).toBe('a'.repeat(40));
      expect(runnerStore.claimResume(WORKFLOW_ID)).toBe(true);
      expect(runnerStore.claimResume(WORKFLOW_ID)).toBe(false);
      // The real worker takes over the launcher's handoff lease.
      expect(runnerStore.acquireLease(WORKFLOW_ID, 'worker-real', 60)).toBe(true);
      // A stranded RUNNING workflow (worker died mid-run, lease expired) is claimable too.
      runnerStore.update(WORKFLOW_ID, {
        leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      expect(runnerStore.claimResume(WORKFLOW_ID)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('reverts a claimed resume whose launch failed, keeping the workflow resumable', async () => {
    seedRunnerState('PAUSED_BY_USER');
    // Break the background launch: the CLI entry point cannot be resolved.
    const originalEntry = process.argv[1];
    process.argv[1] = undefined as unknown as string;
    try {
      await expect(
        reviewWorkflowResumeCommand(WORKFLOW_ID, { timeout: 60, background: true }),
      ).rejects.toThrow(/entry point/);
    } finally {
      process.argv[1] = originalEntry;
    }
    const db = openDatabase(getDbPath(projectDir));
    try {
      const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);
      // The claim was reverted: the workflow is still publicly resumable.
      expect(runnerStore.require(WORKFLOW_ID).status).toBe('PAUSED_BY_USER');
    } finally {
      db.close();
    }
  });

  it('covers both pause/acquisition interleavings: neither side can strand the other', () => {
    seedRunnerState('RUNNING');
    const db = openDatabase(getDbPath(projectDir));
    try {
      const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);
      const capture = { headSha: 'a'.repeat(40), clean: true, statusFingerprint: 'fp' };

      // Interleaving 1: the pause settles first (no live worker). A worker that read
      // RUNNING beforehand can NOT acquire afterwards — acquisition requires an
      // executable status, never a paused one.
      expect(runnerStore.requestPause(WORKFLOW_ID)).toBe(true);
      expect(
        runnerStore.settleRequestedPause(WORKFLOW_ID, capture, { requireDeadLease: true }),
      ).toBe(true);
      expect(runnerStore.acquireLease(WORKFLOW_ID, 'late-worker', 60)).toBe(false);
      expect(runnerStore.require(WORKFLOW_ID).status).toBe('PAUSED_BY_USER');

      // Interleaving 2: a worker acquires first. The pause request lands, but the
      // dead-lease settle LOSES against the live lease — the running worker keeps
      // ownership and settles the pause itself at its next action boundary.
      expect(runnerStore.claimResume(WORKFLOW_ID)).toBe(true);
      expect(runnerStore.acquireLease(WORKFLOW_ID, 'live-worker', 60)).toBe(true);
      expect(runnerStore.requestPause(WORKFLOW_ID)).toBe(true);
      expect(
        runnerStore.settleRequestedPause(WORKFLOW_ID, capture, { requireDeadLease: true }),
      ).toBe(false);
      expect(runnerStore.require(WORKFLOW_ID).status).toBe('PAUSE_REQUESTED');
      // The worker's own graceful settle (under its live lease) still succeeds.
      expect(runnerStore.settleRequestedPause(WORKFLOW_ID, capture)).toBe(true);
      expect(runnerStore.require(WORKFLOW_ID).status).toBe('PAUSED_BY_USER');

      // Acquisition is allowed for decision-resume (HUMAN_DECISION_REQUIRED) but never
      // for paused states.
      runnerStore.update(WORKFLOW_ID, {
        status: 'HUMAN_DECISION_REQUIRED',
        workerId: null,
        leaseExpiresAt: null,
      });
      expect(runnerStore.acquireLease(WORKFLOW_ID, 'decide-worker', 60)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('resolves the invocation timeout from cliAdapter.timeout when no flag is given', () => {
    // Dead configuration is worse than none: cliAdapter.timeout validated, was documented,
    // and had no effect for three runs because the runner always passed an explicit value.
    expect(resolveInvocationTimeoutSeconds(projectDir)).toBe(120);
    // An explicit flag still wins.
    expect(resolveInvocationTimeoutSeconds(projectDir, 7200)).toBe(7200);
  });

  it('forwards --timeout into every detached background worker spawn', () => {
    // `--timeout N --background` was accepted, reported success, and still ran at the 1800s
    // default because the spawned argv carried no timeout at all. ESM prevents spying on
    // spawn, so this asserts the shipped call sites directly: every run-resume spawn must
    // pass --timeout.
    const source = readFileSync(
      join(__dirname, '..', 'src', 'commands', 'review-workflow.ts'),
      'utf8',
    );
    // Both detached spawns (workflow run --background, workflow run-resume --background).
    const spawnCalls = source.split("'run-resume'").slice(1);
    expect(spawnCalls.length).toBeGreaterThanOrEqual(2);
    for (const [index, call] of spawnCalls.entries()) {
      expect(call.slice(0, 260), `spawn call ${index} must forward --timeout`).toContain(
        "'--timeout'",
      );
    }
  });
});
