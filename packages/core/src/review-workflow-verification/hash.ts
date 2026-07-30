import { createHash } from 'node:crypto';
import type { VerificationRecord } from '../review-workflow/types.js';

export function canonicalVerificationJson(value: unknown): string {
  return JSON.stringify(sortCanonicalValue(value));
}

export function hashVerificationRecord(record: VerificationRecord): string {
  return createHash('sha256').update(canonicalVerificationJson(record)).digest('hex');
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, sortCanonicalValue(nested)]),
    );
  }
  return value;
}
