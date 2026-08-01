// Strict, fail-closed parsing and deterministic identifiers for model handoffs.

import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { Finding, FindingDisposition } from '../review-workflow/types.js';
import {
  batchPlanContractSchema,
  dispositionResultContractSchema,
  finalAuditResultContractSchema,
  implementationResultContractSchema,
  refinementOutlineContractSchema,
  refinementResultContractSchema,
  reviewResultContractSchema,
} from './schemas.js';
import type {
  CodeReviewTarget,
  DispositionResultContract,
  FinalAuditResultContract,
  FinalAuditTarget,
  FindingDraft,
  ImplementationResultContract,
  PlanReviewTarget,
  RefinementResultContract,
  ReviewContractTarget,
  ReviewResultContract,
} from './types.js';

export const HANDOFF_PARSE_ERROR_CODES = [
  'INVALID_JSON',
  'SCHEMA_INVALID',
  'TARGET_MISMATCH',
  'EXPECTED_FINDINGS_MISMATCH',
  'POLICY_MISMATCH',
] as const;

export type HandoffParseErrorCode = (typeof HANDOFF_PARSE_ERROR_CODES)[number];

export class HandoffParseError extends Error {
  constructor(
    readonly code: HandoffParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HandoffParseError';
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashHandoffContent(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deriveScopedId(prefix: string, value: unknown): string {
  return `${prefix}-${hashHandoffContent(stableJson(value))}`;
}

export function deriveFindingId(input: {
  readonly workflowId: string;
  readonly batchId: string;
  readonly reviewRoundId: string;
  readonly reviewKind: 'PLAN' | 'CODE' | 'FINAL_AUDIT';
  readonly findingKey: string;
}): string {
  return deriveScopedId('finding', input);
}

export function deriveDispositionId(input: {
  readonly workflowId: string;
  readonly batchId: string;
  readonly findingId: string;
  readonly actorExecutionId: string;
  readonly target: DispositionResultContract['target'];
}): string {
  return deriveScopedId('disposition', input);
}

function parseContract<Schema extends z.ZodTypeAny>(
  rawTranscript: string,
  schema: Schema,
): z.output<Schema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawTranscript);
  } catch {
    throw new HandoffParseError(
      'INVALID_JSON',
      'The handoff must contain exactly one valid JSON value',
    );
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const location = firstIssue?.path.join('.') ?? 'root';
    const detail = firstIssue?.message ?? 'Unknown schema error';
    throw new HandoffParseError(
      'SCHEMA_INVALID',
      `The handoff failed schema validation at ${location}: ${detail}`,
    );
  }
  return parsed.data;
}

export function parseRefinementResult(rawTranscript: string): RefinementResultContract {
  return parseContract(rawTranscript, refinementResultContractSchema);
}

export function parseRefinementOutline(
  rawTranscript: string,
): z.output<typeof refinementOutlineContractSchema> {
  return parseContract(rawTranscript, refinementOutlineContractSchema);
}

export function parseBatchPlanResult(
  rawTranscript: string,
): z.output<typeof batchPlanContractSchema> {
  return parseContract(rawTranscript, batchPlanContractSchema);
}

export function parseReviewResult(rawTranscript: string): ReviewResultContract {
  return parseContract(rawTranscript, reviewResultContractSchema);
}

export function parseImplementationResult(rawTranscript: string): ImplementationResultContract {
  return parseContract(rawTranscript, implementationResultContractSchema);
}

export function parseDispositionResult(rawTranscript: string): DispositionResultContract {
  return parseContract(rawTranscript, dispositionResultContractSchema);
}

export function parseFinalAuditResult(rawTranscript: string): FinalAuditResultContract {
  return parseContract(rawTranscript, finalAuditResultContractSchema);
}

function equalTargets(
  actual: ReviewContractTarget | FinalAuditTarget | DispositionResultContract['target'],
  expected: ReviewContractTarget | FinalAuditTarget | DispositionResultContract['target'],
): boolean {
  return stableJson(actual) === stableJson(expected);
}

export function requireExpectedTarget<
  Target extends ReviewContractTarget | FinalAuditTarget | DispositionResultContract['target'],
>(actual: Target, expected: Target): void {
  if (!equalTargets(actual, expected)) {
    throw new HandoffParseError(
      'TARGET_MISMATCH',
      'The handoff target does not match the authoritative requested target',
    );
  }
}

export function requireExpectedFindingIds(
  actualFindingIds: readonly string[],
  expectedFindingIds: readonly string[],
): void {
  const actual = [...actualFindingIds].sort();
  const expected = [...expectedFindingIds].sort();
  if (stableJson(actual) !== stableJson(expected)) {
    throw new HandoffParseError(
      'EXPECTED_FINDINGS_MISMATCH',
      'The disposition result must address every expected finding exactly once',
    );
  }
}

function reviewedArtifact(
  target: PlanReviewTarget | CodeReviewTarget | FinalAuditTarget,
): Finding['reviewedArtifact'] {
  if (target.kind === 'PLAN') {
    return { artifactId: target.planVersionId, contentHash: target.planContentHash };
  }
  return { artifactId: target.reviewRangeEvidenceId, contentHash: target.patchHash };
}

export function materializeFindings(input: {
  readonly workflowId: string;
  readonly batchId: string;
  readonly reviewRoundId: string;
  readonly reviewRoundNumber: number;
  readonly reviewKind: 'PLAN' | 'CODE' | 'FINAL_AUDIT';
  readonly target: PlanReviewTarget | CodeReviewTarget | FinalAuditTarget;
  readonly reviewerActorExecutionId: string;
  readonly findings: readonly FindingDraft[];
  readonly createdAt: string;
}): readonly Finding[] {
  return input.findings.map((draft) => {
    const reviewedCommitSha =
      input.target.kind === 'PLAN' ? undefined : input.target.reviewedCommitSha;
    return {
      findingId: deriveFindingId({
        workflowId: input.workflowId,
        batchId: input.batchId,
        reviewRoundId: input.reviewRoundId,
        reviewKind: input.reviewKind,
        findingKey: draft.findingKey,
      }),
      workflowId: input.workflowId,
      batchId: input.batchId,
      reviewRoundId: input.reviewRoundId,
      reviewRoundNumber: input.reviewRoundNumber,
      reviewKind: input.reviewKind,
      severity: draft.severity,
      category: draft.category,
      title: draft.title,
      description: draft.description,
      repositoryEvidence: draft.repositoryEvidence,
      affectedFiles: draft.affectedFiles,
      acceptanceCriterionId: draft.acceptanceCriterionId,
      expectedResult: draft.expectedResult,
      observedResult: draft.observedResult,
      requiredAction: draft.requiredAction,
      reviewerActorExecutionId: input.reviewerActorExecutionId,
      reviewedArtifact: reviewedArtifact(input.target),
      repositoryContextSha: input.target.repositoryContextSha,
      reviewedCommitSha,
      status: 'OPEN',
      occurrenceLinks: draft.occurrenceLinks,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
  });
}

export function materializeDispositions(input: {
  readonly workflowId: string;
  readonly batchId: string;
  readonly actorExecutionId: string;
  readonly target: DispositionResultContract['target'];
  readonly result: DispositionResultContract;
  readonly createdAt: string;
}): readonly FindingDisposition[] {
  return input.result.dispositions.map((draft) => ({
    dispositionId: deriveDispositionId({
      workflowId: input.workflowId,
      batchId: input.batchId,
      findingId: draft.findingId,
      actorExecutionId: input.actorExecutionId,
      target: input.target,
    }),
    findingId: draft.findingId,
    disposition: draft.disposition,
    explanation: draft.explanation,
    actorExecutionId: input.actorExecutionId,
    filesChanged: draft.filesChanged,
    verificationRecordIds: draft.verificationRecordIds,
    evidence: draft.evidence,
    resultTarget: input.target,
    reviewerDecision: { decision: 'PENDING' },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  }));
}
