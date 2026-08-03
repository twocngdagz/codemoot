// The relay is a message bus: it carries, health-checks, counts cycles, and records.
// These tests prove the four jobs and the ONE piece of structure in the system — the
// reviewer's VERDICT line — plus the property that gives the design its recovery story:
// the event log alone is enough to resume from any interruption, with no ceremony.

import { execFileSync, spawn } from 'node:child_process';
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

  it('survives an adapter exception mid-call: records it, stops, and resumes clean', async () => {
    // The 28-minute crash, reproduced: a paused-unclear run is resumed, the direct re-ask
    // call dies at the adapter level (process exits without a result), and the old code let
    // that exception escape relayResumeCommand and kill the runner — losing the guarantee
    // that every failure becomes a resumable note. Now it is recorded like any other.
    writeFileSync(implFile, JSON.stringify(['Did batch 1.', 'Did batch 2.']));
    writeFileSync(
      revFile,
      JSON.stringify([
        'Looks fine, probably.',
        '__CRASH__',
        'Verified.\nVERDICT: PROCEED',
        'Verified.\nVERDICT: COMPLETE',
      ]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-boundary' });
    expect(printedStatus().status).toBe('PAUSED_UNCLEAR_VERDICT');

    // The re-ask itself dies at the adapter level. No throw, no dead process — a note.
    await relayResumeCommand('relay-boundary', {});
    expect(printedStatus().status).toBe('STOPPED');
    const afterCrash = events('relay-boundary');
    expect(
      afterCrash.some(
        (e) => e.role === 'RELAY' && e.kind === 'NOTE' && e.content.includes('Call failed'),
      ),
    ).toBe(true);

    // Resume again: the log ends with the unanswered re-ask, so it is re-sent with the
    // reconcile preface — not stacked with a second re-ask — and the run completes.
    await relayResumeCommand('relay-boundary', {});
    expect(printedStatus().status).toBe('COMPLETE');
    const log = events('relay-boundary');
    const resent = log.find(
      (e) =>
        e.role === 'REVIEWER' &&
        e.kind === 'PROMPT' &&
        e.content.includes('may have been interrupted'),
    );
    expect(
      resent,
      'the unanswered re-ask must be re-sent with the reconcile preface',
    ).toBeDefined();
    expect(
      log.filter(
        (e) => e.content.includes('did not end with a clear VERDICT') && e.kind === 'PROMPT',
      ),
    ).toHaveLength(2);
  });

  it('a consumed decision flips the summary row to ACTIVE in the same transaction', async () => {
    // After `resume --decision accept` the run is genuinely active — decision recorded,
    // prompt recorded, model working — but the status column used to stay PAUSED_CYCLE_CAP
    // for the whole next call, because updateRun re-wrote the stale field alongside the
    // counters it was advancing. `relay status` reads that column: a watcher polling the
    // documented surface alerted "paused" twice on a healthy run. The event and the row
    // must never disagree about whether the run is paused.
    writeFileSync(implFile, JSON.stringify(['Attempt.', '__DELAY:1500:Applied final feedback.']));
    writeFileSync(revFile, JSON.stringify(['No.\nVERDICT: FIX', 'fine\nVERDICT: COMPLETE']));
    await relayRunCommand({ plan: 'plan.md', id: 'relay-status-flip', maxCycles: 1 });
    expect(printedStatus().status).toBe('PAUSED_CYCLE_CAP');

    // Fire the resume WITHOUT awaiting, then probe the row while the implementer call is
    // held open by the fake's delay.
    const resume = relayResumeCommand('relay-status-flip', { decision: 'accept' });
    const deadline = Date.now() + 5_000;
    let observed: { status: string } | undefined;
    while (Date.now() < deadline) {
      const db = openDatabase(getDbPath());
      const decisionRecorded = db
        .prepare("SELECT COUNT(*) AS n FROM relay_events WHERE run_id = ? AND kind = 'DECISION'")
        .get('relay-status-flip') as { n: number };
      if (decisionRecorded.n > 0) {
        observed = db
          .prepare('SELECT status FROM relay_runs WHERE run_id = ?')
          .get('relay-status-flip') as { status: string };
        db.close();
        break;
      }
      db.close();
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    // The moment the DECISION event exists, the row already says ACTIVE — same transaction.
    expect(observed?.status).toBe('ACTIVE');
    await resume;
  });

  it('refuses a second worker while a live process holds the run', async () => {
    // Two workers once drove one run: a killed reviewer call left its relay process alive,
    // and a resume started another — two reviewers interleaving one event log. The lease is
    // a pid, checked for liveness; nothing else is true enough on one machine.
    writeFileSync(implFile, JSON.stringify(['b1.', 'b2.']));
    writeFileSync(revFile, JSON.stringify(['no verdict here']));
    await relayRunCommand({ plan: 'plan.md', id: 'relay-lease' });
    expect(printedStatus().status).toBe('PAUSED_UNCLEAR_VERDICT');

    // A stand-in for the stale-but-alive worker.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
    });
    try {
      const db = openDatabase(getDbPath());
      db.prepare(
        'UPDATE relay_runs SET worker_pid = ?, worker_started_at = ? WHERE run_id = ?',
      ).run(holder.pid, new Date().toISOString(), 'relay-lease');
      db.close();
      await expect(relayResumeCommand('relay-lease', {})).rejects.toThrow(
        new RegExp(`held by live relay process ${holder.pid}`),
      );
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('a DEAD holder releases by being dead — resume takes over without ceremony', async () => {
    writeFileSync(implFile, JSON.stringify(['b1.', 'b2.']));
    writeFileSync(
      revFile,
      JSON.stringify(['no verdict', 'ok\nVERDICT: PROCEED', 'ok\nVERDICT: COMPLETE']),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-lease-dead' });
    expect(printedStatus().status).toBe('PAUSED_UNCLEAR_VERDICT');

    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => dead.once('exit', resolve));
    const db = openDatabase(getDbPath());
    db.prepare('UPDATE relay_runs SET worker_pid = ?, worker_started_at = ? WHERE run_id = ?').run(
      dead.pid,
      new Date().toISOString(),
      'relay-lease-dead',
    );
    db.close();

    await relayResumeCommand('relay-lease-dead', {});
    expect(printedStatus().status).toBe('COMPLETE');

    // And the finished worker released its own claim.
    const after = openDatabase(getDbPath());
    const row = after
      .prepare('SELECT worker_pid FROM relay_runs WHERE run_id = ?')
      .get('relay-lease-dead') as { worker_pid: number | null };
    after.close();
    expect(row.worker_pid).toBeNull();
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
