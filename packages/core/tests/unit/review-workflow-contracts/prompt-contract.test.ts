// The contract instruction must be DERIVED from the validating schema: a hand-written
// field list drifts silently, which is exactly how a refinement lost 21 minutes and $5.07
// to a prompt that named the contract value but not its fields.

import { describe, expect, it } from 'vitest';
import {
  buildContractInstruction,
  describeContractFields,
} from '../../../src/review-workflow-contracts/prompt-contract.js';
import {
  finalAuditResultContractSchema,
  implementationResultContractSchema,
  refinementResultContractSchema,
  reviewResultContractSchema,
} from '../../../src/review-workflow-contracts/schemas.js';

describe('describeContractFields', () => {
  it('sees through .strict().superRefine() to the real shape', () => {
    const fields = describeContractFields(refinementResultContractSchema);
    const names = fields.map((field) => field.name);
    // Every field the validator actually requires — including the three a real run omitted.
    expect(names).toEqual([
      'schemaVersion',
      'contractKind',
      'summary',
      'refinedPlanContent',
      'batchPlanVersionIds',
      'requirementCoverage',
      'batchPlans',
    ]);
    expect(fields.find((field) => field.name === 'batchPlans')?.required).toBe(false);
    expect(fields.find((field) => field.name === 'refinedPlanContent')?.required).toBe(true);
    expect(fields.find((field) => field.name === 'batchPlanVersionIds')?.type).toBe('string[]');
    expect(fields.find((field) => field.name === 'contractKind')?.type).toBe('"REFINEMENT_RESULT"');
  });

  it('derives fields for every contract used by the workflow', () => {
    for (const schema of [
      refinementResultContractSchema,
      reviewResultContractSchema,
      implementationResultContractSchema,
      finalAuditResultContractSchema,
    ]) {
      const fields = describeContractFields(schema);
      expect(fields.length).toBeGreaterThanOrEqual(4);
      expect(fields.some((field) => field.name === 'contractKind')).toBe(true);
    }
  });
});

describe('buildContractInstruction', () => {
  it('names every required field, marks optionals, and states strict mode', () => {
    const instruction = buildContractInstruction(
      refinementResultContractSchema,
      'REFINEMENT_RESULT',
    );
    for (const field of [
      'schemaVersion',
      'contractKind',
      'summary',
      'refinedPlanContent',
      'batchPlanVersionIds',
      'requirementCoverage',
    ]) {
      expect(instruction, field).toContain(`${field}:`);
    }
    expect(instruction).toContain('(REQUIRED)');
    expect(instruction).toContain('batchPlans: object[]   (optional)');
    expect(instruction).toContain('STRICT');
    expect(instruction).toContain('NOT "kind"');
    // The concrete invented keys that were rejected in a real run.
    expect(instruction).toContain('producedAt');
  });

  it('cannot drift from the schema: a new required field appears automatically', () => {
    // Proven structurally — the instruction is generated from .shape, so the field list and
    // the validator are the same source of truth.
    const fields = describeContractFields(reviewResultContractSchema).filter(
      (field) => field.required,
    );
    const instruction = buildContractInstruction(reviewResultContractSchema, 'REVIEW_RESULT');
    for (const field of fields) {
      expect(instruction, field.name).toContain(field.name);
    }
  });

  it('describes NESTED strict shapes, not just the top level', () => {
    // Regression for the second real rejection: the model produced `batchIds` and invented
    // `notes`/`sourceReference` inside requirementCoverage[] because only top-level fields
    // were ever named.
    const instruction = buildContractInstruction(
      refinementResultContractSchema,
      'REFINEMENT_RESULT',
    );
    expect(instruction).toContain('requirementCoverage[]:');
    for (const field of ['requirementId', 'batchPlanVersionIds', 'acceptanceCriterionIds']) {
      expect(instruction, field).toContain(field);
    }
    // The nested shapes are strict too, and the exact confusion is called out.
    expect(instruction).toContain('strict as well');
    expect(instruction).toContain('batchPlanVersionIds is not batchIds');
    expect(instruction).toContain('sourceReference');
    // Deeper batch-plan shapes are reached as well.
    expect(instruction).toContain('batchPlans[]:');
  });

  it('bounds recursion so a prompt cannot explode', () => {
    const shallow = buildContractInstruction(refinementResultContractSchema, 'REFINEMENT_RESULT', {
      maxNestedDepth: 1,
    });
    const deep = buildContractInstruction(refinementResultContractSchema, 'REFINEMENT_RESULT', {
      maxNestedDepth: 3,
    });
    expect(shallow.length).toBeLessThan(deep.length);
    expect(deep.length).toBeLessThan(20_000);
  });
});
