// Final merge gate: every condition derived from persisted facts and fresh repository reads.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  ReviewWorkflowCommandStore,
  ReviewWorkflowSideEffectKind,
  StoredReviewWorkflowCommand,
} from '../memory/review-workflow-command-store.js';
import { parseFinalAuditResult } from '../review-workflow-contracts/parser.js';
import type { ReviewWorkflowContractService } from '../review-workflow-contracts/service.js';
import type { GitRepository, ReviewWorkflowGitService } from '../review-workflow-git/index.js';
import {
  type ReviewWorkflowConfigurationSnapshot,
  reviewWorkflowConfigurationSnapshotSchema,
} from '../review-workflow-identity/index.js';
import {
  gitShaSchema,
  mergeApprovalEvidenceSchema,
  verificationRecordSchema,
} from '../review-workflow/schemas.js';
import { transitionBatch } from '../review-workflow/state-machine.js';
import type {
  ActorExecutionIdentity,
  AllowedTransition,
  Finding,
  MergeApprovalEvidence,
  ReviewWorkflowBatch,
  StateChangingCommandRequest,
  TransitionCommand,
  VerificationRecord,
} from '../review-workflow/types.js';
import { isSessionContinuityError } from '../roles/role-invocation.js';
import type {
  PreparedRoleInvocation,
  RoleInvocationInput,
  RoleInvocationService,
} from '../roles/role-invocation.js';
import type { ReviewWorkflowGateStore } from './store.js';
import {
  type BatchEffectiveStateReport,
  type EvaluateGateInput,
  type EvaluateGateResult,
  type FinalAuditInput,
  type FinalAuditResult,
  type GateConditionReport,
  type GateVerificationExecutionInput,
  type GateVerificationExecutionResult,
  type MarkMergedInput,
  type ReconcileStaleApprovalInput,
  ReviewWorkflowGateError,
} from './types.js';

interface RoleInvoker {
  prepare(input: RoleInvocationInput): Promise<PreparedRoleInvocation>;
  persistPrepared(prepared: PreparedRoleInvocation): void;
}

type Clock = () => Date;

const gateConditionReportSchema = z
  .object({
    reviewedCommitSha: gitShaSchema.nullable(),
    currentHeadSha: gitShaSchema,
    headMatchesReviewedCommit: z.boolean(),
    cleanWorktree: z.boolean(),
    unresolvedCriticalOrHighFindingCount: z.number().int().nonnegative(),
    incompleteDispositionCount: z.number().int().nonnegative(),
    requiredCriteriaPassed: z.boolean(),
    requiredVerificationComplete: z.boolean(),
    requiredAttestationsAccepted: z.boolean(),
    manualAndBrowserEvidenceIndependentlyAttested: z.boolean(),
    finalDiffReviewed: z.boolean(),
    scopeMatchesApprovedPlan: z.boolean(),
    documentationComplete: z.boolean(),
  })
  .strict();

const gateApprovalReplaySchema = z
  .object({
    conditions: gateConditionReportSchema,
    evidence: mergeApprovalEvidenceSchema,
  })
  .strict();

export function deriveFinalAuditRangeEvidenceId(batchId: string): string {
  return `${batchId}:range:final-gate`;
}

export function deriveFinalAuditRoundId(batchId: string): string {
  return `${batchId}:final-audit:1`;
}

/**
 * The final audit completes without a state transition, so its claimed side-effect identity
 * is a deterministic derivation rather than the per-attempt invocation ID. This gives the
 * final audit a durable identity distinct from code review (whose claimed identity must be
 * its invocation, for transition-actor binding) even when command IDs collide.
 */
export function deriveFinalAuditSideEffectIdentity(commandId: string): string {
  return `${commandId}:final-audit-invocation`;
}

export class ReviewWorkflowGateService {
  constructor(
    private readonly store: ReviewWorkflowGateStore,
    private readonly commandStore: ReviewWorkflowCommandStore,
    private readonly contractService: ReviewWorkflowContractService,
    private readonly gitService: ReviewWorkflowGitService,
    private readonly repository: GitRepository,
    private readonly roleInvoker: RoleInvoker | RoleInvocationService,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /**
   * The single bounded final audit: the reviewer verifies workflow-requirement coverage,
   * acceptance-criterion completeness, scope, and documentation against the final-gate range
   * (H = I, empty I..H, cumulative hash equal to the accepted code review). Evidence only —
   * the batch stays in VERIFYING; the gate consumes the persisted audit.
   */
  async finalAudit(input: FinalAuditInput): Promise<FinalAuditResult> {
    const context = this.requireContext(input.workflowId, input.batchId, input.configuration);
    const replayed = this.replayedCommand({
      commandId: input.commandId,
      workflowId: input.workflowId,
      batchId: input.batchId,
      commandType: 'START_CODE_REVIEW',
      sideEffect: {
        kind: 'AGENT_INVOCATION',
        identity: deriveFinalAuditSideEffectIdentity(input.commandId),
      },
    });
    if (replayed !== null) return this.replayFinalAudit(input.batchId);
    this.requireState(context.batch, 'VERIFYING');
    if (this.store.listFinalAudits(input.batchId).length > 0) {
      throw new ReviewWorkflowGateError(
        'FINAL_AUDIT_EXISTS',
        `Batch ${input.batchId} already has its single final audit`,
      );
    }
    const approvedReview = this.requireApprovedCodeReview(input.batchId);
    const workflow = context.workflow;
    if (workflow.refinedPlanVersionId === undefined) {
      throw new ReviewWorkflowGateError(
        'CODE_REVIEW_APPROVAL_REQUIRED',
        'Final audit requires the workflow refined plan version',
      );
    }
    // The bound reviewer session is authoritative for audit-trail identity: the guard
    // receipt and its requester must name the session actually being resumed, never a
    // caller-fresh identifier that will remain unpersisted.
    const boundReviewerSession = this.store.workflowStore.getBatchRoleSession(
      input.batchId,
      'REVIEWER',
    );
    const reviewerSessionForEvidence =
      boundReviewerSession?.sessionIdentityId ??
      input.previousSessionIdentityId ??
      input.sessionIdentityId;
    const before = this.repository.readWorktree();
    const captured = this.gitService.captureReviewRange({
      kind: 'FINAL_GATE',
      originalBatchBaseSha: this.requireBatchBase(context.batch),
      currentImplementationSha: approvedReview.target.reviewedCommitSha,
      previousReviewedImplementationSha: approvedReview.target.reviewedCommitSha,
      acceptedCumulativePatchHash: approvedReview.target.patchHash,
    });
    const reviewRangeEvidenceId = deriveFinalAuditRangeEvidenceId(input.batchId);
    const existingRange = this.store.workflowStore.getEntity(
      'REVIEW_RANGE_EVIDENCE',
      reviewRangeEvidenceId,
    );
    if (existingRange === null) {
      this.store.workflowStore.saveEntity({
        kind: 'REVIEW_RANGE_EVIDENCE',
        reviewRangeEvidenceId,
        workflowId: input.workflowId,
        batchId: input.batchId,
        value: captured.evidence,
      });
    }
    const requirementIds = this.store.listPlanRequirementIds(workflow.generalPlanVersionId);
    const criterionIds = this.store
      .listAcceptanceCriteria(context.batch.currentPlanVersionId)
      .map((criterion) => criterion.acceptanceCriterionId);
    const deferredFindings = this.store
      .listBatchFindings(input.batchId)
      .filter((finding) => finding.severity !== 'critical' && finding.severity !== 'high');

    const target = {
      kind: 'FINAL_AUDIT' as const,
      reviewedCommitSha: approvedReview.target.reviewedCommitSha,
      repositoryContextSha: approvedReview.target.reviewedCommitSha,
      reviewRangeEvidenceId,
      patchHash: captured.evidence.patchHash,
      refinedPlanVersionId: workflow.refinedPlanVersionId,
    };

    // Invocation-guard receipt: the durable reservation for the reviewer subprocess. Its
    // command mirrors the read-only review-start vocabulary and is completed without a
    // transition; the audit itself is evidence, not a state change.
    const guardCommand: TransitionCommand = {
      type: 'START_CODE_REVIEW',
      evidence: {
        reviewedCommitSha: target.reviewedCommitSha,
        currentHeadSha: before.headSha,
        cleanWorktree: before.clean,
        unresolvedFindingCount: 0,
        incompleteDispositionCount: 0,
        roleSeparation: this.roleSeparation(context.configuration, reviewerSessionForEvidence),
      },
    };
    const request = this.commandRequest({
      commandId: input.commandId,
      workflowId: input.workflowId,
      batch: context.batch,
      requester: {
        actorExecutionId: `${input.commandId}:requester`,
        actorType: 'AGENT',
        assignmentId: context.configuration.assignments.reviewer.assignmentId,
        invocationIdentityId: input.invocationId,
        sessionIdentityId: reviewerSessionForEvidence,
        authoritiesExercised: ['REVIEWER'],
        identityAssurance: 'CONFIG_ONLY',
        observedEvidence: [],
        startedAt: this.timestamp(),
      },
      authorityExercised: 'REVIEWER',
      targetCommitSha: target.reviewedCommitSha,
      command: guardCommand,
      ...(input.expectedBatchVersion === undefined
        ? {}
        : { expectedVersion: input.expectedBatchVersion }),
    });
    this.commandStore.reserve(request, 'AGENT_INVOCATION');
    this.commandStore.claimSideEffect(
      input.commandId,
      deriveFinalAuditSideEffectIdentity(input.commandId),
    );
    let prepared: PreparedRoleInvocation;
    try {
      prepared = await this.roleInvoker.prepare({
        resolution: input.resolution,
        workflowId: input.workflowId,
        commandId: input.commandId,
        actorExecutionId: input.actorExecutionId,
        invocationId: input.invocationId,
        sessionIdentityId: input.sessionIdentityId,
        prompt: input.buildPrompt({
          target,
          requirementIds,
          acceptanceCriterionIds: criterionIds,
          cumulativePatch: captured.cumulativePatch.patch,
          deferredFindings,
        }),
        // The final audit must resume the batch's initial reviewer session.
        sessionBinding: { batchId: input.batchId, role: 'REVIEWER', expectExisting: true },
        ...(input.previousSessionIdentityId === undefined
          ? {}
          : { previousSessionIdentityId: input.previousSessionIdentityId }),
        ...(input.options === undefined ? {} : { options: input.options }),
      });
    } catch (error) {
      this.failCommand(input.commandId, 'AGENT_INVOCATION_FAILED', {
        message: error instanceof Error ? error.message : 'Final-audit invocation failed',
      });
      if (isSessionContinuityError(error)) {
        // Fail closed: broken reviewer-session continuity is a human decision. The
        // escalation is best-effort: it must never mask the typed continuity error.
        try {
          this.blockBatch({
            workflowId: input.workflowId,
            batchId: input.batchId,
            commandId: `${input.commandId}:session-continuity-block`,
            reason: `SESSION_CONTINUITY_FAILURE:${error.code}: ${error.message}`,
          });
        } catch {
          // The typed error below remains the authoritative failure.
        }
      }
      throw error;
    }
    if (prepared.invocation.commandId !== input.commandId) {
      const failure = {
        code: 'INVOCATION_MISMATCH',
        message: 'Prepared invocation is not bound to the authoritative final-audit command',
      };
      this.failCommand(input.commandId, failure.code, failure);
      throw new ReviewWorkflowGateError('INVOCATION_MISMATCH', failure.message);
    }
    this.roleInvoker.persistPrepared(prepared);
    const after = this.repository.readWorktree();

    return this.store.runAtomically(() => {
      if (
        after.headSha !== before.headSha ||
        after.worktreeFingerprint !== before.worktreeFingerprint
      ) {
        const failure = {
          code: 'REVIEWER_MODIFIED_WORKTREE',
          message: 'The final auditor changed repository state during a read-only audit',
        };
        this.failCommand(input.commandId, failure.code, failure);
        return {
          capture: this.contractService.captureReviewRejection(
            {
              transcriptId: input.transcriptId,
              workflowId: input.workflowId,
              batchId: input.batchId,
              actorExecutionId: prepared.execution.actorExecutionId,
              invocationId: prepared.invocation.invocationId,
              sessionIdentityId: prepared.session.sessionIdentityId,
              rawTranscript: prepared.call.text,
              createdAt: prepared.invocation.finishedAt ?? this.timestamp(),
            },
            failure.message,
          ),
          batch: context.batch,
          replayed: false,
        };
      }
      const capture = this.contractService.captureFinalAudit({
        transcriptId: input.transcriptId,
        workflowId: input.workflowId,
        batchId: input.batchId,
        actorExecutionId: prepared.execution.actorExecutionId,
        invocationId: prepared.invocation.invocationId,
        sessionIdentityId: prepared.session.sessionIdentityId,
        rawTranscript: prepared.call.text,
        createdAt: prepared.invocation.finishedAt ?? this.timestamp(),
        reviewRoundId: deriveFinalAuditRoundId(input.batchId),
        reviewRoundNumber: 1,
        expectedTarget: target,
        expectedRequirementIds: requirementIds,
        expectedAcceptanceCriterionIds: criterionIds,
      });
      if (!capture.accepted) {
        this.failCommand(input.commandId, capture.error.code, capture.error);
        return { capture, batch: context.batch, replayed: false };
      }
      this.commandStore.succeedWithoutTransition({
        commandId: input.commandId,
        resultHash: hashValue(capture.value.review),
        result: capture.value.review,
      });
      if (capture.value.review.verdict !== 'APPROVED') {
        // The single bounded audit is exhausted: an unresolved final audit is a human
        // decision, never another automatic review round.
        this.blockBatch({
          workflowId: input.workflowId,
          batchId: input.batchId,
          commandId: `${input.commandId}:block`,
          reason:
            'The single bounded final audit returned NEEDS_REVISION; a human decision is required',
        });
      }
      return { capture, batch: this.requireBatch(input.batchId), replayed: false };
    });
  }

  /**
   * Runs one approved verification command behind a durable reservation: the receipt and
   * its VERIFICATION_EXECUTION side effect are claimed before the subprocess starts, and a
   * same-ID retry replays the persisted record without re-executing anything.
   */
  async executeVerification(
    input: GateVerificationExecutionInput,
  ): Promise<GateVerificationExecutionResult> {
    const context = this.requireContext(input.workflowId, input.batchId, input.configuration);
    const replayed = this.replayedCommand({
      commandId: input.commandId,
      workflowId: input.workflowId,
      batchId: input.batchId,
      commandType: 'START_CODE_REVIEW',
      sideEffect: { kind: 'VERIFICATION_EXECUTION', identity: input.verificationRecordId },
    });
    if (replayed !== null) {
      return { record: verificationRecordSchema.parse(replayed.result), replayed: true };
    }
    this.requireState(context.batch, 'VERIFYING');
    const approvedReview = this.requireApprovedCodeReview(input.batchId);
    const before = this.repository.readWorktree();
    const guardCommand: TransitionCommand = {
      type: 'START_CODE_REVIEW',
      evidence: {
        reviewedCommitSha: approvedReview.target.reviewedCommitSha,
        currentHeadSha: before.headSha,
        cleanWorktree: before.clean,
        unresolvedFindingCount: 0,
        incompleteDispositionCount: 0,
        roleSeparation: this.roleSeparation(context.configuration, undefined),
      },
    };
    this.commandStore.reserve(
      this.commandRequest({
        commandId: input.commandId,
        workflowId: input.workflowId,
        batch: context.batch,
        requester: {
          actorExecutionId: `${input.commandId}:requester`,
          actorType: 'HUMAN',
          authoritiesExercised: ['VERIFICATION_EXECUTOR'],
          identityAssurance: 'CLI_ASSERTED',
          observedEvidence: [],
          startedAt: this.timestamp(),
        },
        authorityExercised: 'VERIFICATION_EXECUTOR',
        targetCommitSha: approvedReview.target.reviewedCommitSha,
        command: guardCommand,
        ...(input.expectedBatchVersion === undefined
          ? {}
          : { expectedVersion: input.expectedBatchVersion }),
      }),
      'VERIFICATION_EXECUTION',
    );
    this.commandStore.claimSideEffect(input.commandId, input.verificationRecordId);
    let record: VerificationRecord;
    try {
      record = await input.run();
    } catch (error) {
      this.failCommand(input.commandId, 'VERIFICATION_EXECUTION_FAILED', {
        message: error instanceof Error ? error.message : 'Verification execution failed',
      });
      throw error;
    }
    if (record.verificationRecordId !== input.verificationRecordId) {
      const failure = {
        code: 'INVOCATION_MISMATCH',
        message: 'The executed verification record is not bound to the reserved side effect',
      };
      this.failCommand(input.commandId, failure.code, failure);
      throw new ReviewWorkflowGateError('INVOCATION_MISMATCH', failure.message);
    }
    this.commandStore.succeedWithoutTransition({
      commandId: input.commandId,
      resultHash: hashValue(record),
      result: record,
    });
    return { record, replayed: false };
  }

  /** Derives every gate condition from durable evidence; approves only when all hold. */
  evaluateGate(input: EvaluateGateInput): EvaluateGateResult {
    const context = this.requireContext(input.workflowId, input.batchId, input.configuration);
    const replayed = this.replayedCommand({
      commandId: input.commandId,
      workflowId: input.workflowId,
      batchId: input.batchId,
      commandType: 'APPROVE_FOR_MERGE',
      sideEffect: null,
    });
    if (replayed !== null) {
      const stored = gateApprovalReplaySchema.parse(replayed.result);
      return {
        approved: true,
        batch: this.requireBatch(input.batchId),
        conditions: stored.conditions,
        evidence: stored.evidence,
      };
    }
    this.requireState(context.batch, 'VERIFYING');
    const approvedReview = this.requireApprovedCodeReview(input.batchId);
    const reviewedCommitSha = approvedReview.target.reviewedCommitSha;
    const worktree = this.repository.readWorktree();

    const criteria = this.store.listAcceptanceCriteria(context.batch.currentPlanVersionId);
    const requiredCriteria = criteria.filter((criterion) => criterion.required);
    const plan = this.store.getBatchPlan(context.batch.currentPlanVersionId);
    const records = this.store
      .listVerificationRecords(input.batchId)
      .filter((record) => record.commitSha === reviewedCommitSha);
    const acceptedByRecord = new Map(
      records.map((record) => [
        record.verificationRecordId,
        this.store
          .listAttestationsForRecord(record.verificationRecordId)
          .filter((attestation) => attestation.decision === 'ACCEPTED'),
      ]),
    );
    const acceptedRecords = records.filter(
      (record) => (acceptedByRecord.get(record.verificationRecordId) ?? []).length > 0,
    );
    const criterionPassed = (criterionId: string): boolean =>
      acceptedRecords.some(
        (record) =>
          record.observedStatus === 'SUCCEEDED' && record.relatedCriterionIds.includes(criterionId),
      );

    const findings = this.store.listBatchFindings(input.batchId);
    const criticalOrHigh = findings.filter(
      (finding) =>
        finding.status === 'OPEN' &&
        (finding.severity === 'critical' || finding.severity === 'high'),
    );
    const acceptedDispositionFor = (finding: Finding): boolean =>
      this.store
        .listDispositionsForFinding(finding.findingId)
        .some((disposition) => disposition.reviewerDecision.decision === 'ACCEPTED');
    const unresolved = criticalOrHigh.filter((finding) => !acceptedDispositionFor(finding));
    const incompleteDispositions = criticalOrHigh.filter(
      (finding) =>
        this.store
          .listDispositionsForFinding(finding.findingId)
          .some((disposition) => disposition.reviewerDecision.decision !== 'ACCEPTED') &&
        !acceptedDispositionFor(finding),
    );

    const manualOrBrowserCriteria = requiredCriteria.filter(
      (criterion) => criterion.kind === 'MANUAL' || criterion.kind === 'BROWSER',
    );
    const manualIndependent = manualOrBrowserCriteria.every((criterion) =>
      acceptedRecords.some(
        (record) =>
          record.relatedCriterionIds.includes(criterion.acceptanceCriterionId) &&
          (acceptedByRecord.get(record.verificationRecordId) ?? []).some(
            (attestation) =>
              attestation.acceptanceMode === 'REVIEWER' || attestation.acceptanceMode === 'HUMAN',
          ),
      ),
    );

    const requiredCommands = plan?.verificationCommands ?? [];
    const commandSatisfied = (command: (typeof requiredCommands)[number]): boolean =>
      acceptedRecords.some(
        (record) =>
          record.observedStatus === 'SUCCEEDED' &&
          record.command === command.executable &&
          JSON.stringify(record.arguments) === JSON.stringify(command.arguments) &&
          record.workingDirectory === command.workingDirectory &&
          record.verificationType === command.verificationType,
      );

    let finalDiffReviewed = false;
    try {
      this.gitService.captureReviewRange({
        kind: 'FINAL_GATE',
        originalBatchBaseSha: this.requireBatchBase(context.batch),
        currentImplementationSha: reviewedCommitSha,
        previousReviewedImplementationSha: reviewedCommitSha,
        acceptedCumulativePatchHash: approvedReview.target.patchHash,
      });
      finalDiffReviewed = true;
    } catch {
      finalDiffReviewed = false;
    }

    const finalAudit = this.store
      .listFinalAudits(input.batchId)
      .filter(
        (audit) =>
          audit.verdict === 'APPROVED' &&
          audit.target.kind === 'FINAL_AUDIT' &&
          audit.target.reviewedCommitSha === reviewedCommitSha,
      )
      .at(-1);

    const conditions: GateConditionReport = {
      reviewedCommitSha,
      currentHeadSha: worktree.headSha,
      headMatchesReviewedCommit: worktree.headSha === reviewedCommitSha,
      cleanWorktree: worktree.clean,
      unresolvedCriticalOrHighFindingCount: unresolved.length,
      incompleteDispositionCount: incompleteDispositions.length,
      requiredCriteriaPassed: requiredCriteria.every((criterion) =>
        criterionPassed(criterion.acceptanceCriterionId),
      ),
      requiredVerificationComplete: requiredCommands.every(commandSatisfied),
      requiredAttestationsAccepted:
        records.length > 0 &&
        records.every(
          (record) => (acceptedByRecord.get(record.verificationRecordId) ?? []).length > 0,
        ),
      manualAndBrowserEvidenceIndependentlyAttested: manualIndependent,
      finalDiffReviewed,
      scopeMatchesApprovedPlan: finalAudit?.scopeComplete === true,
      documentationComplete: finalAudit?.documentationComplete === true,
    };
    const failedConditions = collectFailedConditions(conditions);
    if (failedConditions.length > 0) {
      return { approved: false, batch: context.batch, conditions, failedConditions };
    }

    const evidence: MergeApprovalEvidence = {
      reviewedCommitSha,
      currentHeadSha: worktree.headSha,
      cleanWorktree: worktree.clean,
      unresolvedCriticalOrHighFindingCount: 0,
      incompleteDispositionCount: 0,
      requiredCriteriaPassed: true,
      requiredVerificationComplete: true,
      requiredAttestationsAccepted: true,
      manualAndBrowserEvidenceIndependentlyAttested: true,
      finalDiffReviewed: true,
      scopeMatchesApprovedPlan: true,
      documentationComplete: true,
      roleSeparation: this.roleSeparation(context.configuration, undefined),
    };
    const command: TransitionCommand = { type: 'APPROVE_FOR_MERGE', evidence };
    const reconciler = this.systemReconciler(input.commandId);
    const transition = this.requireAllowedTransition(
      context.batch.persistedState,
      command,
      reconciler,
    );
    this.store.runAtomically(() => {
      this.commandStore.reserve(
        this.commandRequest({
          commandId: input.commandId,
          workflowId: input.workflowId,
          batch: context.batch,
          requester: reconciler,
          authorityExercised: 'SYSTEM_RECONCILER',
          targetCommitSha: reviewedCommitSha,
          command,
          ...(input.expectedBatchVersion === undefined
            ? {}
            : { expectedVersion: input.expectedBatchVersion }),
        }),
      );
      this.commandStore.succeedWithTransition({
        commandId: input.commandId,
        transition,
        eventType: 'BATCH_GATE_APPROVED',
        eventPayload: { approvedCommitSha: reviewedCommitSha },
        resultHash: hashValue({ conditions, evidence }),
        result: { conditions, evidence },
      });
    });
    return {
      approved: true,
      batch: this.requireBatch(input.batchId),
      conditions,
      evidence,
    };
  }

  /** Persisted state plus repository-derived effective state. */
  effectiveState(batchId: string): BatchEffectiveStateReport {
    const batch = this.requireBatch(batchId);
    const approvalSha = this.approvedCommitShaFor(batchId);
    const snapshot = this.gitService.readEffectiveApproval({
      persistedState: batch.persistedState,
      ...(approvalSha === undefined ? {} : { persistedApprovalSha: approvalSha }),
      invalidationPersisted: batch.persistedState === 'APPROVAL_STALE',
    });
    return {
      batchId,
      persistedState: batch.persistedState,
      effectiveState: snapshot.effectiveState,
      approvalValid: snapshot.approvalValid,
      ...(approvalSha === undefined ? {} : { persistedApprovalSha: approvalSha }),
      currentHeadSha: snapshot.currentHeadSha,
    };
  }

  /** Persists APPROVAL_STALE once a HEAD mismatch has been observed; it never un-persists. */
  reconcileStaleApproval(input: ReconcileStaleApprovalInput): ReviewWorkflowBatch {
    const batch = this.requireBatch(input.batchId);
    const replayed = this.replayedCommand({
      commandId: input.commandId,
      workflowId: input.workflowId,
      batchId: input.batchId,
      commandType: 'RECONCILE_STALE_APPROVAL',
      sideEffect: null,
    });
    if (replayed !== null) return batch;
    this.requireState(batch, 'APPROVED_FOR_MERGE');
    const approvalSha = this.approvedCommitShaFor(input.batchId);
    if (approvalSha === undefined) {
      throw new ReviewWorkflowGateError(
        'APPROVAL_EVENT_MISSING',
        `Batch ${input.batchId} has no persisted gate approval event`,
      );
    }
    const currentHeadSha = this.repository.readHeadSha();
    if (currentHeadSha === approvalSha) {
      throw new ReviewWorkflowGateError(
        'APPROVAL_NOT_STALE',
        'The approval is not stale while HEAD equals the approved commit',
      );
    }
    const command: TransitionCommand = {
      type: 'RECONCILE_STALE_APPROVAL',
      evidence: { persistedApprovalSha: approvalSha, currentHeadSha },
    };
    const reconciler = this.systemReconciler(input.commandId);
    const transition = this.requireAllowedTransition(batch.persistedState, command, reconciler);
    this.store.runAtomically(() => {
      this.commandStore.reserve(
        this.commandRequest({
          commandId: input.commandId,
          workflowId: input.workflowId,
          batch,
          requester: reconciler,
          authorityExercised: 'SYSTEM_RECONCILER',
          command,
          ...(input.expectedBatchVersion === undefined
            ? {}
            : { expectedVersion: input.expectedBatchVersion }),
        }),
      );
      this.commandStore.succeedWithTransition({
        commandId: input.commandId,
        transition,
        eventType: 'APPROVAL_STALE_RECONCILED',
        eventPayload: { persistedApprovalSha: approvalSha, currentHeadSha },
        resultHash: hashValue({ persistedApprovalSha: approvalSha, currentHeadSha }),
      });
    });
    return this.requireBatch(input.batchId);
  }

  /** Records an externally performed merge; never executes one. */
  markMerged(input: MarkMergedInput): ReviewWorkflowBatch {
    const batch = this.requireBatch(input.batchId);
    const replayed = this.replayedCommand({
      commandId: input.commandId,
      workflowId: input.workflowId,
      batchId: input.batchId,
      commandType: 'RECORD_EXTERNAL_MERGE',
      sideEffect: null,
    });
    if (replayed !== null) {
      const storedCommand = replayed.request.command;
      if (
        storedCommand.type !== 'RECORD_EXTERNAL_MERGE' ||
        storedCommand.evidence.mergeCommitSha !== input.mergeCommitSha
      ) {
        throw new ReviewWorkflowGateError(
          'COMMAND_REPLAY_MISMATCH',
          `Command ${input.commandId} recorded a different merge commit; only a completed identical command can be replayed`,
        );
      }
      return batch;
    }
    this.requireState(batch, 'APPROVED_FOR_MERGE');
    const report = this.effectiveState(input.batchId);
    if (!report.approvalValid || report.persistedApprovalSha === undefined) {
      throw new ReviewWorkflowGateError(
        'APPROVAL_NOT_EFFECTIVE',
        'The persisted approval is no longer effective; reconcile and re-verify instead',
      );
    }
    // The recorded merge must be a real commit that actually contains the approved work.
    let mergeCommitContainsApproval = false;
    try {
      this.repository.readCommit(input.mergeCommitSha);
      mergeCommitContainsApproval = this.repository.isAncestor(
        report.persistedApprovalSha,
        input.mergeCommitSha,
      );
    } catch {
      mergeCommitContainsApproval = false;
    }
    if (!mergeCommitContainsApproval) {
      throw new ReviewWorkflowGateError(
        'MERGE_COMMIT_INVALID',
        `Merge commit ${input.mergeCommitSha} does not exist in this repository or does not contain approved commit ${report.persistedApprovalSha}`,
      );
    }
    const recorder: ActorExecutionIdentity = {
      actorExecutionId: input.recorder.actorExecutionId,
      actorType: input.recorder.actorType,
      authoritiesExercised: ['MERGE_RECORDER'],
      identityAssurance: 'CLI_ASSERTED',
      observedEvidence: [],
      startedAt: this.timestamp(),
    };
    const command: TransitionCommand = {
      type: 'RECORD_EXTERNAL_MERGE',
      evidence: {
        approvedCommitSha: report.persistedApprovalSha,
        currentHeadSha: report.currentHeadSha,
        mergeCommitSha: input.mergeCommitSha,
        effectiveApprovalValid: report.approvalValid,
      },
    };
    const transition = this.requireAllowedTransition(batch.persistedState, command, recorder);
    this.store.runAtomically(() => {
      this.commandStore.reserve(
        this.commandRequest({
          commandId: input.commandId,
          workflowId: input.workflowId,
          batch,
          requester: recorder,
          authorityExercised: 'MERGE_RECORDER',
          targetCommitSha: input.mergeCommitSha,
          command,
          ...(input.expectedBatchVersion === undefined
            ? {}
            : { expectedVersion: input.expectedBatchVersion }),
        }),
      );
      this.commandStore.succeedWithTransition({
        commandId: input.commandId,
        transition,
        eventType: 'BATCH_MERGED',
        eventPayload: {
          approvedCommitSha: report.persistedApprovalSha,
          mergeCommitSha: input.mergeCommitSha,
        },
        resultHash: hashValue({ mergeCommitSha: input.mergeCommitSha }),
      });
    });
    return this.requireBatch(input.batchId);
  }

  private approvedCommitShaFor(batchId: string): string | undefined {
    const event = this.store
      .getEvents(batchId)
      .filter((candidate) => candidate.eventType === 'BATCH_GATE_APPROVED')
      .at(-1);
    const sha = event?.payload.approvedCommitSha;
    return typeof sha === 'string' ? sha : undefined;
  }

  private requireApprovedCodeReview(batchId: string) {
    const review = this.store
      .listCodeReviews(batchId)
      .filter((candidate) => candidate.verdict === 'APPROVED')
      .at(-1);
    if (review === undefined || review.target.kind !== 'CODE') {
      throw new ReviewWorkflowGateError(
        'CODE_REVIEW_APPROVAL_REQUIRED',
        `Batch ${batchId} has no approved code review to gate against`,
      );
    }
    return { ...review, target: review.target };
  }

  private requireBatchBase(batch: ReviewWorkflowBatch): string {
    if (batch.originalBatchBaseSha === undefined) {
      throw new ReviewWorkflowGateError(
        'INVALID_STATE',
        `Batch ${batch.batchId} has no established original base SHA`,
      );
    }
    return batch.originalBatchBaseSha;
  }

  private systemReconciler(commandId: string): ActorExecutionIdentity {
    return {
      actorExecutionId: `${commandId}:system-reconciler`,
      actorType: 'SYSTEM',
      authoritiesExercised: ['SYSTEM_RECONCILER'],
      identityAssurance: 'PROCESS_ATTESTED',
      observedEvidence: [],
      startedAt: this.timestamp(),
    };
  }

  private roleSeparation(
    configuration: ReviewWorkflowConfigurationSnapshot,
    reviewerSessionIdentityId: string | undefined,
  ) {
    return {
      implementerAssignment: configuration.assignments.implementer,
      reviewerAssignment: configuration.assignments.reviewer,
      ...(reviewerSessionIdentityId === undefined ? {} : { reviewerSessionIdentityId }),
      minimumIdentityAssurance: configuration.identityPolicy.minimumAssurance,
    };
  }

  private requireContext(
    workflowId: string,
    batchId: string,
    configurationInput: ReviewWorkflowConfigurationSnapshot,
  ) {
    const configuration = reviewWorkflowConfigurationSnapshotSchema.parse(configurationInput);
    const workflow = this.store.getWorkflow(workflowId);
    if (workflow === null) {
      throw new ReviewWorkflowGateError(
        'WORKFLOW_NOT_FOUND',
        `Workflow ${workflowId} does not exist`,
      );
    }
    const batch = this.store.getBatch(batchId);
    if (batch === null || batch.workflowId !== workflowId) {
      throw new ReviewWorkflowGateError(
        'BATCH_NOT_FOUND',
        `Batch ${batchId} does not belong to workflow ${workflowId}`,
      );
    }
    if (
      configuration.workflowId !== workflowId ||
      (configuration.batchId !== undefined && configuration.batchId !== batchId) ||
      configuration.configurationHash !== workflow.configurationHash ||
      configuration.assignments.implementer.assignmentId !== batch.implementerAssignmentId ||
      configuration.assignments.reviewer.assignmentId !== batch.reviewerAssignmentId
    ) {
      throw new ReviewWorkflowGateError(
        'CONFIGURATION_SCOPE_MISMATCH',
        'Active review-workflow configuration does not match the persisted workflow and batch',
      );
    }
    return { workflow, batch, configuration };
  }

  private requireState(
    batch: ReviewWorkflowBatch,
    expected: ReviewWorkflowBatch['persistedState'],
  ): void {
    if (batch.persistedState !== expected) {
      throw new ReviewWorkflowGateError(
        'INVALID_STATE',
        `Batch ${batch.batchId} must be ${expected}, observed ${batch.persistedState}`,
      );
    }
  }

  private requireBatch(batchId: string): ReviewWorkflowBatch {
    const batch = this.store.getBatch(batchId);
    if (batch === null) {
      throw new ReviewWorkflowGateError('BATCH_NOT_FOUND', `Batch ${batchId} does not exist`);
    }
    return batch;
  }

  private requireAllowedTransition(
    currentState: ReviewWorkflowBatch['persistedState'],
    command: TransitionCommand,
    actor: ActorExecutionIdentity,
  ): AllowedTransition {
    const transition = transitionBatch({ currentState, command, actor });
    if (!transition.allowed) {
      throw new ReviewWorkflowGateError(
        'TRANSITION_REJECTED',
        `${command.type} rejected by the domain kernel: ${transition.code}`,
      );
    }
    return transition;
  }

  private failCommand(commandId: string, errorCode: string, result: unknown): void {
    this.commandStore.recordOutcome({
      commandId,
      status: 'FAILED_FINAL',
      errorCode,
      resultHash: hashValue(result),
      result,
    });
  }

  private commandRequest(input: {
    readonly commandId: string;
    readonly workflowId: string;
    readonly batch: ReviewWorkflowBatch;
    readonly requester: ActorExecutionIdentity;
    readonly authorityExercised: StateChangingCommandRequest['authorityExercised'];
    readonly targetCommitSha?: string;
    readonly command: TransitionCommand;
    readonly expectedVersion?: number;
  }): StateChangingCommandRequest {
    const request = {
      commandId: input.commandId,
      workflowId: input.workflowId,
      batchId: input.batch.batchId,
      expectedAggregateVersion: input.expectedVersion ?? input.batch.aggregateVersion,
      ...(input.targetCommitSha === undefined ? {} : { targetCommitSha: input.targetCommitSha }),
      requester: input.requester,
      authorityExercised: input.authorityExercised,
      command: input.command,
    };
    return { ...request, canonicalRequestHash: hashValue(request) };
  }

  /**
   * Same-ID retries return the recorded outcome instead of re-running state guards. The
   * stored receipt must match this operation's full identity — workflow, batch, command
   * vocabulary, and side-effect kind/identity — so a command ID can never replay another
   * batch's outcome or a different operation that shares transition vocabulary.
   */
  private replayedCommand(input: {
    readonly commandId: string;
    readonly workflowId: string;
    readonly batchId: string;
    readonly commandType: TransitionCommand['type'];
    readonly sideEffect: {
      readonly kind: ReviewWorkflowSideEffectKind;
      readonly identity?: string;
    } | null;
  }): StoredReviewWorkflowCommand | null {
    const stored = this.commandStore.get(input.commandId);
    if (stored === null) return null;
    const storedSideEffect = stored.sideEffect;
    const sideEffectMatches =
      input.sideEffect === null
        ? storedSideEffect === null
        : storedSideEffect !== null &&
          storedSideEffect.kind === input.sideEffect.kind &&
          (input.sideEffect.identity === undefined ||
            storedSideEffect.sideEffectIdentity === input.sideEffect.identity);
    if (
      stored.receipt.status !== 'SUCCEEDED' ||
      stored.request.command.type !== input.commandType ||
      stored.request.workflowId !== input.workflowId ||
      stored.request.batchId !== input.batchId ||
      !sideEffectMatches
    ) {
      throw new ReviewWorkflowGateError(
        'COMMAND_REPLAY_MISMATCH',
        `Command ${input.commandId} does not match this operation's workflow, batch, command, and side-effect identity; only a completed identical command can be replayed`,
      );
    }
    return stored;
  }

  private replayFinalAudit(batchId: string): FinalAuditResult {
    const review = this.store.listFinalAudits(batchId).at(-1);
    if (review === undefined) {
      throw new ReviewWorkflowGateError(
        'COMMAND_REPLAY_MISMATCH',
        `Batch ${batchId} has a completed final-audit command but no persisted final audit`,
      );
    }
    const transcript = this.store.workflowStore.getHandoffTranscript(review.transcriptId);
    if (transcript === null) {
      throw new ReviewWorkflowGateError(
        'COMMAND_REPLAY_MISMATCH',
        `Final audit ${review.reviewRoundId} has no persisted handoff transcript`,
      );
    }
    const contract = parseFinalAuditResult(transcript.rawTranscript);
    const findings: Finding[] = [];
    for (const findingId of review.findingIds) {
      const finding = this.store.getFinding(findingId);
      if (finding !== null) findings.push(finding);
    }
    return {
      capture: { accepted: true, transcript, value: { contract, review, findings } },
      batch: this.requireBatch(batchId),
      replayed: true,
    };
  }

  private blockBatch(input: {
    readonly workflowId: string;
    readonly batchId: string;
    readonly commandId: string;
    readonly reason: string;
  }): void {
    const batch = this.requireBatch(input.batchId);
    const command: TransitionCommand = { type: 'BLOCK_BATCH', reason: input.reason };
    const reconciler = this.systemReconciler(input.commandId);
    const transition = this.requireAllowedTransition(batch.persistedState, command, reconciler);
    this.commandStore.reserve(
      this.commandRequest({
        commandId: input.commandId,
        workflowId: input.workflowId,
        batch,
        requester: reconciler,
        authorityExercised: 'SYSTEM_RECONCILER',
        command,
      }),
    );
    this.commandStore.succeedWithTransition({
      commandId: input.commandId,
      transition,
      eventType: 'BATCH_BLOCKED',
      eventPayload: { reason: input.reason },
      resultHash: hashValue({ reason: input.reason }),
    });
  }

  private timestamp(): string {
    return this.clock().toISOString();
  }
}

function collectFailedConditions(conditions: GateConditionReport): readonly string[] {
  const failures: string[] = [];
  if (!conditions.headMatchesReviewedCommit) failures.push('HEAD_MATCHES_REVIEWED_COMMIT');
  if (!conditions.cleanWorktree) failures.push('CLEAN_WORKTREE');
  if (conditions.unresolvedCriticalOrHighFindingCount > 0) {
    failures.push('UNRESOLVED_CRITICAL_OR_HIGH_FINDINGS');
  }
  if (conditions.incompleteDispositionCount > 0) failures.push('INCOMPLETE_DISPOSITIONS');
  if (!conditions.requiredCriteriaPassed) failures.push('REQUIRED_CRITERIA_PASSED');
  if (!conditions.requiredVerificationComplete) failures.push('REQUIRED_VERIFICATION_COMPLETE');
  if (!conditions.requiredAttestationsAccepted) failures.push('REQUIRED_ATTESTATIONS_ACCEPTED');
  if (!conditions.manualAndBrowserEvidenceIndependentlyAttested) {
    failures.push('MANUAL_BROWSER_INDEPENDENT_ATTESTATION');
  }
  if (!conditions.finalDiffReviewed) failures.push('FINAL_DIFF_REVIEWED');
  if (!conditions.scopeMatchesApprovedPlan) failures.push('SCOPE_MATCHES_APPROVED_PLAN');
  if (!conditions.documentationComplete) failures.push('DOCUMENTATION_COMPLETE');
  return failures;
}

function hashValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ReviewWorkflowGateError('INVALID_STATE', 'Gate evidence is not serializable');
  }
  return createHash('sha256').update(serialized).digest('hex');
}
