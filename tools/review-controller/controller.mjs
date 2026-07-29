#!/usr/bin/env node

import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './lib/config.mjs';
import {
  initializeState,
  reconcile,
  runOnce,
  runUntilStop,
  validateArtifactFile,
} from './lib/controller-runner.mjs';
import { ControllerError, errorMessage } from './lib/errors.mjs';
import { loadState } from './lib/state.mjs';

const HELP = `Repository-local review workflow controller

Usage:
  node tools/review-controller/controller.mjs init [options]
  node tools/review-controller/controller.mjs status [options]
  node tools/review-controller/controller.mjs validate <artifact-file> [options]
  node tools/review-controller/controller.mjs run-once [options]
  node tools/review-controller/controller.mjs run-until-stop [options]
  node tools/review-controller/controller.mjs reconcile [options]

Common options:
  --root <path>          Repository root (default: current directory)
  --config <path>        Controller config (default: .cowork/controller-config.json)
  --state-file <path>    Override live state path

init requires:
  --workflow-id <id> --batch <number> --phase <IMPLEMENT|REVIEW_INITIAL>
  --implementer <agent> --reviewer <agent> --plan <path> --base-sha <sha>

init also accepts:
  --implementation-report <path>   Required when phase is REVIEW_INITIAL
  --criterion <text>               Repeat for required acceptance criteria
  --merge-blocking-criterion <text>
  --commit-message <text>
  --auto-commit | --no-auto-commit
  --auto-push | --no-auto-push
  --auto-advance | --no-auto-advance
  --force
`;

function camelCase(name) {
  return name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

export function parseCliArguments(arguments_) {
  const [command, ...tokens] = arguments_;
  const options = { criteria: [], mergeBlockingCriteria: [] };
  const positionals = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (token === '--force') {
      options.force = true;
      continue;
    }
    if (token.startsWith('--no-')) {
      options[camelCase(token.slice(5))] = false;
      continue;
    }
    if (['--auto-commit', '--auto-push', '--auto-advance'].includes(token)) {
      options[camelCase(token.slice(2))] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ControllerError('ARGUMENT_VALUE_REQUIRED', `${token} requires a value`);
    }
    index += 1;
    if (token === '--criterion') {
      options.criteria.push(value);
    } else if (token === '--merge-blocking-criterion') {
      options.mergeBlockingCriteria.push(value);
    } else {
      options[camelCase(token.slice(2))] = value;
    }
  }

  if (options.batch !== undefined) {
    options.batch = Number(options.batch);
  }
  return { command, options, positionals };
}

function printStatus(state) {
  const lines = [
    `workflow: ${state.workflowId}`,
    `active batch: ${state.activeBatch}`,
    `phase: ${state.phase}`,
    `authorised role: ${state.authorisedRole}`,
    `authorised agent: ${state.authorisedAgent}`,
    `next action: ${state.nextAction}`,
    `review rounds: ${state.reviewRound}/${state.limits.initialReviewPasses + state.limits.finalReviewPasses}`,
    `correction rounds: ${state.correctionRound}/${state.limits.correctionPasses}`,
    `open blockers: ${state.openBlockingFindingIds.join(', ') || 'none'}`,
    `deferred findings: ${state.deferredFindingIds.join(', ') || 'none'}`,
    `implementation report: ${state.artifacts.implementationReport ?? 'none'}`,
    `initial review: ${state.artifacts.initialReview ?? 'none'}`,
    `correction report: ${state.artifacts.correctionReport ?? 'none'}`,
    `final review: ${state.artifacts.finalReview ?? 'none'}`,
    `auto commit: ${state.automation.autoCommit}`,
    `auto push: ${state.automation.autoPush}`,
    `auto advance: ${state.automation.autoAdvance}`,
    `stop reason: ${state.stopReason ?? 'none'}`,
  ];
  console.log(lines.join('\n'));
}

async function main(arguments_) {
  const { command, options, positionals } = parseCliArguments(arguments_);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  const config = await loadConfig({
    root: options.root,
    configPath: options.config,
    stateFile: options.stateFile,
  });

  if (command === 'init') {
    const state = await initializeState(config, options);
    console.log(`Initialized ${relative(config.repositoryRoot, config.stateFile)}`);
    printStatus(state);
    return;
  }
  if (command === 'status') {
    printStatus(await loadState(config.stateFile));
    return;
  }
  if (command === 'validate') {
    if (positionals.length !== 1) {
      throw new ControllerError('ARTIFACT_PATH_REQUIRED', 'validate requires one artifact file');
    }
    const artifactPath = resolve(config.repositoryRoot, positionals[0]);
    const result = await validateArtifactFile(config, artifactPath);
    console.log(JSON.stringify({ valid: true, type: result.type, artifactPath }, null, 2));
    return;
  }
  if (command === 'run-once') {
    const result = await runOnce(config);
    printStatus(result.state);
    return;
  }
  if (command === 'run-until-stop') {
    const result = await runUntilStop(config);
    printStatus(result.state);
    console.log(`controller actions performed: ${result.actionsPerformed}`);
    return;
  }
  if (command === 'reconcile') {
    const result = await reconcile(config);
    printStatus(result.state);
    console.log(
      JSON.stringify(
        {
          staleLockRemoved: result.staleLockRemoved,
          artifactStatuses: result.artifactStatuses,
          gitHead: result.git.headSha,
          changedFiles: result.git.changedFiles,
        },
        null,
        2,
      ),
    );
    return;
  }
  throw new ControllerError('COMMAND_UNKNOWN', `Unknown command: ${command}`);
}

const isDirectInvocation =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof ControllerError) {
      console.error(`${error.code}: ${error.message}`);
      if (error.details) {
        console.error(JSON.stringify(error.details, null, 2));
      }
    } else {
      console.error(errorMessage(error));
    }
    process.exitCode = 1;
  });
}
