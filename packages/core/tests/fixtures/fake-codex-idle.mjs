#!/usr/bin/env node
// A codex CLI stand-in for idle-timeout tests: answers the --version attestation probe,
// then on the real call stays COMPLETELY SILENT for CODEMOOT_FAKE_SILENT_MS before emitting
// the minimal --json protocol (thread.started + agent_message). The silence is the point —
// codex emits nothing during long reasoning, and the idle timer must be judging that
// silence against the CONFIGURED budget, not a hardcoded one.

const argumentsList = process.argv.slice(2);

if (argumentsList.includes('--version')) {
  process.stdout.write('codex-cli 0.0.0-fake\n');
  process.exit(0);
}

const silentMs = Number.parseInt(process.env.CODEMOOT_FAKE_SILENT_MS ?? '0', 10);

setTimeout(
  () => {
    process.stdout.write(
      `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-fake-1' })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })}\n`,
    );
    process.exit(0);
  },
  Number.isFinite(silentMs) ? silentMs : 0,
);
