# CodeMoot

[![CI](https://github.com/katarmal-ram/codemoot/actions/workflows/ci.yml/badge.svg)](https://github.com/katarmal-ram/codemoot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A second opinion for AI-generated code.** Claude Code + Codex CLI collaboration platform that brings debate, review, autofix, and consensus patterns to your development workflow.

CodeMoot bridges Claude and GPT so they work as partners — one plans, the other reviews, and together they build better code than either could alone.

## Quick Start

```bash
# Install globally
npm install -g @codemoot/cli

# One-command setup: verifies codex, creates config, runs first review
codemoot start

# Or step by step:
codemoot doctor           # check prerequisites
codemoot init             # create .cowork.yml
codemoot review src/      # review code with GPT
codemoot fix src/         # autofix loop: review → fix → re-review

# Debate architecture with GPT
codemoot debate start "Should we use REST or GraphQL?"

# Build features the review-gated way (recommended)
codemoot init --preset review-gated
codemoot workflow start --plan plan.md

# Ship with confidence
codemoot shipit --profile safe
```

## Prerequisites

- Node.js 22; version 22.23.1 is pinned for source development.
- pnpm 9.15.9 for source development, managed through Corepack.
- At least one supported agent CLI:
  - [Claude Code CLI](https://claude.com/claude-code) for Anthropic models.
  - [Codex CLI](https://github.com/openai/codex) for OpenAI models (`npm install -g @openai/codex`).
- Authentication or a subscription for every configured CLI.
- A clean Git repository for autonomous review-gated workflows.

The default `review-gated` preset uses Claude Code as implementer and Codex CLI as reviewer.
Projects may configure two separate Claude models instead, provided role sessions remain
separate and `requireDifferentAdapterKinds` is disabled explicitly — see
[docs/configuration.md](docs/configuration.md).

## Commands

### Getting Started

| Command | Description |
|---------|-------------|
| `codemoot start` | First-run concierge: verify codex, init config, run quick review |
| `codemoot doctor` | Preflight diagnostics: check codex, config, database, git, node |
| `codemoot init` | Initialize CodeMoot in current project |

### Core Workflows

| Command | Description |
|---------|-------------|
| `codemoot review <file>` | Code review via GPT with structured findings |
| `codemoot review --prompt "..."` | Freeform review — GPT explores codebase via tools |
| `codemoot review --diff HEAD~3..HEAD` | Review git changes |
| `codemoot review --preset security-audit` | Use named preset (5 built-in) |
| `codemoot fix <file>` | Autofix loop: review → apply fixes → re-review |
| `codemoot cleanup [path]` | Scan for unused deps, dead code, duplicates, hardcoded values |
| `codemoot plan <task>` | Generate plan via architect + reviewer loop |
| `codemoot run <task>` | Full plan-review-implement cycle |

### Multi-Model Debate

| Command | Description |
|---------|-------------|
| `codemoot debate start <topic>` | Start a Claude vs GPT debate (`--timeout` sets default) |
| `codemoot debate turn <id> <prompt>` | Send next prompt (`--output`, `--force`, `--quiet`, `--response-cap`) |
| `codemoot debate next <id>` | Auto-continue debate (`--quiet` for programmatic use) |
| `codemoot debate status <id>` | Show debate progress |
| `codemoot debate list` | List all debates |
| `codemoot debate history <id>` | Full message history (`--output <file>` for untruncated export) |
| `codemoot debate complete <id>` | Mark debate as done |

### Autonomous Workflow Runner (recommended)

One command runs a complete review-gated workflow end to end — refinement, plan review,
implementation, bounded code reviews and corrections, verification, final audit, merge gate,
and a gated push — stopping at `READY_FOR_HUMAN_VERIFICATION`. CodeMoot never merges. See
[docs/review-workflow-autonomous-runner.md](docs/review-workflow-autonomous-runner.md) and
the full configuration reference in [docs/configuration.md](docs/configuration.md).

| Command | Description |
|---------|-------------|
| `codemoot workflow run --plan <file> [--background]` | Create and autonomously run a new workflow from a Markdown plan |
| `codemoot workflow watch <id>` | Stream durable heartbeats and checkpoints live |
| `codemoot workflow status <id>` | Runner status: phase, HEADs, active invocation, limits, next action |
| `codemoot workflow pause <id>` | Graceful pause after the current atomic action (first Ctrl-C does the same) |
| `codemoot workflow resume <id> [--background]` | Continue a paused workflow from the next unfinished action |
| `codemoot workflow decide <id> --action fix_again\|accept_risk\|cancel` | Explicit human decision on any stop (SHA-bound, immutable) |
| `codemoot workflow run-resume <id> [--background]` | Restart a crashed/stopped worker (receipt-bound recovery) |
| `codemoot workflow logs <id> [--phase ...]` | Immutable full prompt/response invocation audit |
| `codemoot workflow export <id> --output <file>` | Complete evidence bundle (state, logs, findings, transcripts) |

### Review-Gated Batch Workflow (manual per-batch commands)

Two separated agents — an implementer and an independent reviewer — build features in
review-gated batches: one bounded implement → review → correct → final-review cycle per
batch, then verification, a single final audit, and a merge gate that checks every condition
against durable evidence. No debate dependency; merges happen externally and are only
recorded (by a HUMAN or CI actor) — CodeMoot verifies the merge commit exists and contains
the approved commit, but does not authenticate who performed the merge. See
[docs/review-workflow-adoption.md](docs/review-workflow-adoption.md) for migration from the
legacy build loop and the current identity/commit limitations.

| Command | Description |
|---------|-------------|
| `codemoot workflow start --plan <file>` | Import an external plan and capture a repository audit |
| `codemoot workflow refine <id>` | Refine the plan into complete batch plans |
| `codemoot workflow status <id>` | Batch states, effective merge-approval state, and runner status |
| `codemoot batch review-plan / implement / complete-implementation` | Per-batch plan review and implementation |
| `codemoot batch review-code / respond` | One complete initial review, one correction pass, one bounded final review |
| `codemoot batch verify / attest-verification` | Execute approved verification commands and attest acceptance |
| `codemoot batch final-audit / gate / mark-merged` | Single completeness audit, full merge gate, external-merge recording |
| `codemoot workflow jobs run / list / show / cancel` | Background jobs with receipt-bound replay safety (`--background` on verify/review-code/final-audit) |
| `codemoot workflow events <id> --cursor <name> --ack` | Incremental workflow event feed with durable cursors |

### Automation

| Command | Description |
|---------|-------------|
| `codemoot shipit [--profile fast\|safe\|full]` | Composite workflow: lint → test → review → cleanup → commit |
| `codemoot watch` | Watch files, auto-enqueue reviews on save |
| `codemoot build start <task>` | **Deprecated** legacy build loop (stderr warning) — use the review-gated workflow |

### Background Jobs

| Command | Description |
|---------|-------------|
| `codemoot review --background` | Enqueue review, return immediately |
| `codemoot jobs list` | List background jobs |
| `codemoot jobs status <id>` | Job details with logs |
| `codemoot jobs logs <id>` | Full job log output |
| `codemoot jobs cancel <id>` | Cancel a job |
| `codemoot jobs retry <id>` | Retry a failed job |

### Session Management

| Command | Description |
|---------|-------------|
| `codemoot session start` | Start new persistent GPT session |
| `codemoot session current` | Show active session with token usage |
| `codemoot session list` | List all sessions |
| `codemoot session close <id>` | Close a session |

### Observability

| Command | Description |
|---------|-------------|
| `codemoot cost` | Token usage dashboard (by command, by day) |
| `codemoot events --follow` | Stream events as JSONL (for editors/CI) |

## Review Presets

| Preset | Focus | Timeout | Use Case |
|--------|-------|---------|----------|
| `security-audit` | Injection, auth, secrets | 1200s | Pre-deploy security scan |
| `performance` | N+1, memory, blocking | 900s | Performance optimization |
| `quick-scan` | Top bugs only | 240s | Quick sanity check |
| `pre-commit` | Changed code blockers | 180s | Git pre-commit hook |
| `api-review` | Contracts, versioning | 900s | API design review |

## Shipit Profiles

| Profile | Steps | Use Case |
|---------|-------|----------|
| `fast` | review | Quick check before push |
| `safe` | lint → test → review → cleanup | Default — catches most issues |
| `full` | lint → test → review → cleanup → commit | Full pipeline with auto-commit |

## Policy Engine

CodeMoot includes a built-in policy engine that gates actions:

- **Block on CRITICAL**: Any critical finding blocks the commit
- **Warn on NEEDS_REVISION**: Review verdict triggers a warning
- Custom rules via predicate-based engine (enforce/warn modes)

## Architecture

TypeScript monorepo with 4 packages:

| Package | Description | Status |
|---------|-------------|--------|
| `@codemoot/core` | Orchestration engine, memory, policy, caching | Stable |
| `@codemoot/cli` | Command-line interface | Stable |
| `@codemoot/mcp-server` | MCP server (5 tools for IDE integration) | Experimental |
| `@codemoot/web` | Placeholder for a future web UI | Planned |

### How It Works

CodeMoot assigns configured models to distinct workflow roles:

- The **implementer** plans, edits, tests, and corrects code.
- The **reviewer** independently reviews plans and committed implementation changes.
- **CodeMoot** coordinates both roles through durable state, separate sessions, immutable
  audit records, bounded review loops, verification gates, and Git evidence.

Supported CLI adapters include Claude Code and Codex CLI. A project may use Claude plus
Codex, or separate Claude models for both roles. Review-gated workflows prohibit shared
implementer and reviewer sessions.

Autonomous workflows run batch by batch on a dedicated branch, push completed work, and stop
at `READY_FOR_HUMAN_VERIFICATION`. CodeMoot never merges.

## Configuration

`.cowork.yml` in your project root:

```yaml
models:
  codex-architect:
    provider: openai
    model: gpt-5.3-codex
    providerMode: cli
  codex-reviewer:
    provider: openai
    model: gpt-5.3-codex
    providerMode: cli

roles:
  architect:
    model: codex-architect
  reviewer:
    model: codex-reviewer

workflow: plan-review-implement
mode: autonomous
```

### `.codemootignore`

Exclude files from review/cleanup/watch (gitignore syntax):

```
node_modules
dist
*.db
.env
```

## MCP Server (Experimental)

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "codemoot": {
      "command": "npx",
      "args": ["@codemoot/mcp-server"],
      "env": {
        "CODEMOOT_PROJECT_DIR": "/path/to/your/project"
      }
    }
  }
}
```

Tools: `codemoot_review`, `codemoot_plan`, `codemoot_debate`, `codemoot_memory`, `codemoot_cost`

## Development

```bash
git clone https://github.com/katarmal-ram/codemoot.git
cd codemoot
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test         # Vitest workspace suite
pnpm lint         # Biome linter
pnpm typecheck    # TypeScript strict checks
```

## Known Limitations

- Background job worker must be started manually (auto-spawn coming)
- Watch mode enqueues jobs but requires worker process
- MCP server is experimental — core + CLI are stable
- Autofix loop depends on GPT's ability to apply edits via Codex tools
- Windows path normalization may have edge cases

## License

MIT
