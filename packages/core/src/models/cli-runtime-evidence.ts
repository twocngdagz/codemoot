import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve, sep } from 'node:path';

export interface CliRuntimeEvidence {
  readonly executablePath: string;
  readonly executableHash?: string;
  readonly cliVersion: string;
}

export interface CliProbeResult {
  readonly available: boolean;
  readonly command: string;
  readonly path?: string;
  readonly executableHash?: string;
  readonly version?: string;
  readonly error?: string;
}

export async function collectCliRuntimeEvidence(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<CliRuntimeEvidence> {
  const executablePath = await resolveCliExecutable(command, cwd, env);
  const [executableHash, cliVersion] = await Promise.all([
    hashExecutable(executablePath).catch(() => undefined),
    readCliVersion(executablePath, cwd, env),
  ]);
  return {
    executablePath,
    ...(executableHash === undefined ? {} : { executableHash }),
    cliVersion,
  };
}

export async function probeCliCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<CliProbeResult> {
  try {
    const evidence = await collectCliRuntimeEvidence(command, cwd, env);
    return {
      available: true,
      command,
      path: evidence.executablePath,
      ...(evidence.executableHash === undefined ? {} : { executableHash: evidence.executableHash }),
      version: evidence.cliVersion,
    };
  } catch (error) {
    return {
      available: false,
      command,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveCliExecutable(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const containsSeparator =
    command.includes(sep) || command.includes('/') || command.includes('\\');
  if (isAbsolute(command) || containsSeparator) {
    return resolveExistingExecutable(isAbsolute(command) ? command : resolve(cwd, command));
  }

  const extensions =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
      : [''];
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        return await resolveExistingExecutable(resolve(directory, `${command}${extension}`));
      } catch {
        // Continue through PATH candidates.
      }
    }
  }
  throw new Error(`${command} not found in PATH`);
}

async function resolveExistingExecutable(path: string): Promise<string> {
  await access(path, constants.X_OK);
  return realpath(path);
}

function hashExecutable(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('error', rejectHash);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function readCliVersion(
  executablePath: string,
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolveVersion, rejectVersion) => {
    execFile(
      executablePath,
      ['--version'],
      {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 5_000,
        shell: process.platform === 'win32',
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectVersion(error);
          return;
        }
        const version = `${stdout}${stderr}`.trim();
        if (version.length === 0) {
          rejectVersion(new Error(`${executablePath} --version returned no version`));
          return;
        }
        resolveVersion(version);
      },
    );
  });
}
