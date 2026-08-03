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

// A resume attempt against this fake always fails, the way codex refuses a thread id it
// has never seen — e.g. a claude session id handed over after a mid-run vendor swap.
if (argumentsList.includes('resume')) {
  process.stderr.write('fake-codex-idle: no such thread\n');
  process.exit(1);
}

const silentMs = Number.parseInt(process.env.CODEMOOT_FAKE_SILENT_MS ?? '0', 10);

// Worst-case child: ignores polite termination, so only a delivered SIGKILL to its process
// group ends it — exactly the codex-wrapper behaviour that survived a kill by 42 minutes.
if (process.env.CODEMOOT_FAKE_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
}

setTimeout(
  () => {
    process.stdout.write(
      `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-fake-1' })}\n`,
    );
    // Codex's graceful-SIGTERM shape: thread announced, NO agent message, clean exit 0.
    if (process.env.CODEMOOT_FAKE_NO_MESSAGE === '1') {
      process.exit(0);
    }
    process.stdout.write(
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })}\n`,
    );
    process.exit(0);
  },
  Number.isFinite(silentMs) ? silentMs : 0,
);
