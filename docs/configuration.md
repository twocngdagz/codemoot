# `.cowork.yml` — Complete Configuration Reference

The canonical reference for every configuration value. The source of truth is the zod schema
in [`packages/core/src/config/schema.ts`](../packages/core/src/config/schema.ts); this
document mirrors it field-by-field. Scaffold a valid starting file with
`codemoot init --preset review-gated`.

Older v1/v2 files are migrated automatically on load (the original is kept as
`.cowork.yml.bak`). See [review-workflow-configuration.md](review-workflow-configuration.md)
for migration details.

```yaml
configVersion: 3          # literal 3 (default 3)
project:
  name: my-project        # default: "" (init sets the directory name)
  description: ""
```

## `models` — model definitions (required)

A map of **aliases** (any name) to model configurations. Roles reference these aliases.

| Field | Type / values | Default | Notes |
|---|---|---|---|
| `provider` | `anthropic` \| `openai` | — required | Must match the adapter kind (see below) |
| `model` | string | — required | The exact model ID passed to the CLI as `--model`. The CLI must **echo the same string back** (invocation-evidence check) — use canonical IDs (`claude-opus-5`, `claude-sonnet-4-5`, `gpt-5.3-codex`…), never shorthand like `sonnet`. Verify a candidate with: `echo hi \| claude --print --output-format json --model <id>` |
| `maxTokens` | positive int | 4096 | Response token cap (API-path models) |
| `temperature` | 0–2 | 0.7 | |
| `timeout` | positive seconds | 600 | API-path timeout |
| `cliAdapter` | object | optional | Required for review-gated roles (see next table) |

### `models.<alias>.cliAdapter`

| Field | Type | Default | Notes |
|---|---|---|---|
| `kind` | `claude` \| `codex` | inferred from provider | `claude` requires `provider: anthropic`; `codex` requires `provider: openai` |
| `command` | string | — required | Executable, e.g. `claude` or `codex` |
| `args` | string[] | — required | Base CLI args, **passed through to the CLI**. Codex convention: `[exec]`. This is where per-CLI options go, e.g. Codex reasoning effort: `[exec, -c, model_reasoning_effort=high]` (values: `high`/`medium`/`low`) |
| `timeout` | positive seconds | — required | Per-invocation subprocess timeout |
| `versionConstraint` | string | optional | Semver constraint on the CLI version |
| `outputFile` | string | optional | Legacy output-file mode (Codex) |
| `maxOutputBytes` | positive int | optional | Output capture cap |
| `envAllowlist` | string[] | optional | Extra environment variables passed to the CLI subprocess (everything else is filtered). E.g. `[MAX_THINKING_TOKENS]` lets `export MAX_THINKING_TOKENS=31999` deepen Claude's thinking |

**Reasoning "level" cheat-sheet:**
- **Claude:** choose the model tier (`claude-opus-5` > `claude-sonnet-5` > `claude-sonnet-4-5`)
  and optionally allowlist `MAX_THINKING_TOKENS` (e.g. 31999 high / 16000 medium).
- **Codex:** append `-c model_reasoning_effort=high|medium|low` to `args`.

## `roles` — role assignments (required)

Map of role names to `{ model: <alias>, temperature?, maxTokens?, systemPromptFile? }`.
Every referenced alias must exist in `models`. The review-gated workflow uses `implementer`
and `reviewer`; `architect` is used by legacy workflows.

## Top-level

| Field | Values | Default |
|---|---|---|
| `workflow` | `review-gated-batches` (recommended) \| `plan-review-implement` (legacy) | `plan-review-implement` |
| `mode` | `autonomous` \| `interactive` \| `dashboard` | `autonomous` |

## `debate`

Legacy multi-model debate (not used by review-gated workflows — set `enabled: false`).
`enabled` (default true), `defaultPattern` (`structured-rounds`/`proposal-critique`/
`free-flowing`/`parallel-panel`, default `proposal-critique`), `maxRounds` (1–10, default 3),
`consensusThreshold` (0–1, default 0.7).

## `reviewGated` — the review-gated workflow policy

### `identity`

| Field | Values | Default | Notes |
|---|---|---|---|
| `minimumAssurance` | `authenticated_subject` \| `cli_asserted` \| `process_attested` \| `config_only` | `config_only` | Review-gated workflows **require `process_attested` or stronger** |
| `requireDifferentAdapterKinds` | boolean | false | `true` = implementer and reviewer must use different CLI vendors (the preset default, recommended for reviewer independence). `false` = single-vendor setups (e.g. all-Anthropic) are permitted; distinct assignments, distinct model aliases, and isolated role sessions remain mandatory |
| `prohibitSharedSessions` | boolean | true | Must be `true` for review-gated |

### `commit`

| Field | Values | Default | Notes |
|---|---|---|---|
| `mode` | `human_required` \| `agent_authorized` \| `either` | `human_required` | The **autonomous runner requires** `agent_authorized` or `either` |
| `agentMayCommit` | boolean | false | Must equal `mode !== human_required` (validated) |

### `gates`

`planReview`, `codeReview`, `verification`, `humanMerge` are all the literal `required`.
`blockingSeverities`: unique subset of `critical`/`high`/`medium`/`low` (default
`[critical, high]`) — add `medium` to make medium findings block reviews and the merge gate.
`requireAllFindingResponses` (default true), `requireAcceptedAttestations` (default true).

### `pacing` — the immutable per-workflow review contract

Frozen into each workflow's configuration snapshot at start; the coordinators enforce it.

| Field | Range | Default |
|---|---|---|
| `maxCodeReviewRounds` | 1–5 | 3 |
| `maxCorrectionPasses` | 0–4 | 2 |
| `deferNonBlockingFindings` | literal `true` | true |
| `unresolvedAfterFinalReview` | literal `human_decision_required` | — |

### `autonomous` — hard limits for `codemoot workflow run`

All finite and validated; **frozen into the runner state at workflow start** — editing the
file never changes a running workflow. Effective review/correction limits are the minimum of
these and `pacing` (explicit human `FIX_AGAIN` decisions extend by exactly one round/pass).

| Field | Range | Default | Stops with |
|---|---|---|---|
| `maxPlanReviewRoundsPerBatch` | 1–5 | 2 | `PLAN_REVIEW_LIMIT_REACHED` |
| `maxCodeReviewRoundsPerBatch` | 1–5 | 3 | `CODE_REVIEW_LIMIT_REACHED` |
| `maxCorrectionPassesPerBatch` | 0–4 | 2 | `CORRECTION_LIMIT_REACHED` |
| `maxVerificationAttemptsPerCommand` | 1–5 | 2 | `VERIFICATION_LIMIT_REACHED` |
| `maxFinalAuditsPerBatch` | 1 | 1 | `FINAL_AUDIT_LIMIT_REACHED` |
| `maxAgentInvocationsPerBatch` | 1–100 | 12 | `INVOCATION_LIMIT_REACHED` |
| `maxTotalAgentInvocations` | 1–2000 | 100 | `INVOCATION_LIMIT_REACHED` |
| `maxBatchRuntimeMinutes` | 1–10080 | 240 | `BATCH_RUNTIME_LIMIT_REACHED` |
| `maxWorkflowRuntimeMinutes` | 1–20160 | 1440 | `WORKFLOW_RUNTIME_LIMIT_REACHED` |
| `maxConsecutiveNoProgressActions` | 1–10 | 2 | `NO_PROGRESS_LIMIT_REACHED` |
| `maxInputTokensPerBatch` | ≥1 | 500000 | `TOKEN_BUDGET_REACHED` |
| `maxOutputTokensPerBatch` | ≥1 | 100000 | `TOKEN_BUDGET_REACHED` |
| `maxCostUsdPerWorkflow` | >0 | 25 | `COST_BUDGET_REACHED` |
| `heartbeatIntervalSeconds` | 5–300 | 30 | — |
| `heartbeatExpirySeconds` | 30–3600 | 120 | `WORKER_HEARTBEAT_EXPIRED` / stall detection |

## `memory`

`embeddingModel` (optional), `autoExtractFacts` (default true), `contextBudget.activeContext`
(default 8000), `.retrievedMemory` (4000), `.messageBuffer` (2000).

## `budget` — legacy session cost budgets (USD)

`perSession` (5), `perDay` (25), `perMonth` (200), `warningAt` (0.8), `action`
(`warn`/`pause`/`block`, default `warn`). Note: the autonomous runner's enforced cost cap is
`reviewGated.autonomous.maxCostUsdPerWorkflow`, derived from the immutable invocation audit.

## `output`

`saveTranscripts` (true), `transcriptFormat` (`markdown`/`json`), `transcriptDir`
(`.cowork/transcripts`).

## `advanced`

`retryAttempts` (1–10, default 3), `stream` (true), `logLevel`
(`debug`/`info`/`warn`/`error`, default `info`).

## Cross-field validation you can hit

- Every `roles.*.model` must name an existing `models` alias.
- `cliAdapter.kind` must match `provider` (claude↔anthropic, codex↔openai).
- `agentMayCommit` must agree with `commit.mode`.
- Review-gated workflows: `minimumAssurance` ≥ `process_attested`, `prohibitSharedSessions:
  true`, and — only when `requireDifferentAdapterKinds: true` — implementer and reviewer must
  resolve to different adapter kinds.

## Operational notes

- Add `.cowork/` and `.codemoot/` to the project's `.gitignore` (database, transcripts,
  git-guard, verification logs, patch artifacts).
- Model and policy changes apply to **new** workflows only; each workflow snapshots its
  configuration immutably at `workflow run`. Finish or cancel in-flight workflows before
  changing models.
- How to run the workflow itself: [review-workflow-autonomous-runner.md](review-workflow-autonomous-runner.md).
