# Claude CLI Adapter Contract

Batch 5 adds a direct Claude Code adapter behind `CliBridge`. It is not selected by the legacy
model registry yet; role resolution and registry integration belong to Batch 6.

## Supported CLI

- Supported range: Claude Code `>=2.1.0 <3.0.0`.
- Locally inspected version during implementation: `2.1.218`.
- Protocol: non-interactive print mode with `--output-format stream-json --verbose`.
- Prompt transport: stdin. Prompt text is never placed in the process argument list.
- Resume: `--resume <session-id>` in the same working directory.

The adapter rejects a missing or malformed `system/init` or final `result` message, mismatched
session IDs, structured error results, and unsupported CLI versions. Unknown JSONL event types
are ignored so additive protocol events remain compatible.

The contract follows Anthropic's official references:

- <https://code.claude.com/docs/en/cli-usage>
- <https://code.claude.com/docs/en/headless>
- <https://code.claude.com/docs/en/agent-sdk/typescript>

## Invocation

```ts
import { ClaudeCliAdapter } from '@codemoot/core';

const adapter = new ClaudeCliAdapter({
  command: 'claude',
  args: ['--permission-mode', 'acceptEdits'],
  model: 'claude-sonnet-4-6',
  projectDir: process.cwd(),
});

const first = await adapter.send('Implement the approved batch.');
const continued = await adapter.resume(first.sessionId, 'Address the consolidated findings.');
```

The adapter controls `--print`, `--output-format`, `--verbose`, `--model`, and `--resume`.
Configured base arguments are intended for supported tool and permission flags. CodeMoot never
adds `--dangerously-skip-permissions`.
The configured project directory must be trusted because Claude Code skips its workspace-trust
dialog in non-interactive print mode.

Calls support:

- absolute and idle timeouts
- `AbortSignal` cancellation
- stdout, stderr, spawn, heartbeat, and close callbacks
- a configurable final-output byte limit
- process-tree termination on timeout or cancellation

## Evidence and metering

A successful direct call returns:

- configured and CLI-reported model
- Claude Code version and permission mode
- resolved executable path and SHA-256 hash when available
- process ID and a per-process fingerprint
- configured process working directory and observed timestamps
- vendor session ID and resume lineage
- SDK token usage and reported cost when supplied

This supports `PROCESS_ATTESTED` identity assurance. The CLI stream does not expose a stable
authenticated-subject identifier, so the adapter does not claim account-level separation.
`apiKeySource` is retained only as an authentication-source label; credentials and tokens are
never returned or persisted.

## Environment policy

Subprocesses receive a filtered environment:

- standard process-location variables such as `PATH`, `HOME`, and temporary-directory variables
- Anthropic API/token/base-URL variables
- documented Bedrock, Vertex, and Foundry routing/authentication variables
- standard HTTP proxy and certificate variables
- variables explicitly added through the adapter configuration or call options

Arbitrary host variables are excluded. `DISABLE_AUTOUPDATER=1` and `DISABLE_UPDATES=1` are forced
so an invocation cannot change the installed Claude Code version during a run.

## Current boundary

Batch 5 does not:

- change `ModelRegistry`, `caller.ts`, role resolution, legacy commands, or MCP
- persist invocation/session evidence
- invoke `claude auth status` or infer authenticated account identity
- run a credentialed smoke test automatically

The deterministic test harness uses a fake executable and does not read or modify real Claude
credentials, configuration, sessions, or user files.
