import { createHash } from 'node:crypto';
import type { ReviewWorkflowStore } from '../memory/review-workflow-store.js';
import { canonicalVerificationJson } from '../review-workflow-verification/hash.js';
import {
  actorExecutionIdentitySchema,
  verificationRecordSchema,
} from '../review-workflow/schemas.js';
import type {
  ActorExecutionIdentity,
  VerificationCommandSpec,
  VerificationRecord,
} from '../review-workflow/types.js';
import { collectBaselineIncompatibilities } from './comparison.js';
import { hashBaselineValue } from './hash.js';
import { compareFindingSets } from './normalizer.js';
import {
  verificationBaselineApprovalSchema,
  verificationBaselineComparisonAttestationSchema,
  verificationBaselineComparisonSchema,
  verificationBaselineSchema,
  verificationLogArtifactSchema,
} from './schemas.js';
import type { ReviewWorkflowBaselineStore } from './store.js';
import type {
  ApproveBaselineInput,
  AttestBaselineComparisonInput,
  BaselineArtifactStore,
  BaselineRepository,
  CaptureBaselineInput,
  CompareBaselineInput,
  ToolFindingNormalizer,
  VerificationBaseline,
  VerificationBaselineApproval,
  VerificationBaselineComparison,
  VerificationBaselineComparisonAttestation,
  VerificationLogArtifact,
  VerificationLogArtifactReader,
} from './types.js';
import { ReviewWorkflowBaselineError } from './types.js';

export class ReviewWorkflowBaselineService {
  constructor(
    private readonly workflowStore: ReviewWorkflowStore,
    private readonly baselineStore: ReviewWorkflowBaselineStore,
    private readonly normalizer: ToolFindingNormalizer,
    private readonly logReader: VerificationLogArtifactReader,
    private readonly artifactStore: BaselineArtifactStore,
    private readonly repository: BaselineRepository,
  ) {}

  captureBaseline(input: CaptureBaselineInput): VerificationBaseline {
    const recordContext = this.requireVerificationRecord(input.verificationRecordId);
    if (recordContext.workflowId !== input.workflowId) {
      fail(
        'VERIFICATION_RECORD_CONTEXT_INVALID',
        `Verification record ${input.verificationRecordId} belongs to another workflow`,
      );
    }
    const workflow = this.requireWorkflow(recordContext.workflowId, recordContext.batchId);
    const actor = this.requireActor(input.captureActorExecutionId);
    this.requireCaptureActor(actor, recordContext.record);
    const record = requireBaselineRecord(recordContext.record);
    const log = this.readAndVerifyLog(record);
    const findings = this.normalize(log.stdout);
    const artifact = this.artifactStore.store(`baseline:${input.baselineId}`, {
      schemaVersion: 1,
      artifactKind: 'BASELINE_FINDINGS',
      findings,
    });

    const baseline = verificationBaselineSchema.parse({
      baselineId: input.baselineId,
      workflowId: workflow.workflowId,
      captureBatchId: workflow.batchId,
      verificationRecordId: record.verificationRecordId,
      command: commandFrom(record),
      toolName: this.normalizer.toolName,
      toolVersion: record.toolVersion,
      configurationInputPaths: input.configurationInputPaths,
      configurationHash: record.configurationHash,
      baselineCommitSha: record.commitSha,
      exitCode: record.outcome.exitCode,
      normalizerId: this.normalizer.normalizerId,
      normalizationSchemaVersion: this.normalizer.normalizationSchemaVersion,
      normalizedFindings: findings,
      normalizedFindingsLocation: artifact.location,
      normalizedFindingsHash: artifact.contentHash,
      findingCount: findings.length,
      rawLogLocation: record.fullLogLocation,
      rawLogHash: record.fullLogHash,
      captureActorExecutionId: actor.actorExecutionId,
      captureActorType: actor.actorType,
      reviewerApprovalStatus: 'PENDING',
      createdAt: input.createdAt,
    });
    this.baselineStore.saveBaseline(baseline);
    return baseline;
  }

  approveBaseline(input: ApproveBaselineInput): VerificationBaselineApproval {
    const baseline = this.requireBaseline(input.baselineId);
    const workflow = this.requireWorkflow(baseline.workflowId, baseline.captureBatchId);
    const reviewer = this.requireReviewer(input.reviewerActorExecutionId, workflow.reviewerId);
    if (reviewer.actorExecutionId === baseline.captureActorExecutionId) {
      fail(
        'INDEPENDENT_REVIEWER_REQUIRED',
        'The baseline capture actor cannot approve the captured baseline',
      );
    }

    const approval = verificationBaselineApprovalSchema.parse({
      baselineApprovalId: input.baselineApprovalId,
      baselineId: baseline.baselineId,
      baselineEvidenceHash: hashBaselineValue(baseline),
      workflowId: baseline.workflowId,
      captureBatchId: baseline.captureBatchId,
      decision: input.decision,
      rationale: input.rationale,
      reviewerActorExecutionId: reviewer.actorExecutionId,
      reviewerAssignmentId: workflow.reviewerId,
      authorityExercised: 'VERIFICATION_ATTESTOR',
      createdAt: input.createdAt,
    });
    this.baselineStore.saveBaselineApproval(approval);
    return approval;
  }

  compare(input: CompareBaselineInput): VerificationBaselineComparison {
    const baseline = this.requireBaseline(input.baselineId);
    const approval = this.requireAcceptedBaselineApproval(input.baselineApprovalId, baseline);
    const currentContext = this.requireVerificationRecord(input.currentVerificationRecordId);
    if (currentContext.workflowId !== baseline.workflowId) {
      fail(
        'VERIFICATION_RECORD_CONTEXT_INVALID',
        'Baseline and current verification record belong to different workflows',
      );
    }
    const workflow = this.requireWorkflow(currentContext.workflowId, currentContext.batchId);
    const actor = this.requireActor(input.captureActorExecutionId);
    this.requireCaptureActor(actor, currentContext.record);
    const current = requireExitedRecord(currentContext.record);
    const currentCommand = commandFrom(current);
    const incompatibilities = collectBaselineIncompatibilities(baseline, {
      currentCommand,
      currentToolName: this.normalizer.toolName,
      ...(current.toolVersion === undefined ? {} : { currentToolVersion: current.toolVersion }),
      currentConfigurationInputPaths: input.currentConfigurationInputPaths,
      currentConfigurationHash: current.configurationHash,
      normalizerId: this.normalizer.normalizerId,
      normalizationSchemaVersion: this.normalizer.normalizationSchemaVersion,
    });
    const common = {
      comparisonId: input.comparisonId,
      workflowId: workflow.workflowId,
      batchId: workflow.batchId,
      baselineId: baseline.baselineId,
      baselineApprovalId: approval.baselineApprovalId,
      baselineEvidenceHash: approval.baselineEvidenceHash,
      currentVerificationRecordId: current.verificationRecordId,
      currentCommitSha: current.commitSha,
      currentCommand,
      currentToolName: this.normalizer.toolName,
      ...(current.toolVersion === undefined ? {} : { currentToolVersion: current.toolVersion }),
      currentConfigurationInputPaths: input.currentConfigurationInputPaths,
      currentConfigurationHash: current.configurationHash,
      normalizerId: this.normalizer.normalizerId,
      normalizationSchemaVersion: this.normalizer.normalizationSchemaVersion,
      captureActorExecutionId: actor.actorExecutionId,
      captureActorType: actor.actorType,
      createdAt: input.createdAt,
    };

    if (incompatibilities.length > 0) {
      const comparison = verificationBaselineComparisonSchema.parse({
        ...common,
        result: 'INCOMPARABLE',
        incompatibilities,
      });
      this.baselineStore.saveComparison(comparison);
      return comparison;
    }

    const log = this.readAndVerifyLog(current);
    const currentFindings = this.normalize(log.stdout);
    const artifact = this.artifactStore.store(`comparison:${input.comparisonId}`, {
      schemaVersion: 1,
      artifactKind: 'CURRENT_FINDINGS',
      findings: currentFindings,
    });
    const difference = compareFindingSets(baseline.normalizedFindings, currentFindings);
    const comparison = verificationBaselineComparisonSchema.parse({
      ...common,
      result: difference.introduced.length === 0 ? 'PASSED' : 'FAILED',
      incompatibilities: [],
      currentNormalizedFindings: currentFindings,
      currentNormalizedFindingsLocation: artifact.location,
      currentNormalizedFindingsHash: artifact.contentHash,
      currentFindingCount: currentFindings.length,
      introduced: difference.introduced,
      resolved: difference.resolved,
      unchanged: difference.unchanged,
    });
    this.baselineStore.saveComparison(comparison);
    return comparison;
  }

  attestComparison(
    input: AttestBaselineComparisonInput,
  ): VerificationBaselineComparisonAttestation {
    const comparison = this.baselineStore.getComparison(input.comparisonId);
    if (comparison === null) {
      fail('COMPARISON_NOT_FOUND', `Comparison ${input.comparisonId} does not exist`);
    }
    const workflow = this.requireWorkflow(comparison.workflowId, comparison.batchId);
    const reviewer = this.requireReviewer(input.reviewerActorExecutionId, workflow.reviewerId);
    if (reviewer.actorExecutionId === comparison.captureActorExecutionId) {
      fail(
        'INDEPENDENT_REVIEWER_REQUIRED',
        'The comparison capture actor cannot attest its own comparison',
      );
    }
    const baselineApproval = this.requireAcceptedBaselineApproval(
      comparison.baselineApprovalId,
      this.requireBaseline(comparison.baselineId),
    );
    const isComparable = comparison.result !== 'INCOMPARABLE';
    const introducedSetEmpty =
      comparison.result !== 'INCOMPARABLE' && comparison.introduced.length === 0;
    if (
      input.decision === 'ACCEPTED' &&
      (comparison.result !== 'PASSED' ||
        !input.baselineTrustworthy ||
        !input.toolVersionAndConfigurationComparable ||
        !input.introducedSetEmpty ||
        !input.normalizationReviewed ||
        input.toolVersionAndConfigurationComparable !== isComparable ||
        input.introducedSetEmpty !== introducedSetEmpty)
    ) {
      fail(
        'COMPARISON_NOT_ACCEPTABLE',
        'Only a comparable, introduced-finding-free comparison with every reviewer check may be accepted',
      );
    }
    const currentHeadSha = this.repository.readHeadSha();
    if (input.decision === 'ACCEPTED' && currentHeadSha !== comparison.currentCommitSha) {
      fail(
        'HEAD_MISMATCH',
        'Accepted baseline comparison evidence must match the current repository HEAD',
      );
    }

    const attestation = verificationBaselineComparisonAttestationSchema.parse({
      comparisonAttestationId: input.comparisonAttestationId,
      comparisonId: comparison.comparisonId,
      comparisonEvidenceHash: hashBaselineValue(comparison),
      workflowId: comparison.workflowId,
      batchId: comparison.batchId,
      baselineId: comparison.baselineId,
      baselineApprovalId: baselineApproval.baselineApprovalId,
      decision: input.decision,
      rationale: input.rationale,
      baselineTrustworthy: input.baselineTrustworthy,
      toolVersionAndConfigurationComparable: input.toolVersionAndConfigurationComparable,
      introducedSetEmpty: input.introducedSetEmpty,
      normalizationReviewed: input.normalizationReviewed,
      reviewerActorExecutionId: reviewer.actorExecutionId,
      reviewerAssignmentId: workflow.reviewerId,
      authorityExercised: 'VERIFICATION_ATTESTOR',
      reviewedCommitSha: comparison.currentCommitSha,
      createdAt: input.createdAt,
    });
    this.baselineStore.saveComparisonAttestation(attestation);
    return attestation;
  }

  private normalize(rawOutput: string) {
    try {
      return this.normalizer.normalize(rawOutput);
    } catch (error) {
      if (error instanceof ReviewWorkflowBaselineError) throw error;
      fail(
        'NORMALIZATION_FAILED',
        error instanceof Error ? error.message : 'Tool finding normalization failed',
      );
    }
  }

  private readAndVerifyLog(record: VerificationRecord): VerificationLogArtifact {
    let serialized: string;
    try {
      serialized = this.logReader.read(record.fullLogLocation);
    } catch {
      fail(
        'VERIFICATION_LOG_INVALID',
        `Verification log for ${record.verificationRecordId} could not be read`,
      );
    }
    const hash = createHash('sha256').update(serialized).digest('hex');
    if (hash !== record.fullLogHash) {
      fail(
        'VERIFICATION_LOG_HASH_MISMATCH',
        `Verification log for ${record.verificationRecordId} failed its hash check`,
      );
    }
    let log: VerificationLogArtifact;
    try {
      log = verificationLogArtifactSchema.parse(JSON.parse(serialized));
    } catch {
      fail(
        'VERIFICATION_LOG_INVALID',
        `Verification log for ${record.verificationRecordId} is not a valid artifact`,
      );
    }
    const matches =
      log.command === record.command &&
      sameStrings(log.arguments, record.arguments) &&
      log.workingDirectory === record.workingDirectory &&
      log.startedAt === record.startedAt &&
      log.finishedAt === record.finishedAt &&
      canonicalVerificationJson(log.outcome) === canonicalVerificationJson(record.outcome);
    if (!matches) {
      fail(
        'VERIFICATION_LOG_RECORD_MISMATCH',
        `Verification log for ${record.verificationRecordId} does not match its record`,
      );
    }
    return log;
  }

  private requireWorkflow(
    workflowId: string,
    batchId: string,
  ): {
    readonly workflowId: string;
    readonly batchId: string;
    readonly implementerId: string;
    readonly reviewerId: string;
  } {
    const workflow = this.workflowStore.getWorkflow(workflowId);
    const batch = this.workflowStore.getBatch(batchId);
    if (workflow === null || batch === null || batch.workflowId !== workflowId) {
      fail(
        'WORKFLOW_CONTEXT_INVALID',
        `Baseline workflow context ${workflowId}/${batchId} does not exist`,
      );
    }
    return {
      workflowId,
      batchId,
      implementerId: batch.implementerAssignmentId,
      reviewerId: batch.reviewerAssignmentId,
    };
  }

  private requireVerificationRecord(verificationRecordId: string): {
    readonly workflowId: string;
    readonly batchId: string;
    readonly record: VerificationRecord;
  } {
    const entity = this.workflowStore.getEntity('VERIFICATION_RECORD', verificationRecordId);
    if (entity === null || entity.kind !== 'VERIFICATION_RECORD') {
      fail(
        'VERIFICATION_RECORD_NOT_FOUND',
        `Verification record ${verificationRecordId} does not exist`,
      );
    }
    return {
      workflowId: entity.workflowId,
      batchId: entity.batchId,
      record: verificationRecordSchema.parse(entity.value),
    };
  }

  private requireActor(actorExecutionId: string): ActorExecutionIdentity {
    const entity = this.workflowStore.getEntity('ACTOR_EXECUTION', actorExecutionId);
    if (entity === null || entity.kind !== 'ACTOR_EXECUTION') {
      fail('ACTOR_EXECUTION_NOT_FOUND', `Actor execution ${actorExecutionId} does not exist`);
    }
    return actorExecutionIdentitySchema.parse(entity.value);
  }

  private requireCaptureActor(actor: ActorExecutionIdentity, record: VerificationRecord): void {
    if (!actor.authoritiesExercised.includes('VERIFICATION_EXECUTOR')) {
      fail(
        'CAPTURE_AUTHORITY_MISSING',
        `Actor execution ${actor.actorExecutionId} lacks verification executor authority`,
      );
    }
    if (actor.actorExecutionId !== record.executorActorExecutionId) {
      fail(
        'VERIFICATION_RECORD_CONTEXT_INVALID',
        'The baseline capture actor must be the verification record executor',
      );
    }
  }

  private requireReviewer(
    actorExecutionId: string,
    reviewerAssignmentId: string,
  ): ActorExecutionIdentity {
    const actor = this.requireActor(actorExecutionId);
    if (!actor.authoritiesExercised.includes('VERIFICATION_ATTESTOR')) {
      fail(
        'REVIEWER_AUTHORITY_MISSING',
        `Actor execution ${actorExecutionId} lacks verification attestor authority`,
      );
    }
    if (actor.actorType !== 'AGENT' || actor.assignmentId !== reviewerAssignmentId) {
      fail(
        'REVIEWER_ASSIGNMENT_INVALID',
        'Baseline review requires the assigned reviewer agent execution',
      );
    }
    return actor;
  }

  private requireBaseline(baselineId: string): VerificationBaseline {
    const baseline = this.baselineStore.getBaseline(baselineId);
    if (baseline === null) {
      fail('BASELINE_NOT_FOUND', `Baseline ${baselineId} does not exist`);
    }
    return baseline;
  }

  private requireAcceptedBaselineApproval(
    baselineApprovalId: string,
    baseline: VerificationBaseline,
  ): VerificationBaselineApproval {
    const approval = this.baselineStore.getBaselineApproval(baselineApprovalId);
    if (approval === null) {
      fail('BASELINE_APPROVAL_NOT_FOUND', `Baseline approval ${baselineApprovalId} does not exist`);
    }
    if (approval.decision !== 'ACCEPTED') {
      fail('BASELINE_APPROVAL_REQUIRED', 'A reviewer-accepted baseline is required');
    }
    if (
      approval.baselineId !== baseline.baselineId ||
      approval.workflowId !== baseline.workflowId ||
      approval.baselineEvidenceHash !== hashBaselineValue(baseline)
    ) {
      fail(
        'BASELINE_APPROVAL_MISMATCH',
        `Baseline approval ${baselineApprovalId} does not match the selected baseline`,
      );
    }
    return approval;
  }
}

function requireBaselineRecord(record: VerificationRecord): VerificationRecord & {
  readonly toolVersion: string;
  readonly outcome: { readonly kind: 'EXITED'; readonly exitCode: number };
} {
  if (record.toolVersion === undefined || record.outcome.kind !== 'EXITED') {
    fail(
      'VERIFICATION_RECORD_CONTEXT_INVALID',
      'Baseline normalization requires a tool version and an exited verification record',
    );
  }
  return {
    ...record,
    toolVersion: record.toolVersion,
    outcome: record.outcome,
  };
}

function requireExitedRecord(record: VerificationRecord): VerificationRecord & {
  readonly outcome: { readonly kind: 'EXITED'; readonly exitCode: number };
} {
  if (record.outcome.kind !== 'EXITED') {
    fail(
      'VERIFICATION_RECORD_CONTEXT_INVALID',
      'Baseline normalization requires an exited verification record',
    );
  }
  return {
    ...record,
    outcome: record.outcome,
  };
}

function commandFrom(record: VerificationRecord): VerificationCommandSpec {
  return {
    executable: record.command,
    arguments: record.arguments,
    workingDirectory: record.workingDirectory,
    verificationType: record.verificationType,
    relatedCriterionIds: record.relatedCriterionIds,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fail(
  code: ConstructorParameters<typeof ReviewWorkflowBaselineError>[0],
  message: string,
): never {
  throw new ReviewWorkflowBaselineError(code, message);
}
