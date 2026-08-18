#!/usr/bin/env node
// A Claude-protocol CLI that can be silent in the two ways that look identical from outside.
//
//   CODEMOOT_FAKE_MODE=wedged   — emit the init line, then sleep. No output, no CPU: the
//                                 documented cursor-agent freeze (a live process on a dead
//                                 HTTP stream).
//   CODEMOOT_FAKE_MODE=working  — emit the init line, then BURN CPU without emitting
//                                 anything: an agent running a long local test suite.
//
// Both go quiet for CODEMOOT_FAKE_SILENT_MS and then answer normally, so a test can assert
// either "killed at the deadline" or "survived and completed".

const mode = process.env.CODEMOOT_FAKE_MODE ?? 'wedged';
const silentMs = Number.parseInt(process.env.CODEMOOT_FAKE_SILENT_MS ?? '3000', 10);
const sessionId = '00000000-0000-4000-8000-000000000abc';

process.stdout.write(
  `${JSON.stringify({
    type: 'system',
    subtype: 'init',
    uuid: 'fake-init',
    session_id: sessionId,
    apiKeySource: 'subscription',
    claude_code_version: '2.1.218',
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [],
    model: 'fake-model',
    permissionMode: 'acceptEdits',
  })}\n`,
);

const until = Date.now() + silentMs;
if (mode === 'working') {
  // Real CPU, no output. A tight loop would spin a core needlessly, so this alternates
  // short bursts of hashing with yields — enough to register in `ps` TIME, cheap enough to
  // run in CI.
  const { createHash } = await import('node:crypto');
  while (Date.now() < until) {
    const deadline = Date.now() + 40;
    while (Date.now() < deadline) createHash('sha256').update(String(Math.E)).digest('hex');
    await new Promise((r) => setTimeout(r, 10));
  }
} else {
  await new Promise((r) => setTimeout(r, silentMs));
}

process.stdout.write(
  `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: silentMs,
    result: 'done after a long quiet stretch',
    session_id: sessionId,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
  })}\n`,
);
