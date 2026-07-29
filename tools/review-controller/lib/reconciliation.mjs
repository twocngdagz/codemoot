import { resolveStatePath, validationContext } from './artifacts.mjs';
import { ensureRuntimeDirectories } from './config.mjs';
import { ControllerError, errorMessage } from './errors.mjs';
import { captureGitSnapshot, verifyApprovedCommit, verifyPushed } from './git.mjs';
import { inspectLock, removeStaleLock } from './locking.mjs';
import { acquireControllerLock, actionRecord, now, writeState } from './runtime.mjs';
import { loadState, readBytes, readJson, validateWorkflowState } from './state.mjs';
import { enterPhase } from './transitions.mjs';
import { validateArtifact } from './validators.mjs';

async function inspectArtifacts(config, state) {
  const statuses = {};
  const loaded = {};
  for (const [key, path] of Object.entries(state.artifacts)) {
    if (!path) {
      statuses[key] = 'absent';
      continue;
    }
    try {
      loaded[key] = await readJson(resolveStatePath(config.repositoryRoot, path));
      statuses[key] = 'present';
    } catch (error) {
      statuses[key] = `invalid: ${errorMessage(error)}`;
    }
  }
  const initialReview = loaded.initialReview;
  const context = {
    workflowId: state.workflowId,
    batchId: state.activeBatch,
    baseSha: state.baseSha,
    approvedPlanPath: state.batchPlanPath,
    requiredAcceptanceCriteria: state.requiredAcceptanceCriteria,
    mergeBlockingCriteria: state.mergeBlockingCriteria,
    sourceInitialReview: state.artifacts.initialReview,
    sourceCorrectionReport: state.artifacts.correctionReport,
    previousReviewedHeadSha: initialReview?.reviewedHeadSha,
    originalBlockingFindingIds: initialReview?.findings
      ?.filter((finding) => finding.blocking)
      .map((finding) => finding.findingId),
  };
  for (const [key, artifact] of Object.entries(loaded)) {
    try {
      validateArtifact(artifact, context, key);
      statuses[key] = 'valid';
    } catch (error) {
      statuses[key] = `invalid: ${errorMessage(error)}`;
    }
  }
  return statuses;
}

export async function reconcile(config) {
  await ensureRuntimeDirectories(config);
  const lockState = await inspectLock(config.lockFile);
  if (lockState.exists && !lockState.stale) {
    throw new ControllerError('CONTROLLER_LOCKED', 'A live controller process holds the lock');
  }
  if (lockState.stale) {
    await removeStaleLock(config.lockFile);
  }

  const stateBytes = await readBytes(config.stateFile);
  let state = validateWorkflowState(JSON.parse(stateBytes.toString('utf8')));
  const lock = await acquireControllerLock(config, stateBytes, state);
  try {
    const snapshot = await captureGitSnapshot(config.repositoryRoot, state.baseSha);
    const artifactStatuses = await inspectArtifacts(config, state);

    if (state.lastInvocation?.status === 'IN_PROGRESS') {
      state = enterPhase(
        {
          ...state,
          lastInvocation: {
            ...state.lastInvocation,
            status: 'OUTCOME_UNCERTAIN',
            reconciledAt: now(),
          },
          lastAction: actionRecord(state, 'RECONCILE_INTERRUPTED_INVOCATION', 'STOPPED'),
        },
        'HUMAN_DECISION_REQUIRED',
        'INTERRUPTED_INVOCATION_OUTCOME_UNCERTAIN',
      );
      await writeState(config, state);
    } else if (state.phase === 'READY_TO_COMMIT' && state.approvalSnapshot) {
      const verified = await verifyApprovedCommit(config.repositoryRoot, state.approvalSnapshot);
      if (verified.verified) {
        state = enterPhase(
          {
            ...state,
            approvedCommitSha: verified.commitSha,
            lastAction: actionRecord(state, 'RECONCILE_APPROVED_COMMIT', 'SUCCEEDED'),
          },
          'CLOSE_BATCH',
        );
        await writeState(config, state);
      }
    } else if (state.phase === 'CLOSE_BATCH' && state.pushRequired && state.approvedCommitSha) {
      const verified = await verifyPushed(
        config.repositoryRoot,
        state.remote,
        state.branch,
        state.approvedCommitSha,
      );
      if (verified.verified) {
        state = enterPhase(
          {
            ...state,
            pushedCommitSha: state.approvedCommitSha,
            lastAction: actionRecord(state, 'RECONCILE_REQUIRED_PUSH', 'SUCCEEDED'),
          },
          'ADVANCE_BATCH',
        );
        await writeState(config, state);
      }
    }

    return {
      state,
      staleLockRemoved: lockState.stale,
      artifactStatuses,
      git: snapshot,
    };
  } finally {
    await lock.release();
  }
}

export async function validateArtifactFile(config, path) {
  const artifact = await readJson(path);
  let context = {};
  try {
    const state = await loadState(config.stateFile);
    const snapshot = await captureGitSnapshot(config.repositoryRoot, state.baseSha);
    context = await validationContext(config, state, snapshot);
  } catch (error) {
    if (
      !(
        error instanceof ControllerError &&
        ['FILE_NOT_FOUND', 'PRIOR_ARTIFACT_MISSING'].includes(error.code)
      )
    ) {
      throw error;
    }
  }
  return validateArtifact(artifact, context);
}
