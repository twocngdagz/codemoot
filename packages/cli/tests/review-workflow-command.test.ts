import { describe, expect, it } from 'vitest';
import { buildPlanReviewPrompt, buildRefinementPrompt } from '../src/commands/review-workflow.js';

describe('review workflow CLI prompts', () => {
  it('binds refinement output to authoritative sequential IDs and imported requirements', () => {
    const prompt = buildRefinementPrompt({
      workflowId: 'workflow-1',
      repositoryAudit: {
        repositoryAuditId: 'audit-1',
        headSha: 'a'.repeat(40),
        dirty: false,
      },
      generalPlanContent: 'Implement the approved product plan.',
      requirements: [
        {
          requirementId: 'requirement-1',
          sourceReference: '## Required behavior',
          statement: 'The behavior must be reviewed before implementation.',
        },
      ],
    });

    expect(prompt).toContain('Output exactly one JSON object and nothing else.');
    expect(prompt).toContain('workflow-1:batch:N');
    expect(prompt).toContain('workflow-1:batch:N:plan:1');
    expect(prompt).toContain('"requirementId": "requirement-1"');
    expect(prompt).toContain('Do not include implementation work');
  });

  it('binds plan review to the exact persisted plan target', () => {
    const prompt = buildPlanReviewPrompt({
      workflowId: 'workflow-1',
      batchPlan: {
        batchPlanVersionId: 'workflow-1:batch:1:plan:1',
        contentHash: 'b'.repeat(64),
        repositoryContextSha: 'a'.repeat(40),
      },
      acceptanceCriteria: [],
    });

    expect(prompt).toContain('"kind": "PLAN"');
    expect(prompt).toContain('"planVersionId": "workflow-1:batch:1:plan:1"');
    expect(prompt).toContain(`"planContentHash": "${'b'.repeat(64)}"`);
    expect(prompt).toContain('one consolidated finding list');
    expect(prompt).toContain('Do not implement or modify code.');
  });
});
