#!/usr/bin/env node
// A cursor-agent stand-in speaking the VERIFIED stream-json envelope: system/init →
// user → assistant → result, session_id on every line, camelCase usage, and NO
// claude_code_version / total_cost_usd. Modes are chosen by env so one fixture covers the
// success path, the trust-prompt failure, and the OpenAI content refusal.

import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('2026.08.04-aaa8809\n');
  process.exit(0);
}

const record = process.env.CODEMOOT_FAKE_CURSOR_ARGV;
if (record !== undefined) appendFileSync(record, `${JSON.stringify(args)}\n`);

// Verified live: without --force/--yolo/--trust the CLI writes a trust prompt to STDERR,
// emits ZERO stdout, and waits. This fixture exits instead of hanging so tests stay fast.
if (!args.some((a) => ['--force', '--yolo', '--trust'].includes(a))) {
  process.stderr.write(
    '\n⚠ Workspace Trust Required\n\n  Do you trust the contents of this directory?\n',
  );
  process.exit(0);
}

const resumeIndex = args.indexOf('--resume');
const sessionId =
  resumeIndex !== -1 && args[resumeIndex + 1] !== undefined
    ? args[resumeIndex + 1]
    : 'f67fa24d-1111-2222-3333-444455556666';

const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (process.env.CODEMOOT_FAKE_CURSOR_REFUSAL === '1') {
  line({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'login',
    cwd: process.cwd(),
    session_id: sessionId,
    model: 'GPT-5.6 Sol 272K Low',
    permissionMode: 'default',
  });
  process.stderr.write(
    'ActionRequiredError: The provider flagged this request for potential high-risk cybersecurity activity\n',
  );
  line({
    type: 'result',
    subtype: 'error',
    is_error: true,
    session_id: sessionId,
    duration_ms: 1200,
  });
  process.exit(1);
}

// The prompt is the LAST positional argument — proving it travelled as an argument, not
// on stdin (cursor-agent's usage is `agent [options] [prompt...]`).
const prompt = args.at(-1) ?? '';

line({
  type: 'system',
  subtype: 'init',
  apiKeySource: 'login',
  cwd: process.cwd(),
  session_id: sessionId,
  model: 'GPT-5.6 Sol 272K Low',
  permissionMode: 'default',
});
line({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  session_id: sessionId,
});
line({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
  session_id: sessionId,
});
line({
  type: 'result',
  subtype: 'success',
  duration_ms: 8938,
  duration_api_ms: 8938,
  is_error: false,
  result: process.env.CODEMOOT_FAKE_CURSOR_TEXT ?? `echo:${prompt}`,
  session_id: sessionId,
  request_id: 'c015e3d0-aaaa-bbbb-cccc-ddddeeeeffff',
  usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 51556 },
});
process.exit(0);
