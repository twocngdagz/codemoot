// The relay is a message bus: it carries, health-checks, counts cycles, and records.
// These tests prove the four jobs and the ONE piece of structure in the system — the
// reviewer's VERDICT line — plus the property that gives the design its recovery story:
// the event log alone is enough to resume from any interruption, with no ceremony.

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@codemoot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countPlanBatches,
  parseVerdict,
  relayPauseCommand,
  relayResumeCommand,
  relayRunCommand,
} from '../src/commands/relay.js';
import { getDbPath } from '../src/utils.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-relay.mjs', import.meta.url));
// The BUILT cli, for the one test that needs a worker in its own process to kill.
const CLI_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

// Every ADVANCING verdict in these fixtures carries a findings body above the floor —
// a verdict without findings is now refused, because a live run once advanced an
// unreviewed batch on a 72-character manufactured PROCEED.
const FINDINGS =
  'Verified the claims against the repository: the changed files match the summary, the ' +
  'stated commands were re-run and pass, and no regressions were found in the touched ' +
  'areas. Diff inspected hunk by hunk against the batch scope in the plan.\n';

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

  it('routes a verdict with prose GLUED to the token — the live FIXBoth case', () => {
    // Observed live (gpt-5.6-sol, every review): the reviewer writes the verdict and runs
    // the next sentence straight onto it. A human reads it instantly; a \b cannot.
    expect(
      parseVerdict('findings…\nVERDICT: FIXBoth reviews are complete and need the same guard.'),
    ).toBe('FIX');
    expect(parseVerdict('fine\nVERDICT: PROCEED.')).toBe('PROCEED');
    expect(parseVerdict('done\nVERDICT: COMPLETE — the plan is finished.')).toBe('COMPLETE');
    expect(parseVerdict('fine\nVERDICT: **FIX**')).toBe('FIX');
  });

  it('does not read a DIFFERENT word as a verdict — glue is not prefix-matching', () => {
    // A lowercase or digit continuation is a different word (fixme, proceeding), not a
    // sentence glued onto the token.
    expect(parseVerdict('VERDICT: fixme later')).toBeNull();
    expect(parseVerdict('VERDICT: Proceeding with caution')).toBeNull();
    // No token at the anchor at all — including one buried in prose after the colon,
    // where negations live ("CANNOT PROCEED" must pause, never advance).
    expect(parseVerdict('VERDICT: PREFIX')).toBeNull();
    expect(parseVerdict('VERDICT: CANNOT PROCEED WITHOUT THE MIGRATION')).toBeNull();
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

  /**
   * `retryAttempts: 1` — ONE attempt, no retry — is what every test below was written
   * against, and it keeps each of them asserting the thing it was written to guard: an
   * empty reply, a failed resume or an adapter crash surfaces as itself instead of being
   * absorbed by the retry loop. The retry loop has its own tests, which raise this.
   */
  function writeConfig(retryAttempts = 1): void {
    writeFileSync(
      join(projectDir, '.cowork.yml'),
      JSON.stringify({
        configVersion: 3,
        advanced: { retryAttempts },
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
        `${FINDINGS}Verified sample.txt.\nVERDICT: PROCEED`,
        `${FINDINGS}README verified. Everything in the plan is done.\nVERDICT: COMPLETE`,
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
    // A plain start opens with the IMPLEMENTER — the review-only branch must never leak
    // into the default path.
    expect(log[0]?.role).toBe('IMPLEMENTER');
    expect(log[0]?.kind).toBe('PROMPT');
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
        `${FINDINGS}Batch 2 fine.\nVERDICT: COMPLETE`,
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

  it('pauses on a missing verdict; resume re-sends the FULL prompt, never a bare restate', async () => {
    // The context-less "restate your conclusion" re-ask is gone: it carried none of the
    // prior reply, and a session with no memory of the batch once answered it by inventing
    // a verdict. A reply with genuinely no verdict gets the full review prompt again.
    writeFileSync(implFile, JSON.stringify(['Did batch 1.', 'Did batch 2.']));
    writeFileSync(
      revFile,
      JSON.stringify([
        `${FINDINGS}Looks good I suppose.`,
        `${FINDINGS}VERDICT: PROCEED`,
        `${FINDINGS}Fine.\nVERDICT: COMPLETE`,
      ]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-unclear' });
    expect(printedStatus().status).toBe('PAUSED_UNCLEAR_VERDICT');

    await relayResumeCommand('relay-unclear', {});
    expect(printedStatus().status).toBe('COMPLETE');
    const log = events('relay-unclear');
    const reAsk = log.filter((e) => e.role === 'REVIEWER' && e.kind === 'PROMPT')[1];
    expect(reAsk?.content).toContain('The implementer reports the following');
    expect(
      log.some((e) => e.kind === 'PROMPT' && e.content.includes('did not end with a clear')),
    ).toBe(false);
    expect(
      log.some(
        (e) =>
          e.role === 'RELAY' &&
          e.kind === 'NOTE' &&
          e.content.includes('No routable verdict in the stored reply'),
      ),
    ).toBe(true);
  });

  it('resumes an interrupted call by re-sending the prompt with the reconcile preface', async () => {
    writeFileSync(implFile, JSON.stringify(['Recovered and finished batch 1.', 'Batch 2 done.']));
    writeFileSync(
      revFile,
      JSON.stringify([`${FINDINGS}VERDICT: PROCEED`, `${FINDINGS}VERDICT: COMPLETE`]),
    );
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
        `${FINDINGS}Looks fine, probably.`,
        '__CRASH__',
        `${FINDINGS}VERDICT: PROCEED`,
        `${FINDINGS}VERDICT: COMPLETE`,
      ]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-boundary' });
    expect(printedStatus().status).toBe('PAUSED_UNCLEAR_VERDICT');

    // The full-prompt re-send itself dies at the adapter level. No throw, no dead
    // process — a note.
    await relayResumeCommand('relay-boundary', {});
    expect(printedStatus().status).toBe('STOPPED');
    const afterCrash = events('relay-boundary');
    expect(
      afterCrash.some(
        (e) => e.role === 'RELAY' && e.kind === 'NOTE' && e.content.includes('Call failed'),
      ),
    ).toBe(true);

    // Resume again: the log ends with the unanswered re-send, so it goes out again with
    // the reconcile preface — not stacked with another re-send — and the run completes.
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
      'the unanswered re-send must go out again with the reconcile preface',
    ).toBeDefined();
    expect(resent?.content).toContain('The implementer reports the following');
  });

  it('a consumed decision flips the summary row to ACTIVE in the same transaction', async () => {
    // After `resume --decision accept` the run is genuinely active — decision recorded,
    // prompt recorded, model working — but the status column used to stay PAUSED_CYCLE_CAP
    // for the whole next call, because updateRun re-wrote the stale field alongside the
    // counters it was advancing. `relay status` reads that column: a watcher polling the
    // documented surface alerted "paused" twice on a healthy run. The event and the row
    // must never disagree about whether the run is paused.
    writeFileSync(implFile, JSON.stringify(['Attempt.', '__DELAY:1500:Applied final feedback.']));
    writeFileSync(revFile, JSON.stringify(['No.\nVERDICT: FIX', `${FINDINGS}VERDICT: COMPLETE`]));
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
      JSON.stringify(['no verdict', `${FINDINGS}VERDICT: PROCEED`, `${FINDINGS}VERDICT: COMPLETE`]),
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

  it('an empty reply is recorded as a FAILED call, never as a zero-length RESPONSE', async () => {
    // A hand-killed codex once surfaced as a clean call with empty text, and the transcript
    // gained a turn that never happened. The prompt must stay unanswered in the log, the
    // failure must be a RELAY NOTE, and resume must re-send with the reconcile preface.
    writeFileSync(implFile, JSON.stringify(['Did batch 1.', 'Did batch 2.']));
    writeFileSync(
      revFile,
      JSON.stringify(['', `${FINDINGS}VERDICT: PROCEED`, `${FINDINGS}VERDICT: COMPLETE`]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-empty' });
    expect(printedStatus().status).toBe('STOPPED');

    const log = events('relay-empty');
    expect(log.some((e) => e.kind === 'RESPONSE' && e.content.trim().length === 0)).toBe(false);
    expect(
      log.some(
        (e) => e.role === 'RELAY' && e.kind === 'NOTE' && e.content.includes('empty response'),
      ),
    ).toBe(true);

    await relayResumeCommand('relay-empty', {});
    expect(printedStatus().status).toBe('COMPLETE');
  });

  it('a failed RESUME surfaces — it is never retried silently as a fresh session', async () => {
    // The codex adapter's non-strict fallback re-runs a failed resume as a fresh exec.
    // Under the relay that hides a killed call AND forks the role's memory: the model that
    // answers no longer remembers the conversation the transcript says it is part of. The
    // relay passes strictResume, so the failure is recorded and the operator resumes it.
    writeFileSync(implFile, JSON.stringify(['Did batch 1.', 'Did batch 2.']));
    writeFileSync(
      revFile,
      JSON.stringify([
        'needs work\nVERDICT: FIX',
        '__CRASH__',
        `${FINDINGS}VERDICT: PROCEED`,
        `${FINDINGS}VERDICT: COMPLETE`,
      ]),
    );
    // maxCycles 1 → after the FIX forward, the SECOND reviewer call is a resume; it dies.
    await relayRunCommand({ plan: 'plan.md', id: 'relay-strict', maxCycles: 2 });
    expect(printedStatus().status).toBe('STOPPED');

    // Exactly TWO reviewer invocations happened: the original and the crashed resume — no
    // hidden third call re-serving the sequence as a fresh session.
    const revCalls = readFileSync(`${revFile}.prompts.jsonl`, 'utf8').trim().split('\n');
    expect(revCalls).toHaveLength(2);
  });

  it('a mid-run adapter swap starts a FRESH session instead of resuming a foreign id', async () => {
    // An operator swapped the reviewer from claude to codex mid-run; the relay handed the
    // stored claude session id to `codex exec resume`, the resume failed, and the fallback
    // stalled at task_started for 79 minutes. A session id without its creator's kind is
    // not enough to resume safely — when the kind changed, don't attempt it at all.
    writeFileSync(implFile, JSON.stringify(['Did batch 1.', 'Did batch 2.']));
    writeFileSync(
      revFile,
      JSON.stringify(['no verdict', `${FINDINGS}VERDICT: PROCEED`, `${FINDINGS}VERDICT: COMPLETE`]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-kindswap' });
    expect(printedStatus().status).toBe('PAUSED_UNCLEAR_VERDICT');

    // Simulate the pre-swap state: the stored reviewer session was created by another kind.
    const db = openDatabase(getDbPath());
    db.prepare("UPDATE relay_runs SET reviewer_session_kind = 'codex' WHERE run_id = ?").run(
      'relay-kindswap',
    );
    db.close();

    await relayResumeCommand('relay-kindswap', {});
    expect(printedStatus().status).toBe('COMPLETE');

    const log = events('relay-kindswap');
    expect(
      log.some(
        (e) =>
          e.role === 'RELAY' &&
          e.kind === 'NOTE' &&
          e.content.includes('adapter kind changed (codex → claude)'),
      ),
    ).toBe(true);
    // The re-ask ran WITHOUT a resume — a fresh session, not a foreign-id attempt.
    const revCalls = readFileSync(`${revFile}.prompts.jsonl`, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(revCalls.at(1)?.resumedSessionId).toBeNull();
    // And the fresh session is recorded with ITS creator's kind, so the ledger heals.
    const after = openDatabase(getDbPath());
    const row = after
      .prepare('SELECT reviewer_session_kind FROM relay_runs WHERE run_id = ?')
      .get('relay-kindswap') as { reviewer_session_kind: string | null };
    after.close();
    expect(row.reviewer_session_kind).toBe('claude');
  });

  it('an EMPTY legacy reply gets the full review prompt again, never the restate re-ask', async () => {
    // The manufactured-verdict incident: a stalled reviewer was killed, a 0-char RESPONSE
    // was recorded (pre-6c43d00), and the restate re-ask — "restate your conclusion" — ran
    // in a fresh session with no memory of the batch. The model complied with the only
    // thing asked of it: 72 characters, VERDICT: PROCEED, and the run advanced past an
    // unreviewed batch. There was no conclusion to restate. Legacy rows still exist, so
    // the path must refuse to restate what never happened.
    const now = new Date().toISOString();
    const db = openDatabase(getDbPath());
    db.prepare(
      `INSERT INTO relay_runs (run_id, plan_path, project_dir, total_batches, max_cycles, batch, cycle, status, pending, implementer_session, reviewer_session, created_at, updated_at)
       VALUES ('relay-empty-legacy', ?, ?, 2, 3, 1, 1, 'PAUSED_UNCLEAR_VERDICT', NULL, NULL, 'legacy-session', ?, ?)`,
    ).run(join(projectDir, 'plan.md'), projectDir, now, now);
    const insertEvent = db.prepare(
      `INSERT INTO relay_events (run_id, batch, cycle, role, kind, content, created_at)
       VALUES ('relay-empty-legacy', 1, 1, ?, ?, ?, ?)`,
    );
    insertEvent.run('IMPLEMENTER', 'PROMPT', 'Work on Batch 1', now);
    insertEvent.run('IMPLEMENTER', 'RESPONSE', 'Did batch 1.', now);
    insertEvent.run('REVIEWER', 'PROMPT', 'FULL-REVIEW-PROMPT-MARKER verify batch 1', now);
    insertEvent.run('REVIEWER', 'RESPONSE', '', now);
    db.close();

    writeFileSync(implFile, JSON.stringify(['Did batch 2.']));
    writeFileSync(
      revFile,
      JSON.stringify([`${FINDINGS}VERDICT: PROCEED`, `${FINDINGS}VERDICT: COMPLETE`]),
    );
    await relayResumeCommand('relay-empty-legacy', {});
    expect(printedStatus().status).toBe('COMPLETE');

    const log = events('relay-empty-legacy');
    const reAsk = log.filter((e) => e.role === 'REVIEWER' && e.kind === 'PROMPT')[1];
    // The FULL prompt was re-sent — not the restate re-ask an amnesiac would answer blind.
    expect(reAsk?.content).toContain('FULL-REVIEW-PROMPT-MARKER');
    expect(reAsk?.content).not.toContain('did not end with a clear VERDICT');
    expect(
      log.some(
        (e) =>
          e.role === 'RELAY' &&
          e.kind === 'NOTE' &&
          e.content.includes('No routable verdict in the stored reply'),
      ),
    ).toBe(true);
  });

  it('a CLEARED session also forbids the restate — memory of the review is gone', async () => {
    // A substantive-but-verdictless reply is only restatable by the session that wrote it.
    // After a vendor swap clears the session, "restate your conclusion" lands on a model
    // that never reviewed anything — the same manufactured-verdict trap by another door.
    writeFileSync(implFile, JSON.stringify(['Did batch 1.', 'Did batch 2.']));
    writeFileSync(
      revFile,
      JSON.stringify([
        'thorough findings, forgot the line',
        `${FINDINGS}VERDICT: PROCEED`,
        `${FINDINGS}VERDICT: COMPLETE`,
      ]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-noses' });
    expect(printedStatus().status).toBe('PAUSED_UNCLEAR_VERDICT');
    const db = openDatabase(getDbPath());
    db.prepare(
      "UPDATE relay_runs SET reviewer_session = NULL, reviewer_session_kind = NULL WHERE run_id = 'relay-noses'",
    ).run();
    db.close();

    await relayResumeCommand('relay-noses', {});
    expect(printedStatus().status).toBe('COMPLETE');
    const log = events('relay-noses');
    const reAsk = log.filter((e) => e.role === 'REVIEWER' && e.kind === 'PROMPT')[1];
    expect(reAsk?.content).not.toContain('did not end with a clear VERDICT');
    expect(reAsk?.content).toContain('The implementer reports the following');
  });

  it('refuses to ADVANCE on a verdict without findings — the 72-character trap', async () => {
    // Advancing is the one irreversible thing the relay does, and it once did it on
    // "The proposed work is ready to move forward as planned. VERDICT: PROCEED" from a
    // session that read nothing. A verdict with no findings attached is treated like a
    // missing verdict: pause, and resume re-sends the FULL review prompt — a thin reply is
    // not restatable by construction.
    writeFileSync(implFile, JSON.stringify(['Did batch 1.', 'Did batch 2.']));
    writeFileSync(
      revFile,
      JSON.stringify([
        'The proposed work is ready to move forward as planned.\nVERDICT: PROCEED',
        `${FINDINGS}VERDICT: PROCEED`,
        `${FINDINGS}VERDICT: COMPLETE`,
      ]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-thin' });
    expect(printedStatus().status).toBe('PAUSED_UNCLEAR_VERDICT');
    const paused = events('relay-thin');
    expect(
      paused.some(
        (e) =>
          e.role === 'RELAY' &&
          e.kind === 'NOTE' &&
          e.content.includes('a verdict without a review cannot advance a batch'),
      ),
    ).toBe(true);
    // Batch did NOT advance on the thin verdict.
    const db = openDatabase(getDbPath());
    const row = db.prepare('SELECT batch FROM relay_runs WHERE run_id = ?').get('relay-thin') as {
      batch: number;
    };
    db.close();
    expect(row.batch).toBe(1);

    await relayResumeCommand('relay-thin', {});
    expect(printedStatus().status).toBe('COMPLETE');
    const log = events('relay-thin');
    // Resume re-sent the FULL review prompt, not the restate re-ask.
    const reAsk = log.filter((e) => e.role === 'REVIEWER' && e.kind === 'PROMPT')[1];
    expect(reAsk?.content).toContain('The implementer reports the following');
    expect(reAsk?.content).not.toContain('did not end with a clear VERDICT');
  });

  it('a run paused on a GLUED verdict resumes by routing the stored reply — no re-ask call', async () => {
    // The live shape: a run paused under the old word-boundary parser, its last event a
    // recorded reply whose verdict is glued ("VERDICT: PROCEEDBoth…"). Resume must re-read
    // that reply with the current parser and route it AS IT STANDS — the review already
    // happened; asking any model anything about batch 1 again would be waste at best and
    // a manufactured-verdict door at worst.
    const now = new Date().toISOString();
    const db = openDatabase(getDbPath());
    db.prepare(
      `INSERT INTO relay_runs (run_id, plan_path, project_dir, total_batches, max_cycles, batch, cycle, status, pending, implementer_session, reviewer_session, created_at, updated_at)
       VALUES ('relay-glue', ?, ?, 2, 3, 1, 1, 'PAUSED_UNCLEAR_VERDICT', NULL, NULL, 'live-session', ?, ?)`,
    ).run(join(projectDir, 'plan.md'), projectDir, now, now);
    const insertEvent = db.prepare(
      `INSERT INTO relay_events (run_id, batch, cycle, role, kind, content, created_at)
       VALUES ('relay-glue', 1, 1, ?, ?, ?, ?)`,
    );
    insertEvent.run('IMPLEMENTER', 'PROMPT', 'Work on Batch 1', now);
    insertEvent.run('IMPLEMENTER', 'RESPONSE', 'Did batch 1.', now);
    insertEvent.run('REVIEWER', 'PROMPT', 'review batch 1', now);
    insertEvent.run(
      'REVIEWER',
      'RESPONSE',
      `${FINDINGS}VERDICT: PROCEEDBoth reviews are complete and the batch is sound.`,
      now,
    );
    db.close();

    writeFileSync(implFile, JSON.stringify(['Did batch 2.']));
    writeFileSync(revFile, JSON.stringify([`${FINDINGS}VERDICT: COMPLETE`]));
    await relayResumeCommand('relay-glue', {});
    expect(printedStatus().status).toBe('COMPLETE');

    // The reviewer was called exactly ONCE — for batch 2. The stored batch-1 reply routed
    // itself; no restate, no full-prompt re-send.
    const revCalls = readFileSync(`${revFile}.prompts.jsonl`, 'utf8').trim().split('\n');
    expect(revCalls).toHaveLength(1);
    expect(JSON.parse(revCalls[0] ?? '{}').prompt).toContain('Batch 2');
    const log = events('relay-glue');
    expect(
      log.some(
        (e) =>
          e.role === 'RELAY' &&
          e.kind === 'NOTE' &&
          e.content.includes('parses to VERDICT: PROCEED; routing it as it stands'),
      ),
    ).toBe(true);
  });

  it('a terse FIX still routes — the floor guards only the irreversible direction', async () => {
    writeFileSync(implFile, JSON.stringify(['Attempt.', 'Fixed.', 'Did batch 2.']));
    writeFileSync(
      revFile,
      JSON.stringify([
        'No.\nVERDICT: FIX',
        `${FINDINGS}VERDICT: PROCEED`,
        `${FINDINGS}VERDICT: COMPLETE`,
      ]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-terse-fix' });
    expect(printedStatus().status).toBe('COMPLETE');
    const log = events('relay-terse-fix');
    // The two-character-findings FIX was forwarded verbatim, no pause.
    expect(
      log.some((e) => e.role === 'IMPLEMENTER' && e.kind === 'PROMPT' && e.content.includes('No.')),
    ).toBe(true);
  });

  it('--background creates the durable row, spawns a detached worker, and returns', async () => {
    // The nohup workaround this replaces stripped PATH and USER from the child and cost a
    // live run its first attempt. The detached child inherits the full environment and its
    // output goes to a log file — the relay's first real failure was diagnosed from
    // exactly such a log. The child here is a no-op entry (spawning the REAL argv[1] from
    // inside vitest would launch a second test run), so this proves the parent's half:
    // row first, spawn detached, print pid + log, return without looping.
    const realEntry = process.argv[1];
    process.argv[1] = fileURLToPath(new URL('./fixtures/noop-entry.mjs', import.meta.url));
    try {
      writeFileSync(implFile, JSON.stringify(['unused']));
      writeFileSync(revFile, JSON.stringify(['unused']));
      await relayRunCommand({ plan: 'plan.md', id: 'relay-bg', background: true });
    } finally {
      process.argv[1] = realEntry;
    }
    const printed = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
      status: string;
      workerPid: number | null;
      log: string;
    };
    expect(printed.status).toBe('RUNNING');
    expect(printed.workerPid).toBeGreaterThan(0);
    expect(printed.log).toContain('.cowork/relay/relay-bg.log');
    // The row is durable BEFORE the handoff — the child resumes a pristine run.
    const db = openDatabase(getDbPath());
    const row = db
      .prepare('SELECT status, batch FROM relay_runs WHERE run_id = ?')
      .get('relay-bg') as { status: string; batch: number };
    const eventCount = (
      db.prepare('SELECT COUNT(*) n FROM relay_events WHERE run_id = ?').get('relay-bg') as {
        n: number;
      }
    ).n;
    db.close();
    expect(row.status).toBe('ACTIVE');
    expect(eventCount).toBe(0);
  });

  it('relay pause signals the LEASE pid — never a pattern-matched one', async () => {
    // The trap this replaces: an operator's watcher ran pgrep -f "<run-id>", matched its
    // OWN command line, signalled itself, and the run advanced through the boundary they
    // meant to stop at. The pause command resolves the worker from the lease.
    writeFileSync(implFile, JSON.stringify(['b1.']));
    writeFileSync(revFile, JSON.stringify(['no verdict here']));
    await relayRunCommand({ plan: 'plan.md', id: 'relay-pausable' });

    // A stand-in worker that records receiving SIGINT — and announces when its handler is
    // actually installed, because 'spawn' fires before a single line of its JS has run and
    // a signal delivered into that gap takes the default action instead of the handler.
    const marker = join(projectDir, 'sigint-received');
    const ready = join(projectDir, 'holder-ready');
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const fs = require('node:fs'); process.on('SIGINT', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); process.exit(0); }); fs.writeFileSync(${JSON.stringify(ready)}, 'up'); setTimeout(() => {}, 30000);`,
      ],
      { stdio: 'ignore' },
    );
    const readyDeadline = Date.now() + 3_000;
    while (!existsSync(ready) && Date.now() < readyDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    expect(existsSync(ready)).toBe(true);
    try {
      const db = openDatabase(getDbPath());
      db.prepare(
        'UPDATE relay_runs SET worker_pid = ?, worker_started_at = ? WHERE run_id = ?',
      ).run(holder.pid, new Date().toISOString(), 'relay-pausable');
      db.close();

      await relayPauseCommand('relay-pausable', {});
      const printed = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
        status: string;
        workerPid: number;
      };
      expect(printed.status).toBe('PAUSE_REQUESTED');
      expect(printed.workerPid).toBe(holder.pid);
      // The signal reached the LEASE pid.
      const deadline = Date.now() + 3_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      expect(existsSync(marker)).toBe(true);
      // And the durable intent is written as the belt for a lost signal.
      const check = openDatabase(getDbPath());
      const intent = check
        .prepare('SELECT pause_intent FROM relay_runs WHERE run_id = ?')
        .get('relay-pausable') as { pause_intent: string | null };
      check.close();
      expect(intent.pause_intent).toBe('NEXT_BOUNDARY');
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('pause with a dead or absent worker reports honestly and clears the stale lease', async () => {
    writeFileSync(implFile, JSON.stringify(['b1.']));
    writeFileSync(revFile, JSON.stringify(['no verdict here']));
    await relayRunCommand({ plan: 'plan.md', id: 'relay-pause-idle' });
    await relayPauseCommand('relay-pause-idle', {});
    const printed = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as { status: string };
    expect(printed.status).toBe('NOT_RUNNING');
  });

  it('--after-batch stops EXACTLY when the batch is accepted — a deterministic boundary', async () => {
    // Polling can never land between two events written in the same instant; recorded
    // intent is honoured by the loop itself, at the advance, deterministically.
    writeFileSync(implFile, JSON.stringify(['Did batch 1.', 'Did batch 2.']));
    writeFileSync(
      revFile,
      JSON.stringify([`__DELAY:1500:${FINDINGS}VERDICT: PROCEED`, `${FINDINGS}VERDICT: COMPLETE`]),
    );
    const running = relayRunCommand({ plan: 'plan.md', id: 'relay-afterbatch' });
    // While the batch-1 review is held open by the fake's delay, schedule the pause.
    const deadline = Date.now() + 5_000;
    let scheduled = false;
    while (!scheduled && Date.now() < deadline) {
      const db = openDatabase(getDbPath());
      const exists = db
        .prepare(
          "SELECT COUNT(*) n FROM relay_events WHERE run_id = 'relay-afterbatch' AND role = 'REVIEWER' AND kind = 'PROMPT'",
        )
        .get() as { n: number };
      if (exists.n > 0) {
        db.prepare(
          "UPDATE relay_runs SET pause_intent = 'BATCH_END' WHERE run_id = 'relay-afterbatch'",
        ).run();
        scheduled = true;
      }
      db.close();
      if (!scheduled) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    expect(scheduled).toBe(true);
    await running;

    const status = printedStatus();
    expect(status.status).toBe('STOPPED');
    expect(status.batch).toBe(2); // batch 1 accepted, batch 2 NOT opened
    const log = events('relay-afterbatch');
    expect(log.some((e) => e.content.includes('Operator pause honoured: batch 1 finished'))).toBe(
      true,
    );
    expect(log.filter((e) => e.batch === 2 && e.kind === 'PROMPT')).toHaveLength(0);

    await relayResumeCommand('relay-afterbatch', {});
    expect(printedStatus().status).toBe('COMPLETE');
  });

  it('--review-from starts the batch at the REVIEWER — nothing is re-implemented', async () => {
    // The loop's opening move assumes every batch is unbuilt. Pointed at a batch that is
    // already implemented and committed, "Implement it fully per the plan" re-implements
    // code that already exists on the branch. A review-only batch begins at the reviewer,
    // against the repository as it stands — and the implementer is NEVER called before it.
    writeFileSync(implFile, JSON.stringify(['must never be requested']));
    writeFileSync(
      revFile,
      JSON.stringify([`${FINDINGS}VERDICT: PROCEED`, `${FINDINGS}VERDICT: COMPLETE`]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-review-only', reviewFrom: 1 });
    expect(printedStatus().status).toBe('COMPLETE');

    const log = events('relay-review-only');
    // The FIRST role call is the reviewer; the implementer was never called at all.
    expect(log[0]?.role).toBe('REVIEWER');
    expect(log[0]?.kind).toBe('PROMPT');
    expect(log.filter((e) => e.role === 'IMPLEMENTER')).toHaveLength(0);
    expect(existsSync(`${implFile}.prompts.jsonl`)).toBe(false);
    // No fabricated implementer summary — the reviewer is told the truth about the batch.
    expect(log[0]?.content).toContain('implemented outside this run');
    expect(log[0]?.content).not.toContain('The implementer reports the following');
    // The verdict contract is unchanged: findings required, one closing VERDICT line.
    expect(log[0]?.content).toContain('VERDICT: FIX');
  });

  it('a review-only batch that draws FIX engages the existing fix loop unchanged', async () => {
    // Review-only changes only the OPENING move. From the first FIX on, the batch is the
    // normal loop: findings forwarded verbatim via fixPrompt, the implementer's summary
    // forwarded back for re-review.
    writeFileSync(implFile, JSON.stringify(['Guarded the spread. Commit abc.']));
    writeFileSync(
      revFile,
      JSON.stringify([
        'Broken: the spread at api.ts:14 is unguarded.\nVERDICT: FIX',
        `${FINDINGS}VERDICT: PROCEED`,
        `${FINDINGS}VERDICT: COMPLETE`,
      ]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-review-fix', reviewFrom: 1 });
    expect(printedStatus().status).toBe('COMPLETE');

    const prompts = events('relay-review-fix').filter((e) => e.kind === 'PROMPT');
    // Review-only opening, then the ordinary fix loop.
    expect(prompts[0]?.role).toBe('REVIEWER');
    expect(prompts[0]?.content).toContain('implemented outside this run');
    expect(prompts[1]?.role).toBe('IMPLEMENTER');
    expect(prompts[1]?.content).toContain('requires fixes');
    expect(prompts[1]?.content).toContain('Broken: the spread at api.ts:14 is unguarded.');
    // The re-review carries the implementer's ACTUAL summary — there is one now.
    expect(prompts[2]?.role).toBe('REVIEWER');
    expect(prompts[2]?.content).toContain('The implementer reports the following');
    expect(prompts[2]?.content).toContain('Guarded the spread. Commit abc.');
  });

  it('--review-from composes with --start-batch: reviews 9, then 10, never touches 1–8', async () => {
    const tenBatchPlan = `# Big plan\n\n${Array.from(
      { length: 10 },
      (_, index) => `### Batch ${index + 1}\nStep ${index + 1}.\n`,
    ).join('\n')}`;
    writeFileSync(join(projectDir, 'big-plan.md'), tenBatchPlan);
    writeFileSync(implFile, JSON.stringify(['must never be requested']));
    writeFileSync(
      revFile,
      JSON.stringify([`${FINDINGS}VERDICT: PROCEED`, `${FINDINGS}VERDICT: COMPLETE`]),
    );
    await relayRunCommand({
      plan: 'big-plan.md',
      id: 'relay-review-tail',
      startBatch: 9,
      reviewFrom: 9,
    });
    const status = printedStatus() as unknown as {
      status: string;
      batch: number;
      reviewFrom?: number;
    };
    expect(status.status).toBe('COMPLETE');
    expect(status.batch).toBe(10);
    expect(status.reviewFrom).toBe(9);

    const log = events('relay-review-tail');
    // Batches 1–8 were never touched — no event mentions them.
    const db = openDatabase(getDbPath());
    const batches = db
      .prepare("SELECT DISTINCT batch FROM relay_events WHERE run_id = 'relay-review-tail'")
      .all() as { batch: number }[];
    // And the range is DURABLE: a resume after a crash must still know batch 10 is
    // review-only, so the flag lives in the run row, not in the invocation.
    const persisted = db
      .prepare("SELECT review_from FROM relay_runs WHERE run_id = 'relay-review-tail'")
      .get() as { review_from: number | null };
    db.close();
    expect(batches.map((row) => row.batch).sort()).toEqual([10, 9].sort());
    expect(persisted.review_from).toBe(9);
    // Both tail batches were review-only: reviewer prompts only, correctly numbered.
    expect(log.filter((e) => e.role === 'IMPLEMENTER')).toHaveLength(0);
    const reviewPrompts = log.filter((e) => e.role === 'REVIEWER' && e.kind === 'PROMPT');
    expect(reviewPrompts).toHaveLength(2);
    expect(reviewPrompts[0]?.content).toContain('Batch 9 of 10');
    expect(reviewPrompts[1]?.content).toContain('Batch 10 of 10');
    for (const prompt of reviewPrompts) {
      expect(prompt.content).toContain('implemented outside this run');
    }
  });

  it('records the whole exchange — the transcript is the audit', async () => {
    writeFileSync(implFile, JSON.stringify(['b1.', 'b2.']));
    writeFileSync(
      revFile,
      JSON.stringify([`${FINDINGS}VERDICT: PROCEED`, `${FINDINGS}VERDICT: COMPLETE`]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-audit' });
    const log = events('relay-audit');
    // Every call is two entries: the exact prompt sent, the exact reply received.
    expect(log.filter((e) => e.kind === 'PROMPT')).toHaveLength(4);
    expect(log.filter((e) => e.kind === 'RESPONSE')).toHaveLength(4);
    // And every response names the MODEL that produced it — the audit fact two live
    // vendor swaps proved the transcript was missing.
    const db = openDatabase(getDbPath());
    const models = db
      .prepare(
        "SELECT DISTINCT role, model FROM relay_events WHERE run_id = 'relay-audit' AND kind = 'RESPONSE'",
      )
      .all() as { role: string; model: string | null }[];
    db.close();
    expect(models.find((m) => m.role === 'IMPLEMENTER')?.model).toBe('claude-opus-5');
    expect(models.find((m) => m.role === 'REVIEWER')?.model).toBe('claude-fable-5');
  });

  // ── Hardening against a wedged CLI (the usi-l9 post-mortem, 14 hours on 2026-08-17/18) ──
  //
  // `cursor-agent` wedges mid-call: the process lives, its HTTP stream is dead, and it emits
  // nothing ever again. That is a documented upstream bug, so the relay has to stay correct
  // and diagnosable when it happens rather than assume it will not.

  it('AC1: an interrupted step retries, and a repeatedly-stalled session is RETIRED', async () => {
    // The live shape: ten consecutive interrupted implementer attempts on one step, every
    // one re-sent into the SAME cursor session with another reconcile note stacked on top,
    // until the conversation stopped answering at all — an eight-hour hang. Clearing the
    // stored session ended it; the fresh conversation finished the step in 18 minutes.
    // Batch 1 must succeed first, because a session can only poison itself once it exists.
    writeConfig(2);
    writeFileSync(implFile, JSON.stringify(['Did batch 1.', '__CRASH__', 'Fixed it.']));
    writeFileSync(
      revFile,
      JSON.stringify(['needs work\nVERDICT: FIX', `${FINDINGS}VERDICT: COMPLETE`]),
    );

    await relayRunCommand({ plan: 'plan.md', id: 'relay-retire', maxCycles: 3 });

    const log = events('relay-retire');
    // The interrupted fix attempt was retried in place — no human, no second command.
    expect(log.filter((e) => e.role === 'IMPLEMENTER' && e.kind === 'PROMPT')).toHaveLength(3);
    // ...and the retry says, in the transcript, that it abandoned the stalled conversation.
    const retirement = log.find(
      (e) => e.role === 'RELAY' && e.kind === 'NOTE' && e.content.includes('FRESH session'),
    );
    expect(retirement?.content).toContain('IMPLEMENTER session');
    expect(retirement?.content).toContain('was interrupted 1 time(s)');

    // The proof that matters: the retry did NOT resume the session that just stalled.
    const calls = readFileSync(`${implFile}.prompts.jsonl`, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { resumedSessionId: string | null });
    expect(calls).toHaveLength(3);
    expect(calls[1]?.resumedSessionId).not.toBeNull(); // the fix call resumed, as always
    expect(calls[2]?.resumedSessionId).toBeNull(); // the retry started over
  });

  it('AC1: freshSessionAfterInterrupts: 0 keeps resuming — the mechanism is opt-out', async () => {
    // The knob has to be able to be off, or "it is now always fresh" is a claim nobody can
    // check. Same interruption, threshold disabled: the retry resumes exactly as before.
    writeConfig(2);
    const config = JSON.parse(readFileSync(join(projectDir, '.cowork.yml'), 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(projectDir, '.cowork.yml'),
      JSON.stringify({ ...config, relay: { freshSessionAfterInterrupts: 0 } }),
    );
    writeFileSync(implFile, JSON.stringify(['Did batch 1.', '__CRASH__', 'Fixed it.']));
    writeFileSync(
      revFile,
      JSON.stringify(['needs work\nVERDICT: FIX', `${FINDINGS}VERDICT: COMPLETE`]),
    );

    await relayRunCommand({ plan: 'plan.md', id: 'relay-keep-session', maxCycles: 3 });

    expect(events('relay-keep-session').some((e) => e.content.includes('FRESH session'))).toBe(
      false,
    );
    const calls = readFileSync(`${implFile}.prompts.jsonl`, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { resumedSessionId: string | null });
    expect(calls[2]?.resumedSessionId).not.toBeNull();
  });

  it('AC2: a failed call is RETRIED in place, and every attempt is on the record', async () => {
    // Before: one failure ended the worker and the run waited for a person to notice.
    writeConfig(3);
    writeFileSync(implFile, JSON.stringify(['__CRASH__', 'Did batch 1 after two tries.']));
    writeFileSync(revFile, JSON.stringify([`${FINDINGS}VERDICT: COMPLETE`]));

    await relayRunCommand({ plan: 'plan.md', id: 'relay-retry' });
    expect(printedStatus().status).toBe('COMPLETE');

    const retryNote = events('relay-retry').find(
      (e) => e.role === 'RELAY' && e.kind === 'NOTE' && e.content.includes('Retrying in'),
    );
    expect(retryNote?.content).toContain('Call failed');
    expect(retryNote?.content).toContain('attempt(s) left');
  });

  it('AC2: exhausted retries stop the run, and relay status says WHY', async () => {
    writeConfig(2);
    writeFileSync(implFile, JSON.stringify(['__CRASH__', '__CRASH__', '__CRASH__']));
    writeFileSync(revFile, JSON.stringify([`${FINDINGS}VERDICT: COMPLETE`]));

    await relayRunCommand({ plan: 'plan.md', id: 'relay-exhausted' });

    const printed = printedStatus() as unknown as {
      status: string;
      lastFailure: { reason: string; at: string } | null;
    };
    expect(printed.status).toBe('STOPPED');
    // A stalled run explains itself — no event-log archaeology, no babysitter.
    expect(printed.lastFailure?.reason).toContain('exited with code 1');
    expect(printed.lastFailure?.at).not.toBe('');
  });

  it('AC2: a worker that dies mid-run leaves the reason behind, and resume continues', async () => {
    // Several live worker deaths left status STOPPED with NO event row and no log line: the
    // only signal was silence. Here the worker is killed outright while a call is in flight.
    writeConfig(1);
    const ready = join(projectDir, 'call-started');
    writeFileSync(
      implFile,
      JSON.stringify(['__DELAY:10000:Did batch 1.', 'Did batch 1 after the restart.']),
    );
    writeFileSync(revFile, JSON.stringify([`${FINDINGS}VERDICT: COMPLETE`]));
    writeFileSync(join(projectDir, 'plan.md'), PLAN);

    const worker = spawn(
      process.execPath,
      [CLI_ENTRY, 'relay', 'run', '--plan', 'plan.md', '--id', 'relay-killed'],
      { cwd: projectDir, stdio: 'ignore' },
    );
    try {
      // Wait until the implementer call is genuinely in flight.
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error('the worker never issued its first prompt');
        if (events('relay-killed').some((e) => e.kind === 'PROMPT')) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      worker.kill('SIGTERM');
      await new Promise((resolveExit) => worker.on('exit', resolveExit));
    } finally {
      if (worker.exitCode === null) worker.kill('SIGKILL');
    }
    void ready;

    const db = openDatabase(getDbPath());
    const row = db
      .prepare('SELECT status, last_failure FROM relay_runs WHERE run_id = ?')
      .get('relay-killed') as { status: string; last_failure: string | null };
    db.close();
    // The death is ON THE RECORD, whatever else happened.
    expect(row.last_failure).not.toBeNull();
    expect(String(row.last_failure)).toMatch(/SIGTERM|exited without settling/);

    // And the run continues without a human reconstructing anything.
    await relayResumeCommand('relay-killed', {});
    expect(printedStatus().status).toBe('COMPLETE');
  }, 60_000);

  it('AC3: every call tees its raw stream to a capped file that failures point at', async () => {
    // The stream used to feed the idle timer and then vanish, so a freeze could only be
    // diagnosed with process and socket forensics on a machine that had moved on.
    writeConfig(1);
    writeFileSync(implFile, JSON.stringify(['Did batch 1.']));
    writeFileSync(revFile, JSON.stringify([`${FINDINGS}VERDICT: COMPLETE`]));

    await relayRunCommand({ plan: 'plan.md', id: 'relay-stream' });

    const callsDir = join(projectDir, '.cowork', 'relay', 'relay-stream', 'calls');
    const files = readdirSync(callsDir).sort();
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.some((name) => name.endsWith('-implementer.jsonl'))).toBe(true);
    expect(files.some((name) => name.endsWith('-reviewer.jsonl'))).toBe(true);
    // What a wedge diagnosis actually reads: the last thing the model emitted.
    const implementerFile = files.find((name) => name.endsWith('-implementer.jsonl')) as string;
    const raw = readFileSync(join(callsDir, implementerFile), 'utf8');
    expect(raw).toContain('"type":"result"');
    expect(raw).toContain('Did batch 1.');
  });

  it('AC3: the cap holds, and a failure names the file to read', async () => {
    writeConfig(1);
    const config = JSON.parse(readFileSync(join(projectDir, '.cowork.yml'), 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(projectDir, '.cowork.yml'),
      JSON.stringify({ ...config, relay: { callStream: { maxBytesPerCall: 256 } } }),
    );
    writeFileSync(implFile, JSON.stringify(['__CRASH__']));
    writeFileSync(revFile, JSON.stringify([`${FINDINGS}VERDICT: COMPLETE`]));

    await relayRunCommand({ plan: 'plan.md', id: 'relay-capped' });

    const callsDir = join(projectDir, '.cowork', 'relay', 'relay-capped', 'calls');
    for (const name of readdirSync(callsDir)) {
      // The cap plus one short marker line — a diagnostic that fills a disk is a defect.
      expect(statSync(join(callsDir, name)).size).toBeLessThan(256 + 200);
    }
    const failure = events('relay-capped').find(
      (e) => e.role === 'RELAY' && e.kind === 'NOTE' && e.content.includes('Call failed'),
    );
    expect(failure?.content).toContain('Raw adapter stream:');
    expect(failure?.content).toContain('relay-capped/calls/');
  });

  it('a --background launcher leaves no worker handlers behind — it is not the worker', async () => {
    // Live regression: `relay resume --background` built a worker context, spawned the child
    // and returned. Its exit handler then ran against a database withDatabase had already
    // closed — the launcher died with an unreadable stack — and had the connection still
    // been open it would have marked its own child's ACTIVE run STOPPED.
    writeConfig(1);
    // The run must be RESUMABLE, or `resume` returns before it ever builds a context and
    // the test proves nothing. (It did exactly that on the first attempt.)
    writeFileSync(implFile, JSON.stringify(['Did batch 1.', 'Did batch 1 again.']));
    writeFileSync(
      revFile,
      JSON.stringify(['no verdict here at all', `${FINDINGS}VERDICT: COMPLETE`]),
    );
    await relayRunCommand({ plan: 'plan.md', id: 'relay-launcher' });
    expect(printedStatus().status).toBe('PAUSED_UNCLEAR_VERDICT');

    const before = process.listenerCount('exit');
    const realEntry = process.argv[1];
    process.argv[1] = fileURLToPath(new URL('./fixtures/noop-entry.mjs', import.meta.url));
    try {
      await relayResumeCommand('relay-launcher', { background: true });
    } finally {
      process.argv[1] = realEntry;
    }
    // Nothing of the worker's lifecycle stayed registered in the launcher.
    expect(process.listenerCount('exit')).toBe(before);
  });

  // Two crashes plus the retry backoff (2s, then 4s) make this deliberately slow.
  it(
    'the reconcile preface is added once, however many interruptions',
    { timeout: 60_000 },
    async () => {
      // A live prompt carried three stacked copies: each re-send prefixed a prompt that
      // already began with the note.
      writeConfig(3);
      writeFileSync(
        implFile,
        JSON.stringify(['Did batch 1.', '__CRASH__', '__CRASH__', 'Fixed it.']),
      );
      writeFileSync(
        revFile,
        JSON.stringify(['needs work\nVERDICT: FIX', `${FINDINGS}VERDICT: COMPLETE`]),
      );

      await relayRunCommand({ plan: 'plan.md', id: 'relay-preface', maxCycles: 3 });

      for (const event of events('relay-preface')) {
        if (event.kind !== 'PROMPT') continue;
        const copies = event.content.split('NOTE: a previous attempt at this step').length - 1;
        expect(copies).toBeLessThanOrEqual(1);
      }
      // ...and the re-sent prompt still carries the note exactly once.
      const resent = events('relay-preface').filter(
        (e) => e.kind === 'PROMPT' && e.content.startsWith('NOTE: a previous attempt'),
      );
      expect(resent.length).toBeGreaterThanOrEqual(1);
    },
  );
});
