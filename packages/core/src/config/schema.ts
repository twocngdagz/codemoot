// packages/core/src/config/schema.ts

import { z } from 'zod';
import { resolveConfiguredAdapterKind } from '../review-workflow-identity/service.js';
import {
  CONTEXT_ACTIVE,
  CONTEXT_BUFFER,
  CONTEXT_RETRIEVED,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_SEC,
} from '../utils/constants.js';
import { ConfigError } from '../utils/errors.js';
import { COMPATIBILITY_REVIEW_GATED_CONFIG } from './review-gated.js';

export const modelProviderSchema = z.enum(['openai', 'anthropic']);
export const cliAdapterKindSchema = z.enum(['codex', 'claude']);

export const cliAdapterConfigSchema = z.object({
  kind: cliAdapterKindSchema.optional(),
  command: z.string().min(1),
  args: z.array(z.string()),
  timeout: z.number().positive(),
  /**
   * Seconds the CLI may produce NO output before it is killed. Deep reasoning (high
   * `--effort`, large prompts) can think silently for minutes, so this must be raisable.
   */
  idleTimeout: z.number().positive().optional(),
  versionConstraint: z.string().min(1).optional(),
  outputFile: z.string().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  envAllowlist: z.array(z.string()).optional(),
});

export const modelConfigSchema = z
  .object({
    provider: modelProviderSchema,
    model: z.string().min(1),
    maxTokens: z.number().int().positive().default(DEFAULT_MAX_TOKENS),
    temperature: z.number().min(0).max(2).default(0.7),
    timeout: z.number().positive().default(DEFAULT_TIMEOUT_SEC),
    cliAdapter: cliAdapterConfigSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.cliAdapter?.kind === 'claude' && value.provider !== 'anthropic') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cliAdapter', 'kind'],
        message: 'Claude CLI adapters require provider "anthropic"',
      });
    }
    if (value.cliAdapter?.kind === 'codex' && value.provider !== 'openai') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cliAdapter', 'kind'],
        message: 'Codex CLI adapters require provider "openai"',
      });
    }
  })
  .transform((value) => ({
    ...value,
    ...(value.cliAdapter === undefined
      ? {}
      : {
          cliAdapter: {
            ...value.cliAdapter,
            kind: value.cliAdapter.kind ?? (value.provider === 'anthropic' ? 'claude' : 'codex'),
          },
        }),
  }));

const roleConfigSchema = z.object({
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  systemPromptFile: z.string().optional(),
});

const debatePatternSchema = z.enum([
  'structured-rounds',
  'proposal-critique',
  'free-flowing',
  'parallel-panel',
]);

const debateConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaultPattern: debatePatternSchema.default('proposal-critique'),
  maxRounds: z.number().int().positive().max(10).default(3),
  consensusThreshold: z.number().min(0).max(1).default(0.7),
});

export const reviewGatedIdentityConfigSchema = z.object({
  minimumAssurance: z
    .enum(['authenticated_subject', 'cli_asserted', 'process_attested', 'config_only'])
    .default('config_only'),
  requireDifferentAdapterKinds: z.boolean().default(false),
  prohibitSharedSessions: z.boolean().default(true),
});

export const reviewGatedCommitConfigSchema = z
  .object({
    mode: z.enum(['human_required', 'agent_authorized', 'either']).default('human_required'),
    agentMayCommit: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    const modeAllowsAgent = value.mode !== 'human_required';
    if (value.agentMayCommit !== modeAllowsAgent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentMayCommit'],
        message:
          value.mode === 'human_required'
            ? 'agentMayCommit must be false when commit mode is human_required'
            : `agentMayCommit must be true when commit mode is ${value.mode}`,
      });
    }
  });

export const reviewGatedGateConfigSchema = z
  .object({
    planReview: z.literal('required').default('required'),
    codeReview: z.literal('required').default('required'),
    verification: z.literal('required').default('required'),
    humanMerge: z.literal('required').default('required'),
    blockingSeverities: z
      .array(z.enum(['critical', 'high', 'medium', 'low']))
      .min(1)
      .default(['critical', 'high']),
    requireAllFindingResponses: z.boolean().default(true),
    requireAcceptedAttestations: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    if (new Set(value.blockingSeverities).size !== value.blockingSeverities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockingSeverities'],
        message: 'Blocking severities must be unique',
      });
    }
  });

export const reviewGatedPacingConfigSchema = z.object({
  maxCodeReviewRounds: z.number().int().min(1).max(5).default(3),
  maxCorrectionPasses: z.number().int().min(0).max(4).default(2),
  deferNonBlockingFindings: z.literal(true).default(true),
  unresolvedAfterFinalReview: z
    .literal('human_decision_required')
    .default('human_decision_required'),
});

// Every autonomous limit is finite and validated: no unbounded loops, budgets, or runtimes.
export const reviewGatedAutonomousConfigSchema = z.object({
  maxPlanReviewRoundsPerBatch: z.number().int().min(1).max(5).default(2),
  maxCodeReviewRoundsPerBatch: z.number().int().min(1).max(5).default(3),
  maxCorrectionPassesPerBatch: z.number().int().min(0).max(4).default(2),
  maxVerificationAttemptsPerCommand: z.number().int().min(1).max(5).default(2),
  maxFinalAuditsPerBatch: z.number().int().min(1).max(1).default(1),
  maxAgentInvocationsPerBatch: z.number().int().min(1).max(100).default(12),
  maxTotalAgentInvocations: z.number().int().min(1).max(2000).default(100),
  maxBatchRuntimeMinutes: z.number().int().min(1).max(10_080).default(240),
  maxWorkflowRuntimeMinutes: z.number().int().min(1).max(20_160).default(1440),
  maxConsecutiveNoProgressActions: z.number().int().min(1).max(10).default(2),
  maxInputTokensPerBatch: z.number().int().min(1).default(500_000),
  maxOutputTokensPerBatch: z.number().int().min(1).default(100_000),
  maxCostUsdPerWorkflow: z.number().positive().finite().default(25),
  heartbeatIntervalSeconds: z.number().int().min(5).max(300).default(30),
  heartbeatExpirySeconds: z.number().int().min(30).max(3600).default(120),
});

export const reviewGatedConfigSchema = z.object({
  identity: reviewGatedIdentityConfigSchema.default(COMPATIBILITY_REVIEW_GATED_CONFIG.identity),
  commit: reviewGatedCommitConfigSchema.default(COMPATIBILITY_REVIEW_GATED_CONFIG.commit),
  gates: reviewGatedGateConfigSchema.default(COMPATIBILITY_REVIEW_GATED_CONFIG.gates),
  pacing: reviewGatedPacingConfigSchema.default(COMPATIBILITY_REVIEW_GATED_CONFIG.pacing),
  autonomous: reviewGatedAutonomousConfigSchema.default({}),
});

const memoryConfigSchema = z.object({
  embeddingModel: z.string().optional(),
  autoExtractFacts: z.boolean().default(true),
  contextBudget: z
    .object({
      activeContext: z.number().int().positive().default(CONTEXT_ACTIVE),
      retrievedMemory: z.number().int().positive().default(CONTEXT_RETRIEVED),
      messageBuffer: z.number().int().positive().default(CONTEXT_BUFFER),
    })
    .default({}),
});

const budgetConfigSchema = z.object({
  perSession: z.number().nonnegative().default(5.0),
  perDay: z.number().nonnegative().default(25.0),
  perMonth: z.number().nonnegative().default(200.0),
  warningAt: z.number().min(0).max(1).default(0.8),
  action: z.enum(['warn', 'pause', 'block']).default('warn'),
});

const outputConfigSchema = z.object({
  saveTranscripts: z.boolean().default(true),
  transcriptFormat: z.enum(['markdown', 'json']).default('markdown'),
  transcriptDir: z.string().default('.cowork/transcripts'),
});

const executionModeSchema = z.enum(['autonomous', 'interactive', 'dashboard']);

const advancedConfigSchema = z.object({
  retryAttempts: z.number().int().positive().max(10).default(3),
  stream: z.boolean().default(true),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export const projectConfigSchema = z
  .object({
    configVersion: z.literal(3).default(3),
    project: z
      .object({
        name: z.string().default(''),
        description: z.string().default(''),
      })
      .default({}),
    models: z.record(z.string(), modelConfigSchema),
    roles: z.record(z.string(), roleConfigSchema),
    workflow: z.string().default('plan-review-implement'),
    mode: executionModeSchema.default('autonomous'),
    debate: debateConfigSchema.default({}),
    reviewGated: reviewGatedConfigSchema.default(COMPATIBILITY_REVIEW_GATED_CONFIG),
    memory: memoryConfigSchema.default({}),
    budget: budgetConfigSchema.default({}),
    output: outputConfigSchema.default({}),
    advanced: advancedConfigSchema.default({}),
  })
  .superRefine((data, ctx) => {
    const modelAliases = Object.keys(data.models);
    for (const [roleName, roleConfig] of Object.entries(data.roles)) {
      if (!modelAliases.includes(roleConfig.model)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roles', roleName, 'model'],
          message: `Role "${roleName}" references model "${roleConfig.model}" which is not defined in models. Available: ${modelAliases.join(', ')}`,
        });
      }
    }
    if (data.workflow !== 'review-gated-batches') return;

    const implementerRole = data.roles.implementer;
    const reviewerRole = data.roles.reviewer;
    if (implementerRole === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles', 'implementer'],
        message: 'Review-gated workflow requires an implementer role',
      });
    }
    if (reviewerRole === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles', 'reviewer'],
        message: 'Review-gated workflow requires a reviewer role',
      });
    }
    if (implementerRole === undefined || reviewerRole === undefined) return;

    if (implementerRole.model === reviewerRole.model) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles', 'reviewer', 'model'],
        message: 'Implementer and reviewer must use different configured agent keys',
      });
    }
    if (!data.reviewGated.identity.prohibitSharedSessions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewGated', 'identity', 'prohibitSharedSessions'],
        message: 'Review-gated workflows must prohibit shared implementer/reviewer sessions',
      });
    }
    if (data.reviewGated.identity.minimumAssurance === 'config_only') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewGated', 'identity', 'minimumAssurance'],
        message: 'Review-gated workflows require process_attested identity assurance or stronger',
      });
    }

    const implementerModel = data.models[implementerRole.model];
    const reviewerModel = data.models[reviewerRole.model];
    if (
      data.reviewGated.identity.requireDifferentAdapterKinds &&
      implementerModel !== undefined &&
      reviewerModel !== undefined &&
      resolveConfiguredAdapterKind(implementerModel) === resolveConfiguredAdapterKind(reviewerModel)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles', 'reviewer', 'model'],
        message: 'Implementer and reviewer must resolve to different adapter kinds',
      });
    }
  });

export type ProjectConfigInput = z.input<typeof projectConfigSchema>;

/**
 * Validate and parse a config object. Throws ConfigError on invalid input.
 */
export function validateConfig(config: unknown): z.output<typeof projectConfigSchema> {
  const result = projectConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  return result.data;
}
