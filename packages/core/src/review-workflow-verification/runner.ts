import { spawn } from 'node:child_process';
import { verificationCommandSpecSchema } from '../review-workflow/schemas.js';
import type {
  VerificationCommandSpec,
  VerificationExecutionOutcome,
} from '../review-workflow/types.js';
import type { VerificationCommandExecution, VerificationCommandRunner } from './types.js';

type Clock = () => Date;

export class LocalVerificationCommandRunner implements VerificationCommandRunner {
  constructor(private readonly clock: Clock = () => new Date()) {}

  execute(input: {
    readonly command: VerificationCommandSpec;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<VerificationCommandExecution> {
    const command = verificationCommandSpecSchema.parse(input.command);
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new RangeError('Verification timeout must be a positive safe integer');
    }

    const startedAt = this.clock().toISOString();
    if (input.signal?.aborted === true) {
      return Promise.resolve({
        startedAt,
        finishedAt: this.clock().toISOString(),
        outcome: {
          kind: 'ERROR',
          errorCode: 'ABORTED',
          message: 'Verification command was aborted before execution',
        },
        stdout: '',
        stderr: '',
      });
    }

    return new Promise((resolveResult) => {
      const child = spawn(command.executable, [...command.arguments], {
        cwd: command.workingDirectory,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let spawnError: Error | undefined;

      const kill = (): void => {
        if (child.pid === undefined) return;
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          // The process may already have exited.
        }
      };
      const onAbort = (): void => {
        aborted = true;
        kill();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        kill();
      }, input.timeoutMs);
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        input.signal?.removeEventListener('abort', onAbort);
        const finishedAt = this.clock().toISOString();
        const capturedStdout = Buffer.concat(stdout).toString('utf8');
        const capturedStderr = Buffer.concat(stderr).toString('utf8');
        let outcome: VerificationExecutionOutcome;
        if (timedOut) {
          outcome = { kind: 'TIMED_OUT', timeoutMs: input.timeoutMs };
        } else if (aborted) {
          outcome = {
            kind: 'ERROR',
            errorCode: 'ABORTED',
            message: 'Verification command was aborted',
          };
        } else if (spawnError !== undefined) {
          outcome = {
            kind: 'ERROR',
            errorCode: nodeErrorCode(spawnError),
            message: spawnError.message,
          };
        } else if (signal !== null) {
          outcome = {
            kind: 'ERROR',
            errorCode: 'PROCESS_SIGNAL',
            message: `Verification command exited after signal ${signal}`,
          };
        } else {
          outcome = { kind: 'EXITED', exitCode: exitCode ?? 1 };
        }
        resolveResult({
          startedAt,
          finishedAt,
          outcome,
          stdout: capturedStdout,
          stderr: capturedStderr,
        });
      };

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        spawnError = error;
      });
      child.on('close', finish);
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted === true) onAbort();
    });
  }
}

function nodeErrorCode(error: Error): string | undefined {
  if (!('code' in error) || typeof error.code !== 'string') return undefined;
  return error.code;
}
