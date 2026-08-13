# `.cowork.yml` — Complete Configuration Reference

The canonical reference for every configuration value. **`codemoot relay` uses only
`models` and `roles`** — everything under `reviewGated` applies to the review-gated
workflow alone; see [relay.md](relay.md) for the message-bus loop. The source of truth is the zod schema
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
| `kind` | `claude` \| `codex` \| `cursor` | inferred from provider | `claude` requires `provider: anthropic`; `codex` requires `provider: openai`; `cursor` requires `provider: cursor` |
| `command` | string | — required | Executable, e.g. `claude` or `codex` |
| `args` | string[] | — required | Base CLI args, **passed through to the CLI**. Codex convention: `[exec]`. This is where per-CLI options go, e.g. Codex reasoning effort: `[exec, -c, model_reasoning_effort=high]` (values: `high`/`medium`/`low`) |
| `timeout` | positive seconds | — required | Per-invocation subprocess timeout (absolute wall clock). **This is the ceiling the autonomous runner uses** when no explicit `--timeout` is passed. Measured: one plan refinement of a 66 KB plan took 20-30 min at `--effort max` and was still writing at 30 min — set 7200 (2 h) for large plans |
| `idleTimeout` | positive seconds | claude 120 · codex 600 | Seconds the CLI may produce **no output** before being killed — honoured by BOTH adapter kinds. Deep reasoning can think silently for minutes; raise this (e.g. `900`) for those runs, or the run dies mid-think. Claude's complementary lever is `--include-partial-messages` in `args`, which keeps output flowing during generation. **Codex has no equivalent** — it emits events only at item boundaries and is structurally silent while reasoning — so its default is 10 minutes and `idleTimeout` is the only lever |
| `versionConstraint` | string | optional | Semver constraint on the CLI version |
| `outputFile` | string | optional | Legacy output-file mode (Codex) |
| `maxOutputBytes` | positive int | optional | Output capture cap |
| `envAllowlist` | string[] | optional | Extra environment variables passed to the CLI subprocess (everything else is filtered). E.g. `[MAX_THINKING_TOKENS]` lets `export MAX_THINKING_TOKENS=31999` deepen Claude's thinking |

**Output-ceiling pitfall (measured):** a 43-minute refinement failed with *"Claude's
response exceeded the 64000 output token maximum"*. The CLI's remedy —
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` — is allowlisted by default (as is `MAX_THINKING_TOKENS`),
but the allowlist only forwards variables that already exist, so export it in the launching
shell:

```bash
CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000 codemoot workflow run --plan <plan.md> --background
```

If a run fails at the same number despite the variable being set, the ceiling is the
model's rather than the client's, and the response genuinely cannot fit in one turn — the
fix is then to reduce what a single invocation must emit, not to raise the limit.

**Cost reality (measured, `--effort max`, 137-140 KB prompt):** a SINGLE plan-refinement
invocation cost **$3.40-$5.07** and ran 13-30 minutes. At that rate
`maxTotalAgentInvocations: 100` implies a ceiling in the hundreds of dollars, while
`maxCostUsdPerWorkflow` (default 25) binds first and stops the workflow with
`COST_BUDGET_REACHED`. Set both deliberately for large plans — they are not reconcilable by
default at realistic prompt sizes.

**Timeouts compose, they do not conflict:** `cliAdapter.timeout` is the ceiling;
`--timeout` overrides it for one command; `--background` forwards whichever applies to the
detached worker. `idleTimeout` is a separate silence detector, not a total-runtime limit.

**Silent-thinking pitfall:** at high effort the CLI can emit nothing for minutes while it
reasons. The default 120s `idleTimeout` will kill such a run (`Claude CLI idle timeout (no
output for 120000ms…)`). Raise `idleTimeout`, and/or add `--include-partial-messages` to
`args` so chunks stream during generation. Partial messages increase volume — raise
`maxOutputBytes` alongside it. Killed invocations now persist whatever the CLI emitted, so
`workflow logs` shows how far the agent actually got.

**Reasoning "level" cheat-sheet:**
- **Claude:** append `[--effort, <level>]` to `args` — valid levels, fast → smart:
  `low | medium | high | xhigh | max`. Model tier is the other lever
  (`claude-opus-5` > `claude-sonnet-5` > `claude-sonnet-4-5`); `MAX_THINKING_TOKENS` via
  `envAllowlist` remains available for explicit thinking budgets.
- **Codex:** append `-c model_reasoning_effort=high|medium|low` to `args`.

### Cursor (`kind: cursor`)

`cursor-agent` is a **router**: one CLI serving Anthropic, OpenAI, xAI and Moonshot models,
on its own subscription. That makes it a third route rather than a duplicate — it reaches
models neither other adapter can (Grok, Kimi, Composer, the GPT/Sol family), and it keeps
working when another provider's budget is exhausted.

```yaml
reviewer:
  provider: cursor              # 'cursor' is the ROUTER, not the underlying vendor
  model: gpt-5.6-sol-medium     # effort is PART of the id; there is no effort flag
  cliAdapter:
    kind: cursor
    command: cursor-agent
    args: [-p, --force, --output-format, stream-json]
    timeout: 604800
    idleTimeout: 604800         # GPT/Sol models work in total silence — see below
```

- **`--force` (or `--yolo`/`--trust`) is mandatory and validated at config load.** Without
  it a headless run writes a workspace-trust prompt to stderr, emits **zero stdout**, and
  waits forever — which under a runner is not a fast failure but an idle-timeout kill after
  the entire silence budget. Config validation rejects it up front.
- **`--output-format stream-json`, never `text`.** `text` buffers to the very end, so an
  in-progress run shows zero bytes and reads as hung.
- **Silence is not death here.** Claude with `--include-partial-messages` speaks every ~5s;
  GPT/Sol models work silently and speak when finished — measured at 52 seconds and at 15
  minutes, both healthy. Set `idleTimeout` to the workflow ceiling for GPT-family models.
  The adapter's own default is 10 minutes rather than Claude's 2.
- **Effort is part of the model id** (`gpt-5.6-sol-{none,low,medium,high,xhigh,max}`, each
  with a `-fast` variant). The id is passed through verbatim; no effort flag is synthesised.
  `cursor-agent --list-models` shows what your account can reach.
- **Content refusals are their own failure.** Any GPT-family run is subject to OpenAI's
  cybersecurity filter, which kills the run mid-flight and returns no verdict — triggered in
  practice by test fixtures containing fake tokens, and by asking whether a security guard
  could be defeated. CodeMoot surfaces this as a distinct refusal error, not a crash, so you
  re-frame or switch model instead of hunting a bug.

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

### `planAsIs` — use the supplied plan verbatim

`reviewGated.planAsIs: true` (or `codemoot workflow run --plan-as-is`) runs the workflow
with the plan **exactly as written**: no LLM refinement rewrites it into batch plans, and no
plan-review gate runs. Built for plans that were already authored and reviewed outside the
workflow, where a rewrite re-plans redundantly and can degrade precision.

- **Batches** come from the plan's own `## Batch N` headings (order of appearance; any
  heading level). Everything before the first batch heading belongs to batch 1. A plan with
  no batch headings is one batch.
- **Approval is honest**: each batch moves `DRAFT → APPROVED_FOR_IMPLEMENTATION` through an
  explicit `ACCEPT_PLAN_AS_IS` transition on the operator's own authority
  (HUMAN/SYSTEM + WORKFLOW_OWNER, recorded in the immutable audit) — never a fabricated
  reviewer approval, and agents can never fire it.
- **Everything from implementation on is unchanged**: code review ↔ correction,
  verification, final audit, merge gate, gated push.
- **Verification runs the plan's OWN commands.** Put them in fenced ` ```sh ` / ` ```bash `
  blocks under any heading containing "Verification" — one command per line, run exactly as
  written via `sh -c` (so `composer check`, pipes, and env prefixes behave like your
  shell). A verification section inside a batch's span belongs to that batch; one before
  the first batch heading is plan-wide and runs for **every** batch. Comment lines, blanks,
  and a leading `$ ` are dropped. Only when a batch declares **nothing** does it fall back
  to a minimal `git status --porcelain` (the merge gate requires ≥1 accepted verification
  record) — and that fallback is a logged **WARNING** naming the batch, because it proves
  nothing about correctness.
- **The mode must engage or fail.** If plan-as-is is requested but cannot be recorded in
  both the configuration snapshot and the frozen runner state (for example, a stale
  `@codemoot/core` build whose schema predates the field), `workflow run` refuses with an
  explicit error instead of silently falling back to the refined rewrite.
- **The mode is frozen at workflow start** (runner state), like the autonomous limits: a
  config edit or dropped flag never flips a running workflow. `run-resume --plan-as-is` on
  a workflow that started refined fails instead of switching.

The default (`planAsIs: false`) is the refined behavior, unchanged.

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
