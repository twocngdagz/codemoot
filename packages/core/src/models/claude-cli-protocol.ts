import { z } from 'zod';
import type { TokenUsage } from '../types/events.js';

export const SUPPORTED_CLAUDE_CLI_VERSION_RANGE = '>=2.1.0 <3.0.0';

const claudeUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().default(0),
    cache_creation_input_tokens: z.number().int().nonnegative().default(0),
    cache_read_input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative().default(0),
  })
  .passthrough();

const claudeInitMessageSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    session_id: z.string().min(1),
    apiKeySource: z.string().nullable().optional(),
    claude_code_version: z.string().min(1),
    cwd: z.string().min(1),
    model: z.string().min(1),
    permissionMode: z.string().min(1),
  })
  .passthrough();

const claudeResultMessageSchema = z
  .object({
    type: z.literal('result'),
    subtype: z.string().min(1),
    is_error: z.boolean(),
    result: z.string().optional(),
    session_id: z.string().min(1),
    duration_ms: z.number().nonnegative(),
    total_cost_usd: z.number().nonnegative(),
    usage: claudeUsageSchema.optional(),
  })
  .passthrough();

const claudeStreamMessageSchema = z.object({ type: z.string().min(1) }).passthrough();

export interface ParsedClaudeCliOutput {
  readonly text: string;
  readonly sessionId: string;
  readonly durationMs: number;
  readonly cliVersion: string;
  readonly workingDirectory: string;
  readonly reportedModel: string;
  readonly permissionMode: string;
  readonly authenticationSource?: string;
  readonly usage?: TokenUsage;
}

export class ClaudeCliProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCliProtocolError';
  }
}

export function parseClaudeCliStream(stdout: string): ParsedClaudeCliOutput {
  let init: z.infer<typeof claudeInitMessageSchema> | undefined;
  let result: z.infer<typeof claudeResultMessageSchema> | undefined;

  for (const [index, line] of stdout.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new ClaudeCliProtocolError(`Malformed Claude CLI JSONL at line ${index + 1}`);
    }

    const message = claudeStreamMessageSchema.safeParse(value);
    if (!message.success) {
      throw new ClaudeCliProtocolError(
        `Invalid Claude CLI message at line ${index + 1}: ${formatIssues(message.error)}`,
      );
    }

    if (message.data.type === 'system' && message.data.subtype === 'init') {
      if (init !== undefined) {
        throw new ClaudeCliProtocolError('Claude CLI emitted more than one system/init message');
      }
      const parsedInit = claudeInitMessageSchema.safeParse(value);
      if (!parsedInit.success) {
        throw new ClaudeCliProtocolError(
          `Invalid Claude CLI system/init message: ${formatIssues(parsedInit.error)}`,
        );
      }
      init = parsedInit.data;
    }

    if (message.data.type === 'result') {
      if (result !== undefined) {
        throw new ClaudeCliProtocolError('Claude CLI emitted more than one result message');
      }
      const parsedResult = claudeResultMessageSchema.safeParse(value);
      if (!parsedResult.success) {
        throw new ClaudeCliProtocolError(
          `Invalid Claude CLI result message: ${formatIssues(parsedResult.error)}`,
        );
      }
      result = parsedResult.data;
    }
  }

  if (init === undefined) {
    throw new ClaudeCliProtocolError('Claude CLI output is missing its system/init message');
  }
  if (result === undefined) {
    throw new ClaudeCliProtocolError('Claude CLI output is missing its final result message');
  }
  if (!isSupportedClaudeCliVersion(init.claude_code_version)) {
    throw new ClaudeCliProtocolError(
      `Unsupported Claude CLI version ${init.claude_code_version}; expected ${SUPPORTED_CLAUDE_CLI_VERSION_RANGE}`,
    );
  }
  if (init.session_id !== result.session_id) {
    throw new ClaudeCliProtocolError('Claude CLI init and result session IDs do not match');
  }
  if (result.subtype !== 'success' || result.is_error || result.result === undefined) {
    throw new ClaudeCliProtocolError(`Claude CLI reported unsuccessful result ${result.subtype}`);
  }

  const usage = result.usage === undefined ? undefined : toTokenUsage(result.usage, result);
  return {
    text: result.result,
    sessionId: result.session_id,
    durationMs: result.duration_ms,
    cliVersion: init.claude_code_version,
    workingDirectory: init.cwd,
    reportedModel: init.model,
    permissionMode: init.permissionMode,
    ...(init.apiKeySource === undefined || init.apiKeySource === null
      ? {}
      : { authenticationSource: init.apiKeySource }),
    ...(usage === undefined ? {} : { usage }),
  };
}

export function isSupportedClaudeCliVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4];
  return major === 2 && minor >= 1 && !(minor === 1 && patch === 0 && prerelease !== undefined);
}

function toTokenUsage(
  usage: z.infer<typeof claudeUsageSchema>,
  result: z.infer<typeof claudeResultMessageSchema>,
): TokenUsage {
  const inputTokens =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  const outputTokens = usage.output_tokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: result.total_cost_usd,
  };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
