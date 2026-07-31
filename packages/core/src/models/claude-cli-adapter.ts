import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { TokenUsage } from '../types/events.js';
import type { ModelCallResult } from '../types/models.js';
import { ModelError } from '../utils/errors.js';
import type {
  BridgeCapabilities,
  BridgeInvocationEvidence,
  BridgeOptions,
  BridgeSessionEvidence,
  CliBridge,
} from './bridge.js';
import { ClaudeCliProtocolError, parseClaudeCliStream } from './claude-cli-protocol.js';
import type { ParsedClaudeCliOutput } from './claude-cli-protocol.js';
import {
  MAX_OUTPUT_BYTES,
  buildFilteredEnv,
  estimateTokenUsage,
  killProcessTree,
} from './cli-adapter.js';
import { collectCliRuntimeEvidence } from './cli-runtime-evidence.js';

const RAW_OUTPUT_MULTIPLIER = 4;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const TRUNCATION_MARKER = '\n[TRUNCATED: output exceeded configured limit]';

const CLAUDE_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'SystemRoot',
  'COMSPEC',
  'SHELL',
  'LANG',
  'LC_ALL',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'CLAUDE_CODE_CERT_STORE',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

const CLAUDE_CAPABILITIES: BridgeCapabilities = {
  supportsResume: true,
  supportsStream: true,
  maxContextTokens: DEFAULT_CONTEXT_WINDOW,
  supportsTools: true,
  supportsCwd: true,
};

interface ProcessResult {
  readonly stdout: string;
  readonly processId: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export interface ClaudeCallOptions extends BridgeOptions {
  readonly envAllowlist?: readonly string[];
}

export interface ClaudeInvocationEvidence extends BridgeInvocationEvidence {
  readonly adapterKind: 'CLAUDE';
  readonly permissionMode: string;
}

export interface ClaudeSessionEvidence extends BridgeSessionEvidence {
  readonly providerOrAdapter: 'claude';
}

export interface ClaudeCallResult extends ModelCallResult {
  readonly invocationEvidence: ClaudeInvocationEvidence;
  readonly sessionEvidence: ClaudeSessionEvidence;
}

export class ClaudeCliAdapter implements CliBridge {
  readonly name = 'claude';
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly model: string;

  private readonly command: string;
  private readonly baseArgs: readonly string[];
  private readonly projectDir: string;
  private readonly defaultTimeout: number;
  private readonly envAllowlist: readonly string[];

  constructor(config: {
    command?: string;
    args?: readonly string[];
    model: string;
    projectDir?: string;
    timeout?: number;
    envAllowlist?: readonly string[];
  }) {
    this.command = config.command ?? defaultClaudeCommand();
    this.baseArgs = config.args ?? [];
    this.model = config.model;
    this.projectDir = resolve(config.projectDir ?? process.cwd());
    this.defaultTimeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.envAllowlist = config.envAllowlist ?? [];
  }

  async send(prompt: string, options?: ClaudeCallOptions): Promise<ClaudeCallResult> {
    return this.execute(prompt, undefined, options);
  }

  async resume(
    sessionId: string,
    prompt: string,
    options?: ClaudeCallOptions,
  ): Promise<ClaudeCallResult> {
    if (sessionId.length === 0) {
      throw new ModelError('Claude CLI resume requires a session ID', 'anthropic', this.model);
    }
    return this.execute(prompt, sessionId, options);
  }

  async call(prompt: string, options?: ClaudeCallOptions): Promise<ClaudeCallResult> {
    return this.send(prompt, options);
  }

  private async execute(
    prompt: string,
    resumeSessionId: string | undefined,
    options: ClaudeCallOptions | undefined,
  ): Promise<ClaudeCallResult> {
    const env = {
      ...buildClaudeEnvironment([...this.envAllowlist, ...(options?.envAllowlist ?? [])]),
      ...options?.env,
    };
    const executable = await collectCliRuntimeEvidence(this.command, this.projectDir, env);
    const args = this.buildArgs(resumeSessionId);
    const maxOutputBytes = options?.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    const processResult = await runClaudeProcess({
      command: executable.executablePath,
      args,
      cwd: this.projectDir,
      env,
      prompt,
      provider: 'anthropic',
      model: this.model,
      timeout: options?.timeout ?? this.defaultTimeout,
      idleTimeout: options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS,
      maxCaptureBytes: Math.max(
        MAX_OUTPUT_BYTES * RAW_OUTPUT_MULTIPLIER,
        maxOutputBytes * RAW_OUTPUT_MULTIPLIER,
      ),
      options,
    });

    let parsed: ParsedClaudeCliOutput;
    try {
      parsed = parseClaudeCliStream(processResult.stdout);
    } catch (error) {
      if (error instanceof ClaudeCliProtocolError) {
        throw new ModelError(
          `Invalid Claude CLI output: ${error.message}`,
          'anthropic',
          this.model,
        );
      }
      throw error;
    }

    const output = truncateUtf8(parsed.text, maxOutputBytes);
    const usage: TokenUsage = parsed.usage ?? estimateTokenUsage(prompt, output);
    const processInstanceFingerprint = createHash('sha256')
      .update(
        `${executable.executablePath}\0${processResult.processId}\0${processResult.startedAt}\0${parsed.sessionId}`,
      )
      .digest('hex');

    return {
      text: output,
      model: this.model,
      provider: 'anthropic',
      usage,
      finishReason: 'stop',
      durationMs: processResult.durationMs,
      meteringSource: parsed.usage === undefined ? 'estimated' : 'sdk',
      sessionId: parsed.sessionId,
      rawOutput: processResult.stdout,
      invocationEvidence: {
        adapterKind: 'CLAUDE',
        executablePath: executable.executablePath,
        ...(executable.executableHash === undefined
          ? {}
          : { executableHash: executable.executableHash }),
        cliVersion: parsed.cliVersion,
        configuredModel: this.model,
        reportedModel: parsed.reportedModel,
        workingDirectory: this.projectDir,
        processId: processResult.processId,
        processInstanceFingerprint,
        identityAssurance: 'PROCESS_ATTESTED',
        ...(parsed.authenticationSource === undefined
          ? {}
          : { authenticationSource: parsed.authenticationSource }),
        permissionMode: parsed.permissionMode,
        startedAt: processResult.startedAt,
        finishedAt: processResult.finishedAt,
        resultStatus: 'SUCCEEDED',
      },
      sessionEvidence: {
        providerOrAdapter: 'claude',
        vendorSessionId: parsed.sessionId,
        // Continuity is only claimed when the CLI proves it by echoing the resumed session
        // ID. A --resume run that returns a different session_id (a fork) is NOT proven
        // continuity and must not be labelled as one.
        ...(resumeSessionId !== undefined && parsed.sessionId === resumeSessionId
          ? { resumedFromSessionId: resumeSessionId }
          : {}),
      },
    };
  }

  private buildArgs(resumeSessionId: string | undefined): string[] {
    return [
      ...this.baseArgs,
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      this.model,
      ...(resumeSessionId === undefined ? [] : ['--resume', resumeSessionId]),
    ];
  }
}

export function buildClaudeEnvironment(
  additionalAllowlist: readonly string[] = [],
): Record<string, string> {
  return {
    ...buildFilteredEnv([...CLAUDE_ENV_ALLOWLIST, ...additionalAllowlist]),
    DISABLE_AUTOUPDATER: '1',
    DISABLE_UPDATES: '1',
  };
}

async function runClaudeProcess(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  provider: string;
  model: string;
  timeout: number;
  idleTimeout: number;
  maxCaptureBytes: number;
  options?: ClaudeCallOptions;
}): Promise<ProcessResult> {
  if (input.options?.signal?.aborted) {
    throw new ModelError(
      'Claude CLI invocation cancelled before spawn',
      input.provider,
      input.model,
    );
  }

  return new Promise((resolveResult, rejectResult) => {
    const startedAtDate = new Date();
    const startedAt = startedAtDate.toISOString();
    let lastActivityAt = startedAtDate.getTime();
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let processId: number | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;

    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32',
    });

    const cleanup = (): void => {
      clearTimeout(absoluteTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      input.options?.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: ModelError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResult(error);
    };
    const elapsedDescription = (): string =>
      `elapsed ${Date.now() - startedAtDate.getTime()}ms, last activity ${Date.now() - lastActivityAt}ms ago`;
    const resetIdleTimer = (): void => {
      lastActivityAt = Date.now();
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killProcessTree(child.pid);
        fail(
          new ModelError(
            `Claude CLI idle timeout (no output for ${input.idleTimeout}ms, ${elapsedDescription()})`,
            input.provider,
            input.model,
          ),
        );
      }, input.idleTimeout);
    };
    const onAbort = (): void => {
      killProcessTree(child.pid);
      fail(new ModelError('Claude CLI invocation cancelled', input.provider, input.model));
    };

    const absoluteTimer = setTimeout(() => {
      killProcessTree(child.pid);
      fail(
        new ModelError(
          `Claude CLI absolute timeout (limit ${input.timeout}ms, ${elapsedDescription()})`,
          input.provider,
          input.model,
        ),
      );
    }, input.timeout);
    resetIdleTimer();

    if (input.options?.onHeartbeat !== undefined) {
      heartbeatTimer = setInterval(() => {
        invokeCallback(() =>
          input.options?.onHeartbeat?.(Math.round((Date.now() - startedAtDate.getTime()) / 1000)),
        );
      }, 15_000);
    }
    child.on('spawn', () => {
      if (settled) return;
      if (child.pid === undefined || child.pid <= 0) {
        killProcessTree(child.pid);
        fail(
          new ModelError(
            'Claude CLI spawned without a valid process ID',
            input.provider,
            input.model,
          ),
        );
        return;
      }
      const spawnedProcessId = child.pid;
      processId = spawnedProcessId;
      invokeCallback(() => input.options?.onSpawn?.(spawnedProcessId, input.command));
    });
    child.on('error', (error) => {
      fail(
        new ModelError(
          `Claude CLI subprocess failed: ${error.message}`,
          input.provider,
          input.model,
        ),
      );
    });
    child.stdout.on('data', (data: Buffer) => {
      if (settled) return;
      stdoutBytes += data.byteLength;
      if (stdoutBytes > input.maxCaptureBytes) {
        killProcessTree(child.pid);
        fail(
          new ModelError(
            `Claude CLI output exceeded ${input.maxCaptureBytes} captured bytes`,
            input.provider,
            input.model,
          ),
        );
        return;
      }
      const chunk = data.toString();
      stdout += chunk;
      resetIdleTimer();
      invokeCallback(() => input.options?.onProgress?.(chunk));
    });
    child.stderr.on('data', (data: Buffer) => {
      if (settled) return;
      const chunk = data.toString();
      if (stderr.length < 10_000) stderr += chunk;
      resetIdleTimer();
      invokeCallback(() => input.options?.onStderr?.(chunk));
    });
    child.on('close', (code) => {
      invokeCallback(() => input.options?.onClose?.());
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0) {
        rejectResult(
          new ModelError(
            `Claude CLI subprocess exited with code ${code}: ${stderr.slice(0, 500)}`,
            input.provider,
            input.model,
          ),
        );
        return;
      }
      if (processId === undefined) {
        rejectResult(
          new ModelError(
            'Claude CLI closed without process identity evidence',
            input.provider,
            input.model,
          ),
        );
        return;
      }
      const finishedAtDate = new Date();
      resolveResult({
        stdout,
        processId,
        startedAt,
        finishedAt: finishedAtDate.toISOString(),
        durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
      });
    });

    child.stdin.on('error', (error) => {
      fail(
        new ModelError(`Claude CLI stdin failed: ${error.message}`, input.provider, input.model),
      );
    });
    input.options?.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.options?.signal?.aborted) {
      onAbort();
      return;
    }
    child.stdin.end(input.prompt);
  });
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(encoded.subarray(0, maxBytes)) + TRUNCATION_MARKER;
}

function invokeCallback(callback: () => void): void {
  try {
    callback();
  } catch {
    // Progress callbacks cannot change subprocess lifecycle.
  }
}

function defaultClaudeCommand(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}
