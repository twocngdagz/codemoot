// Contract instructions DERIVED from the zod schemas that validate the responses.
//
// Hand-written prose about a schema drifts from it silently: a prompt that named the
// contract value but never the `contractKind` field cost a full 21-minute, $5 refinement,
// and fixing that one word only advanced the failure to the next missing field. Emitting
// the field list from `.shape` means a schema change can never again leave the prompt
// describing a document the validator rejects.

import { z } from 'zod';
import { CONTRACT_EXAMPLES } from './examples.js';

/** Unwraps `.strict().superRefine(...)` (ZodEffects) down to the underlying object. */
function unwrapObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> | undefined {
  let current: z.ZodTypeAny = schema;
  for (let depth = 0; depth < 10; depth += 1) {
    if (current instanceof z.ZodObject) return current;
    if (current instanceof z.ZodEffects) {
      current = current.innerType();
      continue;
    }
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault();
      continue;
    }
    return undefined;
  }
  return undefined;
}

function isOptional(field: z.ZodTypeAny): boolean {
  return field.isOptional();
}

/** A short, model-readable type hint: `string`, `string[]`, `object[]`, `"LITERAL"`, … */
function describeType(field: z.ZodTypeAny): string {
  let current: z.ZodTypeAny = field;
  if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current.unwrap();
  }
  if (current instanceof z.ZodEffects) current = current.innerType();
  if (current instanceof z.ZodLiteral) return JSON.stringify(current.value);
  if (current instanceof z.ZodArray) {
    const element =
      unwrapObject(current.element) === undefined ? describeType(current.element) : 'object';
    return `${element}[]`;
  }
  if (current instanceof z.ZodString) return 'string';
  if (current instanceof z.ZodNumber) return 'number';
  if (current instanceof z.ZodBoolean) return 'boolean';
  if (current instanceof z.ZodEnum)
    return (current.options as string[]).map((o) => JSON.stringify(o)).join(' | ');
  if (current instanceof z.ZodUnion || current instanceof z.ZodDiscriminatedUnion) return 'object';
  if (unwrapObject(current) !== undefined) return 'object';
  return 'value';
}

export interface ContractFieldSummary {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

/** Every TOP-LEVEL field of a contract schema, in declaration order. */
export function describeContractFields(schema: z.ZodTypeAny): readonly ContractFieldSummary[] {
  const object = unwrapObject(schema);
  if (object === undefined) return [];
  return Object.entries(object.shape).map(([name, field]) => ({
    name,
    type: describeType(field as z.ZodTypeAny),
    required: !isOptional(field as z.ZodTypeAny),
  }));
}

/** The object schema behind a field, whether it is `object` or `object[]`. */
function nestedObjectOf(field: z.ZodTypeAny): z.ZodTypeAny | undefined {
  let current: z.ZodTypeAny = field;
  if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current.unwrap();
  }
  if (current instanceof z.ZodEffects) current = current.innerType();
  if (current instanceof z.ZodArray) current = current.element;
  return unwrapObject(current) === undefined ? undefined : current;
}

/**
 * Nested shapes, breadth-first, deduplicated by path. A top-level-only description is what
 * let a model guess `batchIds` for `requirementCoverage[].batchPlanVersionIds` and invent
 * `notes` — the nested schemas are `.strict()` too, so they must be spelled out as well.
 */
function describeNestedShapes(
  schema: z.ZodTypeAny,
  maxDepth: number,
): readonly { readonly path: string; readonly fields: readonly ContractFieldSummary[] }[] {
  const out: { path: string; fields: readonly ContractFieldSummary[] }[] = [];
  const seen = new Set<string>();
  let frontier: { path: string; schema: z.ZodTypeAny }[] = [{ path: '', schema }];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: { path: string; schema: z.ZodTypeAny }[] = [];
    for (const entry of frontier) {
      const object = unwrapObject(entry.schema);
      if (object === undefined) continue;
      for (const [name, field] of Object.entries(object.shape)) {
        const nested = nestedObjectOf(field as z.ZodTypeAny);
        if (nested === undefined) continue;
        const isArray = describeType(field as z.ZodTypeAny).endsWith('[]');
        const path = `${entry.path}${entry.path === '' ? '' : '.'}${name}${isArray ? '[]' : ''}`;
        if (seen.has(path)) continue;
        seen.add(path);
        const fields = describeContractFields(nested);
        if (fields.length === 0) continue;
        out.push({ path, fields });
        next.push({ path, schema: nested });
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * The authoritative instruction block for a contract response. Every required field is
 * named with its type, optional fields are listed separately, and the strict-mode rule
 * (unknown keys are rejected outright) is stated explicitly.
 */
export function buildContractInstruction(
  schema: z.ZodTypeAny,
  contractKind: string,
  options?: { readonly maxNestedDepth?: number },
): string {
  const describe = (fields: readonly ContractFieldSummary[]): string[] => [
    ...fields
      .filter((field) => field.required)
      .map((field) => `  ${field.name}: ${field.type}   (REQUIRED)`),
    ...fields
      .filter((field) => !field.required)
      .map((field) => `  ${field.name}: ${field.type}   (optional)`),
  ];
  const nested = describeNestedShapes(schema, options?.maxNestedDepth ?? 3);
  const lines = [
    `Return EXACTLY one JSON object satisfying the ${contractKind} contract. These are its`,
    'authoritative TOP-LEVEL fields, spelled exactly as shown:',
    ...describe(describeContractFields(schema)),
  ];
  if (nested.length > 0) {
    lines.push(
      '',
      'Nested objects — EVERY one of these is strict as well, so their field names must be',
      'exact and no extra keys may be added:',
    );
    for (const shape of nested) {
      lines.push(`  ${shape.path}:`, ...describe(shape.fields).map((line) => `  ${line}`));
    }
  }
  const example = CONTRACT_EXAMPLES[contractKind as keyof typeof CONTRACT_EXAMPLES];
  if (example !== undefined) {
    // A proven-valid template: this exact document parses under the real validator (the
    // test suite asserts it), so its field names can be copied rather than inferred.
    lines.push(
      '',
      'A MINIMAL VALID document of this contract — copy these field names exactly, then',
      'replace the values with your real content:',
      JSON.stringify(example, null, 2),
    );
  }
  lines.push(
    '',
    `Every REQUIRED field above must be present, including "contractKind": "${contractKind}"`,
    '(the field name is contractKind — NOT "kind", NOT "type").',
    'The contract is STRICT at EVERY level: any key not listed above — at the top level or',
    'inside any nested object — causes outright rejection. Do not add fields such as',
    'producedAt, status, repository, notes, sourceReference, or metadata, and do not',
    'shorten a field name (batchPlanVersionIds is not batchIds).',
  );
  return lines.join('\n');
}
