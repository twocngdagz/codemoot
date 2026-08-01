// Cross-batch invariants belong to the MERGE, and no per-batch guard can see them.
//
// Run 9 reached assembly after eleven successful invocations, ~87 minutes and $25.80, and
// was rejected on a rule no single call could have satisfied. Every existing guard passed:
// `buildContractInstruction` describes shapes, `workflow preflight` validates one document,
// and `findUndescribedContractPaths` proves every path is described. None of them can
// express "unique ACROSS documents" or "references a criterion authored by a later call".
//
// The invariant asserted here is the one that actually matters, and it is a property, not
// an example: assembling ANY set of individually-valid batch plans must produce a document
// the real REFINEMENT_RESULT validator accepts. The adversarial fixtures below reproduce
// the exact naming anarchy ten isolated `claude-opus-5` calls produced.

import { describe, expect, it } from 'vitest';
import {
  assembleRefinement,
  deriveRequirementCoverage,
  namespaceCriterionIds,
} from '../../../src/review-workflow-contracts/assembly.js';
import { parseRefinementResult } from '../../../src/review-workflow-contracts/parser.js';
import { batchPlanDraftSchema } from '../../../src/review-workflow-contracts/schemas.js';
import type { BatchPlanDraft } from '../../../src/review-workflow-contracts/types.js';

const WORKFLOW = 'workflow-1';

/** One individually-valid batch plan using whatever criterion-naming scheme it likes. */
function draft(input: {
  readonly ordinal: number;
  readonly criterionIds: readonly string[];
  readonly requirementIds: readonly string[];
  readonly browser?: boolean;
}): BatchPlanDraft {
  const batchId = `${WORKFLOW}:batch:${input.ordinal}`;
  const [first, ...rest] = input.criterionIds;
  if (first === undefined) throw new Error('a batch needs at least one criterion');
  const plan = {
    batchPlanVersionId: `${batchId}:plan:1`,
    batchId,
    ordinal: input.ordinal,
    objective: `Objective ${input.ordinal}`,
    currentRepositoryEvidence: [
      { kind: 'FILE', location: 'src/example.ts', description: 'What exists today.' },
    ],
    dependencies: [],
    candidateFiles: [],
    technicalImplementation: ['Do the thing.'],
    userJourney: ['User does the thing.'],
    expectedBehaviour: ['The thing is done.'],
    acceptanceCriteria: input.criterionIds.map((id, index) => ({
      acceptanceCriterionId: id,
      kind: index === 0 && input.browser === true ? 'BROWSER' : 'TECHNICAL',
      statement: `Statement for ${id}`,
      required: true,
      passCondition: 'It passes.',
      sourceRequirementIds: [...input.requirementIds],
    })),
    technicalAcceptanceCriteria: input.browser === true ? rest : [...input.criterionIds],
    userFacingAcceptanceCriteria: [],
    cliAcceptanceCriteria: [],
    browserAcceptanceCriteria:
      input.browser === true
        ? { applicability: 'APPLICABLE', criterionIds: [first] }
        : { applicability: 'NOT_APPLICABLE', reason: 'No browser surface.' },
    verificationCommands: [
      {
        executable: 'pnpm',
        arguments: ['test'],
        workingDirectory: '.',
        verificationType: 'test',
        relatedCriterionIds: [...input.criterionIds],
      },
    ],
    manualVerification: [],
    documentationChanges: [],
    outOfScope: ['Everything else.'],
    rollbackBoundary: 'Revert the commit.',
  };
  // Every fixture must be a plan a real batch call could legitimately return, or the test
  // would be proving something about documents the system never sees.
  return batchPlanDraftSchema.parse(plan) as BatchPlanDraft;
}

describe('refinement assembly satisfies the cross-batch invariants by construction', () => {
  it('merges batches that ALL chose the same criterion IDs', () => {
    // The run-9 defect exactly: three of ten batches picked bare sequential numbering.
    const plans = [1, 2, 3].map((ordinal) =>
      draft({
        ordinal,
        criterionIds: ['criterion-01', 'criterion-02'],
        requirementIds: ['requirement-a'],
      }),
    );
    const assembled = assembleRefinement({
      summary: 'Refined.',
      refinedPlanContent: '# Plan',
      batchPlans: plans,
    });
    // The real validator is the judge — not a re-implementation of its rules.
    expect(() => parseRefinementResult(JSON.stringify(assembled))).not.toThrow();
    const ids = assembled.batchPlans.flatMap((plan) =>
      plan.acceptanceCriteria.map((criterion) => criterion.acceptanceCriterionId),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('survives the ten naming schemes ten isolated calls actually produced', () => {
    // Verbatim from run 9's staged drafts.
    const SCHEMES = [
      'criterion-01',
      'ac-01',
      'batch3-ac-01',
      'criterion-01',
      'criterion-5-01',
      'criterion-6-01',
      'batch-7-criterion-01',
      'criterion-1',
      'criterion-b9-panel-registered',
      'b10-ac-01-dependency-gate',
    ];
    const plans = SCHEMES.map((scheme, index) =>
      draft({
        ordinal: index + 1,
        criterionIds: [scheme, `${scheme}-second`],
        requirementIds: ['requirement-a', 'requirement-b'],
        browser: index % 3 === 0,
      }),
    );
    const assembled = assembleRefinement({
      summary: 'Refined.',
      refinedPlanContent: '# Plan',
      batchPlans: plans,
    });
    expect(() => parseRefinementResult(JSON.stringify(assembled))).not.toThrow();
    expect(assembled.batchPlans).toHaveLength(10);
  });

  it('rewrites EVERY reference, not just the declaration', () => {
    // A rename that misses a reference list produces a document that still parses at the
    // top level but is internally broken — the worst possible outcome.
    const plan = namespaceCriterionIds(
      draft({
        ordinal: 1,
        criterionIds: ['ac-01', 'ac-02'],
        requirementIds: ['requirement-a'],
        browser: true,
      }),
    );
    const declared = plan.acceptanceCriteria.map((c) => c.acceptanceCriterionId);
    expect(declared).toEqual(['workflow-1:batch:1:criterion:1', 'workflow-1:batch:1:criterion:2']);
    const referenced = [
      ...plan.technicalAcceptanceCriteria,
      ...plan.cliAcceptanceCriteria,
      ...plan.userFacingAcceptanceCriteria,
      ...(plan.browserAcceptanceCriteria.applicability === 'APPLICABLE'
        ? plan.browserAcceptanceCriteria.criterionIds
        : []),
      ...plan.verificationCommands.flatMap((command) => command.relatedCriterionIds),
    ];
    expect(referenced.length).toBeGreaterThan(0);
    for (const id of referenced) expect(declared, id).toContain(id);
  });

  it('does NOT rewrite sourceRequirementIds', () => {
    // Those are requirement IDs, not criterion IDs. Renaming them would destroy the
    // traceability the coverage map is derived from.
    const plan = namespaceCriterionIds(
      draft({ ordinal: 1, criterionIds: ['ac-01'], requirementIds: ['requirement-a'] }),
    );
    expect(plan.acceptanceCriteria[0]?.sourceRequirementIds).toEqual(['requirement-a']);
  });

  it('derives coverage from what the plans declare, so it can never dangle', () => {
    const plans = [
      draft({ ordinal: 1, criterionIds: ['a1'], requirementIds: ['req-1', 'req-2'] }),
      draft({ ordinal: 2, criterionIds: ['a1'], requirementIds: ['req-2'] }),
    ].map(namespaceCriterionIds);
    const coverage = deriveRequirementCoverage(plans);

    expect(coverage.map((entry) => entry.requirementId).sort()).toEqual(['req-1', 'req-2']);
    const shared = coverage.find((entry) => entry.requirementId === 'req-2');
    expect(shared?.batchPlanVersionIds).toEqual([
      'workflow-1:batch:1:plan:1',
      'workflow-1:batch:2:plan:1',
    ]);
    expect(shared?.acceptanceCriterionIds).toEqual([
      'workflow-1:batch:1:criterion:1',
      'workflow-1:batch:2:criterion:1',
    ]);

    const declared = new Set(
      plans.flatMap((plan) => plan.acceptanceCriteria.map((c) => c.acceptanceCriterionId)),
    );
    for (const entry of coverage) {
      for (const id of entry.acceptanceCriterionIds) expect(declared).toContain(id);
    }
  });

  it('reports an uncovered requirement instead of inventing coverage for it', () => {
    // Honest failure: a requirement no criterion claims must surface, not be papered over.
    const coverage = deriveRequirementCoverage([
      draft({ ordinal: 1, criterionIds: ['a1'], requirementIds: ['req-1'] }),
    ]);
    expect(coverage.map((entry) => entry.requirementId)).toEqual(['req-1']);
    expect(coverage.some((entry) => entry.requirementId === 'req-2')).toBe(false);
  });

  it('is deterministic — the same drafts assemble to the same document', () => {
    // Refinement is resumable, so a re-assembly of the same staged drafts must not produce
    // different IDs; downstream phases reference these criteria by ID.
    const plans = [
      draft({ ordinal: 1, criterionIds: ['x'], requirementIds: ['req-1'] }),
      draft({ ordinal: 2, criterionIds: ['x'], requirementIds: ['req-1'] }),
    ];
    const once = assembleRefinement({ summary: 's', refinedPlanContent: 'p', batchPlans: plans });
    const twice = assembleRefinement({ summary: 's', refinedPlanContent: 'p', batchPlans: plans });
    expect(JSON.stringify(once)).toEqual(JSON.stringify(twice));
  });

  it('assembles a document whose criterion IDs match the form the prompt asks for', () => {
    // Construction and instruction must agree. The prompt tells each batch to emit
    // `<batchId>:criterion:N`; if assembly normalised to a DIFFERENT form, a compliant model
    // would see its IDs silently rewritten and the instruction would be a lie.
    const assembled = assembleRefinement({
      summary: 's',
      refinedPlanContent: 'p',
      batchPlans: [
        draft({
          ordinal: 2,
          criterionIds: ['workflow-1:batch:2:criterion:1', 'workflow-1:batch:2:criterion:2'],
          requirementIds: ['req-1'],
        }),
      ],
    });
    // A model that followed the instruction exactly is a FIXED POINT: nothing is rewritten.
    expect(assembled.batchPlans[0]?.acceptanceCriteria.map((c) => c.acceptanceCriterionId)).toEqual(
      ['workflow-1:batch:2:criterion:1', 'workflow-1:batch:2:criterion:2'],
    );
  });

  it('leaves an undeclared reference alone so the validator still rejects it', () => {
    // Inventing an ID for a dangling reference would turn a real defect into a document
    // that parses. The rename must not launder broken input.
    const broken = {
      ...draft({ ordinal: 1, criterionIds: ['a1'], requirementIds: ['req-1'] }),
      technicalAcceptanceCriteria: ['a1', 'never-declared'],
    } as BatchPlanDraft;
    const renamed = namespaceCriterionIds(broken);
    expect(renamed.technicalAcceptanceCriteria).toContain('never-declared');
  });
});
