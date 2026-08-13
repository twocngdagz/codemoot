// Plan-as-is mechanical ingest: batches from the plan's own `## Batch N` headings, content
// verbatim, zero model involvement — and the output must satisfy the SAME contract, coverage
// and ID vocabulary the agent-authored refinement path is validated against.

import { describe, expect, it } from 'vitest';
import {
  assembleRefinement,
  parseRefinementResult,
  refinementResultContractSchema,
} from '../../../src/review-workflow-contracts/index.js';
import {
  PlanAsIsBuildError,
  buildPlanAsIsBatchPlans,
  deriveBatchPlanVersionId,
  deriveWorkflowBatchId,
  importGeneralPlan,
} from '../../../src/review-workflow-plan/index.js';

const WORKFLOW_ID = 'workflow-as-is';
const NOW = '2026-08-09T00:00:00.000Z';

const BATCHED_PLAN = `Preamble that motivates the work.

## Context

The system under change and its constraints.

## Batch 1 — foundations

Create the base module.

### Files touched

- src/base.ts

## Batch 2 — wiring

Wire the base module into the CLI.
`;

const FLAT_PLAN = `## Deliver the sample feature

Write the sample output file.
`;

function importPlan(content: string) {
  return importGeneralPlan({
    workflowId: WORKFLOW_ID,
    content,
    sourceType: 'MARKDOWN_FILE',
    sourceLocation: 'plan.md',
    authorEvidence: [{ kind: 'LOCAL_CLI', source: 'codemoot workflow run', observedAt: NOW }],
    createdAt: NOW,
  });
}

describe('buildPlanAsIsBatchPlans', () => {
  it('derives batches from the plan\'s own "## Batch N" headings, in order', () => {
    const { generalPlan, requirements } = importPlan(BATCHED_PLAN);
    const built = buildPlanAsIsBatchPlans({ workflowId: WORKFLOW_ID, generalPlan, requirements });

    expect(built.batchPlans).toHaveLength(2);
    expect(built.batchPlans.map((plan) => plan.batchId)).toEqual([
      deriveWorkflowBatchId(WORKFLOW_ID, 1),
      deriveWorkflowBatchId(WORKFLOW_ID, 2),
    ]);
    expect(built.batchPlans.map((plan) => plan.batchPlanVersionId)).toEqual([
      deriveBatchPlanVersionId(deriveWorkflowBatchId(WORKFLOW_ID, 1)),
      deriveBatchPlanVersionId(deriveWorkflowBatchId(WORKFLOW_ID, 2)),
    ]);
    expect(built.batchPlans[0]?.objective).toBe('Batch 1 — foundations');
    expect(built.batchPlans[1]?.objective).toBe('Batch 2 — wiring');
  });

  it('carries the plan text VERBATIM — nothing is rewritten or restated', () => {
    const { generalPlan, requirements } = importPlan(BATCHED_PLAN);
    const built = buildPlanAsIsBatchPlans({ workflowId: WORKFLOW_ID, generalPlan, requirements });

    // The refined-plan content is the stored plan byte for byte.
    expect(built.refinedPlanContent).toBe(generalPlan.content);
    // Batch 1 carries the preamble, the Context section, its own heading section AND the
    // sub-heading section inside its span — every requirement lands in exactly one batch.
    const batch1Text = built.batchPlans[0]?.technicalImplementation.join('\n') ?? '';
    expect(batch1Text).toContain('Preamble that motivates the work.');
    expect(batch1Text).toContain('The system under change and its constraints.');
    expect(batch1Text).toContain('Create the base module.');
    expect(batch1Text).toContain('src/base.ts');
    const batch2Text = built.batchPlans[1]?.technicalImplementation.join('\n') ?? '';
    expect(batch2Text).toContain('Wire the base module into the CLI.');
    expect(batch2Text).not.toContain('Create the base module.');
  });

  it('treats a plan without batch headings as ONE batch', () => {
    const { generalPlan, requirements } = importPlan(FLAT_PLAN);
    const built = buildPlanAsIsBatchPlans({ workflowId: WORKFLOW_ID, generalPlan, requirements });
    expect(built.batchPlans).toHaveLength(1);
    expect(built.batchPlans[0]?.batchId).toBe(deriveWorkflowBatchId(WORKFLOW_ID, 1));
    expect(built.batchPlans[0]?.technicalImplementation.join('\n')).toContain(
      'Write the sample output file.',
    );
  });

  it('covers every imported requirement exactly — the coverage rule the validator enforces', () => {
    const { generalPlan, requirements } = importPlan(BATCHED_PLAN);
    const built = buildPlanAsIsBatchPlans({ workflowId: WORKFLOW_ID, generalPlan, requirements });
    const assembled = assembleRefinement(built);

    const covered = assembled.requirementCoverage.map((entry) => entry.requirementId).sort();
    const expected = requirements.map((requirement) => requirement.requirementId).sort();
    expect(covered).toEqual(expected);
    // And the assembled document passes the same contract schema the agent path must pass.
    expect(refinementResultContractSchema.safeParse(assembled).success).toBe(true);
    expect(() => parseRefinementResult(JSON.stringify(assembled))).not.toThrow();
  });

  it('gives every batch ≥1 verification command linked to its criterion — the gate demands a record', () => {
    const { generalPlan, requirements } = importPlan(BATCHED_PLAN);
    const built = buildPlanAsIsBatchPlans({ workflowId: WORKFLOW_ID, generalPlan, requirements });
    for (const plan of built.batchPlans) {
      expect(plan.verificationCommands.length).toBeGreaterThanOrEqual(1);
      const criterionIds = plan.acceptanceCriteria.map(
        (criterion) => criterion.acceptanceCriterionId,
      );
      expect(criterionIds.length).toBeGreaterThanOrEqual(1);
      for (const command of plan.verificationCommands) {
        expect(command.relatedCriterionIds.length).toBeGreaterThanOrEqual(1);
        for (const id of command.relatedCriterionIds) {
          expect(criterionIds).toContain(id);
        }
      }
    }
  });

  it('refuses to build when the stored requirements do not match the stored plan', () => {
    const { generalPlan, requirements } = importPlan(BATCHED_PLAN);
    const foreign = importPlan(FLAT_PLAN).requirements;
    expect(() =>
      buildPlanAsIsBatchPlans({ workflowId: WORKFLOW_ID, generalPlan, requirements: foreign }),
    ).toThrow(PlanAsIsBuildError);
    // Sanity: the matching set builds.
    expect(() =>
      buildPlanAsIsBatchPlans({ workflowId: WORKFLOW_ID, generalPlan, requirements }),
    ).not.toThrow();
  });
});
