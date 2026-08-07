// The Cursor CLI adapter — a third route alongside claude and codex.
//
// Why a third adapter rather than a variant of one: `cursor-agent` is a ROUTER. One CLI
// serves Anthropic, OpenAI, xAI and Moonshot models, so it reaches models neither existing
// adapter can (Grok, Kimi, Composer, the GPT/Sol family) and it runs on its own
// subscription — which is what let a live project keep reviewing after its ChatGPT budget
// was exhausted mid-run with three batches unverified.
//
// It shares the Claude adapter's process runner deliberately (see runStreamingCliProcess):
// the timer discipline, group-kill and partial-output preservation there were each earned
// by a live failure, and duplicating them would guarantee the next fix reaches only one.
// What it does NOT share is the protocol — see cursor-cli-protocol.ts for the three field
// divergences that make Claude's parser reject every valid Cursor response.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { ModelCallResult } from '../types/models.js';
import { ModelError } from '../utils/errors.js';
import type {
  BridgeCapabilities,
  BridgeInvocationEvidence,
  BridgeOptions,
  BridgeSessionEvidence,
  CliBridge,
} from './bridge.js';
import { runStreamingCliProcess } from './claude-cli-adapter.js';
import { MAX_OUTPUT_BYTES, buildFilteredEnv, estimateTokenUsage } from './cli-adapter.js';
import { collectCliRuntimeEvidence } from './cli-runtime-evidence.js';
import {
  CursorCliProtocolError,
  CursorContentRefusalError,
  findContentRefusal,
  parseCursorCliStream,
} from './cursor-cli-protocol.js';
import type { ParsedCursorCliOutput } from './cursor-cli-protocol.js';

const RAW_OUTPUT_MULTIPLIER = 4;
const MIN_RAW_CAPTURE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Ten minutes of permitted silence, deliberately NOT Claude's two.
 *
 * Silence means different things per model family, and this is not cosmetic. Claude with
 * `--include-partial-messages` speaks roughly every five seconds, so silence really does
 * mean death. GPT/Sol models work in total silence and speak only when finished — measured
 * on real reviews at 52 seconds and at 15 minutes, both perfectly healthy. Cursor has no
 * partial-output equivalent that changes this, so a Claude-shaped default would kill
 * healthy long reviews. Operators running GPT-family models should raise `idleTimeout` to
 * the workflow ceiling; this default only avoids the worst surprise out of the box.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * `--force` (or its alias `--yolo`, or `--trust`) is MANDATORY for headless use, and its
 * absence is a silent failure rather than a loud one: verified live, a run without it
 * writes a workspace-trust prompt to STDERR, emits ZERO stdout, and then waits for input
 * that never arrives. Under a relay that is not a fast error — it is an idle-timeout kill
 * after the full silence budget, which for a GPT reviewer may be hours. Hence a
 * configuration-time rejection rather than a runtime discovery.
 */
export const CURSOR_TRUST_FLAGS = ['--force', '--yolo', '--trust'] as const;

export function hasCursorTrustFlag(args: readonly string[]): boolean {
  return args.some((argument) => CURSOR_TRUST_FLAGS.includes(argument as never));
}

const CURSOR_ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  // USER is load-bearing on macOS: without it a CLI cannot read Keychain credentials and
  // fails with an unexplained exit 1 — two hours were lost to exactly that on the Claude
  // adapter before it was allowlisted there.
  'USER',
  'LOGNAME',
  'CURSOR_API_KEY',
  'CURSOR_API_ENDPOINT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

const CURSOR_CAPABILITIES: BridgeCapabilities = {
  supportsResume: true,
  supportsStream: true,
  maxContextTokens: DEFAULT_CONTEXT_WINDOW,
  supportsTools: true,
  supportsCwd: true,
};

export interface CursorCallOptions extends BridgeOptions {
  envAllowlist?: readonly string[];
}

export interface CursorCallResult extends ModelCallResult {
  readonly sessionId: string;
  readonly invocationEvidence: BridgeInvocationEvidence;
  readonly sessionEvidence: BridgeSessionEvidence;
  readonly rawOutput?: string;
}

export function defaultCursorCommand(): string {
  return process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent';
}

export function buildCursorEnvironment(
  additionalAllowlist: readonly string[] = [],
): Record<string, string> {
  return buildFilteredEnv([...CURSOR_ENV_ALLOWLIST, ...additionalAllowlist]);
}

export class CursorCliAdapter implements CliBridge {
  readonly name = 'cursor';
  readonly capabilities = CURSOR_CAPABILITIES;
  readonly model: string;

  private readonly command: string;
  private readonly baseArgs: readonly string[];
  private readonly projectDir: string;
  private readonly defaultTimeout: number;
  private readonly defaultIdleTimeout: number;
  private readonly envAllowlist: readonly string[];

  constructor(config: {
    command?: string;
    args?: readonly string[];
    model: string;
    projectDir?: string;
    timeout?: number;
    idleTimeout?: number;
    envAllowlist?: readonly string[];
  }) {
    this.command = config.command ?? defaultCursorCommand();
    this.baseArgs = config.args ?? [];
    this.model = config.model;
    this.projectDir = resolve(config.projectDir ?? process.cwd());
    this.defaultTimeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.defaultIdleTimeout = config.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.envAllowlist = config.envAllowlist ?? [];
  }

  async send(prompt: string, options?: CursorCallOptions): Promise<CursorCallResult> {
    return this.execute(prompt, undefined, options);
  }

  async resume(
    sessionId: string,
    prompt: string,
    options?: CursorCallOptions,
  ): Promise<CursorCallResult> {
    if (sessionId.length === 0) {
      throw new ModelError('Cursor CLI resume requires a chat ID', 'cursor', this.model);
    }
    return this.execute(prompt, sessionId, options);
  }

  async call(prompt: string, options?: CursorCallOptions): Promise<CursorCallResult> {
    return this.send(prompt, options);
  }

  private async execute(
    prompt: string,
    resumeSessionId: string | undefined,
    options: CursorCallOptions | undefined,
  ): Promise<CursorCallResult> {
    if (!hasCursorTrustFlag(this.baseArgs)) {
      throw new ModelError(
        `Cursor CLI requires one of ${CURSOR_TRUST_FLAGS.join(', ')} in cliAdapter.args for headless use; without it the CLI emits no output and waits on a workspace-trust prompt`,
        'cursor',
        this.model,
      );
    }
    const env = {
      ...buildCursorEnvironment([...this.envAllowlist, ...(options?.envAllowlist ?? [])]),
      ...options?.env,
    };
    const executable = await collectCliRuntimeEvidence(this.command, this.projectDir, env);
    const args = this.buildArgs(prompt, resumeSessionId);
    const maxOutputBytes = options?.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    let processResult: Awaited<ReturnType<typeof runStreamingCliProcess>>;
    try {
      processResult = await runStreamingCliProcess({
        label: 'Cursor CLI',
        // The prompt travels as a positional argument (`agent [options] [prompt...]`), so
        // stdin is closed empty — a CLI that does not read stdin would otherwise block.
        promptViaStdin: false,
        command: executable.executablePath,
        args,
        cwd: this.projectDir,
        env,
        prompt,
        provider: 'cursor',
        model: this.model,
        timeout: options?.timeout ?? this.defaultTimeout,
        idleTimeout: options?.idleTimeout ?? this.defaultIdleTimeout,
        maxCaptureBytes: Math.max(
          MIN_RAW_CAPTURE_BYTES,
          MAX_OUTPUT_BYTES * RAW_OUTPUT_MULTIPLIER,
          maxOutputBytes * RAW_OUTPUT_MULTIPLIER,
        ),
        options,
      });
    } catch (error) {
      // A refusal usually exits NON-ZERO, so the only place its evidence survives is the
      // runner's error — message and preserved partial output. Re-typing it here keeps the
      // refusal distinguishable from a genuine crash on every path, not just the clean one.
      const haystack = [
        error instanceof Error ? error.message : String(error),
        (error as { partialOutput?: { stdout?: string; stderr?: string } }).partialOutput?.stdout ??
          '',
        (error as { partialOutput?: { stdout?: string; stderr?: string } }).partialOutput?.stderr ??
          '',
      ].join('\n');
      const refusal = findContentRefusal(haystack);
      if (refusal !== null) throw new CursorContentRefusalError(refusal);
      throw error;
    }

    let parsed: ParsedCursorCliOutput;
    try {
      parsed = parseCursorCliStream(processResult.stdout);
    } catch (error) {
      if (error instanceof CursorContentRefusalError) throw error;
      if (error instanceof CursorCliProtocolError) {
        const modelError = new ModelError(
          `Invalid Cursor CLI output: ${error.message}`,
          'cursor',
          this.model,
        );
        modelError.partialOutput = { stdout: processResult.stdout, stderr: '' };
        throw modelError;
      }
      throw error;
    }

    const output = truncateUtf8(parsed.text, maxOutputBytes);
    const usage = parsed.usage ?? estimateTokenUsage(prompt, output);
    const processInstanceFingerprint = createHash('sha256')
      .update(
        `${executable.executablePath}\0${processResult.processId}\0${processResult.startedAt}\0${parsed.sessionId}`,
      )
      .digest('hex');

    return {
      text: output,
      model: this.model,
      provider: 'cursor',
      usage,
      finishReason: 'stop',
      durationMs: parsed.durationMs,
      sessionId: parsed.sessionId,
      rawOutput: processResult.stdout,
      // Cursor reports real token counts but NO per-call cost (subscription billing), so
      // the honest label is 'estimated' either way — 'billed' would imply a cost figure
      // that does not exist.
      meteringSource: 'estimated',
      invocationEvidence: {
        adapterKind: 'CURSOR',
        executablePath: executable.executablePath,
        ...(executable.executableHash === undefined
          ? {}
          : { executableHash: executable.executableHash }),
        cliVersion: executable.cliVersion,
        configuredModel: this.model,
        // Cursor's reported model is a DISPLAY name for the routed model ("GPT-5.6 Sol
        // 272K Low"), never the configured id — so it is recorded as evidence and never
        // compared for equality the way the Claude adapter compares its echo.
        ...(parsed.reportedModel === undefined ? {} : { reportedModel: parsed.reportedModel }),
        workingDirectory: parsed.workingDirectory ?? this.projectDir,
        processId: processResult.processId,
        processInstanceFingerprint,
        identityAssurance: 'PROCESS_ATTESTED',
        startedAt: processResult.startedAt,
        finishedAt: processResult.finishedAt,
        resultStatus: 'SUCCEEDED',
      },
      sessionEvidence: {
        providerOrAdapter: 'cursor',
        vendorSessionId: parsed.sessionId,
        // Continuity is claimed only when the CLI proves it by echoing the resumed chat.
        ...(resumeSessionId !== undefined && parsed.sessionId === resumeSessionId
          ? { resumedFromSessionId: resumeSessionId }
          : {}),
      },
    };
  }

  private buildArgs(prompt: string, resumeSessionId: string | undefined): string[] {
    // Model ids carry their own effort level (gpt-5.6-sol-medium, ...-high, ...-max, each
    // with a -fast variant). There is no separate effort flag and none is synthesised: the
    // configured id is passed through verbatim.
    return [
      ...this.baseArgs,
      '--model',
      this.model,
      ...(resumeSessionId === undefined ? [] : ['--resume', resumeSessionId]),
      prompt,
    ];
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n[output truncated]`;
}

export { CursorCliProtocolError, CursorContentRefusalError, findContentRefusal };
