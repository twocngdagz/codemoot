import { artifactPathsForPhase, resolveStatePath, validationContext } from './artifacts.mjs';
import { ensureRuntimeDirectories, validateExecutorConfig } from './config.mjs';
import { ControllerError, invariant } from './errors.mjs';
import { createInvocationPaths, executeAgent } from './executors.mjs';
import { captureGitSnapshot, remoteHead, stagedFiles } from './git.mjs';
import { handleAdvanceBatch, handleCloseBatch, handleReadyToCommit } from './lifecycle.mjs';
import { authorizationFor, buildPrompt, buildRepairPrompt } from './prompts.mjs';
import { acquireControllerLock, actionRecord, now, writeState } from './runtime.mjs';
import {
  hashBytes,
  loadState,
  readBytes,
  restoreBytesAtomic,
  validateWorkflowState,
  writeJsonAtomic,
} from './state.mjs';
import {
  AGENT_PHASES,
  TERMINAL_PHASES,
  enterPhase,
  transitionWithArtifact,
} from './transitions.mjs';
import { parseAndValidateArtifact } from './validators.mjs';

function executorFor(config, role) {
  return validateExecutorConfig(config, role);
}

async function protectInvocation(config, state, invocation) {
  const next = {
    ...state,
    lastAction: actionRecord(state, invocation.action, 'STARTED', {
      artifactTarget: invocation.artifactTarget,
    }),
    lastInvocation: {
      status: 'IN_PROGRESS',
      phase: state.phase,
      authorisedRole: state.authorisedRole,
      authorisedAgent: state.authorisedAgent,
      artifactTarget: invocation.artifactTarget,
      attempt: invocation.attempt,
      startedAt: now(),
    },
    stopReason: null,
  };
  await writeState(config, next);
  const protectedBytes = await readBytes(config.stateFile);
  const protectedArtifacts = [];
  for (const path of Object.values(next.artifacts)) {
    if (!path) {
      continue;
    }
    const absolutePath = resolveStatePath(config.repositoryRoot, path);
    try {
      const bytes = await readBytes(absolutePath);
      protectedArtifacts.push({
        path: absolutePath,
        bytes,
        hash: hashBytes(bytes),
      });
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
        throw error;
      }
    }
  }
  return {
    state: next,
    protectedBytes,
    protectedHash: hashBytes(protectedBytes),
    protectedArtifacts,
  };
}

async function assertControllerStateUntampered(config, protectedState, commandResult) {
  let actualHash = null;
  try {
    actualHash = hashBytes(await readBytes(config.stateFile));
  } catch {
    actualHash = null;
  }
  const changedArtifacts = [];
  for (const artifact of protectedState.protectedArtifacts) {
    let artifactHash = null;
    try {
      artifactHash = hashBytes(await readBytes(artifact.path));
    } catch {
      artifactHash = null;
    }
    if (artifactHash !== artifact.hash) {
      changedArtifacts.push(artifact);
    }
  }
  if (actualHash === protectedState.protectedHash && changedArtifacts.length === 0) {
    return;
  }
  await restoreBytesAtomic(config.stateFile, protectedState.protectedBytes);
  for (const artifact of changedArtifacts) {
    await restoreBytesAtomic(artifact.path, artifact.bytes);
  }
  const errorCode =
    actualHash !== protectedState.protectedHash
      ? 'CONTROLLER_STATE_TAMPERED'
      : 'CONTROLLER_ARTIFACT_TAMPERED';
  const restored = {
    ...protectedState.state,
    lastAction: {
      ...protectedState.state.lastAction,
      status: 'REJECTED',
      completedAt: now(),
      errorCode,
      rawBasePath: commandResult.rawBasePath,
    },
    lastInvocation: {
      ...protectedState.state.lastInvocation,
      status: 'TAMPERED',
      completedAt: now(),
    },
    stopReason: errorCode,
  };
  await writeState(config, restored);
  throw new ControllerError(
    errorCode,
    'Agent changed controller-owned workflow data; original controller data was restored',
  );
}

function ensureAuthorisationMatchesState(state) {
  const authorization = authorizationFor(state);
  invariant(
    state.authorisedRole === authorization.authorisedRole &&
      state.authorisedAgent === authorization.authorisedAgent,
    'ROLE_VIOLATION',
    'Live state role does not match the role authorised for this phase',
  );
  invariant(
    state.implementer !== state.reviewer,
    'ROLE_SEPARATION_REQUIRED',
    'Implementer and reviewer must be different configured agents',
  );
  return authorization;
}

async function invokeAndValidate(config, state, beforeSnapshot, lockData) {
  const authorization = ensureAuthorisationMatchesState(state);
  const executor = executorFor(config, authorization.authorisedRole);
  invariant(
    !executor.agent || executor.agent === authorization.authorisedAgent,
    'ROLE_VIOLATION',
    `Configured executor ${executor.agent} is not authorised agent ${authorization.authorisedAgent}`,
  );
  const artifactPaths = artifactPathsForPhase(config, state);
  let lastError;
  let attempt = 0;
  let invocationState = state;

  while (attempt <= config.invalidOutputRetryCount) {
    attempt += 1;
    const invocationPaths = createInvocationPaths(config, state, attempt);
    const invocation = {
      action: attempt === 1 ? authorization.allowedAction : 'REPAIR_ARTIFACT_FORMAT',
      artifactTarget: artifactPaths.statePath,
      attempt,
    };
    const protectedState = await protectInvocation(config, invocationState, invocation);
    lockData.artifactTarget = artifactPaths.statePath;
    lockData.phase = state.phase;

    const prompt =
      attempt === 1
        ? await buildPrompt(config, protectedState.state, beforeSnapshot, {
            schemaPath: artifactPaths.schemaPath,
          })
        : buildRepairPrompt(state, lastError.rawBasePath, artifactPaths.schemaPath);
    const repairSnapshot =
      attempt === 1
        ? beforeSnapshot
        : await captureGitSnapshot(config.repositoryRoot, state.baseSha);
    const beforeStaged = await stagedFiles(config.repositoryRoot);
    const beforeRemoteHead = await remoteHead(config.repositoryRoot, state.remote, state.branch);
    let commandResult;
    try {
      commandResult = await executeAgent({
        executor,
        prompt,
        ...invocationPaths,
        repositoryRoot: config.repositoryRoot,
        environmentVariableAllowlist: config.environmentVariableAllowlist,
      });
    } catch (error) {
      if (error instanceof ControllerError && error.details?.rawBasePath) {
        await assertControllerStateUntampered(config, protectedState, {
          rawBasePath: error.details.rawBasePath,
        });
      }
      const failed = {
        ...protectedState.state,
        lastAction: {
          ...protectedState.state.lastAction,
          status: 'FAILED',
          completedAt: now(),
          errorCode: error.code ?? 'AGENT_COMMAND_FAILED',
        },
        lastInvocation: {
          ...protectedState.state.lastInvocation,
          status: 'FAILED',
          completedAt: now(),
        },
      };
      await writeState(config, enterPhase(failed, 'BLOCKED', 'AGENT_COMMAND_FAILED'));
      throw error;
    }

    await assertControllerStateUntampered(config, protectedState, commandResult);
    const afterSnapshot = await captureGitSnapshot(config.repositoryRoot, state.baseSha);
    const afterStaged = await stagedFiles(config.repositoryRoot);
    const afterRemoteHead = await remoteHead(config.repositoryRoot, state.remote, state.branch);
    if (
      afterSnapshot.headSha !== repairSnapshot.headSha ||
      JSON.stringify(afterStaged) !== JSON.stringify(beforeStaged) ||
      afterRemoteHead !== beforeRemoteHead
    ) {
      const rejected = {
        ...protectedState.state,
        lastAction: {
          ...protectedState.state.lastAction,
          status: 'REJECTED',
          completedAt: now(),
          errorCode: 'ROLE_CHANGED_CONTROLLER_OWNED_GIT_STATE',
        },
        lastInvocation: {
          ...protectedState.state.lastInvocation,
          status: 'REJECTED',
          completedAt: now(),
        },
      };
      await writeState(
        config,
        enterPhase(rejected, 'HUMAN_DECISION_REQUIRED', 'ROLE_CHANGED_CONTROLLER_OWNED_GIT_STATE'),
      );
      throw new ControllerError(
        'ROLE_CHANGED_CONTROLLER_OWNED_GIT_STATE',
        'The agent changed HEAD, the Git index, or the configured remote-tracking ref',
      );
    }
    if (
      (!authorization.mayModifyFiles || attempt > 1) &&
      afterSnapshot.fingerprint !== repairSnapshot.fingerprint
    ) {
      const rejected = {
        ...protectedState.state,
        lastAction: {
          ...protectedState.state.lastAction,
          status: 'REJECTED',
          completedAt: now(),
          errorCode: 'ROLE_MODIFIED_WORKTREE',
        },
        lastInvocation: {
          ...protectedState.state.lastInvocation,
          status: 'REJECTED',
          completedAt: now(),
        },
      };
      await writeState(
        config,
        enterPhase(rejected, 'HUMAN_DECISION_REQUIRED', 'ROLE_MODIFIED_WORKTREE'),
      );
      throw new ControllerError(
        'ROLE_MODIFIED_WORKTREE',
        'The authorised role changed repository files when file modification was forbidden',
      );
    }

    const context = await validationContext(config, state, afterSnapshot);
    try {
      const validated = parseAndValidateArtifact(commandResult.stdout, context, artifactPaths.type);
      await writeJsonAtomic(artifactPaths.absolutePath, validated.artifact);
      return {
        validated,
        artifactPaths,
        afterSnapshot,
        protectedState,
        commandResult,
        attempt,
      };
    } catch (error) {
      if (
        !(error instanceof ControllerError) ||
        !['ARTIFACT_INVALID', 'ARTIFACT_JSON_INVALID', 'ARTIFACT_TYPE_UNKNOWN'].includes(error.code)
      ) {
        throw error;
      }
      lastError = { error, rawBasePath: commandResult.rawBasePath };
      if (attempt > config.invalidOutputRetryCount) {
        const invalid = {
          ...protectedState.state,
          lastAction: {
            ...protectedState.state.lastAction,
            status: 'REJECTED',
            completedAt: now(),
            errorCode: error.code,
          },
          lastInvocation: {
            ...protectedState.state.lastInvocation,
            status: 'INVALID_OUTPUT',
            completedAt: now(),
          },
        };
        await writeState(
          config,
          enterPhase(invalid, 'HUMAN_DECISION_REQUIRED', 'INVALID_OUTPUT_RETRY_EXHAUSTED'),
        );
        throw new ControllerError(
          'INVALID_OUTPUT_RETRY_EXHAUSTED',
          'Agent output remained invalid after the permitted formatting repair',
          error.details,
        );
      }
      invocationState = {
        ...protectedState.state,
        lastInvocation: {
          ...protectedState.state.lastInvocation,
          status: 'INVALID_OUTPUT',
          completedAt: now(),
        },
      };
      await writeState(config, invocationState);
    }
  }
  throw new ControllerError('UNREACHABLE', 'Invocation loop terminated unexpectedly');
}

async function runAgentAction(config, state, lockData) {
  const beforeSnapshot = await captureGitSnapshot(config.repositoryRoot, state.baseSha);
  const result = await invokeAndValidate(config, state, beforeSnapshot, lockData);
  const next = transitionWithArtifact(
    result.protectedState.state,
    result.validated.type,
    result.validated.artifact,
    result.artifactPaths.statePath,
  );
  if (next.phase === 'READY_TO_COMMIT') {
    next.approvalSnapshot = result.afterSnapshot;
  }
  next.lastAction = {
    ...result.protectedState.state.lastAction,
    status: 'SUCCEEDED',
    completedAt: now(),
    artifactPath: result.artifactPaths.statePath,
    rawBasePath: result.commandResult.rawBasePath,
  };
  next.lastInvocation = {
    ...result.protectedState.state.lastInvocation,
    status: 'COMPLETE',
    completedAt: now(),
    attempt: result.attempt,
  };
  await writeState(config, next);
  return { state: next, progressed: true, stop: false };
}

export async function runOnce(config) {
  await ensureRuntimeDirectories(config);
  const stateBytes = await readBytes(config.stateFile);
  let state = validateWorkflowState(JSON.parse(stateBytes.toString('utf8')));
  const lock = await acquireControllerLock(config, stateBytes, state);

  try {
    if (state.lastInvocation?.status === 'IN_PROGRESS') {
      state = enterPhase(
        {
          ...state,
          lastInvocation: {
            ...state.lastInvocation,
            status: 'OUTCOME_UNCERTAIN',
            reconciledAt: now(),
          },
        },
        'HUMAN_DECISION_REQUIRED',
        'INTERRUPTED_INVOCATION_OUTCOME_UNCERTAIN',
      );
      await writeState(config, state);
      return { state, progressed: false, stop: true };
    }
    if (
      state.stopReason &&
      !['AUTO_COMMIT_DISABLED', 'AUTO_PUSH_DISABLED'].includes(state.stopReason)
    ) {
      return { state, progressed: false, stop: true };
    }
    if (AGENT_PHASES.includes(state.phase)) {
      return await runAgentAction(config, state, lock.data);
    }
    if (state.phase === 'READY_TO_COMMIT') {
      return await handleReadyToCommit(config, state);
    }
    if (state.phase === 'CLOSE_BATCH') {
      return await handleCloseBatch(config, state);
    }
    if (state.phase === 'ADVANCE_BATCH') {
      return await handleAdvanceBatch(config, state);
    }
    if (TERMINAL_PHASES.includes(state.phase)) {
      return { state, progressed: false, stop: true };
    }
    throw new ControllerError('PHASE_INVALID', `Unsupported controller phase ${state.phase}`);
  } finally {
    await lock.release();
  }
}

export async function runUntilStop(config) {
  const initialState = await loadState(config.stateFile);
  const maximum = Math.min(
    config.maximumControllerActions,
    initialState.limits.maximumControllerActions,
  );
  let result;
  for (let count = 0; count < maximum; count += 1) {
    result = await runOnce(config);
    if (result.stop || !result.progressed) {
      return { ...result, actionsPerformed: count + (result.progressed ? 1 : 0) };
    }
  }

  const stateBytes = await readBytes(config.stateFile);
  const state = validateWorkflowState(JSON.parse(stateBytes.toString('utf8')));
  const lock = await acquireControllerLock(config, stateBytes, state);
  try {
    const stopped = {
      ...state,
      stopReason: 'CONTROLLER_ACTION_LIMIT_REACHED',
      lastAction: actionRecord(state, 'RUN_UNTIL_STOP', 'STOPPED', { maximum }),
    };
    await writeState(config, stopped);
    return { state: stopped, progressed: false, stop: true, actionsPerformed: maximum };
  } finally {
    await lock.release();
  }
}

export { initializeState } from './initialization.mjs';
export { reconcile, validateArtifactFile } from './reconciliation.mjs';
