import { invariant } from './errors.mjs';
import {
  assertSnapshotMatches,
  captureGitSnapshot,
  commitApprovedSnapshot,
  pushBranch,
  uncommittedFiles,
  verifyApprovedCommit,
  verifyPushed,
} from './git.mjs';
import { actionRecord, writeState } from './runtime.mjs';
import { enterPhase, initialiseNextBatch } from './transitions.mjs';

export async function handleReadyToCommit(config, state) {
  invariant(state.approvalSnapshot, 'APPROVAL_SNAPSHOT_MISSING', 'Reviewed snapshot is missing');
  const current = await captureGitSnapshot(config.repositoryRoot, state.baseSha);

  if (!state.automation.autoCommit) {
    const verified = await verifyApprovedCommit(config.repositoryRoot, state.approvalSnapshot);
    if (!verified.verified) {
      const stopped = {
        ...state,
        stopReason: 'AUTO_COMMIT_DISABLED',
        lastAction: actionRecord(state, 'VERIFY_APPROVED_COMMIT', 'STOPPED', verified),
      };
      await writeState(config, stopped);
      return { state: stopped, progressed: false, stop: true };
    }
    const next = enterPhase(
      {
        ...state,
        approvedCommitSha: verified.commitSha,
        actionCount: (state.actionCount ?? 0) + 1,
        lastAction: actionRecord(state, 'VERIFY_APPROVED_COMMIT', 'SUCCEEDED', verified),
      },
      'CLOSE_BATCH',
    );
    await writeState(config, next);
    return { state: next, progressed: true, stop: false };
  }

  assertSnapshotMatches(current, state.approvalSnapshot);
  const commitSha = await commitApprovedSnapshot(
    config.repositoryRoot,
    state.approvalSnapshot,
    state.commitMessage ?? config.commitMessage,
  );
  const next = enterPhase(
    {
      ...state,
      approvedCommitSha: commitSha,
      actionCount: (state.actionCount ?? 0) + 1,
      lastAction: actionRecord(state, 'COMMIT_APPROVED_BATCH', 'SUCCEEDED', { commitSha }),
    },
    'CLOSE_BATCH',
  );
  await writeState(config, next);
  return { state: next, progressed: true, stop: false };
}

export async function handleCloseBatch(config, state) {
  invariant(state.approvedCommitSha, 'APPROVED_COMMIT_MISSING', 'Approved commit is missing');
  const beforeSnapshot = await captureGitSnapshot(config.repositoryRoot, state.approvedCommitSha);
  invariant(
    beforeSnapshot.headSha === state.approvedCommitSha,
    'APPROVED_COMMIT_CHANGED',
    'HEAD no longer matches the approved commit',
  );
  invariant(
    (await uncommittedFiles(config.repositoryRoot)).length === 0,
    'WORKTREE_CHANGED_AFTER_COMMIT',
    'The product worktree changed after the approved commit',
  );
  if (!state.pushRequired) {
    const next = enterPhase(
      {
        ...state,
        actionCount: (state.actionCount ?? 0) + 1,
        lastAction: actionRecord(state, 'CLOSE_WITHOUT_PUSH', 'SUCCEEDED'),
      },
      'ADVANCE_BATCH',
    );
    await writeState(config, next);
    return { state: next, progressed: true, stop: false };
  }

  if (!state.automation.autoPush) {
    const verified = await verifyPushed(
      config.repositoryRoot,
      state.remote,
      state.branch,
      state.approvedCommitSha,
    );
    if (!verified.verified) {
      const stopped = {
        ...state,
        stopReason: 'AUTO_PUSH_DISABLED',
        lastAction: actionRecord(state, 'VERIFY_REQUIRED_PUSH', 'STOPPED', verified),
      };
      await writeState(config, stopped);
      return { state: stopped, progressed: false, stop: true };
    }
    const next = enterPhase(
      {
        ...state,
        pushedCommitSha: state.approvedCommitSha,
        actionCount: (state.actionCount ?? 0) + 1,
        lastAction: actionRecord(state, 'VERIFY_REQUIRED_PUSH', 'SUCCEEDED', verified),
      },
      'ADVANCE_BATCH',
    );
    await writeState(config, next);
    return { state: next, progressed: true, stop: false };
  }

  const pushedCommitSha = await pushBranch(config.repositoryRoot, state.remote, state.branch);
  invariant(
    pushedCommitSha === state.approvedCommitSha,
    'PUSHED_HEAD_MISMATCH',
    'Pushed HEAD does not match approved commit',
  );
  const afterSnapshot = await captureGitSnapshot(config.repositoryRoot, state.approvedCommitSha);
  invariant(
    afterSnapshot.headSha === beforeSnapshot.headSha &&
      (await uncommittedFiles(config.repositoryRoot)).length === 0,
    'GIT_STATE_CHANGED_DURING_PUSH',
    'Git state changed while the approved commit was being pushed',
  );
  const next = enterPhase(
    {
      ...state,
      pushedCommitSha,
      actionCount: (state.actionCount ?? 0) + 1,
      lastAction: actionRecord(state, 'PUSH_APPROVED_BATCH', 'SUCCEEDED', {
        pushedCommitSha,
      }),
    },
    'ADVANCE_BATCH',
  );
  await writeState(config, next);
  return { state: next, progressed: true, stop: false };
}

export async function handleAdvanceBatch(config, state) {
  if (!state.automation.autoAdvance) {
    const stopped = {
      ...state,
      stopReason: 'AUTO_ADVANCE_DISABLED',
      lastAction: actionRecord(state, 'ADVANCE_BATCH', 'STOPPED'),
    };
    await writeState(config, stopped);
    return { state: stopped, progressed: false, stop: true };
  }
  invariant(
    state.approvedCommitSha && (await uncommittedFiles(config.repositoryRoot)).length === 0,
    'CURRENT_BATCH_NOT_CLOSED',
    'Cannot advance while the current batch worktree is not clean',
  );
  const nextBatch = (state.approvedBatches ?? []).find(
    (batch) => batch.batchId > state.activeBatch,
  );
  if (!nextBatch) {
    const done = enterPhase(
      {
        ...state,
        status: 'COMPLETE',
        actionCount: (state.actionCount ?? 0) + 1,
        lastAction: actionRecord(state, 'ADVANCE_BATCH', 'SUCCEEDED', {
          result: 'NO_REMAINING_BATCH',
        }),
      },
      'DONE',
      'NO_REMAINING_BATCH',
    );
    await writeState(config, done);
    return { state: done, progressed: true, stop: true };
  }
  const snapshot = await captureGitSnapshot(config.repositoryRoot, state.approvedCommitSha);
  const next = {
    ...initialiseNextBatch(state, nextBatch, snapshot.headSha),
    actionCount: (state.actionCount ?? 0) + 1,
    lastAction: actionRecord(state, 'ADVANCE_BATCH', 'SUCCEEDED', {
      nextBatch: nextBatch.batchId,
    }),
  };
  await writeState(config, next);
  return { state: next, progressed: true, stop: false };
}
