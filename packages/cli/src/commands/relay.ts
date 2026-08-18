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
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
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
  /** Batches >= this number start at the REVIEWER — the work already exists on the branch. */
  reviewFrom: number | null;
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
    // The token must sit RIGHT AFTER the colon (whitespace and emphasis marks aside). The
    // line is never scanned for a token further in, because the prose between colon and
    // token is where negations live — "VERDICT: CANNOT PROCEED" must pause, never advance.
    const match = /^VERDICT:[\s*_`]*(FIX|PROCEED|COMPLETE)/i.exec(line);
    if (match === null) continue;
    // Glue tolerance. A live reviewer ends every review by running its next sentence
    // straight onto the token — "VERDICT: FIXBoth reviews are complete…" — which a
    // word-boundary rule reads as no verdict at all, pausing the run on every batch a
    // human would route instantly. The token counts unless it CONTINUES as a different
    // word: a lowercase letter or digit right after it is a different word (fixme,
    // proceeding); end-of-line, whitespace, punctuation, or a capitalized next word
    // (FIXBoth) is glue.
    const after = line.charAt(match[0].length);
    if (after !== '' && /[a-z0-9]/.test(after)) continue;
    found.push(match[1]?.toUpperCase() as Verdict);
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

// One contract for BOTH reviewer prompts — a fork here would let the review-only path
// drift from the verdict rules the rest of the loop is built on.
const VERDICT_CONTRACT = `A verdict without findings will not be accepted: PROCEED and COMPLETE must be accompanied by what you verified and how.

End your reply with exactly ONE line, and nothing after it:
VERDICT: FIX        (problems that must be addressed)
VERDICT: PROCEED    (the batch is acceptable; move to the next)
VERDICT: COMPLETE   (this was the final batch and the plan is done)`;

function reviewerPrompt(run: RelayRun, implementerSummary: string): string {
  return `You are the REVIEWER in a two-model loop. The execution plan is the file at ${run.planPath} — read it from disk yourself.

The implementer reports the following for Batch ${run.batch} of ${run.totalBatches}:

${implementerSummary}

Read Batch ${run.batch} in the plan. Verify the implementer's claims against the repository — the diff, the files, and whatever verification you judge necessary; you may run commands. Reply with your findings, written for the implementer.

${SINGLE_TURN_NOTICE}

${VERDICT_CONTRACT}`;
}

/**
 * The opening prompt for a batch that ALREADY EXISTS on the branch (--review-from). There
 * is no implementer summary for such a batch and none is fabricated — the reviewer is told
 * the truth and pointed at the repository itself. The verdict contract is identical, so
 * everything downstream (FIX → fixPrompt → re-review, the findings floor, the cycle cap)
 * behaves exactly as it does for an implemented-in-run batch.
 */
function reviewOnlyReviewerPrompt(run: RelayRun): string {
  return `You are the REVIEWER in a two-model loop. The execution plan is the file at ${run.planPath} — read it from disk yourself.

Batch ${run.batch} of ${run.totalBatches} was implemented outside this run and is already committed. There is no implementer summary to check claims against — review the repository's CURRENT state against the plan.

Read Batch ${run.batch} in the plan. Verify the repository satisfies it — the diff, the files, and whatever verification you judge necessary; you may run commands. Reply with your findings, written for the implementer who will address them.

${SINGLE_TURN_NOTICE}

${VERDICT_CONTRACT}`;
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
    // == null, not === null: rows created before v22 read the column as undefined.
    reviewFrom: row.review_from == null ? null : Number(row.review_from),
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

/**
 * How many attempts at THIS step were interrupted — prompts of this role in this batch and
 * cycle with no answer after them.
 *
 * The log is the state here as everywhere else: an attempt that produced a RESPONSE ends the
 * streak, so the count is always "consecutive failures on the step being retried right now",
 * not a lifetime tally.
 */
function interruptedAttempts(db: RelayDb, run: RelayRun, role: RelayRole): number {
  const lastAnswer = db
    .prepare(
      `SELECT event_id FROM relay_events
       WHERE run_id = ? AND role = ? AND kind = 'RESPONSE' AND batch = ? AND cycle = ?
       ORDER BY event_id DESC LIMIT 1`,
    )
    .get(run.runId, role, run.batch, run.cycle) as { event_id: number } | undefined;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM relay_events
       WHERE run_id = ? AND role = ? AND kind = 'PROMPT' AND batch = ? AND cycle = ?
         AND event_id > ?`,
    )
    .get(run.runId, role, run.batch, run.cycle, lastAnswer?.event_id ?? 0) as { n: number };
  return Number(row.n);
}

/** The id the next appended event will take — a stable, monotonic per-call sequence. */
function nextEventId(db: RelayDb): number {
  const row = db.prepare('SELECT COALESCE(MAX(event_id), 0) AS n FROM relay_events').get() as {
    n: number;
  };
  return Number(row.n) + 1;
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
  /** `relay.*` from .cowork.yml, resolved once at worker start. */
  settings: RelaySettings;
  /** Where the in-flight call's raw stream is being written; named by failure notes. */
  lastCallStream: string | null;
  /** Bounded in-place retries per stop, from `advanced.retryAttempts`. */
  retryAttempts: number;
  roleAliases: { IMPLEMENTER: string; REVIEWER: string };
  roleKinds: { IMPLEMENTER: string; REVIEWER: string };
  timeouts: { IMPLEMENTER: number | undefined; REVIEWER: number | undefined };
  guardEnv: Readonly<Record<string, string>>;
  stopRequested: () => boolean;
  dispose: () => void;
}

interface RelaySettings {
  readonly freshSessionAfterInterrupts: number;
  readonly callStream: {
    readonly enabled: boolean;
    readonly maxBytesPerCall: number;
    readonly keepCalls: number;
  };
}

const DEFAULT_RELAY_SETTINGS: RelaySettings = {
  freshSessionAfterInterrupts: 1,
  callStream: { enabled: true, maxBytesPerCall: 20 * 1024 * 1024, keepCalls: 200 },
};

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

/**
 * Stops a retry from resuming a conversation that has already failed the same step.
 *
 * Each interrupted attempt re-sends into the SAME CLI session with another reconcile note
 * prepended, so the conversation grows by one apology per failure. A live run did that ten
 * times on one step and the session stopped answering at all: an eight-hour overnight hang
 * with the child on ~8 seconds of CPU. Clearing the stored session id ended it — the very
 * next attempt, a fresh conversation, finished the same step in eighteen minutes.
 *
 * Nothing is lost by starting fresh: the reconcile preface already tells the model its
 * previous attempt may have been interrupted and to inspect the working tree, and committed
 * work is on the branch either way. `relay.freshSessionAfterInterrupts: 0` restores the old
 * always-resume behaviour.
 */
function retireSessionAfterInterrupts(context: RelayContext, run: RelayRun, role: RelayRole): void {
  const threshold = context.settings.freshSessionAfterInterrupts;
  if (threshold <= 0) return;
  const sessionId = role === 'IMPLEMENTER' ? run.implementerSession : run.reviewerSession;
  if (sessionId === null) return;
  const failures = interruptedAttempts(context.db, run, role);
  if (failures < threshold) return;
  clearRoleSession(context, run, role);
  appendEvent(context.db, run, {
    role: 'RELAY',
    kind: 'NOTE',
    content: `${role} session ${sessionId} was interrupted ${failures} time(s) on batch ${run.batch} cycle ${run.cycle}; retrying with a FRESH session rather than resuming a conversation that keeps stalling`,
  });
}

/**
 * The raw adapter stream of ONE call, tee'd to disk as it arrives.
 *
 * `relay_events` keeps the finished PROMPT and RESPONSE; everything in between — the tool
 * calls, the partial text, the last thing the model did before it went quiet — was consumed
 * by the idle timer and thrown away. Diagnosing the freezes therefore needed process and
 * socket forensics on a machine that had already moved on. Now a wedge is read off the end
 * of a file: a tool call as the last line means it died waiting on a command; mid-sentence
 * text means the stream itself died.
 *
 * Capped per call and pruned per run, because a diagnostic that fills a disk is a defect.
 */
interface CallStream {
  readonly path: string;
  write(chunk: string): void;
  close(): void;
}

function openCallStream(
  context: RelayContext,
  run: RelayRun,
  role: RelayRole,
  sequence: number,
): CallStream | null {
  if (!context.settings.callStream.enabled) return null;
  const directory = resolve(run.projectDir, '.cowork', 'relay', run.runId, 'calls');
  const path = resolve(
    directory,
    `${String(sequence).padStart(6, '0')}-${role.toLowerCase()}.jsonl`,
  );
  let handle: number;
  try {
    mkdirSync(directory, { recursive: true });
    pruneCallStreams(directory, context.settings.callStream.keepCalls);
    handle = openSync(path, 'a');
  } catch {
    // Diagnostics are never allowed to stop the work they are diagnosing.
    return null;
  }
  let written = 0;
  let capped = false;
  let closed = false;
  return {
    path,
    write: (chunk: string): void => {
      if (closed || capped) return;
      try {
        const remaining = context.settings.callStream.maxBytesPerCall - written;
        if (remaining <= 0) return;
        const buffer = Buffer.from(chunk);
        if (buffer.byteLength > remaining) {
          capped = true;
          writeSync(handle, buffer.subarray(0, remaining));
          writeSync(
            handle,
            `\n[relay] stream capped at ${context.settings.callStream.maxBytesPerCall} bytes\n`,
          );
          return;
        }
        written += buffer.byteLength;
        writeSync(handle, buffer);
      } catch {
        capped = true;
      }
    },
    close: (): void => {
      if (closed) return;
      closed = true;
      try {
        closeSync(handle);
      } catch {
        // Nothing useful remains to do with a handle that will not close.
      }
    },
  };
}

/** Keeps the newest `keep` per-call files; a long run must not grow without bound. */
function pruneCallStreams(directory: string, keep: number): void {
  try {
    const files = readdirSync(directory)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - keep + 1))) {
      rmSync(resolve(directory, name), { force: true });
    }
  } catch {
    // A directory that cannot be pruned is not a reason to skip the recording.
  }
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
  const stream = openCallStream(context, run, role, nextEventId(context.db));
  context.lastCallStream = stream?.path ?? null;
  const options = {
    ...(context.timeouts[role] === undefined ? {} : { timeout: context.timeouts[role] }),
    env: context.guardEnv,
    // A failed resume must SURFACE, never silently fall back to a fresh exec: the fallback
    // both hides a killed call and forks the role's memory — the model that answers no
    // longer remembers the conversation the transcript says it is part of.
    strictResume: true,
    onProgress: (chunk: string) => stream?.write(chunk),
    onStderr: (chunk: string) => stream?.write(chunk),
    // Silence that was EXAMINED and found to be work. Noted in the transcript the first
    // time and then sparsely, so a long quiet stretch is visible without burying the log.
    onIdleExtended: (detail: { reason: string; extension: number; silentMs: number }) => {
      stream?.write(`\n[relay] idle but locally active: ${detail.reason}\n`);
      process.stderr.write(
        `[relay] ${role.toLowerCase()} quiet ${Math.round(detail.silentMs / 1000)}s but locally active (${detail.reason})\n`,
      );
      if (detail.extension === 1 || detail.extension % 10 === 0) {
        appendEvent(context.db, run, {
          role: 'RELAY',
          kind: 'NOTE',
          content: `${role} produced no output for ${Math.round(detail.silentMs / 1000)}s; the idle deadline was NOT enforced because ${detail.reason} (extension ${detail.extension})`,
        });
      }
    },
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
  } finally {
    stream?.close();
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

/**
 * Opens a batch. The loop's default opening move assumes the batch is unbuilt — pointed at
 * work that is already implemented and committed (some batches of a live 10-batch plan were
 * built by hand, outside any run), "Implement it fully per the plan" re-implements code
 * that already exists, duplicating or conflicting with it on the branch. A batch inside the
 * --review-from range therefore begins at the REVIEWER, against the repository as it
 * stands; only the opening move differs, and a FIX from that review enters the ordinary
 * fixPrompt → re-review loop.
 */
async function openBatch(
  context: RelayContext,
  run: RelayRun,
  afterAccept: boolean,
): Promise<void> {
  if (run.reviewFrom !== null && run.batch >= run.reviewFrom) {
    process.stderr.write(
      `[relay] batch ${run.batch}/${run.totalBatches} → reviewer (review-only: already implemented)\n`,
    );
    await callRole(context, run, 'REVIEWER', reviewOnlyReviewerPrompt(run));
    return;
  }
  process.stderr.write(`[relay] batch ${run.batch}/${run.totalBatches} → implementer\n`);
  await callRole(
    context,
    run,
    'IMPLEMENTER',
    implementerBatchPrompt(run, afterAccept ? `Batch ${run.batch - 1} was accepted.\n\n` : ''),
  );
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
 * Records WHY a run stopped, durably, in the row `relay status` reads.
 *
 * A stop used to be visible only as an event among hundreds, and several worker deaths left
 * no event at all — a run sat STOPPED with nothing saying why, and finding out took a person
 * noticing silence. Everything that ends a worker now comes through here first, so the
 * question "what happened?" is answered by the summary the operator already looks at.
 */
function recordFailure(db: RelayDb, runId: string, reason: string): void {
  try {
    db.prepare('UPDATE relay_runs SET last_failure = ?, last_failure_at = ? WHERE run_id = ?').run(
      reason.slice(0, 2_000),
      new Date().toISOString(),
      runId,
    );
  } catch {
    // Recording the reason must never be the thing that kills the worker.
  }
}

/** The failure note every stop shares: the reason, and the file holding the raw stream. */
function failureNote(reason: string, runId: string, streamPath: string | null): string {
  return (
    `Call failed: ${reason}.` +
    `${streamPath === null ? '' : ` Raw adapter stream: ${streamPath}.`}` +
    ` Resume with: codemoot relay resume ${runId}`
  );
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
    await openBatch(context, run, false);
    return true;
  }

  // A prompt with no reply: the call was interrupted. Re-send it with the one-sentence
  // preface and let the model reconcile whatever half-finished state it left behind.
  if (last.kind === 'PROMPT') {
    const role = last.role === 'REVIEWER' ? 'REVIEWER' : 'IMPLEMENTER';
    retireSessionAfterInterrupts(context, run, role);
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

/**
 * Retries a failed call in place instead of ending the worker.
 *
 * A call failure used to stop the run, which was honest but left the work parked until a
 * human noticed — and the failures that mattered most were transient by nature: a wedged CLI
 * that a fresh child does not reproduce. Every attempt is still recorded, the backoff is
 * bounded by `advanced.retryAttempts`, and a run that exhausts it stops exactly as it did
 * before. Retrying is what a person would do; doing it automatically only removes the wait.
 */
async function runLoop(context: RelayContext, run: RelayRun): Promise<void> {
  let attemptsLeft = context.retryAttempts;
  for (;;) {
    const outcome = await runLoopOnce(context, run);
    if (outcome.settled) return;
    attemptsLeft -= 1;
    if (attemptsLeft <= 0 || context.stopRequested()) {
      pause(
        context,
        run,
        'STOPPED',
        failureNote(
          `${outcome.reason} (retries exhausted after ${context.retryAttempts} attempts)`,
          run.runId,
          context.lastCallStream,
        ),
      );
      recordFailure(context.db, run.runId, outcome.reason);
      return;
    }
    const backoffMs = Math.min(30_000, 2_000 * 2 ** (context.retryAttempts - attemptsLeft - 1));
    appendEvent(context.db, run, {
      role: 'RELAY',
      kind: 'NOTE',
      content: failureNote(
        `${outcome.reason}. Retrying in ${Math.round(backoffMs / 1000)}s (${attemptsLeft} attempt(s) left)`,
        run.runId,
        context.lastCallStream,
      ),
    });
    recordFailure(context.db, run.runId, outcome.reason);
    process.stderr.write(
      `[relay] call failed: ${outcome.reason} — retrying in ${Math.round(backoffMs / 1000)}s\n`,
    );
    await new Promise((resolveSleep) => setTimeout(resolveSleep, backoffMs));
    // The log is the state: a fresh pass re-derives the step, including the
    // interrupted-prompt path that re-sends with the reconcile preface.
    const reloaded = getRun(context.db, run.runId);
    if (reloaded === null) return;
    Object.assign(run, reloaded);
  }
}

/** One pass of the loop. `settled` means the run reached a state a retry cannot improve. */
async function runLoopOnce(
  context: RelayContext,
  run: RelayRun,
): Promise<{ settled: true } | { settled: false; reason: string }> {
  run.status = 'ACTIVE';
  updateRun(context.db, run);
  try {
    for (;;) {
      if (context.stopRequested()) {
        pause(context, run, 'STOPPED', 'Stopped by operator between calls.');
        return { settled: true };
      }
      // Durable operator intent — the signal-free pause. Honoured here, between calls,
      // which is the only boundary a poll can never reliably land on from outside.
      if (readPauseIntent(context.db, run.runId) === 'NEXT_BOUNDARY') {
        writePauseIntent(context.db, run.runId, null);
        pause(context, run, 'STOPPED', 'Operator pause honoured at the call boundary.');
        return { settled: true };
      }
      // The opening prompt for a NEW batch is issued here rather than inside step() so an
      // advance and its first prompt are two separate log entries around one call. This is
      // also the seam where a review-only batch branches to the reviewer instead.
      const last = lastEvent(context.db, run.runId);
      if (last !== null && last.batch < run.batch) {
        await openBatch(context, run, true);
        continue;
      }
      const keepGoing = await step(context, run);
      if (!keepGoing) return { settled: true };
    }
  } catch (error) {
    // A failed or killed call is recorded and handed back to the retry loop; resume
    // re-derives everything from the log, including the interrupted-prompt case.
    return { settled: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function buildContext(
  db: RelayDb,
  projectDir: string,
  activeRunId: string | null = null,
): RelayContext {
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
  // Every way this worker can die, except SIGKILL, leaves a reason behind. Several live
  // deaths left a run STOPPED with no event, no log line and nothing to read: the only way
  // to notice was a person watching for silence, and the only way to diagnose was guessing.
  // The signal handlers record BEFORE the graceful stop because a signal may be followed by
  // a hard kill that never reaches the loop's next boundary.
  const onSignal = (signal: NodeJS.Signals): void => {
    recordFailure(db, activeRunId ?? '', `worker received ${signal}`);
    requestStop();
  };
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  const onFatal = (error: unknown): void => {
    const reason = `worker died: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    if (activeRunId !== null) {
      recordFailure(db, activeRunId, reason);
      const current = getRun(db, activeRunId);
      if (current !== null && current.status === 'ACTIVE') {
        current.status = 'STOPPED';
        appendEvent(db, current, {
          role: 'RELAY',
          kind: 'NOTE',
          content: failureNote(reason, activeRunId, null),
        });
        updateRun(db, current);
      }
    }
    process.stderr.write(`\n[relay] ${reason}\n`);
    process.exitCode = 1;
  };
  // A worker that exits while its run still says ACTIVE died without settling — the silent
  // stop this whole path exists to end. better-sqlite3 is synchronous, so the row can still
  // be written from an exit handler.
  const onExit = (): void => {
    if (activeRunId === null) return;
    const current = getRun(db, activeRunId);
    if (current === null || current.status !== 'ACTIVE') return;
    const reason = 'worker exited without settling the run (process death, not a decision)';
    recordFailure(db, activeRunId, reason);
    current.status = 'STOPPED';
    try {
      appendEvent(db, current, {
        role: 'RELAY',
        kind: 'NOTE',
        content: failureNote(reason, activeRunId, null),
      });
      updateRun(db, current);
    } catch {
      // The last_failure column above is the durable part; the event is a courtesy.
    }
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  process.on('exit', onExit);
  return {
    dispose: () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('uncaughtException', onFatal);
      process.removeListener('unhandledRejection', onFatal);
      process.removeListener('exit', onExit);
    },
    db,
    lastCallStream: null,
    retryAttempts: config.advanced?.retryAttempts ?? 3,
    settings: {
      freshSessionAfterInterrupts:
        config.relay?.freshSessionAfterInterrupts ??
        DEFAULT_RELAY_SETTINGS.freshSessionAfterInterrupts,
      callStream: config.relay?.callStream ?? DEFAULT_RELAY_SETTINGS.callStream,
    },
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
  readonly reviewFrom?: number;
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
         (run_id, plan_path, project_dir, total_batches, max_cycles, batch, cycle, review_from,
          status, pending, implementer_session, reviewer_session, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'ACTIVE', NULL, NULL, NULL, ?, ?)`,
    ).run(
      runId,
      planPath,
      projectDir,
      totalBatches,
      options.maxCycles ?? 3,
      options.startBatch ?? 1,
      options.reviewFrom ?? null,
      now,
      now,
    );
    process.stderr.write(
      `[relay] ${runId}: ${totalBatches} batches per the plan's own headings, cycle cap ${options.maxCycles ?? 3}` +
        `${options.reviewFrom === undefined ? '' : `, review-only from batch ${options.reviewFrom}`}\n`,
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
    const context = buildContext(db, projectDir, runId);
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
    const context = buildContext(db, run.projectDir, runId);

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
        // Only act when the reviewer's unclear REPLY is the last word. If the last event
        // is an unanswered PROMPT, the previous re-send crashed mid-call — runLoop's
        // interrupted-prompt path re-sends it with the reconcile preface instead of
        // stacking a second re-send on top.
        const last = lastEvent(db, runId);
        if (last !== null && last.kind === 'RESPONSE') {
          // FIRST, re-read the stored reply itself: the parser may have learned since the
          // pause was recorded (it learned word-glue tolerance from a reviewer that ends
          // every review "VERDICT: FIXBoth reviews are complete…"), so a reply that paused
          // the run may now route AS IT STANDS — no model call at all; runLoop's step()
          // routes the recorded response. Routable means what step() means: a verdict, and
          // for the advancing ones a findings body above the floor.
          const verdict = parseVerdict(last.content);
          const routable =
            verdict !== null &&
            (verdict === 'FIX' || findingsOf(last.content).length >= REVIEW_FINDINGS_FLOOR);
          // Same stale-field shape as the cycle-cap branch: the resume is the run being
          // active again, and the row must say so before any call, not after it returns.
          run.status = 'ACTIVE';
          updateRun(db, run);
          if (routable) {
            appendEvent(db, run, {
              role: 'RELAY',
              kind: 'NOTE',
              content: `The stored reviewer reply parses to VERDICT: ${verdict}; routing it as it stands — no re-ask`,
            });
          } else {
            // Nothing routable: re-send the ORIGINAL full review prompt. Never a
            // context-less "restate your conclusion" re-ask — it carried none of the prior
            // reply, and a session with no memory of the batch once answered it by
            // INVENTING a verdict (the 72-character manufactured PROCEED).
            const originalPrompt = lastEventOf(db, runId, 'REVIEWER', 'PROMPT');
            if (originalPrompt === null) {
              throw new Error(
                `Run ${runId} is paused on an unclear verdict but has no reviewer prompt to re-send`,
              );
            }
            appendEvent(db, run, {
              role: 'RELAY',
              kind: 'NOTE',
              content: 'No routable verdict in the stored reply; re-sending the full review prompt',
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
      const reason = error instanceof Error ? error.message : String(error);
      pause(context, run, 'STOPPED', failureNote(reason, runId, context.lastCallStream));
      recordFailure(db, runId, reason);
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

/** The durable stop reason, or null on a run that has never failed. */
function readLastFailure(db: RelayDb, runId: string): { reason: string; at: string } | null {
  const row = db
    .prepare('SELECT last_failure, last_failure_at FROM relay_runs WHERE run_id = ?')
    .get(runId) as { last_failure: string | null; last_failure_at: string | null } | undefined;
  if (row?.last_failure == null) return null;
  return { reason: String(row.last_failure), at: String(row.last_failure_at ?? '') };
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
        ...(run.reviewFrom === null ? {} : { reviewFrom: run.reviewFrom }),
        pauseIntent: readPauseIntent(db, runId),
        // Why a stalled run stalled, read straight off the row. Before this, a stopped run
        // that died mid-call said nothing at all and the operator had to go looking.
        lastFailure: readLastFailure(db, runId),
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
