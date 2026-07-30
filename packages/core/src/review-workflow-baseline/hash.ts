import { createHash } from 'node:crypto';
import { canonicalVerificationJson } from '../review-workflow-verification/hash.js';

export function hashBaselineValue(value: unknown): string {
  return createHash('sha256').update(canonicalVerificationJson(value)).digest('hex');
}
