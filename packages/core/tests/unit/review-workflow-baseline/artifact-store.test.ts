import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BaselineFindingArtifact,
  LocalBaselineArtifactStore,
  type ReviewWorkflowBaselineError,
} from '../../../src/review-workflow-baseline/index.js';

const EMPTY_ARTIFACT: BaselineFindingArtifact = {
  schemaVersion: 1,
  artifactKind: 'BASELINE_FINDINGS',
  findings: [],
};

describe('LocalBaselineArtifactStore', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createStore(): LocalBaselineArtifactStore {
    const directory = mkdtempSync(join(tmpdir(), 'codemoot-baseline-'));
    directories.push(directory);
    return new LocalBaselineArtifactStore(directory);
  }

  it('writes a private content-addressed normalized-finding artifact', () => {
    const stored = createStore().store('baseline-1', EMPTY_ARTIFACT);

    expect(stored.contentHash).toHaveLength(64);
    expect(JSON.parse(readFileSync(stored.location, 'utf8'))).toEqual(EMPTY_ARTIFACT);
    expect(statSync(stored.location).mode & 0o777).toBe(0o600);
  });

  it('is idempotent for the same artifact content', () => {
    const store = createStore();
    expect(store.store('baseline-1', EMPTY_ARTIFACT)).toEqual(
      store.store('baseline-1', EMPTY_ARTIFACT),
    );
  });

  it('rejects reuse of an artifact identity with different content', () => {
    const store = createStore();
    store.store('artifact-1', EMPTY_ARTIFACT);

    expect(() =>
      store.store('artifact-1', {
        ...EMPTY_ARTIFACT,
        artifactKind: 'CURRENT_FINDINGS',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ReviewWorkflowBaselineError>>({
        code: 'ARTIFACT_IMMUTABILITY_CONFLICT',
      }),
    );
  });
});
