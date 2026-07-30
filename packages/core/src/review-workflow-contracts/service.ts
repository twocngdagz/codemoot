// Application service that validates handoff output before persisting any derived artifact.

import {
  type PersistableReviewWorkflowEntity,
  ReviewWorkflowPersistenceError,
  type ReviewWorkflowStore,
} from '../memory/review-workflow-store.js';
import type {
  AcceptanceCriterion,
  BatchPlanVersion,
  Finding,
  FindingDisposition,
  ImplementationAttempt,
  RefinedPlanVersion,
} from '../review-workflow/types.js';
import {
  HandoffParseError,
  hashHandoffContent,
  materializeDispositions,
  materializeFindings,
  parseDispositionResult,
  parseFinalAuditResult,
  parseImplementationResult,
  parseRefinementResult,
  parseReviewResult,
  requireExpectedFindingIds,
  requireExpectedTarget,
} from './parser.js';
import { REVIEW_WORKFLOW_CONTRACT_SCHEMA_VERSION } from './schemas.js';
import type {
  DispositionResultContract,
  FinalAuditResultContract,
  FinalAuditTarget,
  HandoffTranscript,
  ImplementationResultContract,
  RefinementResultContract,
  ReviewContractTarget,
  ReviewResultContract,
  ReviewWorkflowContractKind,
  StructuredReview,
} from './types.js';

export interface HandoffCaptureContext {
  readonly transcriptId: string;
  readonly workflowId: string;
  readonly batchId?: string;
  readonly actorExecutionId: string;
  readonly invocationId?: string;
  readonly sessionIdentityId?: string;
  readonly rawTranscript: string;
  readonly createdAt: string;
}

export interface RejectedHandoffCapture {
  readonly accepted: false;
  readonly transcript: HandoffTranscript;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export interface AcceptedHandoffCapture<Value> {
  readonly accepted: true;
  readonly transcript: HandoffTranscript;
  readonly value: Value;
}

export type HandoffCaptureResult<Value> = AcceptedHandoffCapture<Value> | RejectedHandoffCapture;

export interface RefinementCaptureValue {
  readonly contract: RefinementResultContract;
  readonly refinedPlan: RefinedPlanVersion;
  readonly batchPlans: readonly BatchPlanVersion[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
}

export interface ReviewCaptureValue {
  readonly contract: ReviewResultContract | FinalAuditResultContract;
  readonly review: StructuredReview;
  readonly findings: readonly Finding[];
}

export interface ImplementationCaptureValue {
  readonly contract: ImplementationResultContract;
  readonly implementationAttempt: ImplementationAttempt;
}

export interface DispositionCaptureValue {
  readonly contract: DispositionResultContract;
  readonly dispositions: readonly FindingDisposition[];
}

function makeTranscriptBase(
  context: HandoffCaptureContext,
  contractKind: ReviewWorkflowContractKind,
): Omit<HandoffTranscript, 'parseStatus' | 'parsedArtifactIds' | 'errorCode' | 'errorMessage'> {
  return {
    transcriptId: context.transcriptId,
    workflowId: context.workflowId,
    batchId: context.batchId,
    contractKind,
    expectedSchemaVersion: REVIEW_WORKFLOW_CONTRACT_SCHEMA_VERSION,
    actorExecutionId: context.actorExecutionId,
    invocationId: context.invocationId,
    sessionIdentityId: context.sessionIdentityId,
    rawTranscript: context.rawTranscript,
    rawTranscriptHash: hashHandoffContent(context.rawTranscript),
    createdAt: context.createdAt,
  };
}

function parsedTranscript(
  context: HandoffCaptureContext,
  contractKind: ReviewWorkflowContractKind,
  parsedArtifactIds: readonly string[],
): HandoffTranscript {
  return {
    ...makeTranscriptBase(context, contractKind),
    parseStatus: 'PARSED',
    parsedArtifactIds,
  };
}

function rejectedTranscript(
  context: HandoffCaptureContext,
  contractKind: ReviewWorkflowContractKind,
  error: HandoffParseError,
): HandoffTranscript {
  return {
    ...makeTranscriptBase(context, contractKind),
    parseStatus: 'REJECTED',
    parsedArtifactIds: [],
    errorCode: error.code,
    errorMessage: error.message,
  };
}

function validateExactIds(
  actualIds: readonly string[],
  expectedIds: readonly string[],
  label: string,
): void {
  const actual = [...actualIds].sort();
  const expected = [...expectedIds].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new HandoffParseError(
      'SCHEMA_INVALID',
      `${label} must match the authoritative expected identifiers`,
    );
  }
}

export class ReviewWorkflowContractService {
  constructor(private readonly store: ReviewWorkflowStore) {}

  captureRefinementRejection(
    context: HandoffCaptureContext,
    message: string,
  ): RejectedHandoffCapture {
    const error = new HandoffParseError('SCHEMA_INVALID', message);
    const transcript = rejectedTranscript(context, 'REFINEMENT_RESULT', error);
    this.store.saveHandoffCapture({ transcript, entities: [] });
    return {
      accepted: false,
      transcript,
      error: { code: error.code, message: error.message },
    };
  }

  captureRefinement(
    input: HandoffCaptureContext & {
      readonly generalPlanVersionId: string;
      readonly repositoryAuditId: string;
      readonly repositoryContextSha: string;
      readonly refinedPlanVersionId: string;
      readonly version: number;
      readonly expectedRequirementIds: readonly string[];
      readonly requireMaterializedBatchPlans?: boolean;
    },
  ): HandoffCaptureResult<RefinementCaptureValue> {
    try {
      const contract = parseRefinementResult(input.rawTranscript);
      validateExactIds(
        contract.requirementCoverage.map((coverage) => coverage.requirementId),
        input.expectedRequirementIds,
        'Requirement coverage',
      );
      const batchPlanVersionIds = new Set(contract.batchPlanVersionIds);
      if (
        contract.requirementCoverage.some((coverage) =>
          coverage.batchPlanVersionIds.some((id) => !batchPlanVersionIds.has(id)),
        )
      ) {
        throw new HandoffParseError(
          'SCHEMA_INVALID',
          'Requirement coverage references an undeclared batch plan version',
        );
      }
      if (input.requireMaterializedBatchPlans && contract.batchPlans === undefined) {
        throw new HandoffParseError(
          'SCHEMA_INVALID',
          'Plan-lifecycle refinement requires complete materialized batch plans',
        );
      }
      const batchPlans: readonly BatchPlanVersion[] = (contract.batchPlans ?? []).map((draft) => ({
        batchPlanVersionId: draft.batchPlanVersionId,
        workflowId: input.workflowId,
        batchId: draft.batchId,
        version: 1,
        contentHash: hashHandoffContent(JSON.stringify(draft)),
        repositoryContextSha: input.repositoryContextSha,
        objective: draft.objective,
        currentRepositoryEvidence: draft.currentRepositoryEvidence,
        dependencies: draft.dependencies,
        candidateFiles: draft.candidateFiles,
        technicalImplementation: draft.technicalImplementation,
        userJourney: draft.userJourney,
        expectedBehaviour: draft.expectedBehaviour,
        technicalAcceptanceCriteria: draft.technicalAcceptanceCriteria,
        userFacingAcceptanceCriteria: draft.userFacingAcceptanceCriteria,
        cliAcceptanceCriteria: draft.cliAcceptanceCriteria,
        browserAcceptanceCriteria: draft.browserAcceptanceCriteria,
        verificationCommands: draft.verificationCommands,
        manualVerification: draft.manualVerification,
        documentationChanges: draft.documentationChanges,
        outOfScope: draft.outOfScope,
        rollbackBoundary: draft.rollbackBoundary,
        addressedFindingIds: [],
        actorExecutionId: input.actorExecutionId,
        createdAt: input.createdAt,
      }));
      const acceptanceCriteria: readonly AcceptanceCriterion[] = (
        contract.batchPlans ?? []
      ).flatMap((draft) =>
        draft.acceptanceCriteria.map((criterion) => ({
          acceptanceCriterionId: criterion.acceptanceCriterionId,
          batchPlanVersionId: draft.batchPlanVersionId,
          kind: criterion.kind,
          statement: criterion.statement,
          required: criterion.required,
          passCondition: criterion.passCondition,
          status: 'PENDING',
          sourceRequirementIds: criterion.sourceRequirementIds,
          createdAt: input.createdAt,
        })),
      );
      const refinedPlan: RefinedPlanVersion = {
        refinedPlanVersionId: input.refinedPlanVersionId,
        workflowId: input.workflowId,
        generalPlanVersionId: input.generalPlanVersionId,
        repositoryAuditId: input.repositoryAuditId,
        repositoryContextSha: input.repositoryContextSha,
        version: input.version,
        contentHash: hashHandoffContent(contract.refinedPlanContent),
        batchPlanVersionIds: contract.batchPlanVersionIds,
        requirementCoverage: contract.requirementCoverage,
        actorExecutionId: input.actorExecutionId,
        createdAt: input.createdAt,
      };
      const transcript = parsedTranscript(input, 'REFINEMENT_RESULT', [
        refinedPlan.refinedPlanVersionId,
        ...batchPlans.map((plan) => plan.batchPlanVersionId),
        ...acceptanceCriteria.map((criterion) => criterion.acceptanceCriterionId),
      ]);
      this.store.saveHandoffCapture({
        transcript,
        entities: [
          { kind: 'REFINED_PLAN_VERSION', value: refinedPlan },
          ...batchPlans.map((value) => ({ kind: 'BATCH_PLAN_VERSION' as const, value })),
          ...acceptanceCriteria.map((value) => ({
            kind: 'ACCEPTANCE_CRITERION' as const,
            value,
          })),
        ],
      });
      return {
        accepted: true,
        transcript,
        value: { contract, refinedPlan, batchPlans, acceptanceCriteria },
      };
    } catch (error) {
      return this.captureRejected(input, 'REFINEMENT_RESULT', error);
    }
  }

  captureReview(
    input: HandoffCaptureContext & {
      readonly batchId: string;
      readonly reviewRoundId: string;
      readonly reviewRoundNumber: number;
      readonly expectedTarget: ReviewContractTarget;
    },
  ): HandoffCaptureResult<ReviewCaptureValue> {
    try {
      const contract = parseReviewResult(input.rawTranscript);
      requireExpectedTarget(contract.target, input.expectedTarget);
      const reviewKind = contract.target.kind;
      const findings = materializeFindings({
        workflowId: input.workflowId,
        batchId: input.batchId,
        reviewRoundId: input.reviewRoundId,
        reviewRoundNumber: input.reviewRoundNumber,
        reviewKind,
        target: contract.target,
        reviewerActorExecutionId: input.actorExecutionId,
        findings: contract.findings,
        createdAt: input.createdAt,
      });
      const review: StructuredReview = {
        reviewRoundId: input.reviewRoundId,
        transcriptId: input.transcriptId,
        workflowId: input.workflowId,
        batchId: input.batchId,
        reviewRoundNumber: input.reviewRoundNumber,
        reviewKind,
        target: contract.target,
        verdict: contract.verdict,
        summary: contract.summary,
        findingIds: findings.map((finding) => finding.findingId),
        reviewerActorExecutionId: input.actorExecutionId,
        createdAt: input.createdAt,
      };
      return this.persistReview(input, 'REVIEW_RESULT', contract, review, findings);
    } catch (error) {
      return this.captureRejected(input, 'REVIEW_RESULT', error);
    }
  }

  captureFinalAudit(
    input: HandoffCaptureContext & {
      readonly batchId: string;
      readonly reviewRoundId: string;
      readonly reviewRoundNumber: number;
      readonly expectedTarget: FinalAuditTarget;
      readonly expectedRequirementIds: readonly string[];
      readonly expectedAcceptanceCriterionIds: readonly string[];
    },
  ): HandoffCaptureResult<ReviewCaptureValue> {
    try {
      const contract = parseFinalAuditResult(input.rawTranscript);
      requireExpectedTarget(contract.target, input.expectedTarget);
      validateExactIds(
        contract.requirementChecks.map((check) => check.subjectId),
        input.expectedRequirementIds,
        'Final-audit requirement checks',
      );
      validateExactIds(
        contract.acceptanceCriterionChecks.map((check) => check.subjectId),
        input.expectedAcceptanceCriterionIds,
        'Final-audit acceptance-criterion checks',
      );
      const findings = materializeFindings({
        workflowId: input.workflowId,
        batchId: input.batchId,
        reviewRoundId: input.reviewRoundId,
        reviewRoundNumber: input.reviewRoundNumber,
        reviewKind: 'FINAL_AUDIT',
        target: contract.target,
        reviewerActorExecutionId: input.actorExecutionId,
        findings: contract.findings,
        createdAt: input.createdAt,
      });
      const review: StructuredReview = {
        reviewRoundId: input.reviewRoundId,
        transcriptId: input.transcriptId,
        workflowId: input.workflowId,
        batchId: input.batchId,
        reviewRoundNumber: input.reviewRoundNumber,
        reviewKind: 'FINAL_AUDIT',
        target: contract.target,
        verdict: contract.verdict,
        summary: contract.summary,
        findingIds: findings.map((finding) => finding.findingId),
        reviewerActorExecutionId: input.actorExecutionId,
        requirementChecks: contract.requirementChecks,
        acceptanceCriterionChecks: contract.acceptanceCriterionChecks,
        scopeComplete: contract.scopeComplete,
        documentationComplete: contract.documentationComplete,
        createdAt: input.createdAt,
      };
      return this.persistReview(input, 'FINAL_AUDIT_RESULT', contract, review, findings);
    } catch (error) {
      return this.captureRejected(input, 'FINAL_AUDIT_RESULT', error);
    }
  }

  captureImplementation(
    input: HandoffCaptureContext & {
      readonly batchId: string;
      readonly implementationAttemptId: string;
      readonly attemptNumber: number;
      readonly approvedPlanVersionId: string;
      readonly approvedPlanContentHash: string;
      readonly originalBatchBaseSha: string;
      readonly startingHeadSha: string;
      readonly implementerAssignmentId: string;
      readonly startedAt: string;
    },
  ): HandoffCaptureResult<ImplementationCaptureValue> {
    try {
      const contract = parseImplementationResult(input.rawTranscript);
      const implementationAttempt: ImplementationAttempt = {
        implementationAttemptId: input.implementationAttemptId,
        workflowId: input.workflowId,
        batchId: input.batchId,
        attemptNumber: input.attemptNumber,
        approvedPlanVersionId: input.approvedPlanVersionId,
        approvedPlanContentHash: input.approvedPlanContentHash,
        originalBatchBaseSha: input.originalBatchBaseSha,
        startingHeadSha: input.startingHeadSha,
        implementerAssignmentId: input.implementerAssignmentId,
        implementerActorExecutionId: input.actorExecutionId,
        summary:
          contract.outcome === 'BLOCKED'
            ? `${contract.summary}\n\nBlocker: ${contract.blockerReason}`
            : contract.summary,
        claimedChangedFiles: contract.changedFiles,
        claimedVerificationRecordIds: contract.verificationRecordIds,
        startedAt: input.startedAt,
        finishedAt: input.createdAt,
      };
      const transcript = parsedTranscript(input, 'IMPLEMENTATION_RESULT', [
        implementationAttempt.implementationAttemptId,
      ]);
      this.store.saveHandoffCapture({
        transcript,
        entities: [{ kind: 'IMPLEMENTATION_ATTEMPT', value: implementationAttempt }],
      });
      return {
        accepted: true,
        transcript,
        value: { contract, implementationAttempt },
      };
    } catch (error) {
      return this.captureRejected(input, 'IMPLEMENTATION_RESULT', error);
    }
  }

  captureDispositions(
    input: HandoffCaptureContext & {
      readonly batchId: string;
      readonly expectedTarget: DispositionResultContract['target'];
      readonly expectedFindingIds: readonly string[];
    },
  ): HandoffCaptureResult<DispositionCaptureValue> {
    try {
      const contract = parseDispositionResult(input.rawTranscript);
      requireExpectedTarget(contract.target, input.expectedTarget);
      requireExpectedFindingIds(
        contract.dispositions.map((disposition) => disposition.findingId),
        input.expectedFindingIds,
      );
      const dispositions = materializeDispositions({
        workflowId: input.workflowId,
        batchId: input.batchId,
        actorExecutionId: input.actorExecutionId,
        target: contract.target,
        result: contract,
        createdAt: input.createdAt,
      });
      const transcript = parsedTranscript(
        input,
        'DISPOSITION_RESULT',
        dispositions.map((disposition) => disposition.dispositionId),
      );
      this.store.saveHandoffCapture({
        transcript,
        entities: dispositions.map(
          (disposition): PersistableReviewWorkflowEntity => ({
            kind: 'FINDING_DISPOSITION',
            value: disposition,
          }),
        ),
      });
      return { accepted: true, transcript, value: { contract, dispositions } };
    } catch (error) {
      return this.captureRejected(input, 'DISPOSITION_RESULT', error);
    }
  }

  private persistReview(
    input: HandoffCaptureContext & { readonly batchId: string },
    contractKind: 'REVIEW_RESULT' | 'FINAL_AUDIT_RESULT',
    contract: ReviewResultContract | FinalAuditResultContract,
    review: StructuredReview,
    findings: readonly Finding[],
  ): AcceptedHandoffCapture<ReviewCaptureValue> {
    const transcript = parsedTranscript(input, contractKind, [
      review.reviewRoundId,
      ...findings.map((finding) => finding.findingId),
    ]);
    this.store.saveHandoffCapture({
      transcript,
      review,
      entities: findings.map(
        (finding): PersistableReviewWorkflowEntity => ({ kind: 'FINDING', value: finding }),
      ),
    });
    return { accepted: true, transcript, value: { contract, review, findings } };
  }

  private captureRejected(
    input: HandoffCaptureContext,
    contractKind: ReviewWorkflowContractKind,
    error: unknown,
  ): RejectedHandoffCapture {
    const rejection =
      error instanceof HandoffParseError
        ? error
        : error instanceof ReviewWorkflowPersistenceError &&
            error.code === 'HANDOFF_EVIDENCE_CONFLICT'
          ? new HandoffParseError('EXPECTED_FINDINGS_MISMATCH', error.message)
          : undefined;
    if (rejection === undefined) throw error;
    const transcript = rejectedTranscript(input, contractKind, rejection);
    this.store.saveHandoffCapture({ transcript, entities: [] });
    return {
      accepted: false,
      transcript,
      error: { code: rejection.code, message: rejection.message },
    };
  }
}
