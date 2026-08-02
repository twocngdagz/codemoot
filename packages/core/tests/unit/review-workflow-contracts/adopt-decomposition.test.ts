// Once batch plans exist, THE STAGED DRAFTS ARE THE DECOMPOSITION.
//
// A fresh outline call is not a second opinion on how many batches a plan has — it is the
// same question asked twice, and it does not give the same answer. Three calls on an
// unchanged ten-batch plan returned 10, then 11, then 11: the model split one migration
// batch in two and invented a dependency between the halves. Refusing the mismatch
// protected ~$24 of staged work but deadlocked, because the outline wanted an ELEVENTH
// batch and no draft could be discarded to supply one.

import { describe, expect, it } from 'vitest';
import { REFINEMENT_OUTLINE_RESULT_EXAMPLE } from '../../../src/review-workflow-contracts/examples.js';
import { parseRefinementOutline } from '../../../src/review-workflow-contracts/parser.js';

/** Exactly the adoption the refinement path performs: outline prose + staged batch set. */
function adopt(
  authored: { summary: string; refinedPlanContent: string; batches: readonly unknown[] },
  staged: readonly {
    batchId: string;
    batchPlanVersionId: string;
    ordinal: number;
    objective: string;
  }[],
) {
  const batches = [...staged].sort((left, right) => left.ordinal - right.ordinal);
  return parseRefinementOutline(
    JSON.stringify({
      schemaVersion: 1,
      contractKind: 'REFINEMENT_OUTLINE_RESULT',
      summary: authored.summary,
      refinedPlanContent: authored.refinedPlanContent,
      batches,
    }),
  );
}

function stagedBatches(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    batchId: `workflow-1:batch:${index + 1}`,
    batchPlanVersionId: `workflow-1:batch:${index + 1}:plan:1`,
    ordinal: index + 1,
    objective: `Objective ${index + 1}`,
  }));
}

describe('adopting the staged decomposition', () => {
  const authored = {
    summary: 'Refined.',
    refinedPlanContent: '# Plan',
    batches: REFINEMENT_OUTLINE_RESULT_EXAMPLE.batches,
  };

  it('keeps TEN batches when the outline proposes eleven', () => {
    // The exact deadlock: 10 staged, outline says 11, nothing to discard.
    const eleven = { ...authored, batches: stagedBatches(11) };
    const result = adopt(eleven, stagedBatches(10));
    expect(result.batches).toHaveLength(10);
    expect(result.batches.map((batch) => batch.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('takes the plan PROSE from the outline — the drafts cannot supply it', () => {
    const result = adopt(
      {
        summary: 'Freshly authored summary.',
        refinedPlanContent: '# Freshly authored',
        batches: [],
      },
      stagedBatches(2),
    );
    expect(result.summary).toBe('Freshly authored summary.');
    expect(result.refinedPlanContent).toBe('# Freshly authored');
  });

  it('preserves each staged batch identity exactly', () => {
    // Adoption must not renumber or rename: the drafts are keyed by these values.
    const staged = stagedBatches(3);
    const result = adopt(authored, staged);
    expect(result.batches).toEqual(staged);
  });

  it('is stable — adopting twice yields the same decomposition', () => {
    const staged = stagedBatches(4);
    expect(JSON.stringify(adopt(authored, staged))).toBe(
      JSON.stringify(adopt({ ...authored, batches: stagedBatches(9) }, staged)),
    );
  });

  it('fails loudly when staged ordinals are not sequential', () => {
    // Left by an earlier partial discard. Re-parsing through the REAL contract is what
    // catches it, rather than assembling a plan with a hole in it.
    const gapped = stagedBatches(3).filter((batch) => batch.ordinal !== 2);
    expect(() => adopt(authored, gapped)).toThrow(/sequential/);
  });
});
