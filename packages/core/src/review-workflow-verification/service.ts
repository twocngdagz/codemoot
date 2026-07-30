import type { ReviewWorkflowStore } from '../memory/review-workflow-store.js';
import {
  actorExecutionIdentitySchema,
  contentHashSchema,
  gitShaSchema,
  verificationAttestationSchema,
  verificationCommandSpecSchema,
  verificationExecutionOutcomeSchema,
  verificationRecordSchema,
} from '../review-workflow/schemas.js';
import type {
  ActorExecutionIdentity,
  VerificationAttestation,
  VerificationExecutionOutcome,
  VerificationObservedStatus,
  VerificationRecord,
} from '../review-workflow/types.js';
import { hashVerificationRecord } from './hash.js';
import { verificationAttestationPolicySchema } from './schemas.js';
import type {
  AttestVerificationInput,
  ExecuteVerificationInput,
  IngestVerificationInput,
  VerificationAttestationPolicy,
  VerificationCaptureResult,
  VerificationCommandExecution,
  VerificationCommandRunner,
  VerificationContext,
  VerificationLogContent,
  VerificationLogStore,
  VerificationRepository,
} from './types.js';
import { ReviewWorkflowVerificationError } from './types.js';

const OUTPUT_SUMMARY_MAX_CHARACTERS = 8_000;

export class ReviewWorkflowVerificationService {
  constructor(
    private readonly store: ReviewWorkflowStore,
    private readonly repository: VerificationRepository,
    private readonly runner: VerificationCommandRunner,
    private readonly logStore: VerificationLogStore,
  ) {}

  async execute(input: ExecuteVerificationInput): Promise<VerificationCaptureResult> {
    const command = verificationCommandSpecSchema.parse(input.command);
    const configurationHash = contentHashSchema.parse(input.configurationHash);
    const expectedCommitSha = gitShaSchema.parse(input.expectedCommitSha);
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new RangeError('Verification timeout must be a positive safe integer');
    }
    const workflow = this.requireWorkflowContext(input.workflowId, input.batchId);
    this.requireApprovedCommand(command, workflow);
    const executor = this.requireActor(input.executorActorExecutionId);
    this.requireExecutor(executor, workflow);

    const headShaBefore = this.repository.readHeadSha();
    if (headShaBefore !== expectedCommitSha) {
      throw new ReviewWorkflowVerificationError(
        'HEAD_MISMATCH',
        `Repository HEAD ${headShaBefore} does not match expected verification SHA ${expectedCommitSha}`,
      );
    }

    const execution = await this.runner.execute({
      command,
      timeoutMs: input.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const headShaAfter = this.repository.readHeadSha();
    const result = this.persistCapture({
      verificationRecordId: input.verificationRecordId,
      workflowId: input.workflowId,
      batchId: input.batchId,
      executor,
      evidenceSource: 'CODEMOOT_EXECUTED',
      command,
      relatedFindingIds: input.relatedFindingIds,
      configurationHash,
      ...(input.toolVersion === undefined ? {} : { toolVersion: input.toolVersion }),
      commitSha: headShaBefore,
      execution,
    });
    return {
      ...result,
      headShaBefore,
      headShaAfter,
      headUnchanged: headShaBefore === headShaAfter,
    };
  }

  ingest(input: IngestVerificationInput): VerificationCaptureResult {
    if (input.evidenceSource !== 'TRUSTED_CI' && input.evidenceSource !== 'EXTERNAL') {
      throw new ReviewWorkflowVerificationError(
        'WORKFLOW_CONTEXT_INVALID',
        'Ingested evidence must be classified as trusted CI or external',
      );
    }
    const command = verificationCommandSpecSchema.parse(input.command);
    const configurationHash = contentHashSchema.parse(input.configurationHash);
    const commitSha = gitShaSchema.parse(input.commitSha);
    const workflow = this.requireWorkflowContext(input.workflowId, input.batchId);
    this.requireApprovedCommand(command, workflow);
    const executor = this.requireActor(input.executorActorExecutionId);
    this.requireExecutor(executor, workflow);
    if (input.evidenceSource === 'TRUSTED_CI' && executor.actorType !== 'CI') {
      throw new ReviewWorkflowVerificationError(
        'WORKFLOW_CONTEXT_INVALID',
        'Trusted CI evidence must identify a CI executor',
      );
    }

    return this.persistCapture({
      verificationRecordId: input.verificationRecordId,
      workflowId: input.workflowId,
      batchId: input.batchId,
      executor,
      evidenceSource: input.evidenceSource,
      command,
      relatedFindingIds: input.relatedFindingIds,
      configurationHash,
      ...(input.toolVersion === undefined ? {} : { toolVersion: input.toolVersion }),
      commitSha,
      execution: {
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        outcome: verificationExecutionOutcomeSchema.parse(input.outcome),
        stdout: input.stdout,
        stderr: input.stderr,
      },
    });
  }

  attest(input: AttestVerificationInput): VerificationAttestation {
    const policy = verificationAttestationPolicySchema.parse(input.policy);
    const currentHeadSha = gitShaSchema.parse(input.currentHeadSha);
    const workflow = this.requireWorkflowContext(input.workflowId, input.batchId);
    this.requireApprovedCommand(policy.approvedCommand, workflow);
    const record = this.requireVerificationRecord(
      input.verificationRecordId,
      input.workflowId,
      input.batchId,
    );
    const attestor = this.requireActor(input.attestorActorExecutionId);
    this.requireAttestor(attestor, workflow, input.acceptanceMode);
    this.requireRecordMatchesPolicy(record, policy, workflow);

    if (input.decision === 'ACCEPTED') {
      if (record.commitSha !== currentHeadSha || policy.expectedCommitSha !== currentHeadSha) {
        throw new ReviewWorkflowVerificationError(
          'HEAD_MISMATCH',
          'Accepted verification evidence must be bound to the current expected commit',
        );
      }
      if (input.acceptanceMode === 'AUTOMATIC_POLICY') {
        this.requireAutomaticAcceptance(record, workflow, policy);
      }
      const judgmentRequired = requiresJudgmentAttestation(record, workflow, policy);
      if (
        judgmentRequired &&
        input.acceptanceMode !== 'REVIEWER' &&
        input.acceptanceMode !== 'HUMAN'
      ) {
        throw new ReviewWorkflowVerificationError(
          'JUDGMENT_ATTESTOR_REQUIRED',
          'This verification evidence requires reviewer or human judgment',
        );
      }
      if (policy.baselineComparison && input.acceptanceMode !== 'REVIEWER') {
        throw new ReviewWorkflowVerificationError(
          'JUDGMENT_ATTESTOR_REQUIRED',
          'Baseline comparison evidence requires assigned reviewer acceptance',
        );
      }
      if (judgmentRequired) {
        this.requireIndependentAttestor(record, attestor);
      }
    }

    const attestation = verificationAttestationSchema.parse({
      verificationAttestationId: input.verificationAttestationId,
      verificationRecordId: record.verificationRecordId,
      evidenceHash: hashVerificationRecord(record),
      workflowId: input.workflowId,
      batchId: input.batchId,
      relatedCriterionIds: record.relatedCriterionIds,
      relatedFindingIds: record.relatedFindingIds,
      decision: input.decision,
      acceptanceMode: input.acceptanceMode,
      rationale: input.rationale,
      attestorActorExecutionId: attestor.actorExecutionId,
      attestorActorType: attestor.actorType,
      ...(attestor.assignmentId === undefined
        ? {}
        : { attestorAssignmentId: attestor.assignmentId }),
      authorityExercised: 'VERIFICATION_ATTESTOR',
      recordVerificationType: record.verificationType,
      recordExecutorActorExecutionId: record.executorActorExecutionId,
      recordExecutorActorType: record.executorActorType,
      ...(record.executorAssignmentId === undefined
        ? {}
        : { recordExecutorAssignmentId: record.executorAssignmentId }),
      reviewedCommitSha: currentHeadSha,
      policyConfigurationHash: policy.policyConfigurationHash,
      createdAt: input.createdAt,
    });
    this.store.saveEntity({ kind: 'VERIFICATION_ATTESTATION', value: attestation });
    return attestation;
  }

  private persistCapture(input: {
    readonly verificationRecordId: string;
    readonly workflowId: string;
    readonly batchId: string;
    readonly executor: ActorExecutionIdentity;
    readonly evidenceSource: NonNullable<VerificationRecord['evidenceSource']>;
    readonly command: ExecuteVerificationInput['command'];
    readonly relatedFindingIds: readonly string[];
    readonly configurationHash: string;
    readonly toolVersion?: string;
    readonly commitSha: string;
    readonly execution: VerificationCommandExecution;
  }): VerificationCaptureResult {
    const logContent: VerificationLogContent = {
      schemaVersion: 1,
      command: input.command.executable,
      arguments: input.command.arguments,
      workingDirectory: input.command.workingDirectory,
      startedAt: input.execution.startedAt,
      finishedAt: input.execution.finishedAt,
      outcome: input.execution.outcome,
      stdout: input.execution.stdout,
      stderr: input.execution.stderr,
    };
    const log = this.logStore.store(input.verificationRecordId, logContent);
    const record = verificationRecordSchema.parse({
      verificationRecordId: input.verificationRecordId,
      command: input.command.executable,
      arguments: input.command.arguments,
      workingDirectory: input.command.workingDirectory,
      startedAt: input.execution.startedAt,
      finishedAt: input.execution.finishedAt,
      outcome: input.execution.outcome,
      outputSummary: summarizeOutput(input.execution.stdout, input.execution.stderr),
      fullLogLocation: log.location,
      fullLogHash: log.contentHash,
      relatedCriterionIds: input.command.relatedCriterionIds,
      relatedFindingIds: input.relatedFindingIds,
      commitSha: input.commitSha,
      executorActorExecutionId: input.executor.actorExecutionId,
      executorActorType: input.executor.actorType,
      ...(input.executor.assignmentId === undefined
        ? {}
        : { executorAssignmentId: input.executor.assignmentId }),
      evidenceSource: input.evidenceSource,
      verificationType: input.command.verificationType,
      ...(input.toolVersion === undefined ? {} : { toolVersion: input.toolVersion }),
      configurationHash: input.configurationHash,
      observedStatus: observedStatusFor(input.execution.outcome),
    });
    this.store.saveEntity({
      kind: 'VERIFICATION_RECORD',
      workflowId: input.workflowId,
      batchId: input.batchId,
      value: record,
    });
    return { record, log };
  }

  private requireWorkflowContext(workflowId: string, batchId: string): VerificationContext {
    const workflow = this.store.getWorkflow(workflowId);
    const batch = this.store.getBatch(batchId);
    if (workflow === null || batch === null || batch.workflowId !== workflowId) {
      throw new ReviewWorkflowVerificationError(
        'WORKFLOW_CONTEXT_INVALID',
        `Verification context ${workflowId}/${batchId} does not exist`,
      );
    }
    return {
      workflowId,
      batchId,
      currentPlanVersionId: batch.currentPlanVersionId,
      workflowConfigurationHash: workflow.configurationHash,
      implementerAssignmentId: batch.implementerAssignmentId,
      reviewerAssignmentId: batch.reviewerAssignmentId,
    };
  }

  private requireApprovedCommand(
    command: ExecuteVerificationInput['command'],
    workflow: VerificationContext,
  ): void {
    const entity = this.store.getEntity('BATCH_PLAN_VERSION', workflow.currentPlanVersionId);
    if (
      entity === null ||
      entity.kind !== 'BATCH_PLAN_VERSION' ||
      entity.value.workflowId !== workflow.workflowId ||
      entity.value.batchId !== workflow.batchId ||
      !entity.value.verificationCommands.some((candidate) => sameCommand(candidate, command))
    ) {
      throw new ReviewWorkflowVerificationError(
        'COMMAND_NOT_APPROVED',
        'Verification command is not present in the current approved batch plan',
      );
    }
  }

  private requireActor(actorExecutionId: string): ActorExecutionIdentity {
    const entity = this.store.getEntity('ACTOR_EXECUTION', actorExecutionId);
    if (entity === null || entity.kind !== 'ACTOR_EXECUTION') {
      throw new ReviewWorkflowVerificationError(
        'ACTOR_EXECUTION_NOT_FOUND',
        `Actor execution ${actorExecutionId} does not exist`,
      );
    }
    return actorExecutionIdentitySchema.parse(entity.value);
  }

  private requireExecutor(actor: ActorExecutionIdentity, workflow: VerificationContext): void {
    if (!actor.authoritiesExercised.includes('VERIFICATION_EXECUTOR')) {
      throw new ReviewWorkflowVerificationError(
        'EXECUTOR_AUTHORITY_MISSING',
        `Actor execution ${actor.actorExecutionId} lacks verification executor authority`,
      );
    }
    requireAgentAssignmentMatchesWorkflow(actor, workflow);
  }

  private requireAttestor(
    actor: ActorExecutionIdentity,
    workflow: VerificationContext,
    mode: VerificationAttestation['acceptanceMode'],
  ): void {
    if (!actor.authoritiesExercised.includes('VERIFICATION_ATTESTOR')) {
      throw new ReviewWorkflowVerificationError(
        'ATTESTOR_AUTHORITY_MISSING',
        `Actor execution ${actor.actorExecutionId} lacks verification attestor authority`,
      );
    }
    requireAgentAssignmentMatchesWorkflow(actor, workflow);
    if (mode === 'REVIEWER' && actor.assignmentId !== workflow.reviewerAssignmentId) {
      throw new ReviewWorkflowVerificationError(
        'AGENT_ASSIGNMENT_INVALID',
        'Reviewer attestation must use the assigned reviewer execution',
      );
    }
  }

  private requireVerificationRecord(
    verificationRecordId: string,
    workflowId: string,
    batchId: string,
  ): VerificationRecord {
    const entity = this.store.getEntity('VERIFICATION_RECORD', verificationRecordId);
    if (entity === null || entity.kind !== 'VERIFICATION_RECORD') {
      throw new ReviewWorkflowVerificationError(
        'VERIFICATION_RECORD_NOT_FOUND',
        `Verification record ${verificationRecordId} does not exist`,
      );
    }
    if (entity.workflowId !== workflowId || entity.batchId !== batchId) {
      throw new ReviewWorkflowVerificationError(
        'VERIFICATION_RECORD_CONTEXT_INVALID',
        `Verification record ${verificationRecordId} belongs to another workflow or batch`,
      );
    }
    return verificationRecordSchema.parse(entity.value);
  }

  private requireRecordMatchesPolicy(
    record: VerificationRecord,
    policy: VerificationAttestationPolicy,
    workflow: VerificationContext,
  ): void {
    const approved = policy.approvedCommand;
    const commandMatches =
      record.command === approved.executable &&
      sameStrings(record.arguments, approved.arguments) &&
      record.workingDirectory === approved.workingDirectory &&
      record.verificationType === approved.verificationType &&
      sameStrings(record.relatedCriterionIds, approved.relatedCriterionIds);
    const criterionPoliciesMatch = sameStrings(
      record.relatedCriterionIds,
      policy.criterionPolicies.map((criterion) => criterion.criterionId),
    );
    if (
      !commandMatches ||
      !criterionPoliciesMatch ||
      policy.policyConfigurationHash !== workflow.workflowConfigurationHash ||
      record.configurationHash !== policy.expectedVerificationConfigurationHash ||
      record.commitSha !== policy.expectedCommitSha
    ) {
      throw new ReviewWorkflowVerificationError(
        'ATTESTATION_POLICY_MISMATCH',
        'Verification record does not match the approved command, criteria, configuration, or commit',
      );
    }
  }

  private requireAutomaticAcceptance(
    record: VerificationRecord,
    workflow: VerificationContext,
    policy: VerificationAttestationPolicy,
  ): void {
    const denied =
      record.observedStatus !== 'SUCCEEDED' ||
      record.evidenceSource === undefined ||
      record.evidenceSource === 'EXTERNAL' ||
      record.toolVersion !== policy.expectedToolVersion ||
      record.verificationType === 'manual' ||
      record.verificationType === 'browser' ||
      record.verificationType === 'static_analysis' ||
      record.executorAssignmentId === workflow.implementerAssignmentId ||
      record.relatedFindingIds.length > 0 ||
      policy.parserAmbiguityRequiresJudgment ||
      policy.baselineComparison ||
      policy.criterionPolicies.some(
        (criterion) =>
          !criterion.allowsAutomaticAcceptance || criterion.requiresIndependentAttestation,
      );
    if (denied) {
      throw new ReviewWorkflowVerificationError(
        'AUTOMATIC_ACCEPTANCE_DENIED',
        'Verification evidence does not satisfy automatic acceptance policy',
      );
    }
  }

  private requireIndependentAttestor(
    record: VerificationRecord,
    attestor: ActorExecutionIdentity,
  ): void {
    if (
      record.executorActorExecutionId === attestor.actorExecutionId ||
      (record.executorAssignmentId !== undefined &&
        record.executorAssignmentId === attestor.assignmentId)
    ) {
      throw new ReviewWorkflowVerificationError(
        'INDEPENDENT_ATTESTOR_REQUIRED',
        'Verification evidence requires an attestor independent from its executor',
      );
    }
  }
}

function requiresJudgmentAttestation(
  record: VerificationRecord,
  workflow: VerificationContext,
  policy: VerificationAttestationPolicy,
): boolean {
  return (
    record.verificationType === 'manual' ||
    record.verificationType === 'browser' ||
    record.evidenceSource === undefined ||
    record.evidenceSource === 'EXTERNAL' ||
    record.executorAssignmentId === workflow.implementerAssignmentId ||
    record.observedStatus !== 'SUCCEEDED' ||
    record.verificationType === 'static_analysis' ||
    record.relatedFindingIds.length > 0 ||
    policy.parserAmbiguityRequiresJudgment ||
    policy.baselineComparison ||
    policy.criterionPolicies.some((criterion) => criterion.requiresIndependentAttestation)
  );
}

function requireAgentAssignmentMatchesWorkflow(
  actor: ActorExecutionIdentity,
  workflow: VerificationContext,
): void {
  if (
    actor.actorType === 'AGENT' &&
    actor.assignmentId !== workflow.implementerAssignmentId &&
    actor.assignmentId !== workflow.reviewerAssignmentId
  ) {
    throw new ReviewWorkflowVerificationError(
      'AGENT_ASSIGNMENT_INVALID',
      `Agent execution ${actor.actorExecutionId} is not assigned to this batch`,
    );
  }
}

function observedStatusFor(outcome: VerificationExecutionOutcome): VerificationObservedStatus {
  if (outcome.kind === 'TIMED_OUT') return 'TIMED_OUT';
  if (outcome.kind === 'ERROR') return 'ERROR';
  return outcome.exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
}

function summarizeOutput(stdout: string, stderr: string): string {
  const combined = [stdout, stderr].filter((value) => value.length > 0).join('\n');
  if (combined.length <= OUTPUT_SUMMARY_MAX_CHARACTERS) return combined;
  return `${combined.slice(0, OUTPUT_SUMMARY_MAX_CHARACTERS)}\n[summary truncated]`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function sameCommand(
  left: ExecuteVerificationInput['command'],
  right: ExecuteVerificationInput['command'],
): boolean {
  return (
    left.executable === right.executable &&
    left.workingDirectory === right.workingDirectory &&
    left.verificationType === right.verificationType &&
    left.arguments.length === right.arguments.length &&
    left.arguments.every((value, index) => value === right.arguments[index]) &&
    sameStrings(left.relatedCriterionIds, right.relatedCriterionIds)
  );
}
