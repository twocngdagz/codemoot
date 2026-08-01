// Contract instructions DERIVED from the zod schemas that validate the responses.
//
// Hand-written prose about a schema drifts from it silently: a prompt that named the
// contract value but never the `contractKind` field cost a full 21-minute, $5 refinement,
// and fixing that one word only advanced the failure to the next missing field. Emitting
// the field list from `.shape` means a schema change can never again leave the prompt
// describing a document the validator rejects.
//
// The same failure recurs whenever a zod construct is UNHANDLED here, because an unhandled
// construct degrades to the useless label `object` instead of failing: a fourth paid run
// died on `browserAcceptanceCriteria` — a discriminated union the generator rendered as a
// bare `object`, so the model was never told `applicability` exists. Every construct the
// contracts use must therefore be resolved explicitly, anything unresolved renders as the
// `value` sentinel, and `findUndescribedContractPaths` fails the build on either.

import { z } from 'zod';
import { CONTRACT_EXAMPLES } from './examples.js';

const DEFAULT_MAX_NESTED_DEPTH = 3;
const MAX_UNWRAP_DEPTH = 10;

/** The label emitted for a construct this module does not understand. Never valid output. */
const UNKNOWN_TYPE = 'value';

/**
 * Peels every TRANSPARENT wrapper — `.strict().superRefine()`, optional, nullable, default,
 * lazy, branded, readonly, pipeline — down to the construct that decides the JSON shape.
 * A wrapper missing from this list silently hides the type it wraps.
 */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
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
    if (current instanceof z.ZodLazy) {
      current = current.schema as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodBranded || current instanceof z.ZodReadonly) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodPipeline) {
      current = current._def.out as z.ZodTypeAny;
      continue;
    }
    return current;
  }
  return current;
}

/** The object schema behind a field, or undefined when the field is not an object. */
function asObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> | undefined {
  const inner = unwrap(schema);
  return inner instanceof z.ZodObject ? inner : undefined;
}

export interface ContractFieldSummary {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

interface UnionVariant {
  /** Human label, e.g. `applicability = "APPLICABLE"` or `variant 2`. */
  readonly label: string;
  /** Path fragment that distinguishes this variant's nested shapes from its siblings'. */
  readonly pathSuffix: string;
  readonly schema: z.ZodTypeAny;
  readonly fields: readonly ContractFieldSummary[];
}

interface UnionDescription {
  readonly discriminator: string | undefined;
  readonly variants: readonly UnionVariant[];
}

/** The discriminator values a single variant accepts (a literal, or a multi-value enum). */
function discriminatorValuesOf(option: z.ZodTypeAny, discriminator: string): readonly string[] {
  const field = asObject(option)?.shape[discriminator];
  if (field === undefined) return [];
  const inner = unwrap(field);
  if (inner instanceof z.ZodLiteral) return [String(inner.value)];
  if (inner instanceof z.ZodEnum) return inner.options as string[];
  return [];
}

/**
 * Resolves `z.union` and `z.discriminatedUnion` into their variants. Both used to render as
 * a bare `object`, which is how a model was left to guess that `browserAcceptanceCriteria`
 * needed an `applicability` discriminator at all.
 */
function asUnion(schema: z.ZodTypeAny): UnionDescription | undefined {
  const inner = unwrap(schema);
  const isDiscriminated = inner instanceof z.ZodDiscriminatedUnion;
  if (!isDiscriminated && !(inner instanceof z.ZodUnion)) return undefined;
  const discriminator = isDiscriminated ? (inner.discriminator as string) : undefined;
  const options = inner.options as readonly z.ZodTypeAny[];
  const variants = options.map((option, index) => {
    const values = discriminator === undefined ? [] : discriminatorValuesOf(option, discriminator);
    const rendered = values.map((value) => JSON.stringify(value)).join(' | ');
    return {
      label:
        discriminator === undefined || rendered === ''
          ? `variant ${index + 1}`
          : `${discriminator} = ${rendered}`,
      pathSuffix:
        discriminator === undefined || values[0] === undefined
          ? `[${index + 1}]`
          : `[${discriminator}=${JSON.stringify(values[0])}]`,
      schema: option,
      fields: describeContractFields(option),
    };
  });
  return { discriminator, variants };
}

/** A short, model-readable type hint: `string`, `string[]`, `object[]`, `"LITERAL"`, … */
function describeType(field: z.ZodTypeAny): string {
  const current = unwrap(field);
  if (current instanceof z.ZodLiteral) return JSON.stringify(current.value);
  if (current instanceof z.ZodArray) {
    const element =
      containerOf(current.element) === undefined ? describeType(current.element) : 'object';
    return `${element}[]`;
  }
  if (current instanceof z.ZodString) return 'string';
  if (current instanceof z.ZodNumber) return 'number';
  if (current instanceof z.ZodBoolean) return 'boolean';
  if (current instanceof z.ZodEnum)
    return (current.options as string[]).map((option) => JSON.stringify(option)).join(' | ');
  const union = asUnion(current);
  if (union !== undefined) {
    return union.discriminator === undefined
      ? `object (EXACTLY ONE of ${union.variants.length} variants — see below)`
      : `object (EXACTLY ONE of the "${union.discriminator}" variants — see below)`;
  }
  if (current instanceof z.ZodRecord)
    return `{ [key: string]: ${describeType(current.valueSchema as z.ZodTypeAny)} }`;
  if (current instanceof z.ZodObject) return 'object';
  return UNKNOWN_TYPE;
}

/** Every TOP-LEVEL field of a contract schema, in declaration order. */
export function describeContractFields(schema: z.ZodTypeAny): readonly ContractFieldSummary[] {
  const object = asObject(schema);
  if (object === undefined) return [];
  return Object.entries(object.shape).map(([name, field]) => ({
    name,
    type: describeType(field as z.ZodTypeAny),
    required: !(field as z.ZodTypeAny).isOptional(),
  }));
}

/** The object/union schema behind a field, whether it is `X`, `X[]`, or a record of X. */
function containerOf(field: z.ZodTypeAny): z.ZodTypeAny | undefined {
  let current = unwrap(field);
  if (current instanceof z.ZodArray) current = unwrap(current.element);
  else if (current instanceof z.ZodRecord) current = unwrap(current.valueSchema as z.ZodTypeAny);
  return asObject(current) !== undefined || asUnion(current) !== undefined ? current : undefined;
}

type NestedShape =
  | {
      readonly kind: 'object';
      readonly path: string;
      readonly schema: z.ZodTypeAny;
      readonly fields: readonly ContractFieldSummary[];
    }
  | {
      readonly kind: 'union';
      readonly path: string;
      readonly discriminator: string | undefined;
      readonly variants: readonly UnionVariant[];
    };

/**
 * Nested shapes, breadth-first, deduplicated by path. A top-level-only description is what
 * let a model guess `batchIds` for `requirementCoverage[].batchPlanVersionIds` and invent
 * `notes` — the nested schemas are `.strict()` too, so they must be spelled out as well.
 * Union variants are expanded in place and each variant is walked in turn.
 */
function describeNestedShapes(schema: z.ZodTypeAny, maxDepth: number): readonly NestedShape[] {
  const out: NestedShape[] = [];
  const seen = new Set<string>();
  let frontier: { path: string; schema: z.ZodTypeAny }[] = [{ path: '', schema }];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: { path: string; schema: z.ZodTypeAny }[] = [];
    for (const entry of frontier) {
      const object = asObject(entry.schema);
      if (object === undefined) continue;
      for (const [name, rawField] of Object.entries(object.shape)) {
        const field = rawField as z.ZodTypeAny;
        const container = containerOf(field);
        if (container === undefined) continue;
        const isArray = describeType(field).endsWith('[]');
        const path = `${entry.path}${entry.path === '' ? '' : '.'}${name}${isArray ? '[]' : ''}`;
        if (seen.has(path)) continue;
        seen.add(path);
        const union = asUnion(container);
        if (union !== undefined) {
          if (union.variants.length === 0) continue;
          out.push({
            kind: 'union',
            path,
            discriminator: union.discriminator,
            variants: union.variants,
          });
          for (const variant of union.variants) {
            next.push({ path: `${path}${variant.pathSuffix}`, schema: variant.schema });
          }
          continue;
        }
        const fields = describeContractFields(container);
        if (fields.length === 0) continue;
        out.push({ kind: 'object', path, schema: container, fields });
        next.push({ path, schema: container });
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Every field this module could not describe: an unresolved construct, or a nested shape
 * that never got spelled out. Four paid runs were lost to exactly this class of silence —
 * the generator labelled something `object` and the model guessed the rest — so the test
 * suite asserts this is EMPTY for every contract an agent is asked to produce.
 */
export function findUndescribedContractPaths(
  schema: z.ZodTypeAny,
  options?: { readonly maxNestedDepth?: number },
): readonly string[] {
  const nested = describeNestedShapes(schema, options?.maxNestedDepth ?? DEFAULT_MAX_NESTED_DEPTH);
  const described = new Set(nested.map((shape) => shape.path));
  const problems: string[] = [];
  const inspect = (path: string, objectSchema: z.ZodTypeAny): void => {
    const object = asObject(objectSchema);
    if (object === undefined) return;
    for (const [name, rawField] of Object.entries(object.shape)) {
      const field = rawField as z.ZodTypeAny;
      const type = describeType(field);
      const childPath = `${path}${path === '' ? '' : '.'}${name}${type.endsWith('[]') ? '[]' : ''}`;
      if (type === UNKNOWN_TYPE) {
        problems.push(`${childPath}: unresolved schema construct`);
        continue;
      }
      // Deliberately keyed on the RENDERED label as well as the walker: the bug this guard
      // exists for was a construct that `describeType` labelled `object` while the walker
      // could not see into it, so trusting the walker alone would reproduce the silence.
      const looksLikeContainer =
        type === 'object' ||
        type === 'object[]' ||
        type.startsWith('object (') ||
        containerOf(field) !== undefined;
      if (looksLikeContainer && !described.has(childPath)) {
        problems.push(`${childPath}: "${type}" is never spelled out`);
      }
    }
  };
  inspect('', schema);
  for (const shape of nested) {
    if (shape.kind === 'object') {
      inspect(shape.path, shape.schema);
      continue;
    }
    for (const variant of shape.variants) {
      inspect(`${shape.path}${variant.pathSuffix}`, variant.schema);
    }
  }
  return problems;
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
  const describe = (fields: readonly ContractFieldSummary[], indent: string): string[] => [
    ...fields
      .filter((field) => field.required)
      .map((field) => `${indent}${field.name}: ${field.type}   (REQUIRED)`),
    ...fields
      .filter((field) => !field.required)
      .map((field) => `${indent}${field.name}: ${field.type}   (optional)`),
  ];
  const nested = describeNestedShapes(schema, options?.maxNestedDepth ?? DEFAULT_MAX_NESTED_DEPTH);
  const lines = [
    `Return EXACTLY one JSON object satisfying the ${contractKind} contract. These are its`,
    'authoritative TOP-LEVEL fields, spelled exactly as shown:',
    ...describe(describeContractFields(schema), '  '),
  ];
  if (nested.length > 0) {
    lines.push(
      '',
      'Nested objects — EVERY one of these is strict as well, so their field names must be',
      'exact and no extra keys may be added:',
    );
    for (const shape of nested) {
      if (shape.kind === 'object') {
        lines.push(`  ${shape.path}:`, ...describe(shape.fields, '    '));
        continue;
      }
      // A union is a CHOICE, and each branch has its own required fields. Saying only
      // "object" here is what cost a run: the model never learned the discriminator existed.
      lines.push(
        shape.discriminator === undefined
          ? `  ${shape.path} — include EXACTLY ONE of these variants:`
          : `  ${shape.path} — include EXACTLY ONE variant, chosen by "${shape.discriminator}":`,
      );
      for (const variant of shape.variants) {
        lines.push(`    when ${variant.label}:`, ...describe(variant.fields, '      '));
      }
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
    'Where a field is described as EXACTLY ONE variant, emit that variant’s fields and',
    'nothing else — mixing two variants, or omitting the discriminator, is a rejection.',
  );
  return lines.join('\n');
}
