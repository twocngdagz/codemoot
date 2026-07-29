import { access, readFile } from 'node:fs/promises';

import { resolveStatePath } from './artifacts.mjs';
import { ensureRuntimeDirectories } from './config.mjs';
import { ControllerError, invariant } from './errors.mjs';
import { captureGitSnapshot } from './git.mjs';
import { writeState } from './runtime.mjs';
import { validateWorkflowState } from './state.mjs';
import { parseAndValidateArtifact } from './validators.mjs';

export async function initializeState(config, options) {
  await ensureRuntimeDirectories(config);
  invariant(options.workflowId, 'INIT_ARGUMENT_REQUIRED', '--workflow-id is required');
  invariant(
    Number.isInteger(options.batch) && options.batch > 0,
    'INIT_ARGUMENT_REQUIRED',
    '--batch is required',
  );
  invariant(
    options.phase === 'IMPLEMENT' || options.phase === 'REVIEW_INITIAL',
    'INIT_PHASE_INVALID',
    '--phase must be IMPLEMENT or REVIEW_INITIAL',
  );
  invariant(options.implementer, 'INIT_ARGUMENT_REQUIRED', '--implementer is required');
  invariant(options.reviewer, 'INIT_ARGUMENT_REQUIRED', '--reviewer is required');
  invariant(
    options.implementer !== options.reviewer,
    'ROLE_SEPARATION_REQUIRED',
    'Implementer and reviewer must be different',
  );
  invariant(options.plan, 'INIT_ARGUMENT_REQUIRED', '--plan is required');
  invariant(options.baseSha, 'INIT_ARGUMENT_REQUIRED', '--base-sha is required');

  try {
    await access(config.stateFile);
    if (!options.force) {
      throw new ControllerError(
        'STATE_ALREADY_EXISTS',
        `Refusing to overwrite existing state: ${config.stateFile}`,
      );
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
      throw error;
    }
  }

  const snapshot = await captureGitSnapshot(config.repositoryRoot, options.baseSha);
  const automation = {
    autoCommit: options.autoCommit ?? config.autoCommit,
    autoPush: options.autoPush ?? config.autoPush,
    autoAdvance: options.autoAdvance ?? config.autoAdvance,
  };
  const state = {
    schemaVersion: 1,
    workflowId: options.workflowId,
    status: 'ACTIVE',
    activeBatch: options.batch,
    phase: options.phase,
    authorisedRole: options.phase === 'IMPLEMENT' ? 'IMPLEMENTER' : 'REVIEWER',
    authorisedAgent: options.phase === 'IMPLEMENT' ? options.implementer : options.reviewer,
    implementer: options.implementer,
    reviewer: options.reviewer,
    batchPlanPath: options.plan,
    baseSha: options.baseSha,
    reviewedHeadSha: options.phase === 'REVIEW_INITIAL' ? snapshot.headSha : null,
    reviewRound: 0,
    correctionRound: 0,
    limits: {
      initialReviewPasses: 1,
      correctionPasses: 1,
      finalReviewPasses: 1,
      maximumControllerActions: config.maximumControllerActions,
    },
    automation,
    pushRequired: config.pushRequired,
    branch: config.branch,
    remote: config.remote,
    approvedBatches: config.approvedBatches,
    requiredAcceptanceCriteria: options.criteria ?? [],
    mergeBlockingCriteria: options.mergeBlockingCriteria ?? [],
    openBlockingFindingIds: [],
    deferredFindingIds: [],
    artifacts: {
      implementationReport: null,
      initialReview: null,
      correctionReport: null,
      finalReview: null,
    },
    commitMessage: options.commitMessage ?? config.commitMessage,
    approvalSnapshot: null,
    approvedCommitSha: null,
    pushedCommitSha: null,
    actionCount: 0,
    lastAction: null,
    lastInvocation: null,
    nextAction: options.phase === 'IMPLEMENT' ? 'RUN_IMPLEMENTER' : 'RUN_INITIAL_REVIEWER',
    stopReason: null,
  };

  if (options.phase === 'REVIEW_INITIAL') {
    invariant(
      options.implementationReport,
      'INIT_ARGUMENT_REQUIRED',
      '--implementation-report is required for REVIEW_INITIAL',
    );
    const reportPath = resolveStatePath(config.repositoryRoot, options.implementationReport);
    const reportSource = await readFile(reportPath, 'utf8');
    const context = {
      workflowId: state.workflowId,
      batchId: state.activeBatch,
      baseSha: state.baseSha,
      approvedPlanPath: state.batchPlanPath,
      reviewedHeadSha: snapshot.headSha,
      changedFiles: snapshot.changedFiles,
      requiredAcceptanceCriteria: state.requiredAcceptanceCriteria,
    };
    const validatedReport = parseAndValidateArtifact(reportSource, context, 'implementationReport');
    if (state.requiredAcceptanceCriteria.length === 0) {
      state.requiredAcceptanceCriteria = [...validatedReport.artifact.acceptanceCriteria];
    }
    state.artifacts.implementationReport = options.implementationReport;
  }

  validateWorkflowState(state);
  await writeState(config, state);
  return state;
}
