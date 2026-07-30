import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  type ImmutableSaveResult,
  ReviewWorkflowPersistenceError,
} from '../memory/review-workflow-store.js';
import { canonicalVerificationJson } from '../review-workflow-verification/hash.js';
import {
  actorExecutionIdentitySchema,
  verificationRecordSchema,
} from '../review-workflow/schemas.js';
import { collectBaselineIncompatibilities } from './comparison.js';
import { hashBaselineValue } from './hash.js';
import { compareFindingSets, fingerprintFindings } from './normalizer.js';
import {
  baselineFindingArtifactSchema,
  verificationBaselineApprovalSchema,
  verificationBaselineComparisonAttestationSchema,
  verificationBaselineComparisonSchema,
  verificationBaselineSchema,
} from './schemas.js';
import type {
  BaselineFindingArtifact,
  VerificationBaseline,
  VerificationBaselineApproval,
  VerificationBaselineComparison,
  VerificationBaselineComparisonAttestation,
} from './types.js';

const storedRowSchema = z
  .object({
    payload_json: z.string(),
    record_hash: z.string(),
  })
  .strict();

const verificationRecordRowSchema = z
  .object({
    workflow_id: z.string(),
    batch_id: z.string(),
    payload_json: z.string(),
  })
  .strict();

export class ReviewWorkflowBaselineStore {
  constructor(private readonly db: Database.Database) {}

  saveBaseline(input: VerificationBaseline): ImmutableSaveResult {
    const baseline = verificationBaselineSchema.parse(input);
    const record = this.loadVerificationRecord(baseline.verificationRecordId);
    const commandMatches =
      baseline.command.executable === record.value.command &&
      sameStrings(baseline.command.arguments, record.value.arguments) &&
      baseline.command.workingDirectory === record.value.workingDirectory &&
      baseline.command.verificationType === record.value.verificationType &&
      sameStringSet(baseline.command.relatedCriterionIds, record.value.relatedCriterionIds);
    if (
      record.workflowId !== baseline.workflowId ||
      record.batchId !== baseline.captureBatchId ||
      !commandMatches ||
      record.value.toolVersion !== baseline.toolVersion ||
      record.value.configurationHash !== baseline.configurationHash ||
      record.value.commitSha !== baseline.baselineCommitSha ||
      record.value.fullLogLocation !== baseline.rawLogLocation ||
      record.value.fullLogHash !== baseline.rawLogHash ||
      record.value.outcome.kind !== 'EXITED' ||
      record.value.outcome.exitCode !== baseline.exitCode ||
      hashArtifact({
        schemaVersion: 1,
        artifactKind: 'BASELINE_FINDINGS',
        findings: baseline.normalizedFindings,
      }) !== baseline.normalizedFindingsHash
    ) {
      invalid(`Baseline ${baseline.baselineId} does not match its verification evidence`);
    }
    const captureActor = this.loadActor(baseline.captureActorExecutionId);
    if (
      captureActor.actorExecutionId !== record.value.executorActorExecutionId ||
      captureActor.actorType !== baseline.captureActorType
    ) {
      invalid(`Baseline ${baseline.baselineId} does not match its capture actor`);
    }
    assertCanonicalFindingSet(baseline.normalizedFindings);

    const existingForRecord = this.db
      .prepare(
        `SELECT baseline_id
         FROM review_workflow_verification_baselines
         WHERE verification_record_id = ?`,
      )
      .pluck()
      .get(baseline.verificationRecordId);
    if (existingForRecord !== undefined && existingForRecord !== baseline.baselineId) {
      conflict(
        `Verification record ${baseline.verificationRecordId} already belongs to another baseline`,
      );
    }

    return this.saveImmutable({
      table: 'review_workflow_verification_baselines',
      idColumn: 'baseline_id',
      id: baseline.baselineId,
      payload: baseline,
      sql: `INSERT INTO review_workflow_verification_baselines (
        baseline_id,
        workflow_id,
        capture_batch_id,
        verification_record_id,
        tool_name,
        tool_version,
        baseline_commit_sha,
        configuration_hash,
        normalizer_id,
        normalization_schema_version,
        finding_count,
        payload_json,
        record_hash,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [
        baseline.baselineId,
        baseline.workflowId,
        baseline.captureBatchId,
        baseline.verificationRecordId,
        baseline.toolName,
        baseline.toolVersion,
        baseline.baselineCommitSha,
        baseline.configurationHash,
        baseline.normalizerId,
        baseline.normalizationSchemaVersion,
        baseline.findingCount,
      ],
      createdAt: baseline.createdAt,
    });
  }

  getBaseline(baselineId: string): VerificationBaseline | null {
    return this.loadImmutable(
      'review_workflow_verification_baselines',
      'baseline_id',
      baselineId,
      verificationBaselineSchema,
    );
  }

  saveBaselineApproval(input: VerificationBaselineApproval): ImmutableSaveResult {
    const approval = verificationBaselineApprovalSchema.parse(input);
    const baseline = this.getBaseline(approval.baselineId);
    if (
      baseline === null ||
      approval.workflowId !== baseline.workflowId ||
      approval.captureBatchId !== baseline.captureBatchId ||
      approval.baselineEvidenceHash !== hashBaselineValue(baseline)
    ) {
      invalid(`Baseline approval ${approval.baselineApprovalId} does not match its baseline`);
    }
    const reviewer = this.loadActor(approval.reviewerActorExecutionId);
    const reviewerAssignmentId = this.loadReviewerAssignmentId(baseline.captureBatchId);
    if (
      reviewer.actorType !== 'AGENT' ||
      reviewer.assignmentId !== reviewerAssignmentId ||
      approval.reviewerAssignmentId !== reviewerAssignmentId ||
      !reviewer.authoritiesExercised.includes('VERIFICATION_ATTESTOR') ||
      reviewer.actorExecutionId === baseline.captureActorExecutionId
    ) {
      invalid(
        `Baseline approval ${approval.baselineApprovalId} is not an independent assigned-reviewer decision`,
      );
    }
    return this.saveImmutable({
      table: 'review_workflow_verification_baseline_approvals',
      idColumn: 'baseline_approval_id',
      id: approval.baselineApprovalId,
      payload: approval,
      sql: `INSERT INTO review_workflow_verification_baseline_approvals (
        baseline_approval_id,
        baseline_id,
        workflow_id,
        decision,
        reviewer_actor_execution_id,
        payload_json,
        record_hash,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [
        approval.baselineApprovalId,
        approval.baselineId,
        approval.workflowId,
        approval.decision,
        approval.reviewerActorExecutionId,
      ],
      createdAt: approval.createdAt,
    });
  }

  getBaselineApproval(baselineApprovalId: string): VerificationBaselineApproval | null {
    return this.loadImmutable(
      'review_workflow_verification_baseline_approvals',
      'baseline_approval_id',
      baselineApprovalId,
      verificationBaselineApprovalSchema,
    );
  }

  saveComparison(input: VerificationBaselineComparison): ImmutableSaveResult {
    const comparison = verificationBaselineComparisonSchema.parse(input);
    const baseline = this.getBaseline(comparison.baselineId);
    const approval = this.getBaselineApproval(comparison.baselineApprovalId);
    const currentRecord = this.loadVerificationRecord(comparison.currentVerificationRecordId);
    const currentCommandMatches =
      comparison.currentCommand.executable === currentRecord.value.command &&
      sameStrings(comparison.currentCommand.arguments, currentRecord.value.arguments) &&
      comparison.currentCommand.workingDirectory === currentRecord.value.workingDirectory &&
      comparison.currentCommand.verificationType === currentRecord.value.verificationType &&
      sameStringSet(
        comparison.currentCommand.relatedCriterionIds,
        currentRecord.value.relatedCriterionIds,
      );
    if (
      baseline === null ||
      approval === null ||
      approval.baselineId !== baseline.baselineId ||
      approval.decision !== 'ACCEPTED' ||
      approval.baselineEvidenceHash !== hashBaselineValue(baseline) ||
      comparison.baselineEvidenceHash !== approval.baselineEvidenceHash ||
      comparison.workflowId !== baseline.workflowId ||
      currentRecord.workflowId !== comparison.workflowId ||
      currentRecord.batchId !== comparison.batchId ||
      currentRecord.value.commitSha !== comparison.currentCommitSha ||
      currentRecord.value.toolVersion !== comparison.currentToolVersion ||
      currentRecord.value.configurationHash !== comparison.currentConfigurationHash ||
      !currentCommandMatches
    ) {
      invalid(`Comparison ${comparison.comparisonId} does not match its durable evidence`);
    }
    const captureActor = this.loadActor(comparison.captureActorExecutionId);
    if (
      captureActor.actorExecutionId !== currentRecord.value.executorActorExecutionId ||
      captureActor.actorType !== comparison.captureActorType
    ) {
      invalid(`Comparison ${comparison.comparisonId} does not match its capture actor`);
    }
    const expectedIncompatibilities = collectBaselineIncompatibilities(baseline, {
      currentCommand: comparison.currentCommand,
      currentToolName: comparison.currentToolName,
      currentToolVersion: comparison.currentToolVersion,
      currentConfigurationInputPaths: comparison.currentConfigurationInputPaths,
      currentConfigurationHash: comparison.currentConfigurationHash,
      normalizerId: comparison.normalizerId,
      normalizationSchemaVersion: comparison.normalizationSchemaVersion,
    });
    if (
      !sameStrings(expectedIncompatibilities, comparison.incompatibilities) ||
      (expectedIncompatibilities.length === 0) !== (comparison.result !== 'INCOMPARABLE')
    ) {
      invalid(`Comparison ${comparison.comparisonId} has an invalid comparability result`);
    }
    if (
      comparison.result !== 'INCOMPARABLE' &&
      hashArtifact({
        schemaVersion: 1,
        artifactKind: 'CURRENT_FINDINGS',
        findings: comparison.currentNormalizedFindings,
      }) !== comparison.currentNormalizedFindingsHash
    ) {
      invalid(`Comparison ${comparison.comparisonId} has an invalid finding artifact hash`);
    }
    if (comparison.result !== 'INCOMPARABLE') {
      assertCanonicalFindingSet(comparison.currentNormalizedFindings);
      const difference = compareFindingSets(
        baseline.normalizedFindings,
        comparison.currentNormalizedFindings,
      );
      const expectedResult = difference.introduced.length === 0 ? 'PASSED' : 'FAILED';
      if (
        comparison.result !== expectedResult ||
        canonicalVerificationJson(comparison.introduced) !==
          canonicalVerificationJson(difference.introduced) ||
        canonicalVerificationJson(comparison.resolved) !==
          canonicalVerificationJson(difference.resolved) ||
        canonicalVerificationJson(comparison.unchanged) !==
          canonicalVerificationJson(difference.unchanged)
      ) {
        invalid(`Comparison ${comparison.comparisonId} has an invalid finding-set difference`);
      }
    }

    return this.saveImmutable({
      table: 'review_workflow_verification_baseline_comparisons',
      idColumn: 'comparison_id',
      id: comparison.comparisonId,
      payload: comparison,
      sql: `INSERT INTO review_workflow_verification_baseline_comparisons (
        comparison_id,
        workflow_id,
        batch_id,
        baseline_id,
        baseline_approval_id,
        current_verification_record_id,
        result,
        current_commit_sha,
        introduced_count,
        resolved_count,
        unchanged_count,
        payload_json,
        record_hash,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [
        comparison.comparisonId,
        comparison.workflowId,
        comparison.batchId,
        comparison.baselineId,
        comparison.baselineApprovalId,
        comparison.currentVerificationRecordId,
        comparison.result,
        comparison.currentCommitSha,
        comparison.result === 'INCOMPARABLE' ? null : comparison.introduced.length,
        comparison.result === 'INCOMPARABLE' ? null : comparison.resolved.length,
        comparison.result === 'INCOMPARABLE' ? null : comparison.unchanged.length,
      ],
      createdAt: comparison.createdAt,
    });
  }

  getComparison(comparisonId: string): VerificationBaselineComparison | null {
    return this.loadImmutable(
      'review_workflow_verification_baseline_comparisons',
      'comparison_id',
      comparisonId,
      verificationBaselineComparisonSchema,
    );
  }

  saveComparisonAttestation(input: VerificationBaselineComparisonAttestation): ImmutableSaveResult {
    const attestation = verificationBaselineComparisonAttestationSchema.parse(input);
    const comparison = this.getComparison(attestation.comparisonId);
    if (
      comparison === null ||
      attestation.comparisonEvidenceHash !== hashBaselineValue(comparison) ||
      attestation.workflowId !== comparison.workflowId ||
      attestation.batchId !== comparison.batchId ||
      attestation.baselineId !== comparison.baselineId ||
      attestation.baselineApprovalId !== comparison.baselineApprovalId ||
      attestation.reviewedCommitSha !== comparison.currentCommitSha
    ) {
      invalid(
        `Comparison attestation ${attestation.comparisonAttestationId} does not match its comparison`,
      );
    }
    const reviewer = this.loadActor(attestation.reviewerActorExecutionId);
    const reviewerAssignmentId = this.loadReviewerAssignmentId(comparison.batchId);
    const acceptedResultIsValid =
      attestation.decision !== 'ACCEPTED' ||
      (comparison.result === 'PASSED' &&
        attestation.baselineTrustworthy &&
        attestation.toolVersionAndConfigurationComparable &&
        attestation.introducedSetEmpty &&
        attestation.normalizationReviewed);
    if (
      reviewer.actorType !== 'AGENT' ||
      reviewer.assignmentId !== reviewerAssignmentId ||
      attestation.reviewerAssignmentId !== reviewerAssignmentId ||
      !reviewer.authoritiesExercised.includes('VERIFICATION_ATTESTOR') ||
      reviewer.actorExecutionId === comparison.captureActorExecutionId ||
      !acceptedResultIsValid
    ) {
      invalid(
        `Comparison attestation ${attestation.comparisonAttestationId} is not a valid assigned-reviewer decision`,
      );
    }
    return this.saveImmutable({
      table: 'review_workflow_baseline_comparison_attestations',
      idColumn: 'comparison_attestation_id',
      id: attestation.comparisonAttestationId,
      payload: attestation,
      sql: `INSERT INTO review_workflow_baseline_comparison_attestations (
        comparison_attestation_id,
        comparison_id,
        workflow_id,
        batch_id,
        decision,
        reviewer_actor_execution_id,
        reviewed_commit_sha,
        payload_json,
        record_hash,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [
        attestation.comparisonAttestationId,
        attestation.comparisonId,
        attestation.workflowId,
        attestation.batchId,
        attestation.decision,
        attestation.reviewerActorExecutionId,
        attestation.reviewedCommitSha,
      ],
      createdAt: attestation.createdAt,
    });
  }

  getComparisonAttestation(
    comparisonAttestationId: string,
  ): VerificationBaselineComparisonAttestation | null {
    return this.loadImmutable(
      'review_workflow_baseline_comparison_attestations',
      'comparison_attestation_id',
      comparisonAttestationId,
      verificationBaselineComparisonAttestationSchema,
    );
  }

  private saveImmutable(input: {
    readonly table: string;
    readonly idColumn: string;
    readonly id: string;
    readonly payload: unknown;
    readonly sql: string;
    readonly values: readonly unknown[];
    readonly createdAt: string;
  }): ImmutableSaveResult {
    const recordHash = hashBaselineValue(input.payload);
    const existing = this.db
      .prepare(`SELECT payload_json, record_hash FROM ${input.table} WHERE ${input.idColumn} = ?`)
      .get(input.id);
    if (existing !== undefined) {
      const parsed = storedRowSchema.parse(existing);
      if (parsed.record_hash !== recordHash || parsed.payload_json !== serialize(input.payload)) {
        conflict(`${input.table} record ${input.id} is immutable`);
      }
      return { inserted: false };
    }

    this.db
      .prepare(input.sql)
      .run(...input.values, serialize(input.payload), recordHash, input.createdAt);
    return { inserted: true };
  }

  private loadImmutable<T>(
    table: string,
    idColumn: string,
    id: string,
    schema: z.ZodType<T>,
  ): T | null {
    const row = this.db
      .prepare(`SELECT payload_json, record_hash FROM ${table} WHERE ${idColumn} = ?`)
      .get(id);
    if (row === undefined) return null;
    try {
      const stored = storedRowSchema.parse(row);
      const value = schema.parse(JSON.parse(stored.payload_json));
      if (stored.record_hash !== hashBaselineValue(value)) {
        invalid(`${table} record ${id} failed its integrity check`);
      }
      return value;
    } catch (error) {
      if (error instanceof ReviewWorkflowPersistenceError) throw error;
      invalid(`${table} record ${id} failed domain validation`);
    }
  }

  private loadVerificationRecord(verificationRecordId: string): {
    readonly workflowId: string;
    readonly batchId: string;
    readonly value: z.infer<typeof verificationRecordSchema>;
  } {
    const row = this.db
      .prepare(
        `SELECT workflow_id, batch_id, payload_json
         FROM review_workflow_verification_records
         WHERE verification_record_id = ?`,
      )
      .get(verificationRecordId);
    if (row === undefined) {
      invalid(`Verification record ${verificationRecordId} does not exist`);
    }
    try {
      const stored = verificationRecordRowSchema.parse(row);
      return {
        workflowId: stored.workflow_id,
        batchId: stored.batch_id,
        value: verificationRecordSchema.parse(JSON.parse(stored.payload_json)),
      };
    } catch (error) {
      if (error instanceof ReviewWorkflowPersistenceError) throw error;
      invalid(`Verification record ${verificationRecordId} failed domain validation`);
    }
  }

  private loadActor(actorExecutionId: string): z.infer<typeof actorExecutionIdentitySchema> {
    const row = this.db
      .prepare(
        `SELECT payload_json
         FROM review_workflow_actor_executions
         WHERE actor_execution_id = ?`,
      )
      .get(actorExecutionId);
    if (row === undefined) invalid(`Actor execution ${actorExecutionId} does not exist`);
    try {
      return actorExecutionIdentitySchema.parse(
        JSON.parse(z.object({ payload_json: z.string() }).parse(row).payload_json),
      );
    } catch (error) {
      if (error instanceof ReviewWorkflowPersistenceError) throw error;
      invalid(`Actor execution ${actorExecutionId} failed domain validation`);
    }
  }

  private loadReviewerAssignmentId(batchId: string): string {
    const value = this.db
      .prepare(
        `SELECT reviewer_assignment_id
         FROM review_workflow_batches
         WHERE batch_id = ?`,
      )
      .pluck()
      .get(batchId);
    if (typeof value !== 'string') invalid(`Batch ${batchId} does not exist`);
    return value;
  }
}

function hashArtifact(artifact: BaselineFindingArtifact): string {
  const parsed = baselineFindingArtifactSchema.parse(artifact);
  return createHash('sha256')
    .update(`${canonicalVerificationJson(parsed)}\n`)
    .digest('hex');
}

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) invalid('Baseline persistence received a non-serializable value');
  return serialized;
}

function assertCanonicalFindingSet(findings: VerificationBaseline['normalizedFindings']): void {
  const recomputed = fingerprintFindings(
    findings.map((finding) => ({
      ruleId: finding.ruleId,
      repositoryRelativePath: finding.repositoryRelativePath,
      message: finding.rawMessage,
      severity: finding.severity,
      category: finding.category,
      ...(finding.symbol === undefined ? {} : { symbol: finding.symbol }),
      ...(finding.structuralContext === undefined
        ? {}
        : { structuralContext: finding.structuralContext }),
      ...(finding.line === undefined ? {} : { line: finding.line }),
      ...(finding.column === undefined ? {} : { column: finding.column }),
      ...(finding.endLine === undefined ? {} : { endLine: finding.endLine }),
      ...(finding.endColumn === undefined ? {} : { endColumn: finding.endColumn }),
    })),
  );
  if (canonicalVerificationJson(recomputed) !== canonicalVerificationJson(findings)) {
    invalid('Normalized finding fingerprints or occurrence indexes are invalid');
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return sameStrings([...left].sort(), [...right].sort());
}

function invalid(message: string): never {
  throw new ReviewWorkflowPersistenceError('PERSISTED_DATA_INVALID', message);
}

function conflict(message: string): never {
  throw new ReviewWorkflowPersistenceError('IMMUTABLE_ENTITY_CONFLICT', message);
}
