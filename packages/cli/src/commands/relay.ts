// The relay: CodeMoot as a message bus, not a judge.
//
// Two days of real use produced thirteen stops, every one in the harness and none in the
// work — contracts, reservations, frozen budgets, coverage derivation, a hash migration.
// The diagnosis that survived all of it: the reviewer is the intelligence; CodeMoot is the
// wiring. The plan is a file in the repo, both models read it off disk themselves, and the
// plan's own `### Batch N` headings ARE the decomposition — nothing transmits, restructures
// or re-derives it.
//
// The relay does exactly four things:
//   1. Carry messages — implementer output to the reviewer and back. It does not read,
//      parse, validate, score or restructure what it carries.
//   2. Health-check the running model. Silence is the signal (the adapter's idleTimeout);
//      elapsed time is not. A model that is working is left alone however long it takes.
//   3. Count feedback cycles, and pause gracefully at the cap so the HUMAN decides.
//   4. Record every prompt and every response, so a person (or another model) can audit
//      the whole exchange afterwards. The transcript is for humans, never for enforcement.
//
// One deliberate exception to "carries but never reads": the bus must know which wire to
// put the reviewer's reply on. That is a single routing token — a final `VERDICT:` line —
// and when it is missing or ambiguous the bus never guesses; it pauses and asks.
//
// Recovery follows the same principle as everything else here: no crash-state machine. If
// the log ends with a prompt that has no reply, resume re-sends it with one sentence telling
// the model its previous attempt may have been interrupted — and lets the intelligence
// reconcile the working tree itself.

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ModelRegistry,
  generateId,
  loadConfig,
  type openDatabase,
  resolveModelAdapterKind,
} from '@codemoot/core';
import { withDatabase } from '../utils.js';
import { installGitGuard, uninstallGitGuard } from './review-workflow.js';

type RelayDb = ReturnType<typeof openDatabase>;
type RelayRole = 'IMPLEMENTER' | 'REVIEWER';
type Verdict = 'FIX' | 'PROCEED' | 'COMPLETE';

interface RelayRun {
  runId: string;
  planPath: string;
  projectDir: string;
  totalBatches: number;
  maxCycles: number;
  batch: number;
  cycle: number;
  status: 'ACTIVE' | 'PAUSED_CYCLE_CAP' | 'PAUSED_UNCLEAR_VERDICT' | 'STOPPED' | 'COMPLETE';
  pending: string | null;
  implementerSession: string | null;
  reviewerSession: string | null;
  implementerSessionKind: string | null;
  reviewerSessionKind: string | null;
}

interface RelayEvent {
  eventId: number;
  batch: number;
  cycle: number;
  role: 'IMPLEMENTER' | 'REVIEWER' | 'OPERATOR' | 'RELAY';
  kind: 'PROMPT' | 'RESPONSE' | 'NOTE' | 'DECISION';
  content: string;
}

// ---------------------------------------------------------------------------
// The one piece of structure in the whole system
// ---------------------------------------------------------------------------

/**
 * Extracts the routing token from the reviewer's reply: the LAST `VERDICT:` line among its
 * closing lines. Only the tail is searched so that a reviewer *discussing* verdicts mid-text
 * cannot accidentally route the loop; only a verdict *stated at the end* counts. Returns
 * null when none is found or the tail states more than one distinct verdict — and null
 * always means "pause and ask the operator", never a guess.
 */
export function parseVerdict(reply: string): Verdict | null {
  const tail = reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-10);
  const found: Verdict[] = [];
  for (const line of tail) {
    const match = /^VERDICT:\s*(FIX|PROCEED|COMPLETE)\b/i.exec(line);
    if (match !== null) found.push(match[1]?.toUpperCase() as Verdict);
  }
  const distinct = [...new Set(found)];
  if (distinct.length === 1 && distinct[0] !== undefined) return distinct[0];
  return null;
}

/**
 * An ADVANCING verdict must arrive attached to findings. Reply text minus its VERDICT
 * lines is what the review actually said; below this floor there is no review, only a
 * routing token. 200 characters is far beneath any genuine review (measured: 4,300-6,200
 * chars with file:line evidence) while excluding the failure that motivated it — a
 * 72-character "ready to move forward, VERDICT: PROCEED" from a session that read nothing,
 * which silently advanced an unreviewed batch. FIX is deliberately exempt: it advances
 * nothing, costs one reversible cycle, and a terse FIX errs in the safe direction.
 */
export const REVIEW_FINDINGS_FLOOR = 200;

/** The reply with its VERDICT lines removed — what the reviewer actually SAID. */
export function findingsOf(reply: string): string {
  return reply
    .split(/\r?\n/)
    .filter((line) => !/^\s*VERDICT:\s*(FIX|PROCEED|COMPLETE)\b/i.test(line.trim()))
    .join('\n')
    .trim();
}

/**
 * The plan's own headings are the decomposition. Counting them is the closest the relay
 * ever comes to reading the plan — and it reads a NUMBER, not the work.
 */
export function countPlanBatches(planContent: string): number {
  const numbers = [...planContent.matchAll(/^#{1,6}\s+Batch\s+(\d+)\b/gim)]
    .map((match) => Number.parseInt(match[1] ?? '0', 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return numbers.length === 0 ? 1 : Math.max(...numbers);
}

// ---------------------------------------------------------------------------
// Prompts — short by design; the models read the plan themselves
// ---------------------------------------------------------------------------

// Demonstrated cost, live: a reviewer armed watchers on a browser suite and replied that it
// would "close out the review" once they fired. Its session ended when it replied, the
// watchers died with it, and the suite was orphaned — it could never have observed the
// result it was waiting for. The relay paused correctly on the unclear verdict, but the
// prompt had never told either model the turn is all it gets.
const SINGLE_TURN_NOTICE =
  'You get exactly one reply. Complete all verification before answering — you will not ' +
  'be asked again, and any background work you start is killed when you reply.';

const INTERRUPTION_PREFACE =
  'NOTE: a previous attempt at this step may have been interrupted. The working tree may ' +
  'contain partial or uncommitted work from it. Reconcile whatever you find with the task ' +
  'below and continue.\n\n';

function implementerBatchPrompt(run: RelayRun, preface = ''): string {
  return `${preface}You are the IMPLEMENTER in a two-model loop. The execution plan is the file at ${run.planPath} — read it from disk yourself.

Work on Batch ${run.batch} of ${run.totalBatches} ONLY. Implement it fully per the plan. Commit your work locally as you go. Do NOT push.

When the batch is complete, stop and reply with a summary for the reviewer: what you did, the files you created or changed, the commands you ran and their results, and the resulting git commits.

${SINGLE_TURN_NOTICE}`;
}

function reviewerPrompt(run: RelayRun, implementerSummary: string): string {
  return `You are the REVIEWER in a two-model loop. The execution plan is the file at ${run.planPath} — read it from disk yourself.

The implementer reports the following for Batch ${run.batch} of ${run.totalBatches}:

${implementerSummary}

Read Batch ${run.batch} in the plan. Verify the implementer's claims against the repository — the diff, the files, and whatever verification you judge necessary; you may run commands. Reply with your findings, written for the implementer.

${SINGLE_TURN_NOTICE}

A verdict without findings will not be accepted: PROCEED and COMPLETE must be accompanied by what you verified and how.

End your reply with exactly ONE line, and nothing after it:
VERDICT: FIX        (problems that must be addressed)
VERDICT: PROCEED    (the batch is acceptable; move to the next)
VERDICT: COMPLETE   (this was the final batch and the plan is done)`;
}

function fixPrompt(run: RelayRun, review: string, preface = ''): string {
  return `${preface}The reviewer examined your Batch ${run.batch} work and requires fixes:

${review}

Address them, commit locally, do NOT push, then reply with a summary of what you changed.

${SINGLE_TURN_NOTICE}`;
}

function acceptPrompt(run: RelayRun, review: string): string {
  return `The reviewer examined your Batch ${run.batch} work:

${review}

The operator has decided this feedback is FINAL for this batch: apply what is quick and essential, commit locally, do NOT push, and reply with a brief summary. There will be no further review round for this batch.

${SINGLE_TURN_NOTICE}`;
}

function unclearVerdictPrompt(): string {
  return 'Your previous reply did not end with a clear VERDICT line, so the loop cannot route it. Restate your conclusion and end with exactly one line: VERDICT: FIX, VERDICT: PROCEED, or VERDICT: COMPLETE.';
}

// ---------------------------------------------------------------------------
// Storage — an append-only log and one counters row; the log is the truth
// ---------------------------------------------------------------------------

function getRun(db: RelayDb, runId: string): RelayRun | null {
  const row = db.prepare('SELECT * FROM relay_runs WHERE run_id = ?').get(runId) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) return null;
  return {
    runId: String(row.run_id),
    planPath: String(row.plan_path),
    projectDir: String(row.project_dir),
    totalBatches: Number(row.total_batches),
    maxCycles: Number(row.max_cycles),
    batch: Number(row.batch),
    cycle: Number(row.cycle),
    status: String(row.status) as RelayRun['status'],
    pending: row.pending === null ? null : String(row.pending),
    implementerSession: row.implementer_session === null ? null : String(row.implementer_session),
    reviewerSession: row.reviewer_session === null ? null : String(row.reviewer_session),
    implementerSessionKind:
      row.implementer_session_kind == null ? null : String(row.implementer_session_kind),
    reviewerSessionKind:
      row.reviewer_session_kind == null ? null : String(row.reviewer_session_kind),
  };
}

function updateRun(db: RelayDb, run: RelayRun): void {
  db.prepare(
    `UPDATE relay_runs SET total_batches = ?, max_cycles = ?, batch = ?, cycle = ?, status = ?,
       pending = ?, implementer_session = ?, reviewer_session = ?,
       implementer_session_kind = ?, reviewer_session_kind = ?, updated_at = ?
     WHERE run_id = ?`,
  ).run(
    run.totalBatches,
    run.maxCycles,
    run.batch,
    run.cycle,
    run.status,
    run.pending,
    run.implementerSession,
    run.reviewerSession,
    run.implementerSessionKind,
    run.reviewerSessionKind,
    new Date().toISOString(),
    run.runId,
  );
}

function appendEvent(
  db: RelayDb,
  run: RelayRun,
  event: {
    role: RelayEvent['role'];
    kind: RelayEvent['kind'];
    content: string;
    sessionId?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
  },
): void {
  db.prepare(
    `INSERT INTO relay_events
       (run_id, batch, cycle, role, kind, content, session_id, model, input_tokens, output_tokens, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.runId,
    run.batch,
    run.cycle,
    event.role,
    event.kind,
    event.content,
    event.sessionId ?? null,
    event.model ?? null,
    event.inputTokens ?? null,
    event.outputTokens ?? null,
    event.durationMs ?? null,
    new Date().toISOString(),
  );
}

/** The most recent event of one role and kind — e.g. the reviewer's last FULL prompt. */
function lastEventOf(
  db: RelayDb,
  runId: string,
  role: RelayEvent['role'],
  kind: RelayEvent['kind'],
): RelayEvent | null {
  const row = db
    .prepare(
      `SELECT event_id, batch, cycle, role, kind, content FROM relay_events
       WHERE run_id = ? AND role = ? AND kind = ? ORDER BY event_id DESC LIMIT 1`,
    )
    .get(runId, role, kind) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    eventId: Number(row.event_id),
    batch: Number(row.batch),
    cycle: Number(row.cycle),
    role: String(row.role) as RelayEvent['role'],
    kind: String(row.kind) as RelayEvent['kind'],
    content: String(row.content),
  };
}

function lastEvent(db: RelayDb, runId: string): RelayEvent | null {
  const row = db
    .prepare(
      `SELECT event_id, batch, cycle, role, kind, content FROM relay_events
       WHERE run_id = ? AND kind IN ('PROMPT', 'RESPONSE') ORDER BY event_id DESC LIMIT 1`,
    )
    .get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    eventId: Number(row.event_id),
    batch: Number(row.batch),
    cycle: Number(row.cycle),
    role: String(row.role) as RelayEvent['role'],
    kind: String(row.kind) as RelayEvent['kind'],
    content: String(row.content),
  };
}

// ---------------------------------------------------------------------------
// The worker lease — one process per run, enforced, not assumed
// ---------------------------------------------------------------------------

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Claims the run for THIS process, refusing while another live process holds it.
 *
 * Two workers once drove one run: a killed reviewer call left its relay process alive (an
 * unkillable child's pipes held the event loop), and a `resume` started a second — same
 * batch, same cycle, two reviewers appending to one event log. That is a data-integrity
 * hazard, not untidiness. The relay is same-machine by construction, so the lease is the
 * simplest thing that is actually true: the holder's pid, checked for liveness. No
 * heartbeats, no expiry arithmetic — a dead pid releases by BEING dead.
 */
function claimRelayWorker(db: RelayDb, runId: string): void {
  const row = db
    .prepare('SELECT worker_pid, worker_started_at FROM relay_runs WHERE run_id = ?')
    .get(runId) as { worker_pid: number | null; worker_started_at: string | null } | undefined;
  if (row === undefined) throw new Error(`Relay run ${runId} does not exist`);
  const holder = row.worker_pid;
  if (holder !== null && holder !== process.pid && pidAlive(holder)) {
    throw new Error(
      `Run ${runId} is held by live relay process ${holder} (since ${row.worker_started_at ?? 'unknown'}). ` +
        'Two workers on one run would interleave two conversations into one event log. ' +
        `If that process is genuinely stuck, kill it (kill ${holder}) and resume again.`,
    );
  }
  // Optimistic claim: WHERE pins the exact value we read, so two simultaneous resumes
  // serialize in SQLite and the loser sees zero changed rows.
  const claimed = db
    .prepare(
      `UPDATE relay_runs SET worker_pid = ?, worker_started_at = ?, pause_intent = NULL
       WHERE run_id = ? AND (worker_pid IS ? OR worker_pid = ?)`,
    )
    .run(process.pid, new Date().toISOString(), runId, holder, process.pid);
  if (claimed.changes !== 1) {
    throw new Error(
      `Run ${runId} was claimed by another process at the same moment; not starting a second worker.`,
    );
  }
}

type PauseIntent = 'NEXT_BOUNDARY' | 'BATCH_END';

/**
 * Deliberately read fresh from the row each time, and deliberately NOT part of RelayRun /
 * updateRun: the intent is written by a CONCURRENT operator command while the worker's
 * in-memory run object is stale, and updateRun writing that stale copy back would silently
 * erase the pause the operator just asked for.
 */
function readPauseIntent(db: RelayDb, runId: string): PauseIntent | null {
  const row = db.prepare('SELECT pause_intent FROM relay_runs WHERE run_id = ?').get(runId) as
    | { pause_intent: string | null }
    | undefined;
  const value = row?.pause_intent ?? null;
  return value === 'NEXT_BOUNDARY' || value === 'BATCH_END' ? value : null;
}

function writePauseIntent(db: RelayDb, runId: string, intent: PauseIntent | null): void {
  db.prepare('UPDATE relay_runs SET pause_intent = ? WHERE run_id = ?').run(intent, runId);
}

/** Releases only OUR OWN claim — a newer holder's lease is never clobbered. */
function releaseRelayWorker(db: RelayDb, runId: string): void {
  db.prepare(
    'UPDATE relay_runs SET worker_pid = NULL, worker_started_at = NULL WHERE run_id = ? AND worker_pid = ?',
  ).run(runId, process.pid);
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

interface RelayContext {
  db: RelayDb;
  registry: ModelRegistry;
  roleAliases: { IMPLEMENTER: string; REVIEWER: string };
  roleKinds: { IMPLEMENTER: string; REVIEWER: string };
  timeouts: { IMPLEMENTER: number | undefined; REVIEWER: number | undefined };
  guardEnv: Readonly<Record<string, string>>;
  stopRequested: () => boolean;
  dispose: () => void;
}

function clearRoleSession(context: RelayContext, run: RelayRun, role: RelayRole): void {
  if (role === 'IMPLEMENTER') {
    run.implementerSession = null;
    run.implementerSessionKind = null;
  } else {
    run.reviewerSession = null;
    run.reviewerSessionKind = null;
  }
  updateRun(context.db, run);
}

async function callRole(
  context: RelayContext,
  run: RelayRun,
  role: RelayRole,
  prompt: string,
): Promise<string> {
  const adapter = context.registry.getAdapter(context.roleAliases[role]);
  const currentKind = context.roleKinds[role];
  let sessionId = role === 'IMPLEMENTER' ? run.implementerSession : run.reviewerSession;
  const sessionKind = role === 'IMPLEMENTER' ? run.implementerSessionKind : run.reviewerSessionKind;
  // A session id without its creator's adapter kind is not enough to resume safely. An
  // operator swapped the reviewer from claude to codex mid-run and the relay handed the
  // claude session id to `codex exec resume` — the resume failed and the pre-strict
  // fallback stalled at task_started, twice, for 79 and 13 minutes of nothing. When the
  // kind has changed, don't attempt the resume at all: start fresh, and say so.
  if (sessionId !== null && sessionKind !== null && sessionKind !== currentKind) {
    appendEvent(context.db, run, {
      role: 'RELAY',
      kind: 'NOTE',
      content: `${role} adapter kind changed (${sessionKind} → ${currentKind}); starting a fresh ${role.toLowerCase()} session`,
    });
    clearRoleSession(context, run, role);
    sessionId = null;
  }
  appendEvent(context.db, run, { role, kind: 'PROMPT', content: prompt });
  const options = {
    ...(context.timeouts[role] === undefined ? {} : { timeout: context.timeouts[role] }),
    env: context.guardEnv,
    // A failed resume must SURFACE, never silently fall back to a fresh exec: the fallback
    // both hides a killed call and forks the role's memory — the model that answers no
    // longer remembers the conversation the transcript says it is part of.
    strictResume: true,
  };
  const startedAt = Date.now();
  let call: Awaited<ReturnType<typeof adapter.send>>;
  try {
    call =
      sessionId === null
        ? await adapter.send(prompt, options)
        : await adapter.resume(sessionId, prompt, options);
  } catch (error) {
    // A REFUSED RESUME means the stored session is bad — legacy rows predate the kind
    // columns, so a foreign id can still reach here. Clear it so the NEXT attempt starts
    // fresh instead of failing on the same id forever, then surface the failure honestly:
    // the boundary records it and the operator resumes deliberately.
    if ((error as { resumeFailed?: boolean }).resumeFailed === true && sessionId !== null) {
      clearRoleSession(context, run, role);
      appendEvent(context.db, run, {
        role: 'RELAY',
        kind: 'NOTE',
        content: `${role} session ${sessionId} could not be resumed; cleared — the next attempt starts a fresh session`,
      });
    }
    throw error;
  }
  // An empty response is NOT a response. A hand-killed codex once surfaced as a clean call
  // with zero-length text, and the transcript gained a turn that never happened. Refuse it
  // here — the prompt stays unanswered in the log, the boundary records the failure, and
  // resume re-sends with the reconcile preface, exactly like any other failed call.
  if (call.text.trim().length === 0) {
    throw new Error(
      `${role} returned an empty response — recording it as a failed call, not a turn`,
    );
  }
  const newSession = call.sessionId ?? sessionId;
  if (role === 'IMPLEMENTER') {
    run.implementerSession = newSession ?? null;
    run.implementerSessionKind = newSession == null ? null : currentKind;
  } else {
    run.reviewerSession = newSession ?? null;
    run.reviewerSessionKind = newSession == null ? null : currentKind;
  }
  appendEvent(context.db, run, {
    role,
    kind: 'RESPONSE',
    content: call.text,
    ...(newSession == null ? {} : { sessionId: newSession }),
    // Which model said this — the audit fact a transcript exists to carry. Two vendor
    // swaps happened on one live run and its own log showed neither seam.
    model: call.model,
    inputTokens: call.usage.inputTokens,
    outputTokens: call.usage.outputTokens,
    durationMs: Date.now() - startedAt,
  });
  updateRun(context.db, run);
  return call.text;
}

function pause(
  context: RelayContext,
  run: RelayRun,
  status: 'PAUSED_CYCLE_CAP' | 'PAUSED_UNCLEAR_VERDICT' | 'STOPPED' | 'COMPLETE',
  note: string,
): void {
  run.status = status;
  appendEvent(context.db, run, { role: 'RELAY', kind: 'NOTE', content: note });
  updateRun(context.db, run);
}

/**
 * One step: look at the last logged exchange, do the single thing it implies, return
 * whether the loop should keep going. The log IS the state — nothing else records where
 * the process is, so resume is "run the same loop again" with no ceremony.
 */
async function step(context: RelayContext, run: RelayRun): Promise<boolean> {
  const last = lastEvent(context.db, run.runId);

  // Nothing yet: open the first batch.
  if (last === null) {
    process.stderr.write(`[relay] batch ${run.batch}/${run.totalBatches} → implementer\n`);
    await callRole(context, run, 'IMPLEMENTER', implementerBatchPrompt(run));
    return true;
  }

  // A prompt with no reply: the call was interrupted. Re-send it with the one-sentence
  // preface and let the model reconcile whatever half-finished state it left behind.
  if (last.kind === 'PROMPT') {
    const role = last.role === 'REVIEWER' ? 'REVIEWER' : 'IMPLEMENTER';
    process.stderr.write(`[relay] re-sending interrupted ${role.toLowerCase()} prompt\n`);
    await callRole(context, run, role, `${INTERRUPTION_PREFACE}${last.content}`);
    return true;
  }

  // Implementer replied: forward the summary to the reviewer — unless the operator already
  // decided this batch is final, in which case the reply closes the batch.
  if (last.role === 'IMPLEMENTER') {
    if (run.pending === 'ADVANCE_AFTER_RESPONSE') {
      run.pending = null;
      return advanceBatch(context, run);
    }
    process.stderr.write(
      `[relay] batch ${run.batch}/${run.totalBatches} · cycle ${run.cycle} → reviewer\n`,
    );
    await callRole(context, run, 'REVIEWER', reviewerPrompt(run, last.content));
    return true;
  }

  // Reviewer replied: the only routing decision in the system.
  if (last.role === 'REVIEWER') {
    const verdict = parseVerdict(last.content);
    if (verdict === null) {
      pause(
        context,
        run,
        'PAUSED_UNCLEAR_VERDICT',
        `The reviewer reply has no single clear VERDICT line; pausing rather than guessing. Resume with: codemoot relay resume ${run.runId}`,
      );
      return false;
    }
    if (verdict === 'COMPLETE' || verdict === 'PROCEED') {
      // Advancing is the one IRREVERSIBLE thing the relay does. It once did it on 72
      // characters. The relay still never grades review quality — but a verdict with no
      // findings attached is not a review the routing token can honestly come from, so it
      // is treated exactly like a missing verdict: pause, and resume re-sends the FULL
      // review prompt (the thin reply is not restatable by construction).
      const findings = findingsOf(last.content);
      if (findings.length < REVIEW_FINDINGS_FLOOR) {
        pause(
          context,
          run,
          'PAUSED_UNCLEAR_VERDICT',
          `The reviewer answered VERDICT: ${verdict} with only ${findings.length} characters of findings — a verdict without a review cannot advance a batch. Resume re-sends the full review prompt: codemoot relay resume ${run.runId}`,
        );
        return false;
      }
      // Log-only early warning: an accepted review far below this reviewer's own norm is
      // worth a line in the transcript even though it passed the floor.
      const priorLengths = context.db
        .prepare(
          `SELECT LENGTH(content) AS n FROM relay_events
           WHERE run_id = ? AND role = 'REVIEWER' AND kind = 'RESPONSE' AND LENGTH(content) >= ?
           ORDER BY event_id`,
        )
        .all(run.runId, REVIEW_FINDINGS_FLOOR)
        .map((row) => Number((row as { n: number }).n))
        .slice(0, -1);
      if (priorLengths.length >= 2) {
        const sorted = [...priorLengths].sort((left, right) => left - right);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        if (median > 1_000 && last.content.length < median / 4) {
          appendEvent(context.db, run, {
            role: 'RELAY',
            kind: 'NOTE',
            content: `Accepted review is far shorter than this reviewer's norm (${last.content.length} chars vs median ${median}) — worth a human look in the transcript`,
          });
        }
      }
      if (verdict === 'COMPLETE') {
        pause(context, run, 'COMPLETE', 'The reviewer declared the plan complete.');
        return false;
      }
      return advanceBatch(context, run);
    }
    // FIX — the only place a counter matters.
    if (run.cycle >= run.maxCycles) {
      pause(
        context,
        run,
        'PAUSED_CYCLE_CAP',
        `Batch ${run.batch} has been through ${run.cycle} review cycles (cap ${run.maxCycles}). ` +
          `The operator decides: codemoot relay resume ${run.runId} --decision continue | accept | proceed`,
      );
      return false;
    }
    run.cycle += 1;
    updateRun(context.db, run);
    process.stderr.write(
      `[relay] batch ${run.batch}/${run.totalBatches} · fix cycle ${run.cycle} → implementer\n`,
    );
    await callRole(context, run, 'IMPLEMENTER', fixPrompt(run, last.content));
    return true;
  }

  throw new Error(`Unroutable last event: ${last.role} ${last.kind}`);
}

function advanceBatch(context: RelayContext, run: RelayRun): boolean {
  if (run.batch >= run.totalBatches) {
    pause(context, run, 'COMPLETE', `Batch ${run.batch} accepted; all batches are done.`);
    return false;
  }
  run.batch += 1;
  run.cycle = 1;
  updateRun(context.db, run);
  appendEvent(context.db, run, {
    role: 'RELAY',
    kind: 'NOTE',
    content: `Advanced to batch ${run.batch}/${run.totalBatches}`,
  });
  // "Stop when this batch finishes" — honoured exactly at the finish, deterministically,
  // instead of an operator racing a poll against two events written in the same instant.
  if (readPauseIntent(context.db, run.runId) === 'BATCH_END') {
    writePauseIntent(context.db, run.runId, null);
    pause(
      context,
      run,
      'STOPPED',
      `Operator pause honoured: batch ${run.batch - 1} finished (next up: batch ${run.batch}). Resume with: codemoot relay resume ${run.runId}`,
    );
    return false;
  }
  return true;
}

async function runLoop(context: RelayContext, run: RelayRun): Promise<void> {
  run.status = 'ACTIVE';
  updateRun(context.db, run);
  try {
    for (;;) {
      if (context.stopRequested()) {
        pause(context, run, 'STOPPED', 'Stopped by operator between calls.');
        return;
      }
      // Durable operator intent — the signal-free pause. Honoured here, between calls,
      // which is the only boundary a poll can never reliably land on from outside.
      if (readPauseIntent(context.db, run.runId) === 'NEXT_BOUNDARY') {
        writePauseIntent(context.db, run.runId, null);
        pause(context, run, 'STOPPED', 'Operator pause honoured at the call boundary.');
        return;
      }
      // The implementer prompt for a NEW batch is issued here rather than inside step() so
      // an advance and its first prompt are two separate log entries around one call.
      const last = lastEvent(context.db, run.runId);
      if (last !== null && last.batch < run.batch) {
        process.stderr.write(`[relay] batch ${run.batch}/${run.totalBatches} → implementer\n`);
        await callRole(
          context,
          run,
          'IMPLEMENTER',
          implementerBatchPrompt(run, `Batch ${run.batch - 1} was accepted.\n\n`),
        );
        continue;
      }
      const keepGoing = await step(context, run);
      if (!keepGoing) return;
    }
  } catch (error) {
    // A failed or killed call is recorded and the run stops cleanly; resume re-derives
    // everything from the log, including the interrupted-prompt case.
    pause(
      context,
      run,
      'STOPPED',
      `Call failed: ${error instanceof Error ? error.message : String(error)}. Resume with: codemoot relay resume ${run.runId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function buildContext(db: RelayDb, projectDir: string): RelayContext {
  const config = loadConfig({ projectDir });
  const implementerAlias = config.roles.implementer?.model;
  const reviewerAlias = config.roles.reviewer?.model;
  if (implementerAlias === undefined || reviewerAlias === undefined) {
    throw new Error('The relay requires "implementer" and "reviewer" roles in .cowork.yml');
  }
  if (implementerAlias === reviewerAlias) {
    // Reviewer independence is the product, not a guard: one alias would mean one session
    // reviewing itself.
    throw new Error('implementer and reviewer must be different model aliases');
  }
  const timeoutOf = (alias: string): number | undefined => {
    const seconds = config.models[alias]?.cliAdapter?.timeout;
    return seconds === undefined ? undefined : seconds * 1000;
  };
  // The composed guarded PATH: guard dir first, then the operator's real PATH, so `claude`
  // resolves while `git` hits the deny-by-default wrapper. The adapter overlays this env on
  // its ALLOWLISTED base (claude-cli-adapter.ts), so USER/HOME/LANG survive — these six
  // keys are an overlay, not the whole environment.
  const guardedPath = installGitGuard(projectDir);
  let stopRequested = false;
  const requestStop = (): void => {
    stopRequested = true;
    process.stderr.write('\n[relay] finishing the current call, then stopping…\n');
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  return {
    dispose: () => {
      process.removeListener('SIGINT', requestStop);
      process.removeListener('SIGTERM', requestStop);
    },
    db,
    registry: ModelRegistry.fromConfig(config, projectDir),
    roleAliases: { IMPLEMENTER: implementerAlias, REVIEWER: reviewerAlias },
    roleKinds: {
      IMPLEMENTER: resolveModelAdapterKind(
        config.models[implementerAlias] ?? { provider: 'anthropic', model: '' },
      ),
      REVIEWER: resolveModelAdapterKind(
        config.models[reviewerAlias] ?? { provider: 'anthropic', model: '' },
      ),
    },
    timeouts: { IMPLEMENTER: timeoutOf(implementerAlias), REVIEWER: timeoutOf(reviewerAlias) },
    guardEnv: {
      PATH: guardedPath,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      GIT_SSH_COMMAND: '/usr/bin/false',
    },
    stopRequested: () => stopRequested,
  };
}

/**
 * Re-invokes this CLI detached: `codemoot relay <args>` in its own session, stderr and
 * stdout to a log file under .cowork/relay/. The child inherits the FULL parent
 * environment — the nohup workaround this replaces silently stripped PATH and USER, which
 * cost a live run its first attempt — and the log file stays, because the relay's first
 * real failure was diagnosed in two minutes precisely because nohup kept one.
 */
function spawnDetachedRelay(
  projectDir: string,
  runId: string,
  args: readonly string[],
): { readonly pid: number | null; readonly log: string } {
  const entry = process.argv[1];
  if (entry === undefined) throw new Error('Cannot resolve the CLI entry point');
  const logDir = resolve(projectDir, '.cowork', 'relay');
  mkdirSync(logDir, { recursive: true });
  const log = resolve(logDir, `${runId}.log`);
  const fd = openSync(log, 'a');
  const child = spawn(process.execPath, [entry, 'relay', ...args], {
    cwd: projectDir,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  closeSync(fd);
  return { pid: child.pid ?? null, log };
}

export async function relayRunCommand(options: {
  readonly plan: string;
  readonly id?: string;
  readonly maxCycles?: number;
  readonly batches?: number;
  readonly startBatch?: number;
  readonly background?: boolean;
}): Promise<void> {
  await withDatabase(async (db) => {
    const projectDir = process.cwd();
    const planPath = resolve(projectDir, options.plan);
    const planContent = readFileSync(planPath, 'utf8');
    const totalBatches = options.batches ?? countPlanBatches(planContent);
    const runId = options.id ?? generateId('relay');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO relay_runs
         (run_id, plan_path, project_dir, total_batches, max_cycles, batch, cycle, status,
          pending, implementer_session, reviewer_session, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'ACTIVE', NULL, NULL, NULL, ?, ?)`,
    ).run(
      runId,
      planPath,
      projectDir,
      totalBatches,
      options.maxCycles ?? 3,
      options.startBatch ?? 1,
      now,
      now,
    );
    process.stderr.write(
      `[relay] ${runId}: ${totalBatches} batches per the plan's own headings, cycle cap ${options.maxCycles ?? 3}\n`,
    );
    if (options.background === true) {
      // The row is durable; the detached child is just `relay resume` on a pristine run —
      // the loop derives "open batch 1" from an empty event log, so run-in-background and
      // resume share one worker path instead of two.
      const worker = spawnDetachedRelay(projectDir, runId, ['resume', runId]);
      console.log(
        JSON.stringify(
          {
            status: 'RUNNING',
            runId,
            workerPid: worker.pid,
            log: worker.log,
            watch: `codemoot relay status ${runId}`,
          },
          null,
          2,
        ),
      );
      return;
    }
    const context = buildContext(db, projectDir);
    const run = getRun(db, runId);
    if (run === null) throw new Error('run row vanished');
    claimRelayWorker(db, runId);
    try {
      await runLoop(context, run);
    } finally {
      releaseRelayWorker(db, runId);
      context.dispose();
      uninstallGitGuard(projectDir);
    }
    printRelayStatus(db, runId);
  });
}

export async function relayResumeCommand(
  runId: string,
  options: {
    readonly decision?: 'continue' | 'accept' | 'proceed';
    readonly background?: boolean;
  },
): Promise<void> {
  await withDatabase(async (db) => {
    const run = getRun(db, runId);
    if (run === null) throw new Error(`Relay run ${runId} does not exist`);
    if (run.status === 'COMPLETE') {
      printRelayStatus(db, runId);
      return;
    }
    claimRelayWorker(db, runId);
    const context = buildContext(db, run.projectDir);

    // Every call below runs inside ONE error boundary. runLoop guards its own calls — that
    // is why the two PATH failures cost $0 and two minutes — but these direct decision and
    // re-ask calls used to sit OUTSIDE it, so an adapter exception here escaped as an
    // unhandled rejection and killed the process: a 28-minute reviewer call died on a
    // protocol error and the runner died with it. The "record events, resume is automatic"
    // guarantee must hold for adapter exceptions exactly as it holds for model outcomes.
    // Operator-input validation happens BEFORE the boundary: a missing --decision is the
    // human's error to correct, not a call failure to record.
    if (run.status === 'PAUSED_CYCLE_CAP' && options.decision === undefined) {
      throw new Error(
        `Batch ${run.batch} is paused at the cycle cap. Choose: --decision continue (one more review cycle) | accept (implementer applies the last feedback as final, then the batch advances) | proceed (advance as-is)`,
      );
    }
    if (options.background === true) {
      // Validated above, claimed by the CHILD: the lease belongs to the process that
      // actually works the run, so the parent must not take it and hand off.
      const worker = spawnDetachedRelay(run.projectDir, runId, [
        'resume',
        runId,
        ...(options.decision === undefined ? [] : ['--decision', options.decision]),
      ]);
      console.log(
        JSON.stringify(
          {
            status: 'RESUMING',
            runId,
            workerPid: worker.pid,
            log: worker.log,
            watch: `codemoot relay status ${runId}`,
          },
          null,
          2,
        ),
      );
      return;
    }
    try {
      if (run.status === 'PAUSED_CYCLE_CAP') {
        const review = lastEvent(db, runId);
        // Narrowed above: PAUSED_CYCLE_CAP without a decision already threw.
        const decision = options.decision as 'continue' | 'accept' | 'proceed';
        // The decision CONSUMES the pause, and the summary row must say so in the same
        // transaction that records it. It used to stay PAUSED_CYCLE_CAP for the entire
        // next model call, because updateRun faithfully re-wrote every field of the run
        // object — including the stale status it was loaded with. cycle and maxCycles
        // advanced in the same write, which is what made the row look half-updated: one
        // stale FIELD, not a missing write. `relay status` reports from this column, so a
        // watcher polling the documented surface alerted "paused, waiting for you" twice
        // on a healthy mid-call run.
        db.transaction(() => {
          appendEvent(db, run, { role: 'OPERATOR', kind: 'DECISION', content: decision });
          run.status = 'ACTIVE';
          if (decision === 'continue') {
            run.maxCycles += 1; // one more cycle, explicitly granted — the count stays honest
            run.cycle += 1;
          } else if (decision === 'accept') {
            run.pending = 'ADVANCE_AFTER_RESPONSE';
          }
          updateRun(db, run);
        })();
        if (decision === 'continue') {
          if (review === null) throw new Error('no review to continue from');
          await callRole(context, run, 'IMPLEMENTER', fixPrompt(run, review.content));
        } else if (decision === 'accept') {
          if (review === null) throw new Error('no review to accept');
          await callRole(context, run, 'IMPLEMENTER', acceptPrompt(run, review.content));
        } else {
          appendEvent(db, run, {
            role: 'RELAY',
            kind: 'NOTE',
            content: `Batch ${run.batch} advanced as-is by operator decision`,
          });
          advanceBatch(context, run);
        }
      } else if (run.status === 'PAUSED_UNCLEAR_VERDICT') {
        // Only re-ask when the reviewer's unclear REPLY is the last word. If the last event
        // is an unanswered PROMPT, the re-ask itself crashed mid-call — runLoop's
        // interrupted-prompt path re-sends it with the reconcile preface instead of
        // stacking a second re-ask on top.
        const last = lastEvent(db, runId);
        if (last !== null && last.kind === 'RESPONSE') {
          // The restate re-ask presumes a review HAPPENED and only its verdict line was
          // malformed. That presumption has two prerequisites, and both must hold:
          //   1. the reply actually said something (a legacy zero-length RESPONSE has
          //      nothing to restate), and
          //   2. the reviewer session still exists (a fresh session has no memory of the
          //      batch — asked only to "restate your conclusion", it will oblige by
          //      INVENTING one; a live run advanced past an unreviewed batch on a
          //      72-character manufactured PROCEED exactly this way).
          // When either fails, the honest re-ask is the ORIGINAL full review prompt.
          const restatable =
            findingsOf(last.content).length >= REVIEW_FINDINGS_FLOOR &&
            run.reviewerSession !== null;
          // Same stale-field shape as the cycle-cap branch: the re-ask is the run being
          // active again, and the row must say so before the call, not after it returns.
          run.status = 'ACTIVE';
          updateRun(db, run);
          if (restatable) {
            await callRole(context, run, 'REVIEWER', unclearVerdictPrompt());
          } else {
            const originalPrompt = lastEventOf(db, runId, 'REVIEWER', 'PROMPT');
            if (originalPrompt === null) {
              throw new Error(
                `Run ${runId} is paused on an unclear verdict but has no reviewer prompt to re-send`,
              );
            }
            appendEvent(db, run, {
              role: 'RELAY',
              kind: 'NOTE',
              content:
                'There is no conclusion to restate (empty reply or fresh reviewer session); re-sending the full review prompt instead of the restate re-ask',
            });
            await callRole(context, run, 'REVIEWER', originalPrompt.content);
          }
        }
      }

      // Every mutation above persisted through updateRun, so the row is the truth — and a
      // `proceed` on the final batch may have just completed the run.
      const current = getRun(db, runId);
      if (current !== null && current.status !== 'COMPLETE') await runLoop(context, current);
    } catch (error) {
      // Decision-state mutations (cycle grants, pending advances) were persisted BEFORE the
      // failed call, so recording the failure and stopping loses nothing: resume re-derives
      // from the log, and an unanswered prompt takes the interrupted-call path.
      pause(
        context,
        run,
        'STOPPED',
        `Call failed: ${error instanceof Error ? error.message : String(error)}. Resume with: codemoot relay resume ${runId}`,
      );
    } finally {
      releaseRelayWorker(db, runId);
      context.dispose();
      uninstallGitGuard(run.projectDir);
    }
    printRelayStatus(db, runId);
  });
}

export async function relayPauseCommand(
  runId: string,
  options: { readonly afterBatch?: boolean },
): Promise<void> {
  await withDatabase(async (db) => {
    const run = getRun(db, runId);
    if (run === null) throw new Error(`Relay run ${runId} does not exist`);
    const row = db.prepare('SELECT worker_pid FROM relay_runs WHERE run_id = ?').get(runId) as {
      worker_pid: number | null;
    };
    const holder = row.worker_pid;
    const holderAlive = holder !== null && pidAlive(holder);

    if (!holderAlive) {
      // A dead holder's lease is stale bookkeeping; clear it so the report is honest.
      if (holder !== null) {
        db.prepare(
          'UPDATE relay_runs SET worker_pid = NULL, worker_started_at = NULL WHERE run_id = ? AND worker_pid = ?',
        ).run(runId, holder);
      }
      console.log(
        JSON.stringify(
          {
            status: 'NOT_RUNNING',
            runId,
            note:
              holder === null
                ? 'No worker holds this run; there is nothing to pause.'
                : `Worker ${holder} is already dead; stale lease cleared. Nothing to pause.`,
            resume: `codemoot relay resume ${runId}`,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (options.afterBatch === true) {
      // Intent only — no signal. A signal would stop EARLIER than what was asked for; the
      // loop honours BATCH_END exactly when the current batch is accepted.
      writePauseIntent(db, runId, 'BATCH_END');
      console.log(
        JSON.stringify(
          {
            status: 'PAUSE_SCHEDULED',
            runId,
            workerPid: holder,
            note: `Worker ${holder} will stop when batch ${run.batch} finishes.`,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Default: graceful stop after the current call. The signal goes to the pid the LEASE
    // records — never to a pgrep pattern, which is how an operator's watcher once matched
    // its own command line, signalled itself, and the run sailed through the boundary they
    // meant to stop at. The intent is written as well, so even a lost signal still stops
    // the loop at its next boundary.
    writePauseIntent(db, runId, 'NEXT_BOUNDARY');
    try {
      process.kill(holder, 'SIGINT');
    } catch {
      console.log(
        JSON.stringify(
          {
            status: 'PAUSE_SCHEDULED',
            runId,
            note: `Worker ${holder} died as the pause was sent; the durable intent stops any successor at its next boundary.`,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(
      JSON.stringify(
        {
          status: 'PAUSE_REQUESTED',
          runId,
          workerPid: holder,
          note: 'The worker finishes its current call, then stops. The intent is durable: even if the signal is lost, the loop stops at its next call boundary.',
          watch: `codemoot relay status ${runId}`,
        },
        null,
        2,
      ),
    );
  });
}

export async function relayStatusCommand(runId: string): Promise<void> {
  await withDatabase(async (db) => {
    printRelayStatus(db, runId);
  });
}

export async function relayLogCommand(
  runId: string,
  options: { readonly full?: boolean },
): Promise<void> {
  await withDatabase(async (db) => {
    const rows = db
      .prepare(
        `SELECT event_id, batch, cycle, role, kind, content, model, input_tokens, output_tokens, duration_ms, created_at
         FROM relay_events WHERE run_id = ? ORDER BY event_id`,
      )
      .all(runId) as Record<string, unknown>[];
    for (const row of rows) {
      const content = String(row.content);
      const body = options.full === true ? content : content.split('\n')[0]?.slice(0, 160);
      const model = row.model == null ? '' : ` [${row.model}]`;
      console.log(
        `#${row.event_id} b${row.batch}c${row.cycle} ${String(row.role).padEnd(11)} ${String(row.kind).padEnd(8)}${model} ${body}`,
      );
    }
  });
}

function printRelayStatus(db: RelayDb, runId: string): void {
  const run = getRun(db, runId);
  if (run === null) throw new Error(`Relay run ${runId} does not exist`);
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output
       FROM relay_events WHERE run_id = ? AND kind = 'RESPONSE'`,
    )
    .get(runId) as { calls: number; input: number; output: number };
  console.log(
    JSON.stringify(
      {
        runId: run.runId,
        status: run.status,
        batch: run.batch,
        totalBatches: run.totalBatches,
        cycle: run.cycle,
        maxCycles: run.maxCycles,
        pauseIntent: readPauseIntent(db, runId),
        calls: totals.calls,
        inputTokens: totals.input,
        outputTokens: totals.output,
        plan: run.planPath,
        resume:
          run.status === 'COMPLETE'
            ? null
            : `codemoot relay resume ${run.runId}${run.status === 'PAUSED_CYCLE_CAP' ? ' --decision continue|accept|proceed' : ''}`,
      },
      null,
      2,
    ),
  );
}
