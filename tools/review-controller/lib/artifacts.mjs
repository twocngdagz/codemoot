import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ControllerError } from './errors.mjs';
import { readJson } from './state.mjs';

const PHASE_ARTIFACTS = Object.freeze({
  IMPLEMENT: {
    type: 'implementationReport',
    stateKey: 'implementationReport',
    directoryKey: 'reportDirectory',
    suffix: 'implementation-report',
    schema: 'implementation-report.schema.json',
  },
  REVIEW_INITIAL: {
    type: 'initialReview',
    stateKey: 'initialReview',
    directoryKey: 'artifactDirectory',
    suffix: 'initial-review',
    schema: 'initial-review.schema.json',
  },
  FIX_BLOCKING_FINDINGS: {
    type: 'correctionReport',
    stateKey: 'correctionReport',
    directoryKey: 'reportDirectory',
    suffix: 'correction-report',
    schema: 'correction-report.schema.json',
  },
  REVIEW_FINAL: {
    type: 'finalReview',
    stateKey: 'finalReview',
    directoryKey: 'artifactDirectory',
    suffix: 'final-review',
    schema: 'final-review.schema.json',
  },
});
const SCHEMA_ROOT = fileURLToPath(new URL('../schemas/', import.meta.url));

export function artifactDefinitionForPhase(phase) {
  const definition = PHASE_ARTIFACTS[phase];
  if (!definition) {
    throw new ControllerError('NO_AGENT_ACTION', `Phase ${phase} has no agent artefact`);
  }
  return definition;
}

export function artifactPathsForPhase(config, state) {
  const definition = artifactDefinitionForPhase(state.phase);
  const filename = `batch-${state.activeBatch}-${definition.suffix}.json`;
  const absolutePath = join(config[definition.directoryKey], filename);
  return {
    ...definition,
    absolutePath,
    statePath: relative(config.repositoryRoot, absolutePath),
    schemaPath: join(SCHEMA_ROOT, definition.schema),
  };
}

export function resolveStatePath(repositoryRoot, path) {
  return isAbsolute(path) ? path : resolve(repositoryRoot, path);
}

async function referencedArtifact(config, state, key) {
  const path = state.artifacts[key];
  if (!path) {
    throw new ControllerError('PRIOR_ARTIFACT_MISSING', `State does not reference ${key}`);
  }
  return readJson(resolveStatePath(config.repositoryRoot, path));
}

export async function validationContext(config, state, snapshot) {
  const context = {
    workflowId: state.workflowId,
    batchId: state.activeBatch,
    baseSha: state.baseSha,
    approvedPlanPath: state.batchPlanPath,
    reviewedHeadSha: snapshot.headSha,
    changedFiles: snapshot.changedFiles,
    requiredAcceptanceCriteria: state.requiredAcceptanceCriteria ?? [],
    mergeBlockingCriteria: state.mergeBlockingCriteria ?? [],
  };

  if (state.phase === 'FIX_BLOCKING_FINDINGS' || state.phase === 'REVIEW_FINAL') {
    const initialReview = await referencedArtifact(config, state, 'initialReview');
    context.sourceInitialReview = state.artifacts.initialReview;
    context.originalBlockingFindingIds = initialReview.findings
      .filter((finding) => finding.blocking)
      .map((finding) => finding.findingId);
    context.previousReviewedHeadSha = initialReview.reviewedHeadSha;
  }
  if (state.phase === 'REVIEW_FINAL') {
    await referencedArtifact(config, state, 'correctionReport');
    context.sourceCorrectionReport = state.artifacts.correctionReport;
  }
  return context;
}
