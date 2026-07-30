// Types derived from the structured handoff schemas.

import type { z } from 'zod';
import type * as schemas from './schemas.js';

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ReviewWorkflowContractKind = (typeof schemas.REVIEW_WORKFLOW_CONTRACT_KINDS)[number];
export type ReviewWorkflowContractParseStatus =
  (typeof schemas.REVIEW_WORKFLOW_CONTRACT_PARSE_STATUSES)[number];
export type ReviewWorkflowReviewVerdict = (typeof schemas.REVIEW_WORKFLOW_REVIEW_VERDICTS)[number];
export type PlanReviewTarget = DeepReadonly<z.infer<typeof schemas.planReviewTargetSchema>>;
export type CodeReviewTarget = DeepReadonly<z.infer<typeof schemas.codeReviewTargetSchema>>;
export type FinalAuditTarget = DeepReadonly<z.infer<typeof schemas.finalAuditTargetSchema>>;
export type ReviewContractTarget = DeepReadonly<z.infer<typeof schemas.reviewContractTargetSchema>>;
export type FindingDraft = DeepReadonly<z.infer<typeof schemas.findingDraftSchema>>;
export type AcceptanceCriterionDraft = DeepReadonly<
  z.infer<typeof schemas.acceptanceCriterionDraftSchema>
>;
export type BatchPlanDraft = DeepReadonly<z.infer<typeof schemas.batchPlanDraftSchema>>;
export type RefinementResultContract = DeepReadonly<
  z.infer<typeof schemas.refinementResultContractSchema>
>;
export type ReviewResultContract = DeepReadonly<z.infer<typeof schemas.reviewResultContractSchema>>;
export type ImplementationResultContract = DeepReadonly<
  z.infer<typeof schemas.implementationResultContractSchema>
>;
export type DispositionDraft = DeepReadonly<z.infer<typeof schemas.dispositionDraftSchema>>;
export type DispositionResultContract = DeepReadonly<
  z.infer<typeof schemas.dispositionResultContractSchema>
>;
export type FinalAuditCheck = DeepReadonly<z.infer<typeof schemas.finalAuditCheckSchema>>;
export type FinalAuditResultContract = DeepReadonly<
  z.infer<typeof schemas.finalAuditResultContractSchema>
>;
export type ReviewWorkflowContract = DeepReadonly<
  z.infer<typeof schemas.reviewWorkflowContractSchema>
>;
export type HandoffTranscript = DeepReadonly<z.infer<typeof schemas.handoffTranscriptSchema>>;
export type StructuredReview = DeepReadonly<z.infer<typeof schemas.structuredReviewSchema>>;
