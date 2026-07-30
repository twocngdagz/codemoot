import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalVerificationJson } from '../review-workflow-verification/hash.js';
import { baselineFindingArtifactSchema } from './schemas.js';
import type {
  BaselineArtifactStore,
  BaselineFindingArtifact,
  StoredBaselineArtifact,
  VerificationLogArtifactReader,
} from './types.js';
import { ReviewWorkflowBaselineError } from './types.js';

export class LocalBaselineArtifactStore implements BaselineArtifactStore {
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  store(artifactId: string, input: BaselineFindingArtifact): StoredBaselineArtifact {
    const artifact = baselineFindingArtifactSchema.parse(input);
    mkdirSync(this.rootDirectory, { recursive: true, mode: 0o700 });
    const serialized = `${canonicalVerificationJson(artifact)}\n`;
    const contentHash = createHash('sha256').update(serialized).digest('hex');
    const filename = `${createHash('sha256').update(artifactId).digest('hex')}.json`;
    const location = resolve(this.rootDirectory, filename);

    try {
      writeFileSync(location, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (readFileSync(location, 'utf8') !== serialized) {
        throw new ReviewWorkflowBaselineError(
          'ARTIFACT_IMMUTABILITY_CONFLICT',
          `Baseline artifact ${artifactId} already exists with different content`,
        );
      }
    }
    return { location, contentHash };
  }
}

export class LocalVerificationLogArtifactReader implements VerificationLogArtifactReader {
  read(location: string): string {
    return readFileSync(resolve(location), 'utf8');
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
