// Contract instructions DERIVED from the zod schemas that validate the responses.
//
// Hand-written prose about a schema drifts from it silently: a prompt that named the
// contract value but never the `contractKind` field cost a full 21-minute, $5 refinement,
// and fixing that one word only advanced the failure to the next missing field. Emitting
// the field list from `.shape` means a schema change can never again leave the prompt
// describing a document the validator rejects.

import { z } from 'zod';

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

/**
 * The authoritative instruction block for a contract response. Every required field is
 * named with its type, optional fields are listed separately, and the strict-mode rule
 * (unknown keys are rejected outright) is stated explicitly.
 */
export function buildContractInstruction(schema: z.ZodTypeAny, contractKind: string): string {
  const fields = describeContractFields(schema);
  const required = fields.filter((field) => field.required);
  const optional = fields.filter((field) => !field.required);
  const lines = [
    `Return EXACTLY one JSON object satisfying the ${contractKind} contract. These are its`,
    'authoritative TOP-LEVEL fields, spelled exactly as shown:',
    ...required.map((field) => `  ${field.name}: ${field.type}   (REQUIRED)`),
    ...optional.map((field) => `  ${field.name}: ${field.type}   (optional)`),
    '',
    `Every REQUIRED field above must be present, including "contractKind": "${contractKind}"`,
    '(the field name is contractKind — NOT "kind", NOT "type").',
    'The contract is STRICT: any key not listed above causes outright rejection, so do not',
    'add fields such as producedAt, status, repository, notes, or metadata.',
  ];
  return lines.join('\n');
}
