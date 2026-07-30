// Versioned schemas for structured review-workflow handoffs and their durable captures.

import { z } from 'zod';
import {
  contentHashSchema,
  dispositionResultTargetSchema,
  evidenceReferenceSchema,
  gitShaSchema,
  isoTimestampSchema,
  requirementCoverageSchema,
} from '../review-workflow/schemas.js';
import {
  DISPOSITION_KINDS,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
} from '../review-workflow/types.js';

export const REVIEW_WORKFLOW_CONTRACT_SCHEMA_VERSION = 1 as const;

export const REVIEW_WORKFLOW_CONTRACT_KINDS = [
  'REFINEMENT_RESULT',
  'REVIEW_RESULT',
  'IMPLEMENTATION_RESULT',
  'DISPOSITION_RESULT',
  'FINAL_AUDIT_RESULT',
] as const;

export const REVIEW_WORKFLOW_CONTRACT_PARSE_STATUSES = ['PARSED', 'REJECTED'] as const;
export const REVIEW_WORKFLOW_REVIEW_VERDICTS = ['APPROVED', 'NEEDS_REVISION'] as const;

const idSchema = z.string().min(1);
const uniqueStrings = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

export const planReviewTargetSchema = z
  .object({
    kind: z.literal('PLAN'),
    planVersionId: idSchema,
    planContentHash: contentHashSchema,
    repositoryContextSha: gitShaSchema,
  })
  .strict();

export const codeReviewTargetSchema = z
  .object({
    kind: z.literal('CODE'),
    reviewedCommitSha: gitShaSchema,
    repositoryContextSha: gitShaSchema,
    reviewRangeEvidenceId: idSchema,
    patchHash: contentHashSchema,
  })
  .strict();

export const finalAuditTargetSchema = z
  .object({
    kind: z.literal('FINAL_AUDIT'),
    reviewedCommitSha: gitShaSchema,
    repositoryContextSha: gitShaSchema,
    reviewRangeEvidenceId: idSchema,
    patchHash: contentHashSchema,
    refinedPlanVersionId: idSchema,
  })
  .strict();

export const reviewContractTargetSchema = z.discriminatedUnion('kind', [
  planReviewTargetSchema,
  codeReviewTargetSchema,
]);

export const findingDraftSchema = z
  .object({
    findingKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    severity: z.enum(FINDING_SEVERITIES),
    category: z.enum(FINDING_CATEGORIES),
    title: z.string().min(1),
    description: z.string().min(1),
    repositoryEvidence: z.array(evidenceReferenceSchema).min(1),
    affectedFiles: z.array(z.string().min(1)),
    acceptanceCriterionId: idSchema.optional(),
    expectedResult: z.string().min(1),
    observedResult: z.string().min(1),
    requiredAction: z.string().min(1),
    occurrenceLinks: z.array(idSchema).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (!uniqueStrings(value.affectedFiles)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['affectedFiles'],
        message: 'Affected files must be unique',
      });
    }
    if (!uniqueStrings(value.occurrenceLinks)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['occurrenceLinks'],
        message: 'Occurrence links must be unique',
      });
    }
    if (
      value.category === 'browser_behaviour' &&
      !value.repositoryEvidence.some((evidence) => evidence.kind === 'BROWSER')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repositoryEvidence'],
        message: 'Browser-behaviour findings require browser evidence',
      });
    }
  });

function validateReviewResult(
  value: {
    readonly verdict: (typeof REVIEW_WORKFLOW_REVIEW_VERDICTS)[number];
    readonly findings: readonly {
      readonly findingKey: string;
      readonly severity: (typeof FINDING_SEVERITIES)[number];
    }[];
  },
  context: z.RefinementCtx,
): void {
  const findingKeys = value.findings.map((finding) => finding.findingKey);
  if (!uniqueStrings(findingKeys)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['findings'],
      message: 'Finding keys must be unique within a review result',
    });
  }
  if (value.verdict === 'NEEDS_REVISION' && value.findings.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verdict'],
      message: 'A needs-revision verdict requires at least one finding',
    });
  }
  if (
    value.verdict === 'APPROVED' &&
    value.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high')
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verdict'],
      message: 'An approved verdict cannot include critical or high findings',
    });
  }
}

export const refinementResultContractSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_WORKFLOW_CONTRACT_SCHEMA_VERSION),
    contractKind: z.literal('REFINEMENT_RESULT'),
    summary: z.string().min(1),
    refinedPlanContent: z.string().min(1),
    batchPlanVersionIds: z.array(idSchema).min(1),
    requirementCoverage: z.array(requirementCoverageSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (!uniqueStrings(value.batchPlanVersionIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['batchPlanVersionIds'],
        message: 'Batch plan version IDs must be unique',
      });
    }
    const requirementIds = value.requirementCoverage.map((coverage) => coverage.requirementId);
    if (!uniqueStrings(requirementIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requirementCoverage'],
        message: 'Requirement coverage entries must be unique',
      });
    }
    value.requirementCoverage.forEach((coverage, index) => {
      if (
        coverage.batchPlanVersionIds.length === 0 ||
        coverage.acceptanceCriterionIds.length === 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requirementCoverage', index],
          message: 'Each requirement requires a batch and an acceptance criterion',
        });
      }
      if (
        !uniqueStrings(coverage.batchPlanVersionIds) ||
        !uniqueStrings(coverage.acceptanceCriterionIds)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requirementCoverage', index],
          message: 'Requirement coverage identifiers must be unique',
        });
      }
    });
  });

export const reviewResultContractSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_WORKFLOW_CONTRACT_SCHEMA_VERSION),
    contractKind: z.literal('REVIEW_RESULT'),
    target: reviewContractTargetSchema,
    verdict: z.enum(REVIEW_WORKFLOW_REVIEW_VERDICTS),
    summary: z.string().min(1),
    findings: z.array(findingDraftSchema),
  })
  .strict()
  .superRefine(validateReviewResult);

export const implementationResultContractSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_WORKFLOW_CONTRACT_SCHEMA_VERSION),
    contractKind: z.literal('IMPLEMENTATION_RESULT'),
    outcome: z.enum(['COMPLETE', 'BLOCKED']),
    summary: z.string().min(1),
    blockerReason: z.string().min(1).optional(),
    changedFiles: z.array(z.string().min(1)),
    verificationRecordIds: z.array(idSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === 'BLOCKED' && value.blockerReason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockerReason'],
        message: 'A blocked implementation result requires a blocker reason',
      });
    }
    if (value.outcome === 'COMPLETE' && value.blockerReason !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockerReason'],
        message: 'A complete implementation result cannot include a blocker reason',
      });
    }
    if (!uniqueStrings(value.changedFiles)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['changedFiles'],
        message: 'Changed files must be unique',
      });
    }
    if (!uniqueStrings(value.verificationRecordIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verificationRecordIds'],
        message: 'Verification record IDs must be unique',
      });
    }
  });

export const dispositionDraftSchema = z
  .object({
    findingId: idSchema,
    disposition: z.enum(DISPOSITION_KINDS),
    explanation: z.string().min(1),
    filesChanged: z.array(z.string().min(1)),
    verificationRecordIds: z.array(idSchema),
    evidence: z.array(evidenceReferenceSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (!uniqueStrings(value.filesChanged)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filesChanged'],
        message: 'Changed files must be unique',
      });
    }
    if (!uniqueStrings(value.verificationRecordIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verificationRecordIds'],
        message: 'Verification record IDs must be unique',
      });
    }
  });

export const dispositionResultContractSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_WORKFLOW_CONTRACT_SCHEMA_VERSION),
    contractKind: z.literal('DISPOSITION_RESULT'),
    target: dispositionResultTargetSchema,
    summary: z.string().min(1),
    dispositions: z.array(dispositionDraftSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const findingIds = value.dispositions.map((disposition) => disposition.findingId);
    if (!uniqueStrings(findingIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispositions'],
        message: 'Each finding may have only one disposition in a result',
      });
    }
  });

export const finalAuditCheckSchema = z
  .object({
    subjectId: idSchema,
    status: z.enum(['PASSED', 'FAILED', 'NOT_APPLICABLE']),
    explanation: z.string().min(1),
    evidence: z.array(evidenceReferenceSchema).min(1),
  })
  .strict();

export const finalAuditResultContractSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_WORKFLOW_CONTRACT_SCHEMA_VERSION),
    contractKind: z.literal('FINAL_AUDIT_RESULT'),
    target: finalAuditTargetSchema,
    verdict: z.enum(REVIEW_WORKFLOW_REVIEW_VERDICTS),
    summary: z.string().min(1),
    findings: z.array(findingDraftSchema),
    requirementChecks: z.array(finalAuditCheckSchema),
    acceptanceCriterionChecks: z.array(finalAuditCheckSchema),
    scopeComplete: z.boolean(),
    documentationComplete: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    validateReviewResult(value, context);
    for (const [field, checks] of [
      ['requirementChecks', value.requirementChecks],
      ['acceptanceCriterionChecks', value.acceptanceCriterionChecks],
    ] as const) {
      if (!uniqueStrings(checks.map((check) => check.subjectId))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} subjects must be unique`,
        });
      }
    }
    if (
      value.verdict === 'APPROVED' &&
      (!value.scopeComplete ||
        !value.documentationComplete ||
        [...value.requirementChecks, ...value.acceptanceCriterionChecks].some(
          (check) => check.status === 'FAILED',
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verdict'],
        message: 'An approved final audit requires complete scope, documentation, and checks',
      });
    }
  });

export const reviewWorkflowContractSchema = z.union([
  refinementResultContractSchema,
  reviewResultContractSchema,
  implementationResultContractSchema,
  dispositionResultContractSchema,
  finalAuditResultContractSchema,
]);

const handoffTranscriptBaseSchema = z
  .object({
    transcriptId: idSchema,
    workflowId: idSchema,
    batchId: idSchema.optional(),
    contractKind: z.enum(REVIEW_WORKFLOW_CONTRACT_KINDS),
    expectedSchemaVersion: z.literal(REVIEW_WORKFLOW_CONTRACT_SCHEMA_VERSION),
    actorExecutionId: idSchema,
    invocationId: idSchema.optional(),
    sessionIdentityId: idSchema.optional(),
    rawTranscript: z.string(),
    rawTranscriptHash: contentHashSchema,
    createdAt: isoTimestampSchema,
  })
  .strict();

export const handoffTranscriptSchema = z
  .discriminatedUnion('parseStatus', [
    handoffTranscriptBaseSchema
      .extend({
        parseStatus: z.literal('PARSED'),
        parsedArtifactIds: z.array(idSchema).min(1),
      })
      .strict(),
    handoffTranscriptBaseSchema
      .extend({
        parseStatus: z.literal('REJECTED'),
        parsedArtifactIds: z.array(idSchema).length(0),
        errorCode: z.string().min(1),
        errorMessage: z.string().min(1),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.parseStatus === 'PARSED' && !uniqueStrings(value.parsedArtifactIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parsedArtifactIds'],
        message: 'Parsed artifact IDs must be unique',
      });
    }
  });

export const structuredReviewSchema = z
  .object({
    reviewRoundId: idSchema,
    transcriptId: idSchema,
    workflowId: idSchema,
    batchId: idSchema,
    reviewRoundNumber: z.number().int().positive(),
    reviewKind: z.enum(['PLAN', 'CODE', 'FINAL_AUDIT']),
    target: z.discriminatedUnion('kind', [
      planReviewTargetSchema,
      codeReviewTargetSchema,
      finalAuditTargetSchema,
    ]),
    verdict: z.enum(REVIEW_WORKFLOW_REVIEW_VERDICTS),
    summary: z.string().min(1),
    findingIds: z.array(idSchema),
    reviewerActorExecutionId: idSchema,
    requirementChecks: z.array(finalAuditCheckSchema).optional(),
    acceptanceCriterionChecks: z.array(finalAuditCheckSchema).optional(),
    scopeComplete: z.boolean().optional(),
    documentationComplete: z.boolean().optional(),
    createdAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.reviewKind === 'PLAN' && value.target.kind !== 'PLAN') ||
      (value.reviewKind === 'CODE' && value.target.kind !== 'CODE') ||
      (value.reviewKind === 'FINAL_AUDIT' && value.target.kind !== 'FINAL_AUDIT')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target'],
        message: 'Review kind and review target must match',
      });
    }
    if (!uniqueStrings(value.findingIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['findingIds'],
        message: 'Structured review finding IDs must be unique',
      });
    }
    const auditFields = [
      value.requirementChecks,
      value.acceptanceCriterionChecks,
      value.scopeComplete,
      value.documentationComplete,
    ];
    if (value.reviewKind === 'FINAL_AUDIT' && auditFields.some((field) => field === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requirementChecks'],
        message: 'Final-audit reviews require all audit check fields',
      });
    }
    if (value.reviewKind !== 'FINAL_AUDIT' && auditFields.some((field) => field !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requirementChecks'],
        message: 'Only final-audit reviews may contain audit check evidence',
      });
    }
  });
