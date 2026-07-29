import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../lib/config.mjs';
import { captureGitSnapshot } from '../lib/git.mjs';
import { writeJsonAtomic } from '../lib/state.mjs';
import { roleForPhase } from '../lib/transitions.mjs';

export const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

export function git(root, arguments_) {
  return execFileSync('git', arguments_, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), 'review-controller-'));
  git(root, ['init', '-b', 'master']);
  git(root, ['config', 'user.name', 'Controller Test']);
  git(root, ['config', 'user.email', 'controller@example.test']);
  await writeFile(join(root, 'base.txt'), 'base\n', 'utf8');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '-m', 'base']);
  const baseSha = git(root, ['rev-parse', 'HEAD']);
  return { root, baseSha };
}

export function controllerConfig(root, overrides = {}) {
  const defaultExecutor = {
    agent: 'codex',
    command: process.execPath,
    args: [FAKE_AGENT],
    promptDelivery: 'stdin',
    timeoutMs: 5_000,
  };
  return normalizeConfig(
    {
      repositoryRoot: root,
      stateFile: '.cowork/workflow-state.json',
      artifactDirectory: '.cowork/reviews',
      reportDirectory: '.cowork/reports',
      rawOutputDirectory: '.cowork/raw',
      runtimeDirectory: '.cowork/runtime',
      lockFile: '.cowork/controller.lock',
      implementer: defaultExecutor,
      reviewer: { ...defaultExecutor, agent: 'claude' },
      invalidOutputRetryCount: 1,
      autoCommit: false,
      autoPush: false,
      autoAdvance: true,
      pushRequired: false,
      branch: 'master',
      remote: 'origin',
      environmentVariableAllowlist: ['PATH', 'HOME'],
      maximumControllerActions: 20,
      approvedBatches: [],
      ...overrides,
    },
    root,
  );
}

export function workflowState(baseSha, overrides = {}) {
  const base = {
    schemaVersion: 1,
    workflowId: 'workflow-test',
    status: 'ACTIVE',
    activeBatch: 3,
    phase: 'REVIEW_INITIAL',
    authorisedRole: 'REVIEWER',
    authorisedAgent: 'claude',
    implementer: 'codex',
    reviewer: 'claude',
    batchPlanPath: 'docs/plans/batch-03.md',
    baseSha,
    reviewedHeadSha: null,
    reviewRound: 0,
    correctionRound: 0,
    limits: {
      initialReviewPasses: 1,
      correctionPasses: 1,
      finalReviewPasses: 1,
      maximumControllerActions: 20,
    },
    automation: {
      autoCommit: false,
      autoPush: false,
      autoAdvance: true,
    },
    pushRequired: false,
    branch: 'master',
    remote: 'origin',
    approvedBatches: [],
    requiredAcceptanceCriteria: ['criterion-1'],
    mergeBlockingCriteria: [],
    openBlockingFindingIds: [],
    deferredFindingIds: [],
    artifacts: {
      implementationReport: '.cowork/reports/batch-3-implementation-report.json',
      initialReview: null,
      correctionReport: null,
      finalReview: null,
    },
    commitMessage: 'feat: approved batch',
    approvalSnapshot: null,
    approvedCommitSha: null,
    pushedCommitSha: null,
    actionCount: 0,
    lastAction: null,
    lastInvocation: null,
    nextAction: 'RUN_INITIAL_REVIEWER',
    stopReason: null,
  };
  const state = { ...base, ...overrides };
  Object.assign(state, roleForPhase(state, state.phase));
  return state;
}

export function finding(overrides = {}) {
  return {
    findingId: 'B-001',
    severity: 'HIGH',
    category: 'correctness',
    file: 'change.txt',
    location: 'line 1',
    requirementOrInvariant: 'criterion-1',
    observedImplementation: 'The invariant is not enforced',
    impact: 'The workflow can advance incorrectly',
    requiredCorrection: 'Enforce the invariant',
    verificationRequired: 'Run the focused regression test',
    blocking: true,
    ...overrides,
  };
}

export function initialReview(snapshot, overrides = {}) {
  const findings = overrides.findings ?? [];
  const blockingFindingCount = findings.filter((item) => item.blocking).length;
  const deferredFindingCount = findings.filter((item) => !item.blocking).length;
  return {
    schemaVersion: 1,
    workflowId: 'workflow-test',
    batchId: 3,
    reviewType: 'INITIAL',
    reviewRound: 1,
    baseSha: overrides.baseSha,
    reviewedHeadSha: snapshot.headSha,
    filesReviewed: snapshot.changedFiles,
    acceptanceCriteriaReviewed: ['criterion-1'],
    verification: { commands: ['node --test'] },
    scopeCompliant: true,
    reviewComplete: true,
    findings,
    blockingFindingCount,
    deferredFindingCount,
    verdict: blockingFindingCount > 0 ? 'NEEDS_REVISION' : 'APPROVED',
    ...overrides,
  };
}

export function correctionReport(snapshot, initialPath, findingIds = ['B-001'], overrides = {}) {
  return {
    schemaVersion: 1,
    workflowId: 'workflow-test',
    batchId: 3,
    correctionRound: 1,
    sourceReviewArtifact: initialPath,
    baseSha: overrides.baseSha,
    resultingHeadSha: snapshot.headSha,
    reviewComplete: true,
    dispositions: findingIds.map((findingId) => ({
      findingId,
      disposition: 'FIXED',
      explanation: 'The invariant is now enforced',
      filesChanged: ['change.txt'],
      verificationPerformed: { commands: ['node --test'] },
      evidence: 'Regression test passes',
    })),
    verification: { commands: ['node --test'] },
    ...overrides,
  };
}

export function finalReview(
  snapshot,
  initialPath,
  correctionPath,
  findingIds = ['B-001'],
  overrides = {},
) {
  return {
    schemaVersion: 1,
    workflowId: 'workflow-test',
    batchId: 3,
    reviewType: 'FINAL',
    reviewRound: 2,
    sourceInitialReview: initialPath,
    sourceCorrectionReport: correctionPath,
    baseSha: overrides.baseSha,
    previousReviewedHeadSha: overrides.previousReviewedHeadSha ?? snapshot.headSha,
    reviewedHeadSha: snapshot.headSha,
    reviewComplete: true,
    findingResults: findingIds.map((findingId) => ({
      findingId,
      status: 'FIXED_AND_VERIFIED',
      explanation: 'The regression is fixed',
      verificationPerformed: { commands: ['node --test'] },
      evidence: 'Focused test passes',
    })),
    newRegressionFindings: [],
    verification: { commands: ['node --test'] },
    verdict: 'APPROVED',
    ...overrides,
  };
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeState(config, state) {
  await writeJsonAtomic(config.stateFile, state);
}

export async function changedSnapshot(root, baseSha, contents = 'batch change\n') {
  await writeFile(join(root, 'change.txt'), contents, 'utf8');
  return captureGitSnapshot(root, baseSha);
}

export async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
