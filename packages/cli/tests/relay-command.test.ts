// The relay is a message bus: it carries, health-checks, counts cycles, and records.
// These tests prove the four jobs and the ONE piece of structure in the system — the
// reviewer's VERDICT line — plus the property that gives the design its recovery story:
// the event log alone is enough to resume from any interruption, with no ceremony.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@codemoot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countPlanBatches,
  parseVerdict,
  relayResumeCommand,
  relayRunCommand,
} from '../src/commands/relay.js';
import { getDbPath } from '../src/utils.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-relay.mjs', import.meta.url));

const PLAN = `# Sample plan

### Batch 1
Write sample.txt.
- [ ] sample.txt exists

### Batch 2
Document sample.txt in README.
- [ ] README mentions sample.txt
`;

describe('parseVerdict — the single routing token', () => {
  it('routes each verdict stated on a final line', () => {
    expect(parseVerdict('looks wrong\nVERDICT: FIX')).toBe('FIX');
    expect(parseVerdict('fine\nverdict: proceed')).toBe('PROCEED');
    expect(parseVerdict('done\nVERDICT: COMPLETE\n\n')).toBe('COMPLETE');
  });

  it('returns null — pause, never guess — when absent or ambiguous', () => {
    expect(parseVerdict('I think this is fine but I forgot the line')).toBeNull();
    expect(parseVerdict('VERDICT: FIX\nactually no\nVERDICT: PROCEED')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });

  it('ignores verdicts DISCUSSED mid-reply — only the closing lines route', () => {
    const body = `${'If tests failed I would say VERDICT: FIX.\n'.repeat(15)}All good.\nVERDICT: PROCEED`;
    expect(parseVerdict(body)).toBe('PROCEED');
  });
});

describe('countPlanBatches — the plan IS the decomposition', () => {
  it('reads the batch count from the headings', () => {
    expect(countPlanBatches(PLAN)).toBe(2);
    expect(countPlanBatches('# no batches here')).toBe(1);
    expect(countPlanBatches('### Batch 1\n## Batch 10\n### Batch 3')).toBe(10);
  });
});

describe('codemoot relay (real command, two scripted models)', () => {
  let projectDir: string;
  let implFile: string;
  let revFile: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  function writeConfig(): void {
    writeFileSync(
      join(projectDir, '.cowork.yml'),
      JSON.stringify({
        configVersion: 3,
        // Deliberately NOT review-gated: the relay needs models and roles, nothing else.
        models: {
          implementer: {
            provider: 'anthropic',
            model: 'claude-opus-5',
            cliAdapter: {
              kind: 'claude',
              command: process.execPath,
              args: [FAKE, implFile],
              timeout: 60,
            },
          },
          reviewer: {
            provider: 'anthropic',
            model: 'claude-fable-5',
            cliAdapter: {
              kind: 'claude',
              command: process.execPath,
              args: [FAKE, revFile],
              timeout: 60,
            },
          },
        },
        roles: { implementer: { model: 'implementer' }, reviewer: { model: 'reviewer' } },
        debate: { enabled: false },
      }),
    );
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'codemoot-relay-'));
    implFile = join(projectDir, 'impl.responses.json');
    revFile = join(projectDir, 'rev.responses.json');
    execFileSync('git', ['init', '-q'], { cwd: projectDir });
    writeFileSync(join(projectDir, 'plan.md'), PLAN);
    writeConfig();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(projectDir, { recursive: true, force: true });
  });

  function printedStatus(): { status: string; batch: number; calls: number } {
    const last = logSpy.mock.calls.at(-1)?.[0];
    return JSON.parse(String(last));
  }

  function events(runId: string): { role: string; kind: string; content: string }[] {
    const db = openDatabase(getDbPath());
    const rows = db
      .prepare('SELECT role, kind, content FROM relay_events WHERE run_id = ? ORDER BY event_id')
      .all(runId) as { role: string; kind: string; content: string }[];
    db.close();
    return rows;
  }

  it('carries a full two-batch run with one fix cycle to COMPLETE', async () => {
    writeFileSync(
      implFile,
      JSON.stringify([
        'I wrote sample.txt. Commit abc.',
        'Fixed the newline. Commit def.',
        'I documented it. Commit ghi.',
      ]),
    );
    writeFileSync(
      revFile,
      JSON.stringify([
        'Missing trailing newline.\nVERDICT: FIX',
        'Verified sample.txt.\nVERDICT: PROCEED',
        'README verified. Everything in the plan is done.\nVERDICT: COMPLETE',
      ]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-e2e' });

    const status = printedStatus();
    expect(status.status).toBe('COMPLETE');
    expect(status.batch).toBe(2);
    expect(status.calls).toBe(6); // 3 implementer + 3 reviewer

    // The bus carried VERBATIM: the reviewer received exactly what the implementer said.
    const reviewerPrompts = JSON.parse(readFileSync(implFile.replace('impl', 'rev'), 'utf8'));
    void reviewerPrompts;
    const log = events('relay-e2e');
    const firstReviewerPrompt = log.find((e) => e.role === 'REVIEWER' && e.kind === 'PROMPT');
    expect(firstReviewerPrompt?.content).toContain('I wrote sample.txt. Commit abc.');
    // Both roles are told the turn is all they get — a live reviewer once armed watchers on
    // a browser suite and deferred its verdict to a follow-up that could never come.
    const firstImplementerPrompt = log.find((e) => e.role === 'IMPLEMENTER' && e.kind === 'PROMPT');
    expect(firstImplementerPrompt?.content).toContain('exactly one reply');
    expect(firstReviewerPrompt?.content).toContain('exactly one reply');
    const fixForward = log.filter((e) => e.role === 'IMPLEMENTER' && e.kind === 'PROMPT')[1];
    expect(fixForward?.content).toContain('Missing trailing newline.');

    // Sessions persisted per role: the second implementer call RESUMED the first.
    const implCalls = readFileSync(`${implFile}.prompts.jsonl`, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(implCalls[0].resumedSessionId).toBeNull();
    expect(implCalls[1].resumedSessionId).not.toBeNull();
  });

  it('pauses at the cycle cap and each operator decision routes correctly', async () => {
    writeFileSync(
      implFile,
      JSON.stringify(['Attempt.', 'Fixed?', 'Applied final feedback.', 'Batch 2 done.']),
    );
    writeFileSync(
      revFile,
      JSON.stringify([
        'No.\nVERDICT: FIX',
        'Still no.\nVERDICT: FIX',
        'Batch 2 fine.\nVERDICT: COMPLETE',
      ]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-cap', maxCycles: 2 });
    expect(printedStatus().status).toBe('PAUSED_CYCLE_CAP');

    // Without a decision the resume refuses — the human is the judge here, not the bus.
    await expect(relayResumeCommand('relay-cap', {})).rejects.toThrow(/--decision/);

    // accept: the implementer applies the last feedback as final, then the batch advances
    // with NO further review round.
    await relayResumeCommand('relay-cap', { decision: 'accept' });
    const status = printedStatus();
    expect(status.status).toBe('COMPLETE');
    const log = events('relay-cap');
    const acceptPrompt = log.filter((e) => e.role === 'IMPLEMENTER' && e.kind === 'PROMPT').at(-2);
    expect(acceptPrompt?.content).toContain('FINAL for this batch');
    expect(log.some((e) => e.kind === 'DECISION' && e.content === 'accept')).toBe(true);
  });

  it('pauses on a missing verdict and resume re-asks the reviewer', async () => {
    writeFileSync(implFile, JSON.stringify(['Did batch 1.', 'Did batch 2.']));
    writeFileSync(
      revFile,
      JSON.stringify(['Looks good I suppose.', 'VERDICT: PROCEED', 'Fine.\nVERDICT: COMPLETE']),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-unclear' });
    expect(printedStatus().status).toBe('PAUSED_UNCLEAR_VERDICT');

    await relayResumeCommand('relay-unclear', {});
    expect(printedStatus().status).toBe('COMPLETE');
    const log = events('relay-unclear');
    expect(
      log.some(
        (e) =>
          e.role === 'REVIEWER' &&
          e.kind === 'PROMPT' &&
          e.content.includes('did not end with a clear VERDICT'),
      ),
    ).toBe(true);
  });

  it('resumes an interrupted call by re-sending the prompt with the reconcile preface', async () => {
    writeFileSync(implFile, JSON.stringify(['Recovered and finished batch 1.', 'Batch 2 done.']));
    writeFileSync(revFile, JSON.stringify(['ok\nVERDICT: PROCEED', 'ok\nVERDICT: COMPLETE']));
    // Seed a run whose log ends with an unanswered implementer prompt — a crash mid-call.
    const db = openDatabase(getDbPath());
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO relay_runs (run_id, plan_path, project_dir, total_batches, max_cycles, batch, cycle, status, pending, implementer_session, reviewer_session, created_at, updated_at)
       VALUES ('relay-crash', ?, ?, 2, 3, 1, 1, 'STOPPED', NULL, NULL, NULL, ?, ?)`,
    ).run(join(projectDir, 'plan.md'), projectDir, now, now);
    db.prepare(
      `INSERT INTO relay_events (run_id, batch, cycle, role, kind, content, created_at)
       VALUES ('relay-crash', 1, 1, 'IMPLEMENTER', 'PROMPT', 'Work on Batch 1', ?)`,
    ).run(now);
    db.close();

    await relayResumeCommand('relay-crash', {});
    expect(printedStatus().status).toBe('COMPLETE');
    const implCalls = readFileSync(`${implFile}.prompts.jsonl`, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(implCalls[0].prompt).toContain('may have been interrupted');
    expect(implCalls[0].prompt).toContain('Work on Batch 1');
  });

  it('records the whole exchange — the transcript is the audit', async () => {
    writeFileSync(implFile, JSON.stringify(['b1.', 'b2.']));
    writeFileSync(revFile, JSON.stringify(['ok\nVERDICT: PROCEED', 'ok\nVERDICT: COMPLETE']));
    await relayRunCommand({ plan: 'plan.md', id: 'relay-audit' });
    const log = events('relay-audit');
    // Every call is two entries: the exact prompt sent, the exact reply received.
    expect(log.filter((e) => e.kind === 'PROMPT')).toHaveLength(4);
    expect(log.filter((e) => e.kind === 'RESPONSE')).toHaveLength(4);
  });
});
