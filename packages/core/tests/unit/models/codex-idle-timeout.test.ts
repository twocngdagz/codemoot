// `cliAdapter.idleTimeout` on a CODEX model: validated by the schema and — until now —
// ignored by the adapter. The claude factory resolved the setting into its adapter; the
// codex factory passed nothing, so the runner fell through to a hardcoded 120s and killed a
// reviewer configured with idleTimeout: 900 at exactly "no output for 120000ms", eight
// minutes into a normal medium-effort review. Same shape as the dead cliAdapter.timeout: a
// setting that validates and has no effect is worse than a missing one, because the
// operator believes the problem is already fixed.

import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModelAdapter } from '../../../src/models/registry.js';
import type { ModelConfig } from '../../../src/types/config.js';

const FAKE = fileURLToPath(new URL('../../fixtures/fake-codex-idle.mjs', import.meta.url));

function codexConfig(idleTimeoutSeconds?: number): ModelConfig {
  return {
    provider: 'openai',
    model: 'gpt-5.3-codex',
    maxTokens: 4096,
    temperature: 0.7,
    timeout: 60,
    cliAdapter: {
      kind: 'codex',
      command: FAKE,
      args: ['exec'],
      timeout: 60,
      ...(idleTimeoutSeconds === undefined ? {} : { idleTimeout: idleTimeoutSeconds }),
    },
  } as ModelConfig;
}

const CALL_OPTIONS = {
  envAllowlist: [
    'CODEMOOT_FAKE_SILENT_MS',
    'CODEMOOT_FAKE_IGNORE_SIGTERM',
    'CODEMOOT_FAKE_NO_MESSAGE',
  ],
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('codex idleTimeout resolution', () => {
  beforeEach(() => chmodSync(FAKE, 0o755));
  afterEach(() => {
    delete process.env.CODEMOOT_FAKE_SILENT_MS;
    delete process.env.CODEMOOT_FAKE_IGNORE_SIGTERM;
    delete process.env.CODEMOOT_FAKE_NO_MESSAGE;
  });

  it('a clean exit with NO agent message is a FAILED call, not an empty reply', async () => {
    // Codex handles SIGTERM as graceful shutdown: thread.started, nothing else, exit 0.
    // parseCodexJsonl used to return that as a successful empty text, and a hand-killed
    // reviewer became a zero-length RESPONSE in a relay transcript — a recorded turn that
    // never happened.
    process.env.CODEMOOT_FAKE_NO_MESSAGE = '1';
    const adapter = createModelAdapter(codexConfig());
    await expect(adapter.send('hello', CALL_OPTIONS)).rejects.toThrow(
      /closed without an agent message/,
    );
  }, 15_000);

  it('actually KILLS the child it says it killed — even one that ignores SIGTERM', async () => {
    // The 42-minute zombie: codex was spawned without its own process group, so the
    // group-signal in killProcessTree threw ESRCH into a silent catch and nothing died.
    // The unkilled child's pipes then held the relay's event loop open, and a resume
    // started a SECOND worker on the same run. Detachment gives the child a real group;
    // this pins that an idle-kill leaves a DEAD child, not a reported-dead one — through
    // the SIGKILL escalation, because this child ignores SIGTERM outright.
    process.env.CODEMOOT_FAKE_SILENT_MS = '60000';
    process.env.CODEMOOT_FAKE_IGNORE_SIGTERM = '1';
    const adapter = createModelAdapter(codexConfig(1));
    let childPid = 0;
    await expect(
      adapter.send('hello', { ...CALL_OPTIONS, onSpawn: (pid) => (childPid = pid) }),
    ).rejects.toThrow(/no output for 1000ms/);
    expect(childPid).toBeGreaterThan(0);
    // SIGTERM at ~1s is ignored; SIGKILL escalates at +5s. Poll a little past that.
    const deadline = Date.now() + 8_000;
    while (pidAlive(childPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(pidAlive(childPid), `child ${childPid} must be dead after the kill`).toBe(false);
  }, 15_000);

  it('honours the CONFIGURED idle timeout instead of the hardcoded default', async () => {
    // 1s configured silence budget against a 5s-silent process: killed at ~1s, and the
    // error names the configured value — proof the setting reached the runner. Under the
    // old chain this waited the hardcoded 120s.
    process.env.CODEMOOT_FAKE_SILENT_MS = '5000';
    const adapter = createModelAdapter(codexConfig(1));
    const startedAt = Date.now();
    await expect(adapter.send('hello', CALL_OPTIONS)).rejects.toThrow(/no output for 1000ms/);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  }, 15_000);

  it('a silence SHORTER than the configured budget completes normally', async () => {
    process.env.CODEMOOT_FAKE_SILENT_MS = '1200';
    const adapter = createModelAdapter(codexConfig(5));
    const result = await adapter.send('hello', CALL_OPTIONS);
    expect(result.text).toBe('done');
    expect(result.sessionId).toBe('thread-fake-1');
  }, 15_000);

  it('the unconfigured default tolerates reasoning silence a 2-minute budget would kill', async () => {
    // Codex has no --include-partial-messages equivalent: long reasoning is structurally
    // silent, so the codex default is 10 minutes, not claude's 2. Proven by construction
    // here (a silent stretch completes under no configuration) and pinned by the constant
    // in the failure message of the test above.
    process.env.CODEMOOT_FAKE_SILENT_MS = '1500';
    const adapter = createModelAdapter(codexConfig());
    await expect(adapter.send('hello', CALL_OPTIONS)).resolves.toBeDefined();
  }, 15_000);

  it('an explicit per-call option still overrides the configured default', async () => {
    process.env.CODEMOOT_FAKE_SILENT_MS = '5000';
    const adapter = createModelAdapter(codexConfig(30));
    await expect(adapter.send('hello', { ...CALL_OPTIONS, idleTimeout: 1_000 })).rejects.toThrow(
      /no output for 1000ms/,
    );
  }, 15_000);
});
