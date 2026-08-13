// A scenario-driven Claude CLI stand-in for the full-lifecycle integration test. It speaks
// the exact stream-json protocol the adapter requires, creates a FRESH session id per new
// conversation, echoes the exact resumed session id (mandatory continuity evidence), and
// answers from the numbered scenario steps in <cwd>/.cowork/scenario (see scenario-lib.mjs).
// A step may carry a `shell` command, so the scripted implementer can really edit files and
// create commits through the guarded PATH exactly like a live agent.

import { randomUUID } from 'node:crypto';
import { readStdin, renderResponse, takeStep } from './scenario-lib.mjs';

const argumentsList = process.argv.slice(2);
const prompt = await readStdin();

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
const sessionId = resumedSessionId ?? randomUUID();

const step = takeStep('claude');
const responseText = renderResponse(step, prompt);

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

function resultMessage(text, resultSessionId) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 10,
    result: text,
    session_id: resultSessionId,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 10,
      output_tokens: 20,
    },
  };
}

// `doubleResult`: the long-session refresh boundary — TWO result messages on the same
// announced session; the parser must let the LAST one win (the first carries garbage that
// would fail every downstream contract parse, so a first-wins regression cannot hide).
if (step.doubleResult === true) {
  process.stdout.write(
    `${JSON.stringify(resultMessage('SUPERSEDED-EARLY-RESULT', sessionId))}\n`,
  );
}
// `corruptResultSession`: genuine corruption — the result claims a session no init ever
// announced. The parser must reject it even though repetition itself is tolerated.
const finalSessionId =
  step.corruptResultSession === true ? `corrupted-${sessionId}` : sessionId;
process.stdout.write(`${JSON.stringify(resultMessage(responseText, finalSessionId))}\n`);

function optionValue(name) {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
}
