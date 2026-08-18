// Telling "quiet but working" apart from "wedged", which stream silence alone cannot do.
//
// The live cost of conflating them: 900s idle kills fired during real work, and raising the
// limit to stop that turned real freezes into multi-hour hangs — one of them eight hours,
// the child holding ~8 seconds of CPU the whole time.

import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runStreamingCliProcess } from '../../../src/models/claude-cli-adapter.js';
import {
  DEFAULT_LIVENESS_PROBE,
  type LivenessProbeConfig,
  parseCpuTime,
  probeLocalActivity,
  sampleProcessTreeCpuSeconds,
} from '../../../src/models/process-liveness.js';

const FAKE = fileURLToPath(new URL('../../fixtures/fake-wedging-cli.mjs', import.meta.url));

const PROBE: LivenessProbeConfig = {
  enabled: true,
  minCpuRatio: 0.01,
  probeIntervalMs: 200,
  maxExtensions: 30,
};

describe('parseCpuTime', () => {
  it('reads every shape ps prints', () => {
    expect(parseCpuTime('0:00.00')).toBe(0);
    expect(parseCpuTime('0:08.31')).toBeCloseTo(8.31, 2);
    expect(parseCpuTime('12:30.00')).toBeCloseTo(750, 2);
    expect(parseCpuTime('1:02:03')).toBeCloseTo(3723, 2);
    expect(parseCpuTime('2-01:00:00')).toBeCloseTo(2 * 86_400 + 3600, 2);
  });

  it('reads garbage as zero rather than NaN — a bad line must not look like activity', () => {
    expect(parseCpuTime('')).toBe(0);
    expect(parseCpuTime('not-a-time')).toBe(0);
  });
});

describe('probeLocalActivity', () => {
  const base = { pid: 4242, extensionsGranted: 0, windowMs: 60_000, config: PROBE };

  it('kills when there is no baseline — a deadline is extended only on evidence', () => {
    // The baseline is normally taken half way through the silence (see the runners), so its
    // absence means the sample failed. That must never buy a wedged call extra life: with no
    // evidence of work the call dies exactly when idleTimeout said it would.
    const verdict = probeLocalActivity({
      ...base,
      previousCpuSeconds: undefined,
      sampler: () => 3,
    });
    expect(verdict.decision).toBe('KILL');
  });

  it('extends while the child tree is burning CPU', () => {
    const verdict = probeLocalActivity({ ...base, previousCpuSeconds: 3, sampler: () => 9 });
    expect(verdict.decision).toBe('EXTEND');
    expect(verdict.detail).toContain('6.00s CPU');
  });

  it('judges busyness against the WINDOW, not an absolute — the same bar at any interval', () => {
    // 0.3s of CPU is working over 200ms and idling over an hour; a fixed threshold would
    // have to be wrong at one end. The ratio makes both readings come out right.
    const short = probeLocalActivity({
      ...base,
      windowMs: 200,
      previousCpuSeconds: 1,
      sampler: () => 1.3,
    });
    const long = probeLocalActivity({
      ...base,
      windowMs: 3_600_000,
      previousCpuSeconds: 1,
      sampler: () => 1.3,
    });
    expect(short.decision).toBe('EXTEND');
    expect(long.decision).toBe('KILL');
  });

  it('kills a tree that burned nothing — the wedge', () => {
    // The live shape exactly: the process is alive, its CPU time has not moved.
    const verdict = probeLocalActivity({ ...base, previousCpuSeconds: 8.31, sampler: () => 8.31 });
    expect(verdict.decision).toBe('KILL');
  });

  it.each([
    ['disabled', { config: { ...PROBE, enabled: false }, sampler: () => 99 }],
    ['no child pid', { pid: undefined, sampler: () => 99 }],
    ['an unreadable process tree', { sampler: () => null }],
    ['extensions exhausted', { extensionsGranted: 30, sampler: () => 99 }],
  ])('fails CLOSED on %s — no evidence never means alive', (_label, overrides) => {
    const verdict = probeLocalActivity({
      ...base,
      previousCpuSeconds: 1,
      ...(overrides as Record<string, unknown>),
    } as Parameters<typeof probeLocalActivity>[0]);
    expect(verdict.decision).toBe('KILL');
  });

  it('reads real CPU from a real process tree', () => {
    // The injected samplers above prove the decision; this proves the default sampler can
    // actually see a process at all, which is what makes the decision meaningful.
    const self = sampleProcessTreeCpuSeconds(process.pid);
    expect(self).not.toBeNull();
    expect(self as number).toBeGreaterThanOrEqual(0);
    expect(sampleProcessTreeCpuSeconds(0x7ffffff)).toBeNull();
  });
});

describe('AC4 — the idle deadline consults the child before enforcing it', () => {
  chmodSync(FAKE, 0o755);

  function run(input: {
    mode: 'working' | 'wedged';
    silentMs: number;
    idleTimeout: number;
    liveness?: LivenessProbeConfig;
  }) {
    const extensions: string[] = [];
    return {
      extensions,
      promise: runStreamingCliProcess({
        command: process.execPath,
        args: [FAKE],
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? '',
          CODEMOOT_FAKE_MODE: input.mode,
          CODEMOOT_FAKE_SILENT_MS: String(input.silentMs),
        },
        prompt: 'anything',
        provider: 'anthropic',
        model: 'fake-model',
        timeout: 60_000,
        idleTimeout: input.idleTimeout,
        maxCaptureBytes: 1_000_000,
        liveness: input.liveness ?? PROBE,
        options: { onIdleExtended: (detail) => extensions.push(detail.reason) },
      }),
    };
  }

  it('a quiet but locally ACTIVE child survives far past idleTimeout', async () => {
    const call = run({ mode: 'working', silentMs: 2_500, idleTimeout: 400 });
    const result = await call.promise;
    expect(result.stdout).toContain('done after a long quiet stretch');
    // It survived by being examined, not by luck: the deadline expired repeatedly.
    expect(call.extensions.length).toBeGreaterThan(1);
    expect(call.extensions.some((reason) => reason.includes('CPU'))).toBe(true);
  }, 30_000);

  it('a fully silent child is still killed — the probe is not a reprieve', async () => {
    const call = run({ mode: 'wedged', silentMs: 10_000, idleTimeout: 400 });
    const startedAt = Date.now();
    await expect(call.promise).rejects.toThrow(/idle timeout/);
    // Killed AT the deadline on the merits, not eventually once extensions ran out: no
    // extension was granted at all, and the wait was the deadline rather than the ceiling.
    expect(call.extensions).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 30_000);

  it('with the probe disabled the deadline is the verdict, exactly as before', async () => {
    const call = run({
      mode: 'working',
      silentMs: 10_000,
      idleTimeout: 400,
      liveness: { ...DEFAULT_LIVENESS_PROBE, enabled: false },
    });
    await expect(call.promise).rejects.toThrow(/idle timeout/);
    expect(call.extensions).toEqual([]);
  }, 30_000);
});
