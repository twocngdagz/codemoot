# Repository Development Guide

This file applies to the entire repository.

## Toolchain

- Use Node.js 22. Node.js 22.23.1 is pinned in `.nvmrc` and `.node-version`, and the root
  `package.json` supports the Node.js 22 release line.
- Use pnpm 9.15.9, pinned by the root `packageManager` and `engines` fields, with the checked-in
  `pnpm-lock.yaml` (lockfile format 9). Do not use npm or Yarn for repository installs.
- `better-sqlite3`, `esbuild`, and `@biomejs/biome` are the only dependencies whose install
  scripts are allowed by `pnpm-workspace.yaml`.
- Claude Code and Codex CLI are optional for ordinary build/unit-test work but are required for
  end-to-end exercises that invoke external model CLIs.

## Installing Dependencies

Run commands from the repository root.

```bash
pnpm install --frozen-lockfile
```

Confirm that `packages/cli/node_modules/@codemoot/core` and
`packages/mcp-server/node_modules/@codemoot/core` link to the local `packages/core` workspace,
not a registry copy.

## Monorepo Map

- `packages/core`: orchestration engine, configuration, workflow engine, SQLite-backed stores,
  policy/security code, model adapters, and most tests.
- `packages/cli`: Commander-based `codemoot` CLI and command tests.
- `packages/mcp-server`: experimental MCP server, tool handlers, tests, and an optional E2E
  harness.
- `packages/web`: placeholder package. Its build and type-check scripts currently only print
  `Sprint 3` messages.
- `presets`: built-in configuration presets.
- `workflows`: CodeMoot workflow YAML definitions. Do not redesign or alter workflow behavior
  unless the task explicitly calls for it.

The root Vitest configuration includes core, CLI, and MCP server projects; it does not include
the placeholder web package. There are currently no checked-in GitHub Actions or other CI
workflow files, so local root scripts are the verification source of truth.

## Development Conventions

- TypeScript is strict and ESM-only. Follow the root `tsconfig.json`; avoid `any`, unused
  declarations, implicit returns, and fallthrough.
- Biome 1.9 controls formatting, import organization, and linting. Use two-space indentation,
  single quotes in JavaScript/TypeScript, semicolons, and a 100-character line width.
- Keep package boundaries intact. `core` is shared by `cli` and `mcp-server`.
- Add or update Vitest coverage for behavior changes. Run tests from the monorepo root because
  `core` and `cli` do not define package-local `test` scripts.
- CLI commands that open a database should use the existing `withDatabase()` pattern or
  otherwise guarantee `db.close()`.
- Generated `dist` output, coverage, local databases, `.cowork*`, and `.codemoot` state are
  ignored artifacts and should not be committed.
- Keep changes focused. Do not refactor unrelated code or change application behavior as part
  of setup, documentation, or baseline-verification work.
- Do not run repository-wide automatic formatting or `pnpm lint:fix` to address the existing
  lint backlog unless a task explicitly owns that cleanup. Format only files in scope and do
  not mix unrelated Biome changes into focused work.

## Verification

Run the full baseline from the repository root:

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm lint
git diff --check
git status --short
```

Useful focused commands:

```bash
pnpm test -- packages/core/tests/unit/path/to/file.test.ts
pnpm --filter @codemoot/core typecheck
pnpm --filter @codemoot/cli typecheck
pnpm --filter @codemoot/mcp-server typecheck
pnpm --filter @codemoot/mcp-server test:e2e:quick
```

The MCP E2E harness is not part of the ordinary local baseline and may require external CLI
credentials and configuration.

Known baseline observed on 2026-07-29 with Node.js 22.23.1 and pnpm 9.15.9:

- `pnpm build` passes for core, CLI, and MCP; web reports its placeholder build.
- `pnpm test` passes. Avoid hard-coding the suite count here because it changes as coverage
  grows.
- `pnpm lint` fails with 147 existing Biome errors, including formatting/import organization
  and analyzer rules such as `noImplicitAnyLet`, `noNonNullAssertion`, and
  `noUnusedTemplateLiteral`.
- `pnpm typecheck` passes for core, CLI, and MCP; web reports its placeholder check.

When making a change, distinguish new failures from this recorded baseline and report both.
Do not fix unrelated baseline failures unless the task explicitly includes them.
Before declaring work complete, review the actual diff and status for unintended changes, then
run the relevant focused checks and the full verification commands above. Report every command
that does not pass.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `twocngdagz/codemoot`. See
`docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the canonical state labels, with `bug`/`enhancement` as broad categories and
`tech-debt` for internal quality debt. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository using root-level `CONTEXT.md` and `docs/adr/`. See
`docs/agents/domain.md`.
