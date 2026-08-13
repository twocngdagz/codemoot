// CLI-parse contract for the batch scope: an invalid --max-batches is rejected by the
// argument parser itself — commander exits before the action runs, so no workflow, no
// branch, and no database row is ever created. Runs against the BUILT CLI, because the
// parse layer is exactly what a real operator's shell hits.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

function runCli(args: readonly string[]): { status: number | null; stderr: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'codemoot-flags-'));
  try {
    const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('workflow run --max-batches parse rejection', () => {
  it('rejects 0 at parse — no workflow is created', () => {
    const result = runCli(['workflow', 'run', '--plan', 'plan.md', '--max-batches', '0']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('positive integer');
  });

  it('rejects a non-numeric value at parse', () => {
    const result = runCli(['workflow', 'run', '--plan', 'plan.md', '--max-batches', 'two']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('positive integer');
  });

  it('rejects a negative value at parse', () => {
    const result = runCli(['workflow', 'run', '--plan', 'plan.md', '--max-batches', '-1']);
    expect(result.status).not.toBe(0);
  });
});
