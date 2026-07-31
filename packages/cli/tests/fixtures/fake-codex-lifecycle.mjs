#!/usr/bin/env node
// A scenario-driven Codex CLI stand-in for the full-lifecycle integration test. It answers
// the `--version` runtime-evidence probe, emits the exact `--json` JSONL event protocol the
// adapter parses (thread identity, agent message, token usage), creates a fresh thread id
// per new conversation, and — under strict resume — echoes the requested thread id exactly.
// Responses come from the numbered scenario steps in <cwd>/.cowork/scenario.

import { randomUUID } from 'node:crypto';
import { readStdin, renderResponse, takeStep } from './scenario-lib.mjs';

const argumentsList = process.argv.slice(2);

if (argumentsList.includes('--version')) {
  process.stdout.write('codex-cli 99.0.0-lifecycle-test\n');
  process.exit(0);
}

if (argumentsList[0] !== 'exec' || !argumentsList.includes('--json')) {
  process.stderr.write('Expected `exec ... --json` argument shape\n');
  process.exit(2);
}

const prompt = await readStdin();
const resumeIndex = argumentsList.indexOf('resume');
const resumedThreadId = resumeIndex === -1 ? undefined : argumentsList[resumeIndex + 1];
const threadId = resumedThreadId ?? `thread-${randomUUID()}`;

const step = takeStep('codex');
const responseText = renderResponse(step, prompt);

const events = [
  { type: 'thread.started', thread_id: threadId },
  { type: 'item.completed', item: { type: 'agent_message', text: responseText } },
  {
    type: 'turn.completed',
    usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 40 },
  },
];
for (const event of events) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
