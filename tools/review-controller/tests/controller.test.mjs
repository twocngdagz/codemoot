import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { initializeState, runOnce } from '../lib/controller-runner.mjs';
import { captureGitSnapshot } from '../lib/git.mjs';
import { loadState } from '../lib/state.mjs';
import { enterPhase } from '../lib/transitions.mjs';
import {
  FAKE_AGENT,
  changedSnapshot,
  controllerConfig,
  correctionReport,
  createRepository,
  finalReview,
  finding,
  git,
  initialReview,
  sha256,
  workflowState,
  writeJson,
  writeState,
} from './helpers.mjs';

function setFakeOutput(config, role, outputPath, extraArguments = []) {
  config[role] = {
    ...config[role],
    command: process.execPath,
    args: [FAKE_AGENT, '--output', outputPath, ...extraArguments],
  };
}

describe('controller role and review enforcement', () => {
  it('accepts one complete initial review and reaches READY_TO_COMMIT', async () => {
    const { root, baseSha } = await createRepository();
    const snapshot = await changedSnapshot(root, baseSha);
    const changedPath = join(root, 'change.txt');
    const originalHash = await sha256(changedPath);
    const outputPath = join(root, '.cowork', 'runtime', 'initial-output.json');
    const promptPath = join(root, '.cowork', 'prompt.log');
    await writeJson(outputPath, initialReview(snapshot, { baseSha }));
    const config = controllerConfig(root);
    setFakeOutput(config, 'reviewer', outputPath, ['--prompt-log', promptPath]);
    await writeState(config, workflowState(baseSha));

    const result = await runOnce(config);

    assert.equal(result.state.phase, 'READY_TO_COMMIT');
    assert.equal(result.state.reviewRound, 1);
    assert.equal(await sha256(changedPath), originalHash);
    const prompt = await readFile(promptPath, 'utf8');
    assert.match(prompt, /\/review-gated-batch/);
    assert.match(prompt, /Collect all findings internally/);
    assert.match(prompt, /mayStartNextBatch": false/);
  });

  it('rejects an implementer role attempting the review phase', async () => {
    const { root, baseSha } = await createRepository();
    const snapshot = await changedSnapshot(root, baseSha);
    const outputPath = join(root, '.cowork', 'runtime', 'initial-output.json');
    await writeJson(outputPath, initialReview(snapshot, { baseSha }));
    const config = controllerConfig(root);
    setFakeOutput(config, 'reviewer', outputPath);
    const state = workflowState(baseSha);
    state.authorisedRole = 'IMPLEMENTER';
    state.authorisedAgent = 'codex';
    await writeState(config, state);

    await assert.rejects(runOnce(config), (error) => error.code === 'ROLE_VIOLATION');
  });

  it('rejects a reviewer role attempting the implementation phase', async () => {
    const { root, baseSha } = await createRepository();
    await changedSnapshot(root, baseSha);
    const config = controllerConfig(root);
    const state = workflowState(baseSha, { phase: 'IMPLEMENT' });
    state.authorisedRole = 'REVIEWER';
    state.authorisedAgent = 'claude';
    await writeState(config, state);

    await assert.rejects(runOnce(config), (error) => error.code === 'ROLE_VIOLATION');
  });

  it('rejects a reviewer that modifies product files', async () => {
    const { root, baseSha } = await createRepository();
    const snapshot = await changedSnapshot(root, baseSha);
    const outputPath = join(root, '.cowork', 'runtime', 'initial-output.json');
    const unauthorisedPath = join(root, 'reviewer-change.txt');
    await writeJson(outputPath, initialReview(snapshot, { baseSha }));
    const config = controllerConfig(root);
    setFakeOutput(config, 'reviewer', outputPath, ['--modify-file', unauthorisedPath]);
    await writeState(config, workflowState(baseSha));

    await assert.rejects(runOnce(config), (error) => error.code === 'ROLE_MODIFIED_WORKTREE');
    assert.equal((await loadState(config.stateFile)).phase, 'HUMAN_DECISION_REQUIRED');
  });

  it('rejects an implementer that changes controller-owned Git state', async () => {
    const { root, baseSha } = await createRepository();
    await changedSnapshot(root, baseSha);
    const outputPath = join(root, '.cowork', 'runtime', 'implementation-output.json');
    await writeJson(outputPath, {});
    const config = controllerConfig(root);
    setFakeOutput(config, 'implementer', outputPath, ['--commit-file', join(root, 'change.txt')]);
    await writeState(config, workflowState(baseSha, { phase: 'IMPLEMENT' }));

    await assert.rejects(
      runOnce(config),
      (error) => error.code === 'ROLE_CHANGED_CONTROLLER_OWNED_GIT_STATE',
    );
    const state = await loadState(config.stateFile);
    assert.equal(state.phase, 'HUMAN_DECISION_REQUIRED');
  });

  it('restores and rejects controller state tampering', async () => {
    const { root, baseSha } = await createRepository();
    const snapshot = await changedSnapshot(root, baseSha);
    const outputPath = join(root, '.cowork', 'runtime', 'initial-output.json');
    await writeJson(outputPath, initialReview(snapshot, { baseSha }));
    const config = controllerConfig(root);
    setFakeOutput(config, 'reviewer', outputPath, ['--tamper-state', config.stateFile]);
    await writeState(config, workflowState(baseSha));

    await assert.rejects(runOnce(config), (error) => error.code === 'CONTROLLER_STATE_TAMPERED');
    const state = await loadState(config.stateFile);
    assert.equal(state.phase, 'REVIEW_INITIAL');
    assert.equal(state.stopReason, 'CONTROLLER_STATE_TAMPERED');
    assert.equal(state.lastInvocation.status, 'TAMPERED');
  });

  it('restores and rejects tampering with a prior review artefact', async () => {
    const { root, baseSha } = await createRepository();
    const snapshot = await changedSnapshot(root, baseSha);
    const initialStatePath = '.cowork/reviews/batch-3-initial-review.json';
    const initialPath = join(root, initialStatePath);
    await writeJson(
      initialPath,
      initialReview(snapshot, {
        baseSha,
        findings: [finding()],
        verdict: 'NEEDS_REVISION',
      }),
    );
    const originalHash = await sha256(initialPath);
    const outputPath = join(root, '.cowork', 'runtime', 'correction-output.json');
    await writeJson(
      outputPath,
      correctionReport(snapshot, initialStatePath, ['B-001'], { baseSha }),
    );
    const config = controllerConfig(root);
    setFakeOutput(config, 'implementer', outputPath, ['--tamper-state', initialPath]);
    await writeState(
      config,
      workflowState(baseSha, {
        phase: 'FIX_BLOCKING_FINDINGS',
        reviewRound: 1,
        openBlockingFindingIds: ['B-001'],
        artifacts: {
          implementationReport: '.cowork/reports/implementation.json',
          initialReview: initialStatePath,
          correctionReport: null,
          finalReview: null,
        },
      }),
    );

    await assert.rejects(runOnce(config), (error) => error.code === 'CONTROLLER_ARTIFACT_TAMPERED');
    assert.equal(await sha256(initialPath), originalHash);
    const state = await loadState(config.stateFile);
    assert.equal(state.phase, 'FIX_BLOCKING_FINDINGS');
    assert.equal(state.stopReason, 'CONTROLLER_ARTIFACT_TAMPERED');
  });

  it('requires different configured implementer and reviewer agents', async () => {
    const { root, baseSha } = await createRepository();
    const config = controllerConfig(root);
    await assert.rejects(
      initializeState(config, {
        workflowId: 'workflow-test',
        batch: 3,
        phase: 'IMPLEMENT',
        implementer: 'codex',
        reviewer: 'codex',
        plan: 'docs/plans/batch-03.md',
        baseSha,
      }),
      (error) => error.code === 'ROLE_SEPARATION_REQUIRED',
    );
  });
});

describe('bounded correction and final review', () => {
  it('runs one complete correction and one final verification to approval', async () => {
    const { root, baseSha } = await createRepository();
    const snapshot = await changedSnapshot(root, baseSha);
    const config = controllerConfig(root);
    const initialStatePath = '.cowork/reviews/batch-3-initial-review.json';
    const correctionStatePath = '.cowork/reports/batch-3-correction-report.json';
    const initialArtifact = initialReview(snapshot, {
      baseSha,
      findings: [finding()],
      verdict: 'NEEDS_REVISION',
    });
    await writeJson(join(root, initialStatePath), initialArtifact);
    const correctionOutput = join(root, '.cowork', 'runtime', 'correction-output.json');
    await writeJson(
      correctionOutput,
      correctionReport(snapshot, initialStatePath, ['B-001'], { baseSha }),
    );
    setFakeOutput(config, 'implementer', correctionOutput);
    await writeState(
      config,
      workflowState(baseSha, {
        phase: 'FIX_BLOCKING_FINDINGS',
        artifacts: {
          implementationReport: '.cowork/reports/implementation.json',
          initialReview: initialStatePath,
          correctionReport: null,
          finalReview: null,
        },
        reviewRound: 1,
        openBlockingFindingIds: ['B-001'],
      }),
    );

    const corrected = await runOnce(config);
    assert.equal(corrected.state.phase, 'REVIEW_FINAL');
    assert.equal(corrected.state.correctionRound, 1);

    const finalOutput = join(root, '.cowork', 'runtime', 'final-output.json');
    await writeJson(
      finalOutput,
      finalReview(snapshot, initialStatePath, correctionStatePath, ['B-001'], {
        baseSha,
        previousReviewedHeadSha: snapshot.headSha,
      }),
    );
    setFakeOutput(config, 'reviewer', finalOutput);
    const approved = await runOnce(config);
    assert.equal(approved.state.phase, 'READY_TO_COMMIT');
    assert.equal(approved.state.reviewRound, 2);
    assert.equal(approved.state.openBlockingFindingIds.length, 0);
  });
});

describe('safe closure and continuity', () => {
  it('stops safely at READY_TO_COMMIT when auto-commit is disabled', async () => {
    const { root, baseSha } = await createRepository();
    const snapshot = await changedSnapshot(root, baseSha);
    const config = controllerConfig(root);
    const state = enterPhase(
      workflowState(baseSha, {
        approvalSnapshot: snapshot,
        automation: { autoCommit: false, autoPush: false, autoAdvance: true },
      }),
      'READY_TO_COMMIT',
    );
    await writeState(config, state);

    const result = await runOnce(config);
    assert.equal(result.stop, true);
    assert.equal(result.state.phase, 'READY_TO_COMMIT');
    assert.equal(result.state.stopReason, 'AUTO_COMMIT_DISABLED');
  });

  it('rejects a manual commit whose content differs from the approved snapshot', async () => {
    const { root, baseSha } = await createRepository();
    const snapshot = await changedSnapshot(root, baseSha, 'reviewed content\n');
    const config = controllerConfig(root);
    const state = enterPhase(
      workflowState(baseSha, {
        approvalSnapshot: snapshot,
        automation: { autoCommit: false, autoPush: false, autoAdvance: true },
      }),
      'READY_TO_COMMIT',
    );
    await writeState(config, state);
    await writeFile(join(root, 'change.txt'), 'different committed content\n', 'utf8');
    git(root, ['add', '--', 'change.txt']);
    git(root, ['commit', '-m', 'feat: unreviewed content']);

    const result = await runOnce(config);

    assert.equal(result.stop, true);
    assert.equal(result.state.phase, 'READY_TO_COMMIT');
    assert.equal(result.state.stopReason, 'AUTO_COMMIT_DISABLED');
    assert.equal(
      result.state.lastAction.reason,
      'Committed content does not match reviewed content',
    );
    assert.deepEqual(
      result.state.lastAction.contentMismatches.map(({ path }) => path),
      ['change.txt'],
    );
  });

  it('commits only reviewed files, closes, and auto-advances an approved next batch', async () => {
    const { root, baseSha } = await createRepository();
    const snapshot = await changedSnapshot(root, baseSha);
    const runtimePath = join(root, '.cowork', 'raw', 'must-not-commit.txt');
    await mkdir(join(root, '.cowork', 'raw'), { recursive: true });
    await writeFile(runtimePath, 'runtime\n', 'utf8');
    const config = controllerConfig(root);
    const state = enterPhase(
      workflowState(baseSha, {
        approvalSnapshot: snapshot,
        automation: { autoCommit: true, autoPush: false, autoAdvance: true },
        pushRequired: false,
        approvedBatches: [
          {
            batchId: 4,
            planPath: 'docs/plans/batch-04.md',
            acceptanceCriteria: ['criterion-4'],
            commitMessage: 'feat: batch 4',
          },
        ],
      }),
      'READY_TO_COMMIT',
    );
    await writeState(config, state);

    const committed = await runOnce(config);
    assert.equal(committed.state.phase, 'CLOSE_BATCH');
    assert.deepEqual(git(root, ['show', '--pretty=', '--name-only', 'HEAD']).split('\n'), [
      'change.txt',
    ]);
    const closed = await runOnce(config);
    assert.equal(closed.state.phase, 'ADVANCE_BATCH');
    const advanced = await runOnce(config);
    assert.equal(advanced.state.phase, 'IMPLEMENT');
    assert.equal(advanced.state.activeBatch, 4);
  });

  it('stops safely when a required push is not automated', async () => {
    const { root, baseSha } = await createRepository();
    const config = controllerConfig(root);
    const state = enterPhase(
      workflowState(baseSha, {
        approvedCommitSha: baseSha,
        pushRequired: true,
        automation: { autoCommit: false, autoPush: false, autoAdvance: true },
      }),
      'CLOSE_BATCH',
    );
    await writeState(config, state);

    const result = await runOnce(config);
    assert.equal(result.state.phase, 'CLOSE_BATCH');
    assert.equal(result.state.stopReason, 'AUTO_PUSH_DISABLED');
  });

  it('stops after closure when auto-advance is disabled', async () => {
    const { root, baseSha } = await createRepository();
    const config = controllerConfig(root);
    const state = enterPhase(
      workflowState(baseSha, {
        automation: { autoCommit: false, autoPush: false, autoAdvance: false },
      }),
      'ADVANCE_BATCH',
    );
    await writeState(config, state);

    const result = await runOnce(config);
    assert.equal(result.state.phase, 'ADVANCE_BATCH');
    assert.equal(result.state.stopReason, 'AUTO_ADVANCE_DISABLED');
  });
});

describe('output repair', () => {
  it('allows exactly one formatting repair without repeating the review', async () => {
    const { root, baseSha } = await createRepository();
    const snapshot = await changedSnapshot(root, baseSha);
    const invalidPath = join(root, '.cowork', 'runtime', 'invalid.txt');
    const validPath = join(root, '.cowork', 'runtime', 'valid.json');
    const counterPath = join(root, '.cowork', 'runtime', 'counter.txt');
    await mkdir(join(root, '.cowork', 'runtime'), { recursive: true });
    await writeFile(invalidPath, 'prose-only approval\n', 'utf8');
    await writeJson(validPath, initialReview(snapshot, { baseSha }));
    const config = controllerConfig(root);
    config.reviewer = {
      ...config.reviewer,
      args: [FAKE_AGENT, '--outputs', `${invalidPath},${validPath}`, '--counter', counterPath],
    };
    await writeState(config, workflowState(baseSha));

    const result = await runOnce(config);
    assert.equal(result.state.phase, 'READY_TO_COMMIT');
    assert.equal(result.state.lastInvocation.attempt, 2);
    assert.equal(await readFile(counterPath, 'utf8'), '2');
  });

  it('stops for human decision after the repair output is still invalid', async () => {
    const { root, baseSha } = await createRepository();
    await changedSnapshot(root, baseSha);
    const invalidPath = join(root, '.cowork', 'runtime', 'invalid.txt');
    const counterPath = join(root, '.cowork', 'runtime', 'counter.txt');
    await mkdir(join(root, '.cowork', 'runtime'), { recursive: true });
    await writeFile(invalidPath, 'still not JSON\n', 'utf8');
    const config = controllerConfig(root);
    config.reviewer = {
      ...config.reviewer,
      args: [FAKE_AGENT, '--outputs', `${invalidPath},${invalidPath}`, '--counter', counterPath],
    };
    await writeState(config, workflowState(baseSha));

    await assert.rejects(
      runOnce(config),
      (error) => error.code === 'INVALID_OUTPUT_RETRY_EXHAUSTED',
    );
    const state = await loadState(config.stateFile);
    assert.equal(state.phase, 'HUMAN_DECISION_REQUIRED');
    assert.equal(state.stopReason, 'INVALID_OUTPUT_RETRY_EXHAUSTED');
    assert.equal(await readFile(counterPath, 'utf8'), '2');
  });
});
