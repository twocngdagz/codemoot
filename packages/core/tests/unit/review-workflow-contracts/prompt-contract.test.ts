// The contract instruction must be DERIVED from the validating schema: a hand-written
// field list drifts silently, which is exactly how a refinement lost 21 minutes and $5.07
// to a prompt that named the contract value but not its fields.

import { describe, expect, it } from 'vitest';
import { CONTRACT_EXAMPLES } from '../../../src/review-workflow-contracts/examples.js';
import {
  parseDispositionResult,
  parseFinalAuditResult,
  parseImplementationResult,
  parseRefinementResult,
  parseReviewResult,
} from '../../../src/review-workflow-contracts/parser.js';
import {
  buildContractInstruction,
  describeContractFields,
} from '../../../src/review-workflow-contracts/prompt-contract.js';
import {
  batchPlanContractSchema,
  refinementOutlineContractSchema,
} from '../../../src/review-workflow-contracts/schemas.js';
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

describe('contract examples round-trip through the real parsers', () => {
  // The build-time gate: three real runs were rejected AFTER a full successful invocation
  // (13-21 min, $3.40-$5.07 each) for field-name mistakes. Every example embedded in a
  // prompt must parse under the exact validator that judges the agent's response, so
  // schema drift breaks the suite instead of a paid workflow. This gate has already caught
  // one hand-written example (a stale FINAL_AUDIT target shape).
  const CASES = [
    ['REFINEMENT_RESULT', parseRefinementResult],
    ['REVIEW_RESULT', parseReviewResult],
    ['IMPLEMENTATION_RESULT', parseImplementationResult],
    ['DISPOSITION_RESULT', parseDispositionResult],
    ['FINAL_AUDIT_RESULT', parseFinalAuditResult],
  ] as const;

  it.each(CASES)('%s example is valid under its real parser', (kind, parse) => {
    const example = CONTRACT_EXAMPLES[kind];
    expect(() => parse(JSON.stringify(example))).not.toThrow();
  });

  it('covers every contract the workflow asks an agent to produce', () => {
    expect(Object.keys(CONTRACT_EXAMPLES).sort()).toEqual([...CASES.map(([kind]) => kind)].sort());
  });

  it('embeds the proven example in the instruction agents receive', () => {
    const instruction = buildContractInstruction(
      refinementResultContractSchema,
      'REFINEMENT_RESULT',
    );
    expect(instruction).toContain('MINIMAL VALID document');
    // The example inside the prompt is the same object the parser validated above.
    expect(instruction).toContain('"refinedPlanContent"');
    expect(instruction).toContain('"batchPlanVersionIds"');
    const embedded = instruction.slice(instruction.indexOf('{'));
    expect(() =>
      parseRefinementResult(embedded.slice(0, embedded.lastIndexOf('}') + 1)),
    ).not.toThrow();
  });
});

describe('per-batch refinement contracts', () => {
  // Refinement used to demand every batch plan in one response: a 43-minute run exceeded
  // the model's output ceiling and produced NOTHING, because batch 1 was discarded when
  // batch 9 made the answer too long. The outline is small by construction and each batch
  // plan is its own response.
  it('the outline carries no batch bodies', () => {
    const fields = describeContractFields(refinementOutlineContractSchema).map((f) => f.name);
    expect(fields).toContain('batches');
    expect(fields).not.toContain('batchPlans');
    const instruction = buildContractInstruction(
      refinementOutlineContractSchema,
      'REFINEMENT_OUTLINE_RESULT',
    );
    // The nested batch entries are the SHAPE only: id, ordinal, objective.
    expect(instruction).toContain('batches[]:');
    expect(instruction).toContain('objective');
    expect(instruction).not.toContain('technicalImplementation');
  });

  it('one batch plan per response, with its full nested shape spelled out', () => {
    const fields = describeContractFields(batchPlanContractSchema).map((f) => f.name);
    expect(fields).toEqual(['schemaVersion', 'contractKind', 'batchPlan']);
    const instruction = buildContractInstruction(batchPlanContractSchema, 'BATCH_PLAN_RESULT');
    for (const field of ['batchPlan[]', 'objective', 'acceptanceCriteria', 'rollbackBoundary']) {
      expect(instruction, field).toContain(field.replace('[]', ''));
    }
  });
});
