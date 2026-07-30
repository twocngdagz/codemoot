import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  StoredVerificationLog,
  VerificationLogContent,
  VerificationLogStore,
} from './types.js';
import { ReviewWorkflowVerificationError } from './types.js';

function serializeLog(content: VerificationLogContent): string {
  return `${JSON.stringify(content, null, 2)}\n`;
}

export class LocalVerificationLogStore implements VerificationLogStore {
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  store(verificationRecordId: string, content: VerificationLogContent): StoredVerificationLog {
    mkdirSync(this.rootDirectory, { recursive: true, mode: 0o700 });
    const serialized = serializeLog(content);
    const contentHash = createHash('sha256').update(serialized).digest('hex');
    const filename = `${createHash('sha256').update(verificationRecordId).digest('hex')}.json`;
    const location = resolve(this.rootDirectory, filename);

    try {
      writeFileSync(location, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      const existing = readFileSync(location, 'utf8');
      if (existing !== serialized) {
        throw new ReviewWorkflowVerificationError(
          'LOG_IMMUTABILITY_CONFLICT',
          `Verification log ${verificationRecordId} already exists with different content`,
        );
      }
    }

    return { location, contentHash };
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
