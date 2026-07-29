import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ControllerError } from './errors.mjs';

function filteredEnvironment(allowlist, additions = {}) {
  const environment = {};
  for (const name of allowlist) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  return { ...environment, ...additions };
}

function substituteArguments(arguments_, promptPath) {
  let replaced = false;
  const result = arguments_.map((value) => {
    if (value.includes('{promptFile}')) {
      replaced = true;
      return value.replaceAll('{promptFile}', promptPath);
    }
    return value;
  });
  return replaced ? result : [...result, promptPath];
}

export async function executeAgent(options) {
  const {
    executor,
    prompt,
    promptPath,
    rawBasePath,
    repositoryRoot,
    environmentVariableAllowlist,
  } = options;
  await mkdir(dirname(promptPath), { recursive: true });
  await mkdir(dirname(rawBasePath), { recursive: true });
  await writeFile(promptPath, prompt, 'utf8');

  const arguments_ =
    executor.promptDelivery === 'file'
      ? substituteArguments(executor.args, promptPath)
      : [...executor.args];
  const environment = filteredEnvironment(environmentVariableAllowlist, {
    REVIEW_CONTROLLER_PROMPT_FILE: promptPath,
  });

  const result = await new Promise((resolve, reject) => {
    const child = spawn(executor.command, arguments_, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, executor.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });

    if (executor.promptDelivery === 'stdin') {
      child.stdin.end(prompt);
    } else {
      child.stdin.end();
    }
  });

  await Promise.all([
    writeFile(`${rawBasePath}.stdout.txt`, result.stdout, 'utf8'),
    writeFile(`${rawBasePath}.stderr.txt`, result.stderr, 'utf8'),
  ]);

  if (result.code !== 0) {
    throw new ControllerError(
      'AGENT_COMMAND_FAILED',
      `Agent command failed with exit code ${result.code ?? 'unknown'}`,
      { ...result, rawBasePath },
    );
  }
  return { ...result, rawBasePath };
}

export function createInvocationPaths(config, state, attempt) {
  const prefix = `batch-${state.activeBatch}-${state.phase.toLowerCase()}-${attempt}`;
  return {
    promptPath: join(config.runtimeDirectory, `${prefix}.prompt.md`),
    rawBasePath: join(config.rawOutputDirectory, prefix),
  };
}
