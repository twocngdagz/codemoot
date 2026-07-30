import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalVerificationCommandRunner,
  LocalVerificationLogStore,
  type ReviewWorkflowVerificationError,
  type VerificationLogContent,
  canonicalVerificationJson,
} from '../../../src/review-workflow-verification/index.js';

describe('LocalVerificationCommandRunner', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'codemoot-verification-'));
    temporaryDirectories.push(directory);
    return directory;
  }

  it('executes an exact argument array without shell interpretation', async () => {
    const directory = temporaryDirectory();
    const runner = new LocalVerificationCommandRunner();
    const hostileArgument = 'value; echo injected';
    const result = await runner.execute({
      command: {
        executable: process.execPath,
        arguments: ['-e', 'process.stdout.write(JSON.stringify(process.argv[1]))', hostileArgument],
        workingDirectory: directory,
        verificationType: 'test',
        relatedCriterionIds: ['criterion-1'],
      },
      timeoutMs: 5_000,
    });

    expect(result.outcome).toEqual({ kind: 'EXITED', exitCode: 0 });
    expect(result.stdout).toBe(JSON.stringify(hostileArgument));
    expect(result.stderr).toBe('');
  });

  it('records nonzero exits and complete stderr', async () => {
    const runner = new LocalVerificationCommandRunner();
    const result = await runner.execute({
      command: {
        executable: process.execPath,
        arguments: ['-e', "process.stderr.write('failure detail'); process.exit(7)"],
        workingDirectory: temporaryDirectory(),
        verificationType: 'test',
        relatedCriterionIds: [],
      },
      timeoutMs: 5_000,
    });

    expect(result.outcome).toEqual({ kind: 'EXITED', exitCode: 7 });
    expect(result.stderr).toBe('failure detail');
  });

  it('retains complete command output without applying the summary limit', async () => {
    const runner = new LocalVerificationCommandRunner();
    const result = await runner.execute({
      command: {
        executable: process.execPath,
        arguments: ['-e', "process.stdout.write('x'.repeat(262144))"],
        workingDirectory: temporaryDirectory(),
        verificationType: 'test',
        relatedCriterionIds: [],
      },
      timeoutMs: 5_000,
    });

    expect(result.outcome).toEqual({ kind: 'EXITED', exitCode: 0 });
    expect(result.stdout).toHaveLength(262_144);
  });

  it('records spawn errors as factual error outcomes', async () => {
    const runner = new LocalVerificationCommandRunner();
    const result = await runner.execute({
      command: {
        executable: join(temporaryDirectory(), 'missing-executable'),
        arguments: [],
        workingDirectory: temporaryDirectory(),
        verificationType: 'custom',
        relatedCriterionIds: [],
      },
      timeoutMs: 5_000,
    });

    expect(result.outcome).toMatchObject({ kind: 'ERROR', errorCode: 'ENOENT' });
  });

  it('records unexpected process signals as errors rather than fabricated exit codes', async () => {
    const runner = new LocalVerificationCommandRunner();
    const result = await runner.execute({
      command: {
        executable: process.execPath,
        arguments: ['-e', "process.kill(process.pid, 'SIGTERM')"],
        workingDirectory: temporaryDirectory(),
        verificationType: 'custom',
        relatedCriterionIds: [],
      },
      timeoutMs: 5_000,
    });

    expect(result.outcome).toMatchObject({ kind: 'ERROR', errorCode: 'PROCESS_SIGNAL' });
  });

  it('kills and records commands that exceed their timeout', async () => {
    const runner = new LocalVerificationCommandRunner();
    const result = await runner.execute({
      command: {
        executable: process.execPath,
        arguments: ['-e', "process.stdout.write('started'); setTimeout(() => {}, 10_000)"],
        workingDirectory: temporaryDirectory(),
        verificationType: 'test',
        relatedCriterionIds: [],
      },
      timeoutMs: 50,
    });

    expect(result.outcome).toEqual({ kind: 'TIMED_OUT', timeoutMs: 50 });
    expect(result.stdout).toBe('started');
  });

  it('records aborts without reporting a successful exit', async () => {
    const runner = new LocalVerificationCommandRunner();
    const controller = new AbortController();
    const execution = runner.execute({
      command: {
        executable: process.execPath,
        arguments: ['-e', 'setTimeout(() => {}, 10_000)'],
        workingDirectory: temporaryDirectory(),
        verificationType: 'test',
        relatedCriterionIds: [],
      },
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(execution).resolves.toMatchObject({
      outcome: { kind: 'ERROR', errorCode: 'ABORTED' },
    });
  });

  it('stores immutable full logs under a record-derived safe filename', () => {
    const directory = temporaryDirectory();
    const store = new LocalVerificationLogStore(directory);
    const content: VerificationLogContent = {
      schemaVersion: 1,
      command: 'pnpm',
      arguments: ['test'],
      workingDirectory: '/repository',
      startedAt: '2026-07-30T00:00:00.000Z',
      finishedAt: '2026-07-30T00:00:01.000Z',
      outcome: { kind: 'EXITED', exitCode: 0 },
      stdout: 'all tests passed',
      stderr: '',
    };

    const first = store.store('../../unsafe-record-id', content);
    expect(first.location.startsWith(directory)).toBe(true);
    expect(readFileSync(first.location, 'utf8')).toContain('all tests passed');
    expect(store.store('../../unsafe-record-id', content)).toEqual(first);
    expect(() =>
      store.store('../../unsafe-record-id', { ...content, stdout: 'different output' }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowVerificationError>>({
        code: 'LOG_IMMUTABILITY_CONFLICT',
      }),
    );
  });

  it('canonicalizes evidence objects independently of insertion order', () => {
    expect(canonicalVerificationJson({ z: 1, nested: { b: 2, a: 1 } })).toBe(
      canonicalVerificationJson({ nested: { a: 1, b: 2 }, z: 1 }),
    );
  });
});
