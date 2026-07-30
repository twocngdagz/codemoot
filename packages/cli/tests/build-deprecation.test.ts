// Batch 15: the legacy build loop stays functional but announces its deprecation on stderr,
// pointing at the review-gated workflow — stdout output is unchanged for scripted consumers.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStartCommand } from '../src/commands/build.js';

describe('legacy build deprecation', () => {
  let projectDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'codemoot-build-deprecation-'));
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('warns on stderr and still completes the legacy start on stdout', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await buildStartCommand('legacy task', { maxRounds: 1 });

    const firstStderr = errorSpy.mock.calls[0]?.[0];
    expect(typeof firstStderr).toBe('string');
    if (typeof firstStderr !== 'string') return;
    expect(firstStderr).toContain('deprecated');
    expect(firstStderr).toContain('codemoot workflow start');
    expect(firstStderr).toContain(
      'https://github.com/twocngdagz/codemoot/blob/master/docs/review-workflow-adoption.md',
    );

    // The legacy loop still works: stdout still carries the machine-readable start record.
    const printed = logSpy.mock.calls.at(-1)?.[0];
    expect(typeof printed).toBe('string');
    if (typeof printed !== 'string') return;
    const output = JSON.parse(printed) as { task: string; status: string };
    expect(output.task).toBe('legacy task');
    expect(output.status).toBe('planning');
  });
});
