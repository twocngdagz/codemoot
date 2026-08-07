// Knowledge and configuration tools: a connected LLM can read the canonical CodeMoot docs
// and safely inspect, scaffold, validate, and update a project's .cowork.yml — including
// one in a DIFFERENT repository via the projectDir input. Writes are validate-first and
// atomic with a timestamped backup; an invalid configuration is never written.

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, reviewWorkflowIdentity, writeConfig } from '@codemoot/core';
import { z } from 'zod';
import { EMBEDDED_DOCS } from '../generated/docs.js';

const DOC_TOPICS = EMBEDDED_DOCS;
const DOC_TOPIC_NAMES = Object.keys(DOC_TOPICS) as [string, ...string[]];

const docsInputSchema = z.object({
  topic: z.enum(DOC_TOPIC_NAMES),
});

const projectDirSchema = z.object({
  projectDir: z.string().min(1).optional(),
});

const validateInputSchema = projectDirSchema.extend({
  content: z.string().min(1).optional(),
});

const initInputSchema = projectDirSchema.extend({
  preset: z.enum(['review-gated', 'cli-first']).default('review-gated'),
  force: z.boolean().default(false),
});

const setInputSchema = projectDirSchema.extend({
  content: z.string().min(1),
});

export const CONFIG_TOOL_DEFINITIONS = [
  {
    name: 'codemoot_docs',
    description:
      'Read the canonical CodeMoot documentation. ALWAYS read topic "configuration" before creating or editing a .cowork.yml, "autonomous-runner" before driving codemoot workflow commands, and "handoff-contracts" before authoring or debugging any agent JSON response (a wrong envelope field costs a full invocation). Adapter kinds are claude, codex and cursor — for cursor, read "configuration" first: it is a router (one CLI, many vendors), its effort level is part of the model id, and a headless run without --force silently produces nothing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          enum: DOC_TOPIC_NAMES,
          description: Object.entries(DOC_TOPICS)
            .map(([key, value]) => `${key}: ${value.summary}`)
            .join('; '),
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'codemoot_config_get',
    description:
      "Read a project's .cowork.yml (raw YAML plus a validation verdict and a role/model summary). projectDir may point at any repository. Reported adapter kinds are claude, codex or cursor.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectDir: {
          type: 'string',
          description: 'Project directory (default: the MCP project dir)',
        },
      },
    },
  },
  {
    name: 'codemoot_config_validate',
    description:
      'Validate a .cowork.yml without writing anything: either the file in projectDir, or candidate YAML passed as content. Returns structured errors and, for review-gated configs, verifies a workflow snapshot can be built.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectDir: {
          type: 'string',
          description: 'Project directory (default: the MCP project dir)',
        },
        content: { type: 'string', description: 'Candidate YAML to validate instead of the file' },
      },
    },
  },
  {
    name: 'codemoot_config_init',
    description:
      'Scaffold a new .cowork.yml from a preset (default review-gated). Refuses to overwrite an existing file unless force is true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectDir: {
          type: 'string',
          description: 'Project directory (default: the MCP project dir)',
        },
        preset: { type: 'string', enum: ['review-gated', 'cli-first'], default: 'review-gated' },
        force: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'codemoot_config_set',
    description:
      "Replace a project's .cowork.yml with the provided YAML. The content is fully validated FIRST (schema, cross-field rules, and — for review-gated — a workflow-snapshot probe); an invalid configuration is never written. The previous file is kept as a timestamped .bak.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectDir: {
          type: 'string',
          description: 'Project directory (default: the MCP project dir)',
        },
        content: { type: 'string', description: 'The complete new .cowork.yml content' },
      },
      required: ['content'],
    },
  },
];

interface ValidationOutcome {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly summary?: Readonly<Record<string, unknown>>;
}

/** Validates YAML content by loading it exactly the way every codemoot command would. */
function validateContent(content: string): ValidationOutcome {
  const probeDir = mkdtempSync(join(tmpdir(), 'codemoot-config-probe-'));
  try {
    writeFileSync(join(probeDir, '.cowork.yml'), content);
    const config = loadConfig({ projectDir: probeDir });
    const summary: Record<string, unknown> = {
      workflow: config.workflow,
      roles: Object.fromEntries(
        Object.entries(config.roles).map(([role, roleConfig]) => {
          const model = config.models[roleConfig.model];
          return [role, { model: model?.model, adapter: model?.cliAdapter?.kind ?? 'api' }];
        }),
      ),
    };
    if (config.workflow === 'review-gated-batches') {
      // The same snapshot every workflow builds at start: if this fails, workflow run fails.
      const snapshot = reviewWorkflowIdentity.createReviewWorkflowConfigurationSnapshot(config, {
        workflowId: 'config-validate-probe',
        implementerAssignmentId: 'probe-implementer',
        reviewerAssignmentId: 'probe-reviewer',
        assignedAt: new Date().toISOString(),
      });
      summary.reviewGated = {
        implementerAdapterKind: snapshot.assignments.implementer.expectedAdapterKind,
        reviewerAdapterKind: snapshot.assignments.reviewer.expectedAdapterKind,
        requireDifferentAdapterKinds: snapshot.identityPolicy.requireDifferentAdapterKinds,
        commitPolicy: snapshot.commitPolicy,
        pacing: snapshot.pacing,
      };
    }
    return { valid: true, errors: [], summary };
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

function resolveProjectDir(defaultDir: string, requested: string | undefined): string {
  return resolve(requested ?? defaultDir);
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function handleDocs(args: unknown) {
  const input = docsInputSchema.parse(args);
  const topic = DOC_TOPICS[input.topic as keyof typeof DOC_TOPICS];
  return { content: [{ type: 'text' as const, text: topic.doc }] };
}

export function handleConfigGet(defaultDir: string, args: unknown) {
  const input = projectDirSchema.parse(args);
  const projectDir = resolveProjectDir(defaultDir, input.projectDir);
  const configPath = join(projectDir, '.cowork.yml');
  if (!existsSync(configPath)) {
    return jsonResult({
      projectDir,
      exists: false,
      hint: 'No .cowork.yml here — use codemoot_config_init to scaffold one',
    });
  }
  const raw = readFileSync(configPath, 'utf8');
  const validation = validateContent(raw);
  return jsonResult({ projectDir, exists: true, ...validation, raw });
}

export function handleConfigValidate(defaultDir: string, args: unknown) {
  const input = validateInputSchema.parse(args);
  if (input.content !== undefined) {
    return jsonResult(validateContent(input.content));
  }
  const projectDir = resolveProjectDir(defaultDir, input.projectDir);
  const configPath = join(projectDir, '.cowork.yml');
  if (!existsSync(configPath)) {
    return jsonResult({ valid: false, errors: [`No .cowork.yml found in ${projectDir}`] });
  }
  return jsonResult({ projectDir, ...validateContent(readFileSync(configPath, 'utf8')) });
}

export function handleConfigInit(defaultDir: string, args: unknown) {
  const input = initInputSchema.parse(args);
  const projectDir = resolveProjectDir(defaultDir, input.projectDir);
  const configPath = join(projectDir, '.cowork.yml');
  if (existsSync(configPath) && !input.force) {
    return jsonResult({
      projectDir,
      written: false,
      error: '.cowork.yml already exists; pass force: true to overwrite',
    });
  }
  const config = loadConfig({ preset: input.preset, skipFile: true });
  writeConfig(config, projectDir);
  const written = readFileSync(configPath, 'utf8');
  return jsonResult({ projectDir, written: true, preset: input.preset, raw: written });
}

export function handleConfigSet(defaultDir: string, args: unknown) {
  const input = setInputSchema.parse(args);
  const projectDir = resolveProjectDir(defaultDir, input.projectDir);
  const configPath = join(projectDir, '.cowork.yml');
  const validation = validateContent(input.content);
  if (!validation.valid) {
    return jsonResult({
      projectDir,
      written: false,
      ...validation,
      hint: 'Nothing was written — fix the errors above (see codemoot_docs topic "configuration")',
    });
  }
  let backup: string | undefined;
  if (existsSync(configPath)) {
    backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(configPath, backup);
  }
  writeFileSync(configPath, input.content);
  return jsonResult({
    projectDir,
    written: true,
    ...(backup === undefined ? {} : { backup }),
    ...validation,
  });
}
