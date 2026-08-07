// Parsing `cursor-agent --print --output-format stream-json`.
//
// The envelope is Claude-SHAPED — system/init → assistant → result, session_id on every
// line — but it is NOT Claude-compatible, so this is its own module rather than a reuse of
// claude-cli-protocol. Three concrete divergences, each of which would make the Claude
// parser reject every valid Cursor response:
//
//   * init carries no `claude_code_version` (Claude requires it, and range-checks it)
//   * result carries no `total_cost_usd` (Claude requires it, and reads cost from it)
//   * usage keys are camelCase — inputTokens / outputTokens / cacheReadTokens /
//     cacheWriteTokens — against Claude's snake_case set
//
// Cursor is a ROUTER: one CLI serving Anthropic, OpenAI, xAI and Moonshot models. The
// reported model string is therefore a display name ("GPT-5.6 Sol 272K Low"), not the
// configured id, and no vendor is inferred from it anywhere in this file.

import { z } from 'zod';
import type { TokenUsage } from '../types/events.js';

const cursorUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    cacheReadTokens: z.number().int().nonnegative().default(0),
    cacheWriteTokens: z.number().int().nonnegative().default(0),
  })
  .passthrough();

const cursorInitMessageSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    session_id: z.string().min(1),
    // Everything below is advisory: Cursor's init has evolved between released versions
    // (the CLI is versioned by date), so only the session identity is required. A parser
    // that hard-requires cosmetic metadata breaks on the next release for no safety gain.
    apiKeySource: z.string().nullable().optional(),
    cwd: z.string().optional(),
    model: z.string().optional(),
    permissionMode: z.string().optional(),
  })
  .passthrough();

const cursorResultMessageSchema = z
  .object({
    type: z.literal('result'),
    subtype: z.string().min(1),
    is_error: z.boolean(),
    result: z.string().optional(),
    session_id: z.string().min(1),
    duration_ms: z.number().nonnegative().optional(),
    usage: cursorUsageSchema.optional(),
  })
  .passthrough();

const cursorStreamMessageSchema = z.object({ type: z.string().min(1) }).passthrough();

export interface ParsedCursorCliOutput {
  readonly text: string;
  readonly sessionId: string;
  readonly durationMs: number;
  readonly workingDirectory?: string;
  /** Cursor's DISPLAY name for the routed model, e.g. "GPT-5.6 Sol 272K Low". */
  readonly reportedModel?: string;
  readonly permissionMode?: string;
  readonly authenticationSource?: string;
  readonly usage?: TokenUsage;
}

export class CursorCliProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorCliProtocolError';
  }
}

/**
 * A provider-side content refusal, not a crash.
 *
 * Any Cursor run on a GPT-family model is subject to OpenAI's cybersecurity filter, which
 * terminates the run mid-flight and returns no verdict. Observed twice on a real review:
 * once on test fixtures containing fake token strings, once on a prompt asking whether a
 * security guard "could be defeated" — i.e. on exactly the work a security reviewer is
 * supposed to do. It must be distinguishable from a crash so an operator re-frames the
 * prompt or switches model, rather than hunting a bug that does not exist.
 */
export class CursorContentRefusalError extends Error {
  constructor(readonly detail: string) {
    super(`Cursor refused the request on content grounds: ${detail}`);
    this.name = 'CursorContentRefusalError';
  }
}

const CONTENT_REFUSAL_PATTERN =
  /ActionRequiredError|flagged this request for potential high-risk cybersecurity activity/i;

/** Detects the provider-side refusal in whatever stream the CLI managed to emit. */
export function findContentRefusal(text: string): string | null {
  if (!CONTENT_REFUSAL_PATTERN.test(text)) return null;
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => CONTENT_REFUSAL_PATTERN.test(entry));
  return (line ?? 'flagged for potential high-risk cybersecurity activity').slice(0, 500);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
    .join('; ');
}

export function parseCursorCliStream(stdout: string): ParsedCursorCliOutput {
  // Checked FIRST, before any strict JSONL parsing: the refusal arrives as a bare
  // non-JSON line, so a line-by-line parser reports it as "malformed JSONL at line N" —
  // technically true and completely useless to an operator deciding whether to re-frame a
  // prompt or switch model.
  const earlyRefusal = findContentRefusal(stdout);
  if (earlyRefusal !== null) throw new CursorContentRefusalError(earlyRefusal);

  let init: z.infer<typeof cursorInitMessageSchema> | undefined;
  const initSessionIds = new Set<string>();
  let result: z.infer<typeof cursorResultMessageSchema> | undefined;

  for (const [index, line] of stdout.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new CursorCliProtocolError(`Malformed Cursor CLI JSONL at line ${index + 1}`);
    }

    const message = cursorStreamMessageSchema.safeParse(value);
    if (!message.success) {
      throw new CursorCliProtocolError(
        `Invalid Cursor CLI message at line ${index + 1}: ${formatIssues(message.error)}`,
      );
    }

    if (message.data.type === 'system' && message.data.subtype === 'init') {
      const parsedInit = cursorInitMessageSchema.safeParse(value);
      if (!parsedInit.success) {
        throw new CursorCliProtocolError(
          `Invalid Cursor CLI system/init message: ${formatIssues(parsedInit.error)}`,
        );
      }
      // Same tolerance the Claude parser learned the expensive way: a long session may
      // announce itself more than once. First init wins for metadata; every announced
      // session is kept so the result can be matched against all of them.
      if (init === undefined) init = parsedInit.data;
      initSessionIds.add(parsedInit.data.session_id);
    }

    if (message.data.type === 'result') {
      if (result !== undefined) {
        throw new CursorCliProtocolError('Cursor CLI emitted more than one result message');
      }
      const parsedResult = cursorResultMessageSchema.safeParse(value);
      if (!parsedResult.success) {
        throw new CursorCliProtocolError(
          `Invalid Cursor CLI result message: ${formatIssues(parsedResult.error)}`,
        );
      }
      result = parsedResult.data;
    }
  }

  if (init === undefined) {
    // The dominant cause, verified live: without --force/--trust the CLI writes a workspace
    // trust prompt to stderr, emits ZERO stdout, and waits for input that will never come.
    throw new CursorCliProtocolError(
      'Cursor CLI output is missing its system/init message (a run without --force or --trust emits nothing and waits for a trust prompt)',
    );
  }
  if (result === undefined) {
    throw new CursorCliProtocolError('Cursor CLI output is missing its final result message');
  }
  if (!initSessionIds.has(result.session_id)) {
    throw new CursorCliProtocolError(
      'Cursor CLI result session ID matches none of the announced init sessions',
    );
  }
  if (result.subtype !== 'success' || result.is_error || result.result === undefined) {
    throw new CursorCliProtocolError(`Cursor CLI reported unsuccessful result ${result.subtype}`);
  }

  return {
    text: result.result,
    sessionId: result.session_id,
    durationMs: result.duration_ms ?? 0,
    ...(init.cwd === undefined ? {} : { workingDirectory: init.cwd }),
    ...(init.model === undefined ? {} : { reportedModel: init.model }),
    ...(init.permissionMode === undefined ? {} : { permissionMode: init.permissionMode }),
    ...(init.apiKeySource === undefined || init.apiKeySource === null
      ? {}
      : { authenticationSource: init.apiKeySource }),
    ...(result.usage === undefined ? {} : { usage: toTokenUsage(result.usage) }),
  };
}

function toTokenUsage(usage: z.infer<typeof cursorUsageSchema>): TokenUsage {
  // Cache reads count as input, matching the Claude adapter's accounting so the two are
  // comparable in one ledger. costUsd is 0: Cursor bills by subscription and reports no
  // per-call cost — an invented figure would be worse than an honest zero.
  const inputTokens = usage.inputTokens + usage.cacheReadTokens;
  const outputTokens = usage.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: 0,
  };
}
