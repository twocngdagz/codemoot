// Batch 15 adoption regressions: the DISTRIBUTED /build skill matches the checked-in
// source byte for byte, `codemoot init --preset review-gated` actually initializes, and the
// skill's documented commands stay synchronized with the real Commander surface.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@codemoot/core';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommand } from '../src/commands/init.js';
import { installSkillsCommand } from '../src/commands/install-skills.js';
import { program } from '../src/index.js';

const REPO_SKILL_PATH = join(__dirname, '..', '..', '..', '.claude', 'skills', 'build', 'SKILL.md');

describe('installed /build skill', () => {
  let projectDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'codemoot-install-skills-'));
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('installs the review-gated build skill byte-identical to the checked-in source', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await installSkillsCommand({ force: true });

    const installed = readFileSync(
      join(projectDir, '.claude', 'skills', 'build', 'SKILL.md'),
      'utf-8',
    );
    const checkedIn = readFileSync(REPO_SKILL_PATH, 'utf-8');
    // Parity: one authoritative content source — the repository skill.
    expect(installed).toBe(checkedIn);
    // The mandatory-debate loop is gone from the distributed skill.
    expect(installed).toContain('Review-Gated Batch Workflow');
    expect(installed).not.toContain('MANDATORY');
    expect(installed).not.toContain('NEVER skip debate rounds');
    expect(installed).not.toContain('codemoot build start "TASK"');

    // The generated CLAUDE.md section describes /build as the review-gated workflow.
    const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('/build');
    expect(claudeMd).toContain('Review-gated batch workflow');
    expect(claudeMd).not.toContain('debate → plan → implement → GPT review → fix');
  });
});

describe('codemoot init --preset review-gated', () => {
  let projectDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'codemoot-init-'));
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('initializes the documented preset and writes a valid review-gated configuration', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await initCommand({ preset: 'review-gated', nonInteractive: true });

    const written = readFileSync(join(projectDir, '.cowork.yml'), 'utf-8');
    expect(written).toContain('review-gated-batches');
    // The written file loads back as a valid review-gated configuration.
    const config = loadConfig({ projectDir });
    expect(config.workflow).toBe('review-gated-batches');
    expect(config.reviewGated?.gates.humanMerge).toBe('required');
    expect(config.debate?.enabled).toBe(false);
    // Post-init guidance points at the review-gated workflow, not the legacy plan flow.
    const guidance = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(guidance).toContain('codemoot workflow start --plan');
    expect(guidance).not.toContain('codemoot plan "describe your task"');
  });
});

describe('/build skill stays synchronized with the Commander surface', () => {
  it('documents every mandatory option of each batch command it references', () => {
    const skill = readFileSync(REPO_SKILL_PATH, 'utf-8');
    const batch = program.commands.find((candidate) => candidate.name() === 'batch');
    if (batch === undefined) throw new Error('batch command group missing');

    const referenced = new Set<string>();
    for (const match of skill.matchAll(/codemoot batch ([a-z-]+)/g)) {
      const name = match[1];
      if (name !== undefined) referenced.add(name);
    }
    expect(referenced.size).toBeGreaterThanOrEqual(9);

    for (const name of referenced) {
      const command: Command | undefined = batch.commands.find(
        (candidate) => candidate.name() === name,
      );
      expect(command, `skill references unknown command 'batch ${name}'`).toBeDefined();
      if (command === undefined) continue;
      for (const option of command.options) {
        if (!option.mandatory) continue;
        expect(
          skill.includes(option.long ?? ''),
          `skill omits mandatory ${option.long} of 'batch ${name}'`,
        ).toBe(true);
      }
    }
  });
});
