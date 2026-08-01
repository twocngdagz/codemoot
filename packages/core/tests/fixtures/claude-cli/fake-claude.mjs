const argumentsList = process.argv.slice(2);
const mode = optionValue('--fixture-mode') ?? 'success';

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  prompt += chunk;
}

if (argumentsList.includes(prompt)) {
  process.stderr.write('Prompt leaked into process arguments\n');
  process.exit(2);
}
if (
  !argumentsList.includes('--print') ||
  optionValue('--output-format') !== 'stream-json' ||
  !argumentsList.includes('--verbose')
) {
  process.stderr.write('Required structured-output arguments are missing\n');
  process.exit(2);
}

if (mode === 'hang') {
  setInterval(() => {}, 60_000);
} else if (mode === 'hang-after-init') {
  // Emits the protocol init line, then goes silent — the real deep-reasoning kill shape.
  process.stdout.write(
    `${JSON.stringify({
      type: 'system',
      subtype: 'init',
      uuid: 'fake-init',
      session_id: '550e8400-e29b-41d4-a716-446655440010',
      apiKeySource: 'subscription',
      claude_code_version: '2.1.218',
      cwd: process.cwd(),
      tools: [],
      mcp_servers: [],
      model: optionValue('--model') ?? 'unknown-model',
      permissionMode: 'acceptEdits',
    })}\n`,
  );
  setInterval(() => {}, 60_000);
} else {
  const configuredModel = optionValue('--model') ?? 'unknown-model';
  const resumedSessionId = optionValue('--resume');
  const sessionId =
    resumedSessionId === undefined
      ? '550e8400-e29b-41d4-a716-446655440010'
      : mode === 'fork-session'
        ? '550e8400-e29b-41d4-a716-446655440777'
        : resumedSessionId;
  const version = mode === 'unsupported-version' ? '3.0.0' : '2.1.218';
  const init = {
    type: 'system',
    subtype: 'init',
    uuid: 'fake-init',
    session_id: sessionId,
    apiKeySource: process.env.ANTHROPIC_API_KEY === undefined ? 'subscription' : 'api-key',
    claude_code_version: version,
    cwd: process.cwd(),
    tools: ['Read', 'Edit'],
    mcp_servers: [],
    model: configuredModel,
    permissionMode: 'acceptEdits',
  };
  process.stdout.write(`${JSON.stringify(init)}\n`);

  if (mode === 'malformed') {
    process.stdout.write('not-json\n');
  }

  const responseText =
    mode === 'large-output'
      ? 'x'.repeat(2_048)
      : mode === 'boundary-output'
        ? 'x'.repeat(512 * 1_024)
        : `${resumedSessionId === undefined ? 'fresh' : 'resumed'}:${prompt}`;
  if (mode === 'boundary-output') {
    process.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: responseText }],
        },
        session_id: sessionId,
        parent_tool_use_id: null,
      })}\n`,
    );
  }

  const result =
    mode === 'error'
      ? {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          duration_ms: 10,
          session_id: sessionId,
          total_cost_usd: 0,
        }
      : {
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 10,
          result:
            mode === 'environment'
              ? JSON.stringify({
                  anthropicApiKeyPresent: process.env.ANTHROPIC_API_KEY !== undefined,
                  unlistedSecretPresent: process.env.UNLISTED_SECRET !== undefined,
                  autoUpdaterDisabled: process.env.DISABLE_AUTOUPDATER === '1',
                  updatesDisabled: process.env.DISABLE_UPDATES === '1',
                })
              : responseText,
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
}

function optionValue(name) {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
}
