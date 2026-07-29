import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { initializeState, reconcile, runOnce, runUntilStop } from '../lib/controller-runner.mjs';
import { executeAgent } from '../lib/executors.mjs';
import { acquireLock } from '../lib/locking.mjs';
import { loadState, writeJsonAtomic } from '../lib/state.mjs';
import { enterPhase } from '../lib/transitions.mjs';
import {
  FAKE_AGENT,
  changedSnapshot,
  controllerConfig,
  createRepository,
  initialReview,
  sha256,
  workflowState,
  writeJson,
  writeState,
} from './helpers.mjs';

describe('locking and interruption recovery', () => {
  it('prevents concurrent controller processes', async () => {
    const { root } = await createRepository();
    const config = controllerConfig(root);
    await mkdir(join(root, '.cowork'), { recursive: true });
    const first = await acquireLock(config.lockFile, { workflowId: 'workflow-test' });
    await assert.rejects(
      acquireLock(config.lockFile, { workflowId: 'workflow-test' }),
      (error) => error.code === 'CONTROLLER_LOCKED',
    );
    await first.release();
  });

  it('removes a stale lock safely during reconcile', async () => {
    const { root, baseSha } = await createRepository();
    const config = controllerConfig(root);
    await writeState(config, workflowState(baseSha));
    await writeJson(config.lockFile, {
      schemaVersion: 1,
      pid: 2_147_483_647,
      createdAt: new Date(0).toISOString(),
    });

    const result = await reconcile(config);
    assert.equal(result.staleLockRemoved, true);
    await assert.rejects(readFile(config.lockFile, 'utf8'), (error) => error.code === 'ENOENT');
  });

  it('does not blindly repeat an interrupted invocation', async () => {
    const { root, baseSha } = await createRepository();
    await changedSnapshot(root, baseSha);
    const config = controllerConfig(root);
    const marker = join(root, '.cowork', 'runtime', 'should-not-run.txt');
    config.reviewer = {
      ...config.reviewer,
      args: [FAKE_AGENT, '--prompt-log', marker],
    };
    await writeState(
      config,
      workflowState(baseSha, {
        lastInvocation: {
          status: 'IN_PROGRESS',
          phase: 'REVIEW_INITIAL',
          authorisedRole: 'REVIEWER',
          authorisedAgent: 'claude',
          artifactTarget: '.cowork/reviews/initial.json',
          attempt: 1,
          startedAt: new Date(0).toISOString(),
        },
      }),
    );

    const result = await runOnce(config);
    assert.equal(result.state.phase, 'HUMAN_DECISION_REQUIRED');
    assert.equal(result.state.stopReason, 'INTERRUPTED_INVOCATION_OUTCOME_UNCERTAIN');
    await assert.rejects(readFile(marker, 'utf8'), (error) => error.code === 'ENOENT');
  });

  it('records a known command failure as BLOCKED', async () => {
    const { root, baseSha } = await createRepository();
    await changedSnapshot(root, baseSha);
    const config = controllerConfig(root);
    config.reviewer = {
      ...config.reviewer,
      args: [FAKE_AGENT, '--exit-code', '9'],
    };
    await writeState(config, workflowState(baseSha));

    await assert.rejects(runOnce(config), (error) => error.code === 'AGENT_COMMAND_FAILED');
    const state = await loadState(config.stateFile);
    assert.equal(state.phase, 'BLOCKED');
    assert.equal(state.stopReason, 'AGENT_COMMAND_FAILED');
  });

  it('stops when the configured agent executable is unavailable', async () => {
    const { root, baseSha } = await createRepository();
    await changedSnapshot(root, baseSha);
    const config = controllerConfig(root);
    config.reviewer = {
      ...config.reviewer,
      command: 'review-controller-agent-that-does-not-exist',
      args: [],
    };
    await writeState(config, workflowState(baseSha));

    await assert.rejects(runOnce(config), (error) => error.code === 'ENOENT');
    const state = await loadState(config.stateFile);
    assert.equal(state.phase, 'BLOCKED');
    assert.equal(state.stopReason, 'AGENT_COMMAND_FAILED');
  });

  it('stops continuous execution at the configured action limit', async () => {
    const { root, baseSha } = await createRepository();
    const config = controllerConfig(root, { maximumControllerActions: 1 });
    await writeState(
      config,
      enterPhase(
        workflowState(baseSha, {
          approvedCommitSha: baseSha,
          pushRequired: false,
        }),
        'CLOSE_BATCH',
      ),
    );

    const result = await runUntilStop(config);
    assert.equal(result.actionsPerformed, 1);
    assert.equal(result.state.phase, 'ADVANCE_BATCH');
    assert.equal(result.state.stopReason, 'CONTROLLER_ACTION_LIMIT_REACHED');
  });
});

describe('configurable agent execution', () => {
  it('delivers a prompt through a configured file argument', async () => {
    const { root } = await createRepository();
    const promptPath = join(root, '.cowork', 'runtime', 'prompt.md');
    const promptLog = join(root, '.cowork', 'runtime', 'prompt.log');
    const outputPath = join(root, '.cowork', 'runtime', 'output.json');
    await writeJson(outputPath, { complete: true });

    const result = await executeAgent({
      executor: {
        command: process.execPath,
        args: [
          FAKE_AGENT,
          '--prompt-file',
          '{promptFile}',
          '--prompt-log',
          promptLog,
          '--output',
          outputPath,
        ],
        promptDelivery: 'file',
        timeoutMs: 5_000,
      },
      prompt: 'single-use authorisation',
      promptPath,
      rawBasePath: join(root, '.cowork', 'raw', 'file-delivery'),
      repositoryRoot: root,
      environmentVariableAllowlist: ['PATH', 'HOME'],
    });

    assert.equal(result.code, 0);
    assert.equal(await readFile(promptLog, 'utf8'), 'single-use authorisation');
  });
});

describe('atomic state and initialisation safety', () => {
  it('preserves the previous state when failure occurs before atomic rename', async () => {
    const { root } = await createRepository();
    const path = join(root, '.cowork', 'workflow-state.json');
    await writeJsonAtomic(path, { version: 'old' });
    const before = await readFile(path, 'utf8');

    await assert.rejects(
      writeJsonAtomic(
        path,
        { version: 'new' },
        {
          beforeRename() {
            throw new Error('simulated failure');
          },
        },
      ),
      /simulated failure/,
    );

    assert.equal(await readFile(path, 'utf8'), before);
    const leftovers = (await readdir(join(root, '.cowork'))).filter((name) =>
      name.endsWith('.tmp'),
    );
    assert.deepEqual(leftovers, []);
  });

  it('refuses to overwrite existing live state without force', async () => {
    const { root, baseSha } = await createRepository();
    const config = controllerConfig(root);
    await writeState(config, workflowState(baseSha));

    await assert.rejects(
      initializeState(config, {
        workflowId: 'workflow-test',
        batch: 3,
        phase: 'IMPLEMENT',
        implementer: 'codex',
        reviewer: 'claude',
        plan: 'docs/plans/batch-03.md',
        baseSha,
      }),
      (error) => error.code === 'STATE_ALREADY_EXISTS',
    );
  });

  it('initialises Batch 3 review from a complete implementation report', async () => {
    const { root, baseSha } = await createRepository();
    const snapshot = await changedSnapshot(root, baseSha);
    const config = controllerConfig(root);
    const reportPath = join(root, '.cowork', 'reports', 'batch-3-implementation-report.json');
    await writeJson(reportPath, {
      schemaVersion: 1,
      workflowId: 'workflow-test',
      batchId: 3,
      reportComplete: true,
      approvedPlanPath: 'docs/plans/batch-03.md',
      baseSha,
      resultingHeadSha: snapshot.headSha,
      filesChanged: snapshot.changedFiles,
      scopeCompliance: true,
      acceptanceCriteria: ['criterion-from-complete-report'],
      verification: { commands: ['pnpm test'] },
      deferredWork: [],
      summary: 'The whole authorised Batch 3 implementation is complete.',
    });

    const state = await initializeState(config, {
      workflowId: 'workflow-test',
      batch: 3,
      phase: 'REVIEW_INITIAL',
      implementer: 'codex',
      reviewer: 'claude',
      plan: 'docs/plans/batch-03.md',
      baseSha,
      implementationReport: '.cowork/reports/batch-3-implementation-report.json',
    });

    assert.equal(state.phase, 'REVIEW_INITIAL');
    assert.deepEqual(state.requiredAcceptanceCriteria, ['criterion-from-complete-report']);
    assert.equal(
      state.artifacts.implementationReport,
      '.cowork/reports/batch-3-implementation-report.json',
    );
  });
});

describe('preservation boundary', () => {
  it('leaves a pre-existing product-batch file byte-for-byte unchanged during review', async () => {
    const { root, baseSha } = await createRepository();
    const batchPath = join(root, 'batch-3-existing.ts');
    await writeFile(batchPath, 'export const existing = true;\n', 'utf8');
    const snapshot = await changedSnapshot(root, baseSha);
    const beforeHash = await sha256(batchPath);
    const outputPath = join(root, '.cowork', 'runtime', 'initial.json');
    await writeJson(outputPath, initialReview(snapshot, { baseSha }));
    const config = controllerConfig(root);
    config.reviewer = {
      ...config.reviewer,
      args: [FAKE_AGENT, '--output', outputPath],
    };
    await writeState(config, workflowState(baseSha));

    await runOnce(config);
    assert.equal(await sha256(batchPath), beforeHash);
  });

  it('does not treat runtime files as reviewed product changes', async () => {
    const { root, baseSha } = await createRepository();
    await writeFile(join(root, 'change.txt'), 'product\n', 'utf8');
    await mkdir(join(root, '.cowork', 'raw'), { recursive: true });
    await writeFile(join(root, '.cowork', 'raw', 'agent.stdout.txt'), 'runtime\n', 'utf8');
    const snapshot = await changedSnapshot(root, baseSha, 'product\n');
    assert.deepEqual(snapshot.changedFiles, ['change.txt']);
  });

  it('cannot start the next batch through an agent phase', async () => {
    const { root, baseSha } = await createRepository();
    const config = controllerConfig(root);
    const state = enterPhase(workflowState(baseSha), 'REVIEW_INITIAL');
    state.approvedBatches = [{ batchId: 4, planPath: 'docs/plans/batch-04.md' }];
    await writeState(config, state);
    assert.equal((await loadState(config.stateFile)).activeBatch, 3);
    assert.equal((await loadState(config.stateFile)).phase, 'REVIEW_INITIAL');
  });
});
