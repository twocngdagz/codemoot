import { describe, expect, it } from 'vitest';
import {
  BiomeJsonFindingNormalizer,
  type ReviewWorkflowBaselineError,
  compareFindingSets,
  fingerprintFindings,
} from '../../../src/review-workflow-baseline/index.js';

function report(
  diagnostics: readonly {
    readonly category: string;
    readonly description: string;
    readonly file: string;
    readonly severity?: string;
    readonly span?: readonly [number, number];
    readonly sourceCode?: string;
  }[],
  diagnosticsNotPrinted = 0,
): string {
  return JSON.stringify({
    summary: {
      changed: 0,
      unchanged: 1,
      matches: 0,
      duration: { secs: 0, nanos: 1 },
      errors: diagnostics.length,
      warnings: 0,
      skipped: 0,
      suggestedFixesSkipped: 0,
      diagnosticsNotPrinted,
    },
    diagnostics: diagnostics.map((diagnostic) => ({
      category: diagnostic.category,
      severity: diagnostic.severity ?? 'error',
      description: diagnostic.description,
      message: [],
      advices: { advices: [] },
      location: {
        path: { file: diagnostic.file },
        span: diagnostic.span ?? null,
        sourceCode: diagnostic.sourceCode ?? null,
      },
      tags: [],
      source: null,
    })),
    command: 'check',
  });
}

describe('BiomeJsonFindingNormalizer', () => {
  const normalizer = new BiomeJsonFindingNormalizer();

  it('normalizes Biome JSON findings into stable repository-relative fingerprints', () => {
    const findings = normalizer.normalize(
      report([
        {
          category: 'lint/style/useTemplate',
          description: 'Template literals are preferred over string concatenation.',
          file: './packages/core/src/example.ts',
          span: [6, 11],
          sourceCode: 'first\nvalue here\n',
        },
      ]),
    );

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'lint/style/useTemplate',
        category: 'lint',
        repositoryRelativePath: 'packages/core/src/example.ts',
        normalizedMessage: 'Template literals are preferred over string concatenation.',
        line: 2,
        column: 1,
        occurrenceIndex: 1,
      }),
    ]);
    expect(findings[0]?.fingerprint).toHaveLength(64);
  });

  it('does not use source line numbers as the sole finding identity', () => {
    const first = normalizer.normalize(
      report([
        {
          category: 'lint/suspicious/noExplicitAny',
          description: 'Unexpected any.',
          file: 'packages/core/src/example.ts',
          span: [0, 1],
          sourceCode: 'x',
        },
      ]),
    );
    const moved = normalizer.normalize(
      report([
        {
          category: 'lint/suspicious/noExplicitAny',
          description: 'Unexpected   any.',
          file: 'packages/core/src/example.ts',
          span: [4, 5],
          sourceCode: '\n\n\nx',
        },
      ]),
    );

    expect(moved[0]?.line).not.toBe(first[0]?.line);
    expect(moved[0]?.fingerprint).toBe(first[0]?.fingerprint);
  });

  it('uses occurrence indexes to preserve duplicate finding multiplicity', () => {
    const duplicates = fingerprintFindings([
      {
        ruleId: 'format',
        repositoryRelativePath: 'src/a.ts',
        message: 'Formatter output differs.',
        severity: 'error',
        category: 'format',
        line: 1,
      },
      {
        ruleId: 'format',
        repositoryRelativePath: 'src/a.ts',
        message: 'Formatter output differs.',
        severity: 'error',
        category: 'format',
        line: 9,
      },
    ]);

    expect(duplicates.map((finding) => finding.occurrenceIndex)).toEqual([1, 2]);
    expect(new Set(duplicates.map((finding) => finding.fingerprint)).size).toBe(2);
    expect(compareFindingSets(duplicates.slice(0, 1), duplicates).introduced).toHaveLength(1);
  });

  it('fails closed when Biome reports omitted diagnostics', () => {
    expect(() => normalizer.normalize(report([], 1))).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowBaselineError>>({
        code: 'NORMALIZATION_FAILED',
      }),
    );
  });

  it('rejects prose-wrapped, malformed, or traversal-path reports', () => {
    expect(() => normalizer.normalize(`result:\n${report([])}`)).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowBaselineError>>({
        code: 'NORMALIZATION_FAILED',
      }),
    );
    expect(() =>
      normalizer.normalize(
        report([
          {
            category: 'format',
            description: 'Formatter output differs.',
            file: '../outside.ts',
          },
        ]),
      ),
    ).toThrow('repository-relative');
  });

  it('detects a same-count replacement as one introduced and one resolved finding', () => {
    const baseline = normalizer.normalize(
      report([
        {
          category: 'lint/style/useTemplate',
          description: 'Use a template.',
          file: 'src/a.ts',
        },
      ]),
    );
    const current = normalizer.normalize(
      report([
        {
          category: 'lint/suspicious/noExplicitAny',
          description: 'Unexpected any.',
          file: 'src/b.ts',
        },
      ]),
    );

    expect(compareFindingSets(baseline, current)).toMatchObject({
      introduced: [expect.objectContaining({ ruleId: 'lint/suspicious/noExplicitAny' })],
      resolved: [expect.objectContaining({ ruleId: 'lint/style/useTemplate' })],
      unchanged: [],
    });
  });
});
