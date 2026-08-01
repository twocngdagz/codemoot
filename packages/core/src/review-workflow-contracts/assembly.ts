// Assembling one REFINEMENT_RESULT from an outline and N independently-authored batch plans.
//
// Refinement is per batch, so ten isolated model calls each see only their own batch. Two
// of the merged document's invariants are therefore UNKNOWABLE to any single call, and run
// 9 proved it after eleven successful invocations, ~87 minutes and $25.80:
//
//   1. `acceptanceCriterionId` must be unique across the WHOLE plan. Nothing constrained
//      the field, so ten calls invented ten conventions — `criterion-01`, `ac-01`,
//      `batch3-ac-01`, `criterion-b9-panel-registered` … Three of ten happened to choose
//      bare sequential numbering and collided on 32 ids. The seven that did not collide
//      were lucky, not correct.
//   2. `requirementCoverage` must reference criteria that EXIST. The outline authors it
//      before a single batch plan has been written, so it can only guess: all 57 ids it
//      produced matched nothing. This is not a model failure — the information did not
//      exist yet.
//
// Both are fixed here by CONSTRUCTION rather than by instruction. The session's repeated
// lesson is that prompts are advisory: the contract prompt already said "Do not use
// Markdown fences" and the model fenced anyway. An invariant that must hold is enforced
// where it can be guaranteed, not requested where it can only be hoped for.

import type { RequirementCoverage } from '../review-workflow/types.js';
import type { BatchPlanDraft } from './types.js';

/** `<batchId>:criterion:<n>` — the same dictated shape as batchId and batchPlanVersionId. */
export function deriveCriterionId(batchId: string, ordinal: number): string {
  return `${batchId}:criterion:${ordinal}`;
}

/**
 * Rewrites one batch plan's criterion IDs into the namespaced form, updating EVERY
 * reference in the same pass.
 *
 * Uniqueness is guaranteed rather than hoped for: `batchPlanDraftSchema` already enforces
 * that IDs are unique WITHIN a batch, and every ID here is prefixed with that batch's own
 * ID, so no two batches can collide however the model chose to name things.
 *
 * `sourceRequirementIds` is deliberately NOT rewritten — those are requirement IDs from
 * the imported plan, not criterion IDs, and renaming them would break the very traceability
 * the coverage map is derived from.
 */
export function namespaceCriterionIds(plan: BatchPlanDraft): BatchPlanDraft {
  const renamed = new Map<string, string>();
  plan.acceptanceCriteria.forEach((criterion, index) => {
    renamed.set(criterion.acceptanceCriterionId, deriveCriterionId(plan.batchId, index + 1));
  });
  // A reference the batch never declared is left untouched so the schema still rejects it:
  // silently inventing an ID for it would convert a real defect into a plausible document.
  const rename = (id: string): string => renamed.get(id) ?? id;
  return {
    ...plan,
    acceptanceCriteria: plan.acceptanceCriteria.map((criterion) => ({
      ...criterion,
      acceptanceCriterionId: rename(criterion.acceptanceCriterionId),
    })),
    technicalAcceptanceCriteria: plan.technicalAcceptanceCriteria.map(rename),
    userFacingAcceptanceCriteria: plan.userFacingAcceptanceCriteria.map(rename),
    cliAcceptanceCriteria: plan.cliAcceptanceCriteria.map(rename),
    browserAcceptanceCriteria:
      plan.browserAcceptanceCriteria.applicability === 'APPLICABLE'
        ? {
            ...plan.browserAcceptanceCriteria,
            criterionIds: plan.browserAcceptanceCriteria.criterionIds.map(rename),
          }
        : plan.browserAcceptanceCriteria,
    verificationCommands: plan.verificationCommands.map((command) => ({
      ...command,
      relatedCriterionIds: command.relatedCriterionIds.map(rename),
    })),
  } as BatchPlanDraft;
}

/**
 * Derives the requirement coverage map from the batch plans themselves.
 *
 * Every criterion already declares the requirements it serves (`sourceRequirementIds`), so
 * coverage is a fact about the authored plans, not a prediction to be made before they
 * exist. Deriving it cannot reference a criterion that was never declared, and it cannot
 * drift from the plans it describes.
 *
 * A requirement no criterion claims is simply absent, which is the honest outcome: the
 * merged document then fails its own coverage rule, surfacing a genuinely uncovered
 * requirement instead of hiding it behind a guess that happened to parse.
 */
export function deriveRequirementCoverage(
  plans: readonly BatchPlanDraft[],
): readonly RequirementCoverage[] {
  const byRequirement = new Map<string, { plans: string[]; criteria: string[] }>();
  for (const plan of plans) {
    for (const criterion of plan.acceptanceCriteria) {
      for (const requirementId of criterion.sourceRequirementIds) {
        const entry = byRequirement.get(requirementId) ?? { plans: [], criteria: [] };
        if (!entry.plans.includes(plan.batchPlanVersionId)) {
          entry.plans.push(plan.batchPlanVersionId);
        }
        if (!entry.criteria.includes(criterion.acceptanceCriterionId)) {
          entry.criteria.push(criterion.acceptanceCriterionId);
        }
        byRequirement.set(requirementId, entry);
      }
    }
  }
  return [...byRequirement.entries()].map(([requirementId, entry]) => ({
    requirementId,
    batchPlanVersionIds: entry.plans,
    acceptanceCriterionIds: entry.criteria,
  }));
}

export interface RefinementAssemblyInput {
  readonly summary: string;
  readonly refinedPlanContent: string;
  /** Staged batch plans, in ordinal order. */
  readonly batchPlans: readonly BatchPlanDraft[];
}

/**
 * Builds the complete REFINEMENT_RESULT document. Every cross-batch invariant is satisfied
 * by construction here, so no per-batch prompt has to carry knowledge it cannot have.
 */
export function assembleRefinement(input: RefinementAssemblyInput): {
  readonly schemaVersion: 1;
  readonly contractKind: 'REFINEMENT_RESULT';
  readonly summary: string;
  readonly refinedPlanContent: string;
  readonly batchPlanVersionIds: readonly string[];
  readonly requirementCoverage: readonly RequirementCoverage[];
  readonly batchPlans: readonly BatchPlanDraft[];
} {
  const namespaced = input.batchPlans.map(namespaceCriterionIds);
  return {
    schemaVersion: 1,
    contractKind: 'REFINEMENT_RESULT',
    summary: input.summary,
    refinedPlanContent: input.refinedPlanContent,
    batchPlanVersionIds: namespaced.map((plan) => plan.batchPlanVersionId),
    requirementCoverage: deriveRequirementCoverage(namespaced),
    batchPlans: namespaced,
  };
}
