// The Cursor adapter: a third route (router CLI, own subscription, models neither existing
// adapter reaches). These tests pin the facts that were VERIFIED against the real
// cursor-agent, and the three protocol divergences that make Claude's parser unusable here.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectConfigSchema } from '../../../src/config/schema.js';
import {
  CursorCliAdapter,
  CursorContentRefusalError,
} from '../../../src/models/cursor-cli-adapter.js';
import {
  CursorCliProtocolError,
  parseCursorCliStream,
} from '../../../src/models/cursor-cli-protocol.js';
import { createModelAdapter, resolveModelAdapterKind } from '../../../src/models/registry.js';
import { resolveConfiguredAdapterKind } from '../../../src/review-workflow-identity/service.js';
import type { ModelConfig } from '../../../src/types/config.js';

const FAKE = fileURLToPath(new URL('../../fixtures/fake-cursor-agent.mjs', import.meta.url));

/** The REAL envelope, captured from cursor-agent — note the three Claude divergences. */
const REAL_STREAM = [
  '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp","session_id":"f67fa24d-1111","model":"GPT-5.6 Sol 272K Low","permissionMode":"default"}',
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Say OK"}]},"session_id":"f67fa24d-1111"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]},"session_id":"f67fa24d-1111"}',
  '{"type":"result","subtype":"success","duration_ms":8938,"duration_api_ms":8938,"is_error":false,"result":"OK","session_id":"f67fa24d-1111","request_id":"c015e3d0","usage":{"inputTokens":3,"outputTokens":5,"cacheReadTokens":0,"cacheWriteTokens":51556}}',
].join('\n');

describe('parseCursorCliStream — Claude-shaped, not Claude-compatible', () => {
  it('parses the real envelope to text, session and usage', () => {
    const parsed = parseCursorCliStream(REAL_STREAM);
    expect(parsed.text).toBe('OK');
    expect(parsed.sessionId).toBe('f67fa24d-1111');
    expect(parsed.durationMs).toBe(8938);
    expect(parsed.reportedModel).toBe('GPT-5.6 Sol 272K Low');
    // camelCase usage; cache READS count as input, matching the Claude ledger.
    expect(parsed.usage).toEqual({
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
      costUsd: 0,
    });
  });

  it('needs no claude_code_version and no total_cost_usd — the two Claude requires', () => {
    // This is why the parser could not simply be reused: Claude's schema marks both
    // required, so it would reject every valid Cursor response.
    expect(REAL_STREAM).not.toContain('claude_code_version');
    expect(REAL_STREAM).not.toContain('total_cost_usd');
    expect(() => parseCursorCliStream(REAL_STREAM)).not.toThrow();
  });

  it('reports the trust-prompt failure in terms an operator can act on', () => {
    // Verified live: no --force ⇒ trust prompt on stderr, ZERO stdout, and it WAITS.
    expect(() => parseCursorCliStream('')).toThrow(/--force or --trust/);
  });

  it('surfaces the OpenAI content refusal as its own type, not a crash', () => {
    // Observed twice on a real review — once on fixtures containing fake tokens, once on
    // a prompt asking whether a guard "could be defeated", i.e. on a reviewer's actual job.
    const refused = [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      'ActionRequiredError: flagged this request for potential high-risk cybersecurity activity',
      '{"type":"result","subtype":"error","is_error":true,"session_id":"s1"}',
    ].join('\n');
    expect(() => parseCursorCliStream(refused)).toThrow(CursorContentRefusalError);
  });

  it('tolerates a repeated init and rejects a foreign result session', () => {
    const lines = REAL_STREAM.split('\n');
    expect(() => parseCursorCliStream([lines[0], ...lines].join('\n'))).not.toThrow();
    const foreign = REAL_STREAM.replace(
      '"session_id":"f67fa24d-1111","request_id"',
      '"session_id":"other","request_id"',
    );
    expect(() => parseCursorCliStream(foreign)).toThrow(CursorCliProtocolError);
  });
});

describe('CursorCliAdapter (real subprocess, fake cursor-agent)', () => {
  let projectDir: string;
  let argvLog: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'codemoot-cursor-'));
    argvLog = join(projectDir, 'argv.jsonl');
    process.env.CODEMOOT_FAKE_CURSOR_ARGV = argvLog;
  });

  afterEach(() => {
    for (const key of [
      'CODEMOOT_FAKE_CURSOR_ARGV',
      'CODEMOOT_FAKE_CURSOR_REFUSAL',
      'CODEMOOT_FAKE_CURSOR_TEXT',
    ]) {
      delete process.env[key];
    }
    rmSync(projectDir, { recursive: true, force: true });
  });

  const ALLOW = [
    'CODEMOOT_FAKE_CURSOR_ARGV',
    'CODEMOOT_FAKE_CURSOR_REFUSAL',
    'CODEMOOT_FAKE_CURSOR_TEXT',
  ];

  function adapter(args: readonly string[]): CursorCliAdapter {
    return new CursorCliAdapter({
      command: process.execPath,
      args: [FAKE, ...args],
      model: 'gpt-5.6-sol-medium',
      projectDir,
      envAllowlist: ALLOW,
    });
  }

  function lastArgv(): string[] {
    return JSON.parse(readFileSync(argvLog, 'utf8').trim().split('\n').at(-1) ?? '[]');
  }

  it('sends a prompt and returns text, usage, session and evidence', async () => {
    const result = await adapter(['-p', '--force', '--output-format', 'stream-json']).send(
      'Say OK',
    );
    expect(result.text).toBe('echo:Say OK');
    expect(result.sessionId).toBe('f67fa24d-1111-2222-3333-444455556666');
    expect(result.provider).toBe('cursor');
    expect(result.invocationEvidence.adapterKind).toBe('CURSOR');
    expect(result.invocationEvidence.identityAssurance).toBe('PROCESS_ATTESTED');
    // The routed model's DISPLAY name is recorded as evidence, never compared to the id.
    expect(result.invocationEvidence.reportedModel).toBe('GPT-5.6 Sol 272K Low');
    expect(result.invocationEvidence.configuredModel).toBe('gpt-5.6-sol-medium');
  });

  it('passes the prompt as a positional ARGUMENT and the model id verbatim', async () => {
    await adapter(['-p', '--force', '--output-format', 'stream-json']).send('Say OK');
    const argv = lastArgv();
    // Verified from `agent [options] [command] [prompt...]`: the prompt is positional, so
    // the adapter must not rely on stdin the way the Claude adapter does.
    expect(argv.at(-1)).toBe('Say OK');
    // Effort is PART of the id (gpt-5.6-sol-medium); no effort flag is synthesised.
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-5.6-sol-medium');
    expect(argv.some((a) => /--effort|--reasoning/.test(a))).toBe(false);
  });

  it('resume passes --resume <chatId> and continues the same session', async () => {
    const result = await adapter(['-p', '--force', '--output-format', 'stream-json']).resume(
      'chat-abc-123',
      'continue',
    );
    const argv = lastArgv();
    expect(argv).toContain('--resume');
    expect(argv[argv.indexOf('--resume') + 1]).toBe('chat-abc-123');
    expect(result.sessionId).toBe('chat-abc-123');
    expect(result.sessionEvidence.resumedFromSessionId).toBe('chat-abc-123');
  });

  it('refuses to run at all without a trust flag — before spending a call', async () => {
    await expect(adapter(['-p', '--output-format', 'stream-json']).send('hi')).rejects.toThrow(
      /--force, --yolo, --trust/,
    );
    // The guard fires BEFORE the subprocess: nothing was invoked.
    expect(existsSync(argvLog)).toBe(false);
  });

  it('surfaces a content refusal as CursorContentRefusalError from a real subprocess', async () => {
    process.env.CODEMOOT_FAKE_CURSOR_REFUSAL = '1';
    await expect(
      adapter(['-p', '--force', '--output-format', 'stream-json']).send(
        'is this guard defeatable?',
      ),
    ).rejects.toThrow(CursorContentRefusalError);
  });
});

describe('cursor wiring across the config and identity layers', () => {
  function cursorModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
    return {
      provider: 'cursor',
      model: 'gpt-5.6-sol-medium',
      maxTokens: 4096,
      temperature: 0.7,
      timeout: 600,
      cliAdapter: {
        kind: 'cursor',
        command: 'cursor-agent',
        args: ['-p', '--force', '--output-format', 'stream-json'],
        timeout: 600,
      },
      ...overrides,
    } as ModelConfig;
  }

  it('resolves the kind from an explicit kind AND from provider alone', () => {
    expect(resolveModelAdapterKind(cursorModel())).toBe('cursor');
    const inferred = { ...cursorModel() } as ModelConfig & { cliAdapter?: unknown };
    inferred.cliAdapter = undefined;
    expect(resolveModelAdapterKind(inferred as ModelConfig)).toBe('cursor');
  });

  it('maps to the CURSOR domain kind — the binary map would have said CODEX', () => {
    // Adapter kind is what requireDifferentAdapterKinds compares to prove reviewer
    // independence, so a cursor assignment mislabelled CODEX would silently corrupt it.
    expect(resolveConfiguredAdapterKind(cursorModel())).toBe('CURSOR');
    expect(
      resolveConfiguredAdapterKind({
        ...cursorModel(),
        provider: 'anthropic',
        cliAdapter: undefined,
      } as ModelConfig),
    ).toBe('CLAUDE');
    expect(
      resolveConfiguredAdapterKind({
        ...cursorModel(),
        provider: 'openai',
        cliAdapter: undefined,
      } as ModelConfig),
    ).toBe('CODEX');
  });

  it('builds a CursorCliAdapter through the registry', () => {
    expect(createModelAdapter(cursorModel()).name).toBe('cursor');
  });

  function parseWith(model: Record<string, unknown>) {
    return projectConfigSchema.parse({
      configVersion: 3,
      models: { reviewer: model, other: { provider: 'anthropic', model: 'claude-opus-5' } },
      roles: { implementer: { model: 'other' }, reviewer: { model: 'reviewer' } },
    });
  }

  it('accepts cursor+cursor and rejects every mismatched pairing', () => {
    expect(() => parseWith(cursorModel() as never)).not.toThrow();
    expect(() => parseWith({ ...cursorModel(), provider: 'openai' } as never)).toThrow(
      /require provider .{0,2}cursor/,
    );
    expect(() =>
      parseWith({
        ...cursorModel(),
        provider: 'cursor',
        cliAdapter: { kind: 'claude', command: 'claude', args: [], timeout: 600 },
      } as never),
    ).toThrow(/require provider .{0,2}anthropic/);
  });

  it('rejects a cursor adapter with no trust flag at CONFIG time', () => {
    // The failure mode is silent and expensive at runtime — zero stdout and a wait that
    // ends only at the idle timeout — so it must be caught before a run starts.
    expect(() =>
      parseWith({
        ...cursorModel(),
        cliAdapter: {
          kind: 'cursor',
          command: 'cursor-agent',
          args: ['-p', '--output-format', 'stream-json'],
          timeout: 600,
        },
      } as never),
    ).toThrow(/--force/);
  });
});
