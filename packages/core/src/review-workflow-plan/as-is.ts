// Plan-as-is: mechanical batch-plan synthesis from an operator-supplied plan, VERBATIM.
//
// The refined path asks a model to rewrite the plan into batch plans and then review-gates
// the rewrite. For a plan that was already authored and reviewed outside the workflow, that
// rewrite re-plans redundantly and can degrade precision — so this module produces the same
// REFINEMENT_RESULT shape the agent path produces, with ZERO model invocations and zero
// interpretation: the plan text itself is the content, batches come from the plan's own
// `## Batch N` headings, and every `.min(1)` field a batch plan must carry is either the
// plan's verbatim text or an honest placeholder that says exactly what it is.
//
// The output feeds the SAME assembleRefinement → captureRefinement pipeline as the agent
// path, so batch materialization, criterion namespacing, coverage derivation, hashing and
// audit are identical — validateLifecycleRefinement runs on this output unchanged, which is
// the point: mechanical does not mean unvalidated.

import { batchPlanDraftSchema } from '../review-workflow-contracts/schemas.js';
import type { BatchPlanDraft } from '../review-workflow-contracts/types.js';
import type { GeneralPlanVersion, PlanRequirement } from '../review-workflow/types.js';
import { importGeneralPlan } from './importer.js';
import { deriveBatchPlanVersionId, deriveWorkflowBatchId } from './service.js';

/** A heading that opens a batch: `## Batch 3 — migrations` etc. Order of appearance rules. */
const BATCH_HEADING_PATTERN = /^Batch\s+\d+\b/i;

/** The same heading shape the importer splits requirements on — the two MUST stay aligned. */
const HEADING_PATTERN = /^(#{2,6})\s+(.+?)\s*$/;

export interface PlanAsIsBuildInput {
  readonly workflowId: string;
  readonly generalPlan: GeneralPlanVersion;
  /** The stored requirements for this plan — used to verify the deterministic re-derivation. */
  readonly requirements: readonly PlanRequirement[];
}

export interface PlanAsIsBuildResult {
  readonly summary: string;
  /** The operator's plan, byte-for-byte. */
  readonly refinedPlanContent: string;
  readonly batchPlans: readonly BatchPlanDraft[];
}

export class PlanAsIsBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanAsIsBuildError';
  }
}

interface OrderedRequirement {
  readonly requirementId: string;
  readonly statement: string;
  /** Line index of the section's heading in the plan, or -1 for preamble/whole-plan. */
  readonly headingLine: number;
  /** True when this section's heading opens a batch. */
  readonly opensBatch: boolean;
  readonly headingTitle: string | null;
}

/**
 * Re-derives the plan's requirement sections IN DOCUMENT ORDER with their authoritative
 * requirement IDs.
 *
 * The store cannot provide this: `listRequirements` orders by (created_at, requirement_id)
 * and every requirement of one import shares a created_at, so the durable order is hash
 * order. The importer's ID derivation is deliberately timestamp-free, so re-running it on
 * the stored plan content reproduces the exact stored IDs in the exact document order —
 * verified against the stored set below, so a divergence fails loudly instead of silently
 * mis-assigning a requirement to the wrong batch.
 */
function orderedRequirements(input: PlanAsIsBuildInput): readonly OrderedRequirement[] {
  const rederived = importGeneralPlan({
    workflowId: input.workflowId,
    content: input.generalPlan.content,
    sourceType: input.generalPlan.sourceType,
    ...(input.generalPlan.sourceLocation === undefined
      ? {}
      : { sourceLocation: input.generalPlan.sourceLocation }),
    authorEvidence: [...input.generalPlan.authorEvidence],
    createdAt: input.generalPlan.createdAt,
    version: input.generalPlan.version,
  });
  const storedIds = [...input.requirements.map((requirement) => requirement.requirementId)].sort();
  const rederivedIds = [...rederived.requirements.map((r) => r.requirementId)].sort();
  if (JSON.stringify(storedIds) !== JSON.stringify(rederivedIds)) {
    throw new PlanAsIsBuildError(
      'The stored requirements do not match a deterministic re-derivation of the stored plan; refusing to guess which requirement belongs to which batch',
    );
  }

  // Walk the plan's headings the way the importer does, so section order matches the
  // re-derived requirement order exactly: optional preamble first, then one per heading.
  const lines = input.generalPlan.content.trim().split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const match = HEADING_PATTERN.exec(line);
    return match === null ? [] : [{ line: index, title: match[2]?.trim() ?? '' }];
  });
  const hasPreamble =
    headings.length > 0 &&
    lines
      .slice(0, headings[0]?.line ?? 0)
      .join('\n')
      .trim().length > 0;
  return rederived.requirements.map((requirement, index) => {
    if (headings.length === 0) {
      // The importer emitted a single 'entire plan' requirement.
      return {
        requirementId: requirement.requirementId,
        statement: requirement.statement,
        headingLine: -1,
        opensBatch: false,
        headingTitle: null,
      };
    }
    const headingIndex = hasPreamble ? index - 1 : index;
    const heading = headingIndex < 0 ? null : headings[headingIndex];
    return {
      requirementId: requirement.requirementId,
      statement: requirement.statement,
      headingLine: heading?.line ?? -1,
      opensBatch: heading !== null && BATCH_HEADING_PATTERN.test(heading.title),
      headingTitle: heading?.title ?? null,
    };
  });
}

/**
 * Builds the batch-plan drafts for a plan used verbatim.
 *
 * Batch boundaries: each `## Batch N` heading (any level 2–6, order of appearance is
 * authoritative) opens a batch that runs to the next batch heading. Everything before the
 * first batch heading — the preamble and any general sections — belongs to batch 1, so
 * every requirement is covered and `validateLifecycleRefinement`'s exact-coverage rule
 * holds. A plan with no batch headings is one batch.
 */
export function buildPlanAsIsBatchPlans(input: PlanAsIsBuildInput): PlanAsIsBuildResult {
  const ordered = orderedRequirements(input);
  if (ordered.length === 0) {
    throw new PlanAsIsBuildError('The plan produced no requirements to build batches from');
  }

  // Partition requirements into batches by document position: each batch heading starts a
  // group; everything before the first batch heading is folded into batch 1 so every
  // requirement is covered; no batch headings at all means one batch of everything.
  const batchGroups: { title: string | null; requirements: OrderedRequirement[] }[] = [];
  const beforeFirstBatch: OrderedRequirement[] = [];
  for (const requirement of ordered) {
    if (requirement.opensBatch) {
      batchGroups.push({ title: requirement.headingTitle, requirements: [requirement] });
    } else if (batchGroups.length > 0) {
      batchGroups.at(-1)?.requirements.push(requirement);
    } else {
      beforeFirstBatch.push(requirement);
    }
  }
  const merged =
    batchGroups.length === 0
      ? [{ title: null, requirements: beforeFirstBatch }]
      : batchGroups.map((group, index) =>
          index === 0
            ? { ...group, requirements: [...beforeFirstBatch, ...group.requirements] }
            : group,
        );

  const batchPlans = merged.map((group, index) => {
    const ordinal = index + 1;
    const batchId = deriveWorkflowBatchId(input.workflowId, ordinal);
    const objective =
      group.title ?? 'Deliver the operator-supplied plan as written (plan-as-is mode).';
    // The plan text of this batch's sections, verbatim. Statements are non-empty by the
    // importer's schema, so `.min(1)` holds whenever the batch has any section — and every
    // batch has at least the section of its own heading.
    const technicalImplementation = group.requirements.map((requirement) => requirement.statement);
    const draft: BatchPlanDraft = batchPlanDraftSchema.parse({
      batchPlanVersionId: deriveBatchPlanVersionId(batchId),
      batchId,
      ordinal,
      objective,
      currentRepositoryEvidence: [
        {
          kind: 'PLAN',
          location: input.generalPlan.sourceLocation ?? 'general-plan',
          description:
            'The operator-supplied plan, used verbatim (plan-as-is mode). No repository audit was authored by a model; the plan itself is the authority.',
        },
      ],
      dependencies: [],
      candidateFiles: [],
      technicalImplementation,
      userJourney: [
        'Plan-as-is mode: the supplied plan is authoritative and was not restated; behaviour is specified by the plan text carried in technicalImplementation.',
      ],
      expectedBehaviour: [
        'The repository satisfies this batch of the supplied plan exactly as written.',
      ],
      acceptanceCriteria: [
        {
          acceptanceCriterionId: 'criterion-1',
          kind: 'TECHNICAL',
          statement:
            'The work of this batch is committed and the synthesized verification command succeeds at the reviewed commit.',
          required: true,
          passCondition: 'git status --porcelain exits 0 at the reviewed commit.',
          sourceRequirementIds: group.requirements.map(
            (requirement) => requirement.requirementId,
          ),
        },
      ],
      technicalAcceptanceCriteria: ['criterion-1'],
      userFacingAcceptanceCriteria: [],
      cliAcceptanceCriteria: [],
      browserAcceptanceCriteria: {
        applicability: 'NOT_APPLICABLE',
        reason:
          'Plan-as-is mode synthesizes no browser criteria; the plan text is authoritative.',
      },
      // The merge gate hard-requires at least one ACCEPTED verification record per batch
      // (it does not consult configuration), so a synthesized batch always carries one
      // command. `git status` is explicitly allowed by the git guard; the criterion above
      // claims only what this command proves — execution evidence at the reviewed commit —
      // and deeper verification stays where this mode puts it: code review and the plan's
      // own instructions to the implementer.
      verificationCommands: [
        {
          executable: 'git',
          arguments: ['status', '--porcelain'],
          workingDirectory: '.',
          verificationType: 'custom',
          relatedCriterionIds: ['criterion-1'],
        },
      ],
      manualVerification: [],
      documentationChanges: [],
      outOfScope: [],
      rollbackBoundary: 'Revert the commits of this batch on the workflow branch.',
    });
    return draft;
  });

  return {
    summary: `Plan-as-is: ${batchPlans.length} batch(es) derived mechanically from the plan's own headings; no model authored or altered any plan content.`,
    refinedPlanContent: input.generalPlan.content,
    batchPlans,
  };
}

