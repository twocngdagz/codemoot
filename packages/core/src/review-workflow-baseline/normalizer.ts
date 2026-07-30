import { createHash } from 'node:crypto';
import { canonicalVerificationJson } from '../review-workflow-verification/hash.js';
import { normalizedToolFindingSchema } from './schemas.js';
import type { NormalizedToolFinding } from './types.js';

export interface UnfingerprintedToolFinding {
  readonly ruleId: string;
  readonly repositoryRelativePath: string;
  readonly message: string;
  readonly severity: string;
  readonly category: string;
  readonly symbol?: string;
  readonly structuralContext?: string;
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

export interface FindingSetDifference {
  readonly introduced: readonly NormalizedToolFinding[];
  readonly resolved: readonly NormalizedToolFinding[];
  readonly unchanged: readonly NormalizedToolFinding[];
}

export function normalizeMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ');
}

export function normalizeRepositoryRelativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`Finding path is not repository-relative: ${path}`);
  }
  return normalized;
}

export function fingerprintFindings(
  findings: readonly UnfingerprintedToolFinding[],
): readonly NormalizedToolFinding[] {
  const prepared = findings.map((finding) => {
    const repositoryRelativePath = normalizeRepositoryRelativePath(finding.repositoryRelativePath);
    const normalizedMessage = normalizeMessage(finding.message);
    const identity = {
      ruleId: finding.ruleId,
      repositoryRelativePath,
      normalizedMessage,
      severity: finding.severity,
      category: finding.category,
      ...(finding.symbol === undefined ? {} : { symbol: finding.symbol }),
      ...(finding.structuralContext === undefined
        ? {}
        : { structuralContext: finding.structuralContext }),
    };
    return {
      identity,
      finding,
      baseFingerprint: sha256(identity),
      repositoryRelativePath,
      normalizedMessage,
    };
  });

  prepared.sort((left, right) => {
    const keys = [
      left.baseFingerprint.localeCompare(right.baseFingerprint),
      (left.finding.line ?? 0) - (right.finding.line ?? 0),
      (left.finding.column ?? 0) - (right.finding.column ?? 0),
      left.finding.message.localeCompare(right.finding.message),
    ];
    return keys.find((value) => value !== 0) ?? 0;
  });

  const occurrences = new Map<string, number>();
  return prepared.map(({ identity, finding, baseFingerprint, ...normalized }) => {
    const occurrenceIndex = (occurrences.get(baseFingerprint) ?? 0) + 1;
    occurrences.set(baseFingerprint, occurrenceIndex);
    return normalizedToolFindingSchema.parse({
      fingerprint: sha256({ ...identity, occurrenceIndex }),
      ...identity,
      rawMessage: finding.message,
      occurrenceIndex,
      ...(finding.line === undefined ? {} : { line: finding.line }),
      ...(finding.column === undefined ? {} : { column: finding.column }),
      ...(finding.endLine === undefined ? {} : { endLine: finding.endLine }),
      ...(finding.endColumn === undefined ? {} : { endColumn: finding.endColumn }),
      ...normalized,
    });
  });
}

export function compareFindingSets(
  baseline: readonly NormalizedToolFinding[],
  current: readonly NormalizedToolFinding[],
): FindingSetDifference {
  const baselineByFingerprint = new Map(baseline.map((finding) => [finding.fingerprint, finding]));
  const currentByFingerprint = new Map(current.map((finding) => [finding.fingerprint, finding]));

  return {
    introduced: current.filter((finding) => !baselineByFingerprint.has(finding.fingerprint)),
    resolved: baseline.filter((finding) => !currentByFingerprint.has(finding.fingerprint)),
    unchanged: current.filter((finding) => baselineByFingerprint.has(finding.fingerprint)),
  };
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalVerificationJson(value)).digest('hex');
}
