import { z } from 'zod';
import {
  actorTypeSchema,
  contentHashSchema,
  gitShaSchema,
  isoTimestampSchema,
  verificationCommandSpecSchema,
  verificationExecutionOutcomeSchema,
} from '../review-workflow/schemas.js';
import {
  BASELINE_APPROVAL_DECISIONS,
  BASELINE_COMPARISON_ATTESTATION_DECISIONS,
  BASELINE_COMPARISON_RESULTS,
  BASELINE_INCOMPATIBILITY_CODES,
} from './types.js';

const idSchema = z.string().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i, 'Expected a SHA-256 hash');
const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Expected a repository-relative path without parent traversal',
  });

export const normalizedToolFindingSchema = z
  .object({
    fingerprint: sha256Schema,
    ruleId: z.string().min(1),
    repositoryRelativePath: repositoryRelativePathSchema,
    normalizedMessage: z.string().min(1),
    rawMessage: z.string().min(1),
    severity: z.string().min(1),
    category: z.string().min(1),
    symbol: z.string().min(1).optional(),
    structuralContext: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    endColumn: z.number().int().positive().optional(),
    occurrenceIndex: z.number().int().positive(),
  })
  .strict();

export const baselineFindingArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.enum(['BASELINE_FINDINGS', 'CURRENT_FINDINGS']),
    findings: z.array(normalizedToolFindingSchema),
  })
  .strict();

export const verificationLogArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    command: z.string().min(1),
    arguments: z.array(z.string()),
    workingDirectory: z.string().min(1),
    startedAt: isoTimestampSchema,
    finishedAt: isoTimestampSchema,
    outcome: verificationExecutionOutcomeSchema,
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();

export const verificationBaselineSchema = z
  .object({
    baselineId: idSchema,
    workflowId: idSchema,
    captureBatchId: idSchema,
    verificationRecordId: idSchema,
    command: verificationCommandSpecSchema,
    toolName: z.string().min(1),
    toolVersion: z.string().min(1),
    configurationInputPaths: z.array(repositoryRelativePathSchema),
    configurationHash: contentHashSchema,
    baselineCommitSha: gitShaSchema,
    exitCode: z.number().int(),
    normalizerId: z.string().min(1),
    normalizationSchemaVersion: z.number().int().positive(),
    normalizedFindings: z.array(normalizedToolFindingSchema),
    normalizedFindingsLocation: z.string().min(1),
    normalizedFindingsHash: sha256Schema,
    findingCount: z.number().int().nonnegative(),
    rawLogLocation: z.string().min(1),
    rawLogHash: sha256Schema,
    captureActorExecutionId: idSchema,
    captureActorType: actorTypeSchema,
    reviewerApprovalStatus: z.literal('PENDING'),
    createdAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.findingCount !== value.normalizedFindings.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['findingCount'],
        message: 'Finding count must match the normalized finding set',
      });
    }
    if (new Set(value.configurationInputPaths).size !== value.configurationInputPaths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['configurationInputPaths'],
        message: 'Configuration input paths must be unique',
      });
    }
  });

export const verificationBaselineApprovalSchema = z
  .object({
    baselineApprovalId: idSchema,
    baselineId: idSchema,
    baselineEvidenceHash: sha256Schema,
    workflowId: idSchema,
    captureBatchId: idSchema,
    decision: z.enum(BASELINE_APPROVAL_DECISIONS),
    rationale: z.string().min(1),
    reviewerActorExecutionId: idSchema,
    reviewerAssignmentId: idSchema,
    authorityExercised: z.literal('VERIFICATION_ATTESTOR'),
    createdAt: isoTimestampSchema,
  })
  .strict();

const baselineComparisonBaseSchema = z
  .object({
    comparisonId: idSchema,
    workflowId: idSchema,
    batchId: idSchema,
    baselineId: idSchema,
    baselineApprovalId: idSchema,
    baselineEvidenceHash: sha256Schema,
    currentVerificationRecordId: idSchema,
    currentCommitSha: gitShaSchema,
    currentCommand: verificationCommandSpecSchema,
    currentToolName: z.string().min(1),
    currentToolVersion: z.string().min(1).optional(),
    currentConfigurationInputPaths: z.array(repositoryRelativePathSchema),
    currentConfigurationHash: contentHashSchema,
    normalizerId: z.string().min(1),
    normalizationSchemaVersion: z.number().int().positive(),
    captureActorExecutionId: idSchema,
    captureActorType: actorTypeSchema,
    createdAt: isoTimestampSchema,
  })
  .strict();

const comparableBaselineComparisonSchema = baselineComparisonBaseSchema
  .extend({
    result: z.enum([BASELINE_COMPARISON_RESULTS[0], BASELINE_COMPARISON_RESULTS[1]]),
    incompatibilities: z.array(z.never()).length(0),
    currentNormalizedFindings: z.array(normalizedToolFindingSchema),
    currentNormalizedFindingsLocation: z.string().min(1),
    currentNormalizedFindingsHash: sha256Schema,
    currentFindingCount: z.number().int().nonnegative(),
    introduced: z.array(normalizedToolFindingSchema),
    resolved: z.array(normalizedToolFindingSchema),
    unchanged: z.array(normalizedToolFindingSchema),
  })
  .strict();

const incomparableBaselineComparisonSchema = baselineComparisonBaseSchema
  .extend({
    result: z.literal('INCOMPARABLE'),
    incompatibilities: z.array(z.enum(BASELINE_INCOMPATIBILITY_CODES)).min(1),
  })
  .strict();

export const verificationBaselineComparisonSchema = z
  .discriminatedUnion('result', [
    comparableBaselineComparisonSchema,
    incomparableBaselineComparisonSchema,
  ])
  .superRefine((value, context) => {
    if (
      new Set(value.currentConfigurationInputPaths).size !==
      value.currentConfigurationInputPaths.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currentConfigurationInputPaths'],
        message: 'Current configuration input paths must be unique',
      });
    }
    if (value.result === 'INCOMPARABLE') return;
    if (value.currentFindingCount !== value.currentNormalizedFindings.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currentFindingCount'],
        message: 'Current finding count must match the normalized finding set',
      });
    }
    if (value.result === 'PASSED' && value.introduced.length !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['introduced'],
        message: 'A passed comparison cannot contain introduced findings',
      });
    }
    if (value.result === 'FAILED' && value.introduced.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['introduced'],
        message: 'A failed comparison must contain introduced findings',
      });
    }
  });

export const verificationBaselineComparisonAttestationSchema = z
  .object({
    comparisonAttestationId: idSchema,
    comparisonId: idSchema,
    comparisonEvidenceHash: sha256Schema,
    workflowId: idSchema,
    batchId: idSchema,
    baselineId: idSchema,
    baselineApprovalId: idSchema,
    decision: z.enum(BASELINE_COMPARISON_ATTESTATION_DECISIONS),
    rationale: z.string().min(1),
    baselineTrustworthy: z.boolean(),
    toolVersionAndConfigurationComparable: z.boolean(),
    introducedSetEmpty: z.boolean(),
    normalizationReviewed: z.boolean(),
    reviewerActorExecutionId: idSchema,
    reviewerAssignmentId: idSchema,
    authorityExercised: z.literal('VERIFICATION_ATTESTOR'),
    reviewedCommitSha: gitShaSchema,
    createdAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.decision === 'ACCEPTED' &&
      (!value.baselineTrustworthy ||
        !value.toolVersionAndConfigurationComparable ||
        !value.introducedSetEmpty ||
        !value.normalizationReviewed)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Accepted comparison attestations require every reviewer check to pass',
      });
    }
  });
