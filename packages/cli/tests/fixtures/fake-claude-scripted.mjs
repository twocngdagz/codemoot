// A scripted Claude CLI stand-in for real-command integration tests: it speaks the exact
// stream-json protocol the adapter requires and returns the response text stored in the
// file named by CODEMOOT_FAKE_RESPONSE_FILE (allowlisted through the adapter env filter).

import { readFileSync, writeFileSync } from 'node:fs';

const argumentsList = process.argv.slice(2);

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  prompt += chunk;
}

if (
  !argumentsList.includes('--print') ||
  optionValue('--output-format') !== 'stream-json' ||
  !argumentsList.includes('--verbose')
) {
  process.stderr.write('Required structured-output arguments are missing\n');
  process.exit(2);
}

const configuredModel = optionValue('--model') ?? 'unknown-model';
const resumedSessionId = optionValue('--resume');
const sessionId = resumedSessionId ?? '550e8400-e29b-41d4-a716-446655440042';

const init = {
  type: 'system',
  subtype: 'init',
  uuid: 'fake-init',
  session_id: sessionId,
  apiKeySource: 'subscription',
  claude_code_version: '2.1.218',
  cwd: process.cwd(),
  tools: ['Read', 'Edit'],
  mcp_servers: [],
  model: configuredModel,
  permissionMode: 'acceptEdits',
};
process.stdout.write(`${JSON.stringify(init)}\n`);

const responseFile = process.env.CODEMOOT_FAKE_RESPONSE_FILE;
// Refinement is per-batch now, so a run makes several calls: a response file holding a JSON
// ARRAY serves one element per call, in order.
let responseText;
if (responseFile === undefined) {
  responseText = `scripted:${prompt.slice(0, 40)}`;
} else {
  const raw = readFileSync(responseFile, 'utf8');
  let sequence;
  try {
    const parsed = JSON.parse(raw);
    sequence = Array.isArray(parsed) ? parsed : undefined;
  } catch {
    sequence = undefined;
  }
  if (sequence === undefined) {
    responseText = raw;
  } else {
    const counterFile = `${responseFile}.calls`;
    let index = 0;
    try {
      index = Number.parseInt(readFileSync(counterFile, 'utf8').trim(), 10);
    } catch {
      index = 0;
    }
    writeFileSync(counterFile, String(index + 1));
    const entry = sequence[Math.min(index, sequence.length - 1)];
    responseText = typeof entry === 'string' ? entry : JSON.stringify(entry);
  }
}

const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 10,
  result: responseText,
  session_id: sessionId,
  total_cost_usd: 0.01,
  usage: {
    input_tokens: 100,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 10,
    output_tokens: 20,
  },
};
process.stdout.write(`${JSON.stringify(result)}\n`);

function optionValue(name) {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
}
