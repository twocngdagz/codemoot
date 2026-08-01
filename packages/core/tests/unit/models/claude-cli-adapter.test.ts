import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeProcessFailure } from '../../../src/models/claude-cli-adapter.js';
import {
  ClaudeCliAdapter,
  buildClaudeEnvironment,
} from '../../../src/models/claude-cli-adapter.js';

const FAKE_CLAUDE = fileURLToPath(
  new URL('../../fixtures/claude-cli/fake-claude.mjs', import.meta.url),
);
const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_UNLISTED_SECRET = process.env.UNLISTED_SECRET;

function adapter(mode: string, projectDir = process.cwd()): ClaudeCliAdapter {
  return new ClaudeCliAdapter({
    command: process.execPath,
    args: [FAKE_CLAUDE, '--fixture-mode', mode],
    model: 'claude-sonnet-4-6',
    projectDir,
  });
}

afterEach(() => {
  process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY;
  process.env.UNLISTED_SECRET = ORIGINAL_UNLISTED_SECRET;
});

describe('ClaudeCliAdapter', () => {
  it('runs a fresh structured call and returns process-attested evidence', async () => {
    const onSpawn = vi.fn();
    const onProgress = vi.fn();
    const result = await adapter('success').send('implement the approved batch', {
      onSpawn,
      onProgress,
    });

    expect(result).toMatchObject({
      text: 'fresh:implement the approved batch',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      usage: {
        inputTokens: 115,
        outputTokens: 20,
        totalTokens: 135,
        costUsd: 0.01,
      },
      finishReason: 'stop',
      meteringSource: 'sdk',
      sessionId: '550e8400-e29b-41d4-a716-446655440010',
      invocationEvidence: {
        adapterKind: 'CLAUDE',
        cliVersion: '2.1.218',
        configuredModel: 'claude-sonnet-4-6',
        reportedModel: 'claude-sonnet-4-6',
        workingDirectory: process.cwd(),
        identityAssurance: 'PROCESS_ATTESTED',
        authenticationSource: 'subscription',
        permissionMode: 'acceptEdits',
        resultStatus: 'SUCCEEDED',
      },
      sessionEvidence: {
        providerOrAdapter: 'claude',
        vendorSessionId: '550e8400-e29b-41d4-a716-446655440010',
      },
    });
    expect(result.invocationEvidence.processId).toBeGreaterThan(0);
    expect(result.invocationEvidence.executablePath).toBe(realpathSync(process.execPath));
    expect(result.invocationEvidence.executableHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.invocationEvidence.processInstanceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(result.invocationEvidence.startedAt)).not.toBeNaN();
    expect(Date.parse(result.invocationEvidence.finishedAt)).not.toBeNaN();
    expect(onSpawn).toHaveBeenCalledWith(expect.any(Number), process.execPath);
    expect(onProgress).toHaveBeenCalled();
  });

  it('resumes the exact vendor session without placing the prompt in arguments', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    const result = await adapter('success').resume(sessionId, 'review the correction');

    expect(result.text).toBe('resumed:review the correction');
    expect(result.sessionId).toBe(sessionId);
    expect(result.sessionEvidence).toEqual({
      providerOrAdapter: 'claude',
      vendorSessionId: sessionId,
      resumedFromSessionId: sessionId,
    });
  });

  it('does not claim continuity when the CLI forks the resumed session', async () => {
    const requested = '550e8400-e29b-41d4-a716-446655440099';
    const result = await adapter('fork-session').resume(requested, 'review the correction');

    // The CLI answered with a different session_id: continuity is unproven, so the
    // evidence must NOT carry resumedFromSessionId.
    expect(result.sessionId).toBe('550e8400-e29b-41d4-a716-446655440777');
    expect(result.sessionEvidence).toEqual({
      providerOrAdapter: 'claude',
      vendorSessionId: '550e8400-e29b-41d4-a716-446655440777',
    });
  });

  it('runs in and records the configured working directory', async () => {
    const workingDirectory = realpathSync(
      fileURLToPath(new URL('../../fixtures/claude-cli/', import.meta.url)),
    );
    const result = await adapter('success', workingDirectory).send('inspect cwd');

    expect(result.invocationEvidence.workingDirectory).toBe(workingDirectory);
  });

  it('passes only the Claude allowlist plus explicit additions', async () => {
    process.env.ANTHROPIC_API_KEY = 'secret-api-key';
    process.env.UNLISTED_SECRET = 'must-not-leak';

    const result = await adapter('environment').send('inspect environment');
    const observed: unknown = JSON.parse(result.text);

    expect(observed).toEqual({
      anthropicApiKeyPresent: true,
      unlistedSecretPresent: false,
      autoUpdaterDisabled: true,
      updatesDisabled: true,
    });
  });

  it('rejects malformed and structured-error output', async () => {
    await expect(adapter('malformed').send('prompt')).rejects.toThrow(
      'Invalid Claude CLI output: Malformed Claude CLI JSONL',
    );
    await expect(adapter('error').send('prompt')).rejects.toThrow(
      'Claude CLI reported unsuccessful result error_during_execution',
    );
  });

  it('rejects unsupported Claude CLI versions', async () => {
    await expect(adapter('unsupported-version').send('prompt')).rejects.toThrow(
      'Unsupported Claude CLI version 3.0.0',
    );
  });

  it('applies the final-output limit independently of JSONL protocol overhead', async () => {
    const result = await adapter('large-output').send('prompt', { maxOutputBytes: 32 });

    expect(result.text).toBe(`${'x'.repeat(32)}\n[TRUNCATED: output exceeded configured limit]`);
  });

  it('accepts a boundary-sized response duplicated by the stream protocol', async () => {
    const result = await adapter('boundary-output').send('prompt');

    expect(Buffer.byteLength(result.text)).toBe(512 * 1_024);
  });

  it('kills and rejects an invocation at its absolute timeout', async () => {
    const call = adapter('hang').send('prompt', {
      timeout: 500,
      idleTimeout: 5_000,
    });

    await expect(call).rejects.toMatchObject({
      name: 'ModelError',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      message: expect.stringContaining('absolute timeout'),
    });
  });

  it('kills and rejects an invocation at its idle timeout', async () => {
    const call = adapter('hang').send('prompt', {
      timeout: 5_000,
      idleTimeout: 250,
    });

    await expect(call).rejects.toThrow('idle timeout');
  });

  it('supports AbortSignal cancellation after spawn', async () => {
    const controller = new AbortController();
    const call = adapter('hang').send('prompt', {
      timeout: 5_000,
      signal: controller.signal,
      onSpawn: () => controller.abort(),
    });

    await expect(call).rejects.toThrow('Claude CLI invocation cancelled');
  });

  it('rejects cancellation before spawning a subprocess', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter('success').send('prompt', { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'ModelError',
      message: 'Claude CLI invocation cancelled before spawn',
    });
  });
});

describe('buildClaudeEnvironment', () => {
  it('does not copy arbitrary host secrets', () => {
    process.env.ANTHROPIC_API_KEY = 'allowed';
    process.env.UNLISTED_SECRET = 'blocked';

    const environment = buildClaudeEnvironment();

    expect(environment.ANTHROPIC_API_KEY).toBe('allowed');
    expect(environment.UNLISTED_SECRET).toBeUndefined();
    expect(environment.DISABLE_AUTOUPDATER).toBe('1');
    expect(environment.DISABLE_UPDATES).toBe('1');
  });

  it('copies an explicitly allowed integration variable', () => {
    process.env.UNLISTED_SECRET = 'explicit';

    expect(buildClaudeEnvironment(['UNLISTED_SECRET']).UNLISTED_SECRET).toBe('explicit');
  });

  it('honours a configured idle timeout instead of the hardcoded default', async () => {
    // Deep reasoning can go minutes without emitting: the ceiling must come from config.
    const configured = new ClaudeCliAdapter({
      command: process.execPath,
      args: [FAKE_CLAUDE, '--fixture-mode', 'hang'],
      model: 'claude-sonnet-4-6',
      projectDir: process.cwd(),
      idleTimeout: 300,
    });
    const startedAt = Date.now();
    await expect(configured.send('prompt', { timeout: 30_000 })).rejects.toThrow(
      /idle timeout \(no output for 300ms/,
    );
    // It used the configured 300ms, not the 120s default.
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  });

  it('preserves partial output when an invocation is killed', async () => {
    // The fixture emits its init line, then hangs — exactly the shape of a real deep-think
    // kill. The audit must still be able to show what the agent produced.
    const call = adapter('hang-after-init').send('prompt', {
      timeout: 30_000,
      idleTimeout: 300,
    });
    await expect(call).rejects.toMatchObject({
      partialOutput: { stdout: expect.stringContaining('"type":"system"') },
    });
  });

  it('diagnoses failures from stdout when stderr is empty', () => {
    // Real runs died with the literal message "exited with code 1: " — nothing after the
    // colon — while stdout carried the actual reason. Two hours of debugging.
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}',
    ].join('\n');
    expect(describeProcessFailure('', stdout)).toContain('Not logged in');
    // stderr still wins when it says something.
    expect(describeProcessFailure('real stderr problem', stdout)).toBe('real stderr problem');
    // Non-JSON stdout still surfaces a tail rather than nothing.
    expect(describeProcessFailure('', 'plain failure text')).toContain('plain failure text');
    expect(describeProcessFailure('', '')).toContain('no stderr or stdout output');
  });

  it("passes the CLI's own tuning knobs through so its advice is actionable", () => {
    // A 43-minute invocation failed with "set the CLAUDE_CODE_MAX_OUTPUT_TOKENS
    // environment variable" — while the allowlist stripped that exact variable.
    const previous = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '128000';
    try {
      expect(buildClaudeEnvironment().CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('128000');
    } finally {
      process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = previous;
    }
  });

  it('passes USER through to the CLI so Keychain credentials are readable', () => {
    // Root cause of two failed runs: without USER the CLI cannot read macOS Keychain
    // credentials and exits 1 with "Not logged in".
    const env = buildClaudeEnvironment();
    expect(env.USER).toBe(process.env.USER);
  });
});
