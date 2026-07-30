import { describe, expect, it } from 'vitest';
import {
  ReviewWorkflowPlanImportError,
  importGeneralPlan,
} from '../../../src/review-workflow-plan/importer.js';

const CREATED_AT = '2026-07-30T10:00:00.000Z';

describe('importGeneralPlan', () => {
  it('imports Markdown sections as stable, complete requirements', () => {
    const input = {
      workflowId: 'workflow-1',
      content: `# Product plan

This preamble applies to every batch.

## Repository audit

Inspect the actual repository before refining the plan.

## Review gate

Require an independent plan review.`,
      sourceType: 'MARKDOWN_FILE',
      sourceLocation: '/repo/plan.md',
      authorEvidence: [],
      createdAt: CREATED_AT,
    };

    const first = importGeneralPlan(input);
    const replay = importGeneralPlan(input);

    expect(replay).toEqual(first);
    expect(first.generalPlan.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.requirements.map((requirement) => requirement.sourceReference)).toEqual([
      'plan preamble',
      '## Repository audit',
      '## Review gate',
    ]);
    expect(first.requirements.every((requirement) => requirement.required)).toBe(true);
    expect(new Set(first.requirements.map((requirement) => requirement.requirementId)).size).toBe(
      3,
    );
  });

  it('preserves an unstructured plan as one required requirement', () => {
    const result = importGeneralPlan({
      workflowId: 'workflow-plain',
      content: 'Implement the complete approved plan without inventing scope.',
      sourceType: 'INLINE',
      authorEvidence: [],
      createdAt: CREATED_AT,
    });

    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]).toMatchObject({
      sourceReference: 'entire plan',
      statement: 'Implement the complete approved plan without inventing scope.',
    });
  });

  it('rejects an empty external plan', () => {
    expect(() =>
      importGeneralPlan({
        workflowId: 'workflow-empty',
        content: '   ',
        sourceType: 'INLINE',
        authorEvidence: [],
        createdAt: CREATED_AT,
      }),
    ).toThrowError(ReviewWorkflowPlanImportError);
  });
});
