// A Claude CLI stand-in for relay tests. Unlike the scripted fake, the response file is
// passed as an ARGUMENT, so the implementer and the reviewer can be two entries in the same
// .cowork.yml pointing at two different response sequences. Every prompt received is
// appended to `<responseFile>.prompts.jsonl` so tests can assert exactly what the bus sent.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argumentsList = process.argv.slice(2);
const responseFile = argumentsList.find((argument) => argument.endsWith('.responses.json'));
if (responseFile === undefined) {
  process.stderr.write('fake-claude-relay: no .responses.json argument\n');
  process.exit(2);
}

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  prompt += chunk;
}

const resumedSessionId = optionValue('--resume');

const counterFile = `${responseFile}.calls`;
let index = 0;
try {
  index = Number.parseInt(readFileSync(counterFile, 'utf8').trim(), 10);
} catch {
  index = 0;
}
writeFileSync(counterFile, String(index + 1));

appendFileSync(
  `${responseFile}.prompts.jsonl`,
  `${JSON.stringify({
    index,
    resumedSessionId: resumedSessionId ?? null,
    prompt,
    // The subprocess environment, so tests can assert what the relay actually handed over.
    // The original relay tests invoked this fake by ABSOLUTE path, so a poisoned PATH was
    // invisible to them — a live run then failed instantly with `claude not found in PATH`.
    envPath: process.env.PATH ?? null,
    envUser: process.env.USER ?? null,
  })}\n`,
);

const sequence = JSON.parse(readFileSync(responseFile, 'utf8'));
const responseText = String(sequence[Math.min(index, sequence.length - 1)]);
// '__CRASH__' simulates an adapter-level failure AFTER the model ran: the process dies
// without a result message, which the adapter surfaces as a thrown ModelError — the class
// of exception that once escaped the relay's boundary and killed the whole runner.
if (responseText === '__CRASH__') {
  process.stderr.write('fake-claude-relay: simulated mid-call death\n');
  process.exit(1);
}
const sessionId = resumedSessionId ?? `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

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
    model: optionValue('--model') ?? 'unknown-model',
    permissionMode: 'acceptEdits',
  })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
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
  })}\n`,
);

function optionValue(name) {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
}
