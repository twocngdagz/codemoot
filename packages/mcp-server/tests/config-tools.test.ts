// Knowledge + configuration tools: an external LLM must be able to learn CodeMoot from the
// embedded docs and safely manage a .cowork.yml in ANY repository — with validate-first
// writes that can never persist an invalid configuration.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMBEDDED_DOCS } from '../src/generated/docs.js';
import {
  CONFIG_TOOL_DEFINITIONS,
  handleConfigGet,
  handleConfigInit,
  handleConfigSet,
  handleConfigValidate,
  handleDocs,
} from '../src/tools/config.js';

function payload(result: { content: readonly { text: string }[] }): Record<string, unknown> {
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('codemoot_docs', () => {
  it('serves the canonical configuration and runner knowledge', () => {
    const configuration = handleDocs({ topic: 'configuration' }).content[0]?.text ?? '';
    expect(configuration).toContain('reviewGated');
    expect(configuration).toContain('maxCostUsdPerWorkflow');
    expect(configuration).toContain('requireDifferentAdapterKinds');
    const runner = handleDocs({ topic: 'autonomous-runner' }).content[0]?.text ?? '';
    expect(runner).toContain('READY_FOR_HUMAN_VERIFICATION');
    const quickstart = handleDocs({ topic: 'quickstart' }).content[0]?.text ?? '';
    expect(quickstart).toContain('workflow run');
    // The contract envelope must be reachable: an agent that guesses "kind" instead of
    // "contractKind" loses a whole invocation.
    const contracts = handleDocs({ topic: 'handoff-contracts' }).content[0]?.text ?? '';
    expect(contracts).toContain('contractKind');
    expect(contracts).toContain('REFINEMENT_RESULT');
  });

  it('rejects unknown topics', () => {
    expect(() => handleDocs({ topic: 'nope' })).toThrow();
  });

  it('reaches EVERY repository doc — no doc can be silently unreachable', () => {
    // The glob is the point: a hand-picked list is how the contract envelope stayed
    // invisible to connected LLMs while the doc sat in the repo.
    const topics = Object.keys(EMBEDDED_DOCS);
    expect(topics.length).toBeGreaterThanOrEqual(20);
    for (const required of [
      'configuration',
      'autonomous-runner',
      'handoff-contracts',
      'quickstart',
      'merge-gate',
      'session-continuity',
      'verification',
      'idempotency',
    ]) {
      expect(topics, required).toContain(required);
    }
    // Every topic serves real content and a non-empty summary for tool discovery.
    for (const [topic, entry] of Object.entries(EMBEDDED_DOCS)) {
      expect(entry.doc.length, topic).toBeGreaterThan(50);
      expect(entry.summary.length, topic).toBeGreaterThan(3);
      expect(handleDocs({ topic }).content[0]?.text).toBe(entry.doc);
    }
  });
});

describe('config tools', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'codemoot-mcp-config-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('init scaffolds a valid review-gated config and refuses accidental overwrite', () => {
    const first = payload(handleConfigInit(projectDir, {}));
    expect(first.written).toBe(true);
    expect(existsSync(join(projectDir, '.cowork.yml'))).toBe(true);

    const second = payload(handleConfigInit(projectDir, {}));
    expect(second.written).toBe(false);
    expect(String(second.error)).toContain('already exists');

    const get = payload(handleConfigGet(projectDir, {}));
    expect(get.exists).toBe(true);
    expect(get.valid).toBe(true);
  });

  it('get reports a missing file with a scaffold hint', () => {
    const result = payload(handleConfigGet(projectDir, {}));
    expect(result.exists).toBe(false);
    expect(String(result.hint)).toContain('codemoot_config_init');
  });

  it('validate returns structured errors for invalid candidate content', () => {
    const invalid = payload(
      handleConfigValidate(projectDir, {
        content: 'configVersion: 3\nmodels: {}\nroles:\n  reviewer:\n    model: missing\n',
      }),
    );
    expect(invalid.valid).toBe(false);
    expect((invalid.errors as string[]).length).toBeGreaterThan(0);
  });

  it('validate probes the review-gated workflow snapshot, including single-vendor setups', () => {
    handleConfigInit(projectDir, {});
    const original = readFileSync(join(projectDir, '.cowork.yml'), 'utf8');
    const allClaude = original
      .replace(/provider: openai/g, 'provider: anthropic')
      .replace(/model: gpt[^\n]*/g, 'model: claude-opus-4-5')
      .replace(/kind: codex/g, 'kind: claude')
      .replace(/command: codex/g, 'command: claude')
      .replace(/requireDifferentAdapterKinds: true/g, 'requireDifferentAdapterKinds: false');
    const result = payload(handleConfigValidate(projectDir, { content: allClaude }));
    expect(result.valid).toBe(true);
    const summary = result.summary as { reviewGated?: { reviewerAdapterKind?: string } };
    expect(summary.reviewGated?.reviewerAdapterKind).toBe('CLAUDE');
  });

  it('set validates first, writes atomically with a backup, and never writes invalid YAML', () => {
    handleConfigInit(projectDir, {});
    const original = readFileSync(join(projectDir, '.cowork.yml'), 'utf8');

    // Invalid replacement: refused, file untouched.
    const refused = payload(handleConfigSet(projectDir, { content: 'not: [valid config' }));
    expect(refused.written).toBe(false);
    expect(readFileSync(join(projectDir, '.cowork.yml'), 'utf8')).toBe(original);

    // Valid replacement: written, previous content preserved as a timestamped backup.
    const updated = original.replace('review-gated-batches', 'review-gated-batches');
    const accepted = payload(
      handleConfigSet(projectDir, { content: `${updated}\n# updated-by-mcp\n` }),
    );
    expect(accepted.written).toBe(true);
    expect(readFileSync(join(projectDir, '.cowork.yml'), 'utf8')).toContain('# updated-by-mcp');
    const backups = readdirSync(projectDir).filter((name) => name.startsWith('.cowork.yml.bak-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(projectDir, backups[0] ?? ''), 'utf8')).toBe(original);
  });

  it('operates on an explicit projectDir pointing at another repository', () => {
    const otherRepo = mkdtempSync(join(tmpdir(), 'codemoot-mcp-other-'));
    try {
      const init = payload(handleConfigInit('/nonexistent-default', { projectDir: otherRepo }));
      expect(init.written).toBe(true);
      const get = payload(handleConfigGet('/nonexistent-default', { projectDir: otherRepo }));
      expect(get.exists).toBe(true);
      expect(get.valid).toBe(true);
    } finally {
      rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  it('publishes complete tool definitions', () => {
    const names = CONFIG_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toEqual([
      'codemoot_docs',
      'codemoot_config_get',
      'codemoot_config_validate',
      'codemoot_config_init',
      'codemoot_config_set',
    ]);
    for (const tool of CONFIG_TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});
