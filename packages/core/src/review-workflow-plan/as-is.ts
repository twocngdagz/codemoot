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

/** A heading title that names a batch: `Batch 3 — migrations` etc. Order of appearance rules. */
const BATCH_HEADING_PATTERN = /^Batch\s+\d+\b/i;

/** The same heading shape the importer splits requirements on — the two MUST stay aligned. */
const HEADING_PATTERN = /^(#{2,6})\s+(.+?)\s*$/;

interface ScannedHeading {
  readonly line: number;
  readonly level: number;
  readonly title: string;
  readonly opensBatch: boolean;
}

/**
 * Scans the plan's headings and marks the ones that OPEN a batch. Batches are siblings:
 * only headings at the SAME level as the first batch-titled heading open batches, so a
 * deeper `### Batch 1 verification` under `## Batch 1` is content of batch 1 — a human
 * reads it as a subsection, and so does this.
 */
function scanHeadings(lines: readonly string[]): readonly ScannedHeading[] {
  const headings = lines.flatMap((line, index) => {
    const match = HEADING_PATTERN.exec(line);
    return match === null
      ? []
      : [{ line: index, level: match[1]?.length ?? 0, title: match[2]?.trim() ?? '' }];
  });
  const batchLevel = headings.find((heading) => BATCH_HEADING_PATTERN.test(heading.title))?.level;
  return headings.map((heading) => ({
    ...heading,
    opensBatch:
      batchLevel !== undefined &&
      heading.level === batchLevel &&
      BATCH_HEADING_PATTERN.test(heading.title),
  }));
}

/** A heading whose section declares the plan's own verification commands. */
const VERIFICATION_HEADING_PATTERN = /verif/i;

/** Fence openers whose contents are commands, one per line. */
const COMMAND_FENCE_PATTERN = /^```(?:sh|bash|shell|zsh)\s*$/i;
const FENCE_CLOSE_PATTERN = /^```\s*$/;

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
  /** Ordinals of batches that declared NO verification commands and use the minimal fallback. */
  readonly fallbackVerificationOrdinals: readonly number[];
}

/**
 * The plan's own verification commands, read mechanically.
 *
 * Contract (documented in docs/configuration.md): fenced ```sh / ```bash / ```shell /
 * ```zsh blocks inside any section whose heading contains "verif" (Verification, Verify,
 * Verification Commands …) are command lists, one command per line. A verification section
 * inside a batch's span belongs to that batch; one before the first batch heading is
 * plan-wide and applies to EVERY batch. Each line runs through `sh -c` exactly as written,
 * so `composer check`, pipes, and env prefixes all behave as they would in the operator's
 * own shell. Comment lines, blank lines, and a leading `$ ` prompt are dropped.
 */
function extractDeclaredVerification(lines: readonly string[]): {
  /** line index of the owning batch heading, or -1 for plan-wide. */
  readonly commandsByScope: ReadonlyMap<number, readonly string[]>;
} {
  const headings = scanHeadings(lines);
  const commandsByScope = new Map<number, string[]>();
  for (const [headingIndex, heading] of headings.entries()) {
    if (!VERIFICATION_HEADING_PATTERN.test(heading.title)) continue;
    const sectionEnd = headings[headingIndex + 1]?.line ?? lines.length;
    // The batch this section belongs to: the last batch-OPENING heading at or before it.
    const owner = headings
      .slice(0, headingIndex + 1)
      .filter((candidate) => candidate.opensBatch)
      .at(-1);
    const scope = owner?.line ?? -1;
    const commands = commandsByScope.get(scope) ?? [];
    let inFence = false;
    for (const raw of lines.slice(heading.line + 1, sectionEnd)) {
      const line = raw.trim();
      if (!inFence && COMMAND_FENCE_PATTERN.test(line)) {
        inFence = true;
        continue;
      }
      if (inFence && FENCE_CLOSE_PATTERN.test(line)) {
        inFence = false;
        continue;
      }
      if (!inFence) continue;
      const command = line.replace(/^\$\s+/, '');
      if (command.length === 0 || command.startsWith('#')) continue;
      commands.push(command);
    }
    commandsByScope.set(scope, commands);
  }
  return { commandsByScope };
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
  const headings = scanHeadings(lines);
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
      opensBatch: heading?.opensBatch ?? false,
      headingTitle: heading?.title ?? null,
    };
  });
}

/**
 * Builds the batch-plan drafts for a plan used verbatim.
 *
 * Batch boundaries: each `Batch N`-titled heading AT THE LEVEL OF THE FIRST ONE (batches
 * are siblings; a deeper `### Batch 1 verification` is content, not a new batch) opens a
 * batch that runs to the next batch heading, in order of appearance. Everything before the
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
  const batchGroups: {
    title: string | null;
    scopeLine: number;
    requirements: OrderedRequirement[];
  }[] = [];
  const beforeFirstBatch: OrderedRequirement[] = [];
  for (const requirement of ordered) {
    if (requirement.opensBatch) {
      batchGroups.push({
        title: requirement.headingTitle,
        scopeLine: requirement.headingLine,
        requirements: [requirement],
      });
    } else if (batchGroups.length > 0) {
      batchGroups.at(-1)?.requirements.push(requirement);
    } else {
      beforeFirstBatch.push(requirement);
    }
  }
  const merged =
    batchGroups.length === 0
      ? [{ title: null, scopeLine: -1, requirements: beforeFirstBatch }]
      : batchGroups.map((group, index) =>
          index === 0
            ? { ...group, requirements: [...beforeFirstBatch, ...group.requirements] }
            : group,
        );

  // The plan's OWN verification commands: declared per batch or plan-wide. A batch with
  // none falls back to a minimal worktree check — the merge gate hard-requires at least
  // one accepted verification record — and the fallback is REPORTED, never silent.
  const { commandsByScope } = extractDeclaredVerification(
    input.generalPlan.content.trim().split(/\r?\n/),
  );
  const planWideCommands = commandsByScope.get(-1) ?? [];
  const fallbackVerificationOrdinals: number[] = [];

  const batchPlans = merged.map((group, index) => {
    const ordinal = index + 1;
    const batchId = deriveWorkflowBatchId(input.workflowId, ordinal);
    // Plan-wide commands apply to every batch; batch-scoped ones only to their own. The
    // no-batch-headings fallback group carries scopeLine -1 — the plan-wide key — so its
    // scoped lookup must be skipped or every plan-wide command would be added twice and
    // run (and be attested) twice per batch.
    const declaredCommands = [
      ...planWideCommands,
      ...(group.scopeLine === -1 ? [] : (commandsByScope.get(group.scopeLine) ?? [])),
    ];
    if (declaredCommands.length === 0) fallbackVerificationOrdinals.push(ordinal);
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
            declaredCommands.length > 0
              ? 'The work of this batch is committed and every verification command the plan declares for it succeeds at the reviewed commit.'
              : 'The work of this batch is committed and the fallback worktree check succeeds at the reviewed commit (the plan declares no verification commands for this batch).',
          required: true,
          passCondition:
            declaredCommands.length > 0
              ? `Each declared command exits 0: ${declaredCommands.join(' ; ')}`
              : 'git status --porcelain exits 0 at the reviewed commit.',
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
      // The plan's OWN checks run, exactly as written, each line through `sh -c` so shell
      // semantics (arguments, pipes, env prefixes) match the operator's intent. Only when
      // the plan declares nothing does the batch fall back to `git status --porcelain`
      // (guard-allowed, always-passing) purely to satisfy the merge gate's hard ≥1-record
      // requirement — and that fallback is surfaced to the operator, never silent.
      verificationCommands:
        declaredCommands.length > 0
          ? declaredCommands.map((command) => ({
              executable: 'sh',
              arguments: ['-c', command],
              workingDirectory: '.',
              verificationType: 'custom' as const,
              relatedCriterionIds: ['criterion-1'],
            }))
          : [
              {
                executable: 'git',
                arguments: ['status', '--porcelain'],
                workingDirectory: '.',
                verificationType: 'custom' as const,
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

  const fallbackNote =
    fallbackVerificationOrdinals.length === 0
      ? ''
      : ` WARNING: batch(es) ${fallbackVerificationOrdinals.join(', ')} declare no verification commands (no fenced sh block under a "Verification" heading) and fall back to a minimal worktree check that proves nothing about correctness.`;
  return {
    summary: `Plan-as-is: ${batchPlans.length} batch(es) derived mechanically from the plan's own headings; no model authored or altered any plan content.${fallbackNote}`,
    refinedPlanContent: input.generalPlan.content,
    batchPlans,
    fallbackVerificationOrdinals,
  };
}

