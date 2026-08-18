// "Quiet" is not "dead": telling the two apart before killing a CLI child.
//
// The relay's health signal is stream silence, because elapsed time says nothing about a
// model that is genuinely working. That was right until the same silence started meaning two
// opposite things: an agent running a long local test suite emits nothing for many minutes,
// and a wedged CLI (a documented `cursor-agent` bug — its HTTP stream dies while the process
// lives) emits nothing forever. One live run paid both prices: 900s idle kills fired during
// real work, and raising the limit to stop that turned real wedges into multi-hour hangs —
// eight of them overnight, the child sitting on ~8 seconds of CPU the whole time.
//
// CPU time separates them cleanly and cheaply. A working agent — or any tool it spawned —
// burns measurable CPU; a wedged process waiting on a dead socket burns none. So the idle
// deadline is not a verdict on its own: at expiry we ask the operating system whether
// anything in the child's process tree has actually run since the last look.

import { execFileSync } from 'node:child_process';

/** Cumulative CPU seconds consumed by a process tree, or null when it cannot be read. */
export type CpuSampler = (pid: number) => number | null;

/**
 * Total CPU time of `pid` and every descendant, in seconds.
 *
 * One `ps` call, no dependencies, no per-descendant syscalls. Returns null when the tree
 * cannot be read at all (process gone, ps unavailable, an unsupported platform) — null means
 * "no evidence", and no evidence must never be read as "alive".
 */
export const sampleProcessTreeCpuSeconds: CpuSampler = (pid) => {
  if (process.platform === 'win32') return null;
  let output: string;
  try {
    // TIME is cumulative CPU (not elapsed), which is exactly the question being asked.
    output = execFileSync('ps', ['-Ao', 'pid=,ppid=,time='], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const children = new Map<number, number[]>();
  const cpuByPid = new Map<number, number>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) continue;
    const self = Number(match[1]);
    const parent = Number(match[2]);
    cpuByPid.set(self, parseCpuTime(match[3] ?? ''));
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [self]);
    else siblings.push(self);
  }
  if (!cpuByPid.has(pid)) return null;
  // Breadth-first over the tree, guarding against a cycle a malformed ps line could imply.
  let total = 0;
  const seen = new Set<number>();
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    if (seen.has(current)) continue;
    seen.add(current);
    total += cpuByPid.get(current) ?? 0;
    for (const child of children.get(current) ?? []) queue.push(child);
  }
  return total;
};

/** `[[dd-]hh:]mm:ss[.ff]` as printed by ps, in seconds. Unparseable reads as zero. */
export function parseCpuTime(value: string): number {
  const [dayPart, clockPart] = value.includes('-') ? value.split('-') : [undefined, value];
  const parts = (clockPart ?? '').split(':').map((part) => Number.parseFloat(part));
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  if (dayPart !== undefined) {
    const days = Number.parseInt(dayPart, 10);
    if (Number.isFinite(days)) seconds += days * 86_400;
  }
  return seconds;
}

export interface LivenessProbeConfig {
  /** Off restores the pre-probe behaviour exactly: the idle deadline is the verdict. */
  readonly enabled: boolean;
  /**
   * How busy the tree must have been to count as working, as a fraction of ONE core over the
   * window just observed. A ratio rather than an absolute: the same threshold then means the
   * same thing whether the window was 200ms or 60s. The bar is deliberately near the floor —
   * a wedged process burns exactly nothing, so anything above measurement noise separates
   * them, and a busier bar would kill an agent that is mostly waiting on its own subprocess.
   */
  readonly minCpuRatio: number;
  /** How long each granted extension lasts — also the measurement window. */
  readonly probeIntervalMs: number;
  /**
   * How many extensions one call may be granted. A ceiling, not a budget — every extension
   * after the first has to be earned by fresh CPU — so a genuinely tireless agent is bounded
   * by `timeout`, the absolute limit, rather than by nothing.
   */
  readonly maxExtensions: number;
}

export const DEFAULT_LIVENESS_PROBE: LivenessProbeConfig = {
  enabled: true,
  minCpuRatio: 0.01,
  probeIntervalMs: 60_000,
  maxExtensions: 30,
};

export interface LivenessVerdict {
  /** EXTEND grants one probe interval; KILL lets the idle timeout stand. */
  readonly decision: 'EXTEND' | 'KILL';
  /** Why, in one phrase, for the log line that accompanies the extension or the kill. */
  readonly detail: string;
  /** The sample to compare against next time; undefined leaves the baseline untouched. */
  readonly cpuSeconds?: number;
}

/**
 * Decides what a silent child has earned: one more probe interval, or the kill the idle
 * timeout already ordered.
 *
 * Everything ambiguous fails CLOSED — probe disabled, no pid, an unreadable process tree, no
 * usable baseline, extensions exhausted, or a tree that burned nothing. A probe that cannot
 * see the process must never be the reason a wedged call survives, and a deadline is only
 * ever extended on positive evidence of work.
 *
 * The baseline is taken PART-WAY through the silence rather than at expiry (see the callers),
 * so the very first deadline can be judged immediately: a wedged call still dies exactly when
 * `idleTimeout` says it should.
 */
export function probeLocalActivity(input: {
  readonly pid: number | undefined;
  readonly previousCpuSeconds: number | undefined;
  /** Wall milliseconds since the baseline sample — the window the ratio is applied to. */
  readonly windowMs: number;
  readonly extensionsGranted: number;
  readonly config: LivenessProbeConfig;
  readonly sampler?: CpuSampler;
}): LivenessVerdict {
  if (!input.config.enabled) return { decision: 'KILL', detail: 'liveness probe disabled' };
  if (input.extensionsGranted >= input.config.maxExtensions) {
    return {
      decision: 'KILL',
      detail: `liveness extensions exhausted (${input.config.maxExtensions})`,
    };
  }
  if (input.pid === undefined) return { decision: 'KILL', detail: 'no child process id' };
  const sampler = input.sampler ?? sampleProcessTreeCpuSeconds;
  const now = sampler(input.pid);
  if (now === null) return { decision: 'KILL', detail: 'process tree unreadable' };
  if (input.previousCpuSeconds === undefined) {
    return { decision: 'KILL', detail: 'no CPU baseline to compare against', cpuSeconds: now };
  }
  const delta = now - input.previousCpuSeconds;
  // `ps` reports CPU time to 10ms, so the ratio is floored at twice that: below it the
  // reading is measurement noise, not evidence of work.
  const required = Math.max(0.02, (input.config.minCpuRatio * input.windowMs) / 1000);
  const detail = `child tree burned ${delta.toFixed(2)}s CPU in ${Math.round(input.windowMs)}ms of silence (needs ${required.toFixed(2)}s)`;
  if (delta >= required) {
    return { decision: 'EXTEND', detail, cpuSeconds: now };
  }
  return { decision: 'KILL', detail, cpuSeconds: now };
}
