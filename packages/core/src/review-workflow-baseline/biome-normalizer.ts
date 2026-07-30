import { z } from 'zod';
import { fingerprintFindings } from './normalizer.js';
import type {
  NormalizedToolFinding,
  ReviewWorkflowBaselineErrorCode,
  ToolFindingNormalizer,
} from './types.js';
import { ReviewWorkflowBaselineError } from './types.js';

const biomeSpanSchema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
const biomeDiagnosticSchema = z
  .object({
    category: z.string().nullable().optional(),
    severity: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    location: z
      .object({
        path: z
          .object({
            file: z.string(),
          })
          .passthrough()
          .nullable()
          .optional(),
        span: biomeSpanSchema.nullable().optional(),
        sourceCode: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const biomeJsonReportSchema = z
  .object({
    summary: z
      .object({
        diagnosticsNotPrinted: z.number().int().nonnegative().optional(),
      })
      .passthrough(),
    diagnostics: z.array(biomeDiagnosticSchema),
  })
  .passthrough();

export class BiomeJsonFindingNormalizer implements ToolFindingNormalizer {
  readonly toolName = 'biome';
  readonly normalizerId = 'biome-json';
  readonly normalizationSchemaVersion = 1;

  normalize(rawOutput: string): readonly NormalizedToolFinding[] {
    const report = parseReport(rawOutput);
    if ((report.summary.diagnosticsNotPrinted ?? 0) > 0) {
      fail(
        'NORMALIZATION_FAILED',
        'Biome omitted diagnostics; an incomplete report cannot be normalized as a baseline',
      );
    }

    return fingerprintFindings(
      report.diagnostics.map((diagnostic) => {
        const category = diagnostic.category ?? 'unknown';
        const rawMessage = diagnostic.description ?? category;
        const location = diagnostic.location;
        const sourceCode = location?.sourceCode ?? undefined;
        const start = location?.span?.[0];
        const end = location?.span?.[1];
        const startPosition =
          sourceCode === undefined || start === undefined
            ? undefined
            : positionAt(sourceCode, start);
        const endPosition =
          sourceCode === undefined || end === undefined ? undefined : positionAt(sourceCode, end);

        return {
          ruleId: category,
          repositoryRelativePath: location?.path?.file ?? '<repository>',
          message: rawMessage,
          severity: diagnostic.severity ?? 'unknown',
          category: category.split('/')[0] ?? category,
          ...(diagnostic.source === null || diagnostic.source === undefined
            ? {}
            : { structuralContext: diagnostic.source }),
          ...(startPosition === undefined
            ? {}
            : { line: startPosition.line, column: startPosition.column }),
          ...(endPosition === undefined
            ? {}
            : { endLine: endPosition.line, endColumn: endPosition.column }),
        };
      }),
    );
  }
}

function parseReport(rawOutput: string): z.infer<typeof biomeJsonReportSchema> {
  try {
    return biomeJsonReportSchema.parse(JSON.parse(rawOutput));
  } catch {
    fail('NORMALIZATION_FAILED', 'Biome output is not a complete JSON reporter document');
  }
}

function positionAt(
  sourceCode: string,
  byteOffset: number,
): {
  readonly line: number;
  readonly column: number;
} {
  const prefix = Buffer.from(sourceCode, 'utf8').subarray(0, byteOffset).toString('utf8');
  const lines = prefix.split('\n');
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function fail(code: ReviewWorkflowBaselineErrorCode, message: string): never {
  throw new ReviewWorkflowBaselineError(code, message);
}
