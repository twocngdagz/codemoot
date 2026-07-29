import { ControllerError } from './errors.mjs';

const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'SUGGESTION']);
const INITIAL_VERDICTS = new Set(['APPROVED', 'NEEDS_REVISION', 'BLOCKED']);
const FINAL_VERDICTS = new Set(['APPROVED', 'HUMAN_DECISION_REQUIRED', 'BLOCKED']);
const DISPOSITIONS = new Set(['FIXED', 'NO_CHANGE_WITH_EVIDENCE', 'BLOCKED', 'SUPERSEDED']);
const FINAL_STATUSES = new Set([
  'FIXED_AND_VERIFIED',
  'ACCEPTED_NO_CHANGE',
  'NOT_FIXED',
  'REGRESSION_INTRODUCED',
  'CANNOT_VERIFY',
]);
const CLOSED_FINAL_STATUSES = new Set(['FIXED_AND_VERIFIED', 'ACCEPTED_NO_CHANGE']);
const CONTINUATION_PATTERNS = [
  /\bmore findings (?:will|to|may) follow\b/i,
  /\badditional findings (?:will|to|may) follow\b/i,
  /\bfindings? (?:continued|continues) (?:later|below|next)\b/i,
  /\bto be continued\b/i,
  /\bpartial (?:review|report|findings|dispositions)\b/i,
  /\bremaining findings\b/i,
];
const CONTROLLER_FIELDS = new Set([
  'nextPhase',
  'authorisedRole',
  'authorizedRole',
  'authorisedAgent',
  'authorizedAgent',
  'mayStartNextBatch',
  'nextBatch',
  'autoAdvance',
  'autoCommit',
  'autoPush',
]);
const TOP_LEVEL_CONTROLLER_FIELDS = new Set([
  'phase',
  'status',
  'nextAction',
  'commitMessage',
  'approvedCommitSha',
  'pushedCommitSha',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function push(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function requireObject(value, path, errors) {
  if (!isObject(value)) {
    push(errors, path, 'must be an object');
    return false;
  }
  return true;
}

function requireFields(value, fields, path, errors) {
  for (const field of fields) {
    if (!(field in value)) {
      push(errors, `${path}.${field}`, 'is required');
    }
  }
}

function requireString(value, path, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    push(errors, path, 'must be a non-empty string');
    return false;
  }
  return true;
}

function requireStringArray(value, path, errors) {
  if (!Array.isArray(value)) {
    push(errors, path, 'must be an array');
    return [];
  }
  value.forEach((item, index) => requireString(item, `${path}[${index}]`, errors));
  return value.filter((item) => typeof item === 'string');
}

function requireComplete(value, field, path, errors) {
  if (value[field] !== true) {
    push(errors, `${path}.${field}`, 'must be exactly true');
  }
}

function requireMatch(actual, expected, path, errors) {
  if (expected !== undefined && actual !== expected) {
    push(errors, path, `must equal controller value ${JSON.stringify(expected)}`);
  }
}

function validateIdentity(artifact, context, errors) {
  if (artifact.schemaVersion !== 1) {
    push(errors, '$.schemaVersion', 'must equal 1');
  }
  requireString(artifact.workflowId, '$.workflowId', errors);
  if (!Number.isInteger(artifact.batchId) || artifact.batchId <= 0) {
    push(errors, '$.batchId', 'must be a positive integer');
  }
  requireString(artifact.baseSha, '$.baseSha', errors);
  requireMatch(artifact.workflowId, context.workflowId, '$.workflowId', errors);
  requireMatch(artifact.batchId, context.batchId, '$.batchId', errors);
  requireMatch(artifact.baseSha, context.baseSha, '$.baseSha', errors);
}

function walk(value, visitor, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) {
    visitor(value, path, null);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    visitor(item, `${path}.${key}`, key);
    walk(item, visitor, `${path}.${key}`);
  }
}

function validateNoContinuationClaims(artifact, errors) {
  walk(artifact, (value, path) => {
    if (typeof value === 'string' && CONTINUATION_PATTERNS.some((pattern) => pattern.test(value))) {
      push(errors, path, 'must not indicate incomplete or incremental output');
    }
  });
}

function validateNoControllerAuthority(artifact, errors) {
  for (const key of TOP_LEVEL_CONTROLLER_FIELDS) {
    if (key in artifact) {
      push(errors, `$.${key}`, 'is controller-owned and may not appear in an agent artefact');
    }
  }
  walk(artifact, (_value, path, key) => {
    if (key && CONTROLLER_FIELDS.has(key)) {
      push(errors, path, 'is controller-owned and may not appear in an agent artefact');
    }
  });
}

function validateVerification(value, path, errors) {
  if (!Array.isArray(value) && !isObject(value)) {
    push(errors, path, 'must be an array or object');
    return;
  }
  if (
    (Array.isArray(value) && value.length === 0) ||
    (isObject(value) && Object.keys(value).length === 0)
  ) {
    push(errors, path, 'must contain verification evidence');
  }
}

function validateCoverage(actual, required, path, errors) {
  const actualSet = new Set(actual);
  for (const item of required ?? []) {
    if (!actualSet.has(item)) {
      push(errors, path, `is missing required value ${JSON.stringify(item)}`);
    }
  }
}

function validateUnique(values, path, errors) {
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      push(errors, `${path}[${index}]`, `duplicates ${JSON.stringify(value)}`);
    }
    seen.add(value);
  }
}

function findingRequiredFields() {
  return [
    'findingId',
    'severity',
    'category',
    'file',
    'location',
    'requirementOrInvariant',
    'observedImplementation',
    'impact',
    'requiredCorrection',
    'verificationRequired',
    'blocking',
  ];
}

function validateFinding(finding, path, context, errors, options = {}) {
  if (!requireObject(finding, path, errors)) {
    return;
  }
  requireFields(finding, findingRequiredFields(), path, errors);
  for (const field of findingRequiredFields().filter((field) => field !== 'blocking')) {
    requireString(finding[field], `${path}.${field}`, errors);
  }
  if (!SEVERITIES.has(finding.severity)) {
    push(errors, `${path}.severity`, 'must be CRITICAL, HIGH, MEDIUM, LOW, or SUGGESTION');
  }
  if (typeof finding.blocking !== 'boolean') {
    push(errors, `${path}.blocking`, 'must be a boolean');
  }

  if (finding.severity === 'CRITICAL' || finding.severity === 'HIGH') {
    if (finding.blocking !== true) {
      push(errors, `${path}.blocking`, `${finding.severity} findings block by default`);
    }
  } else if (finding.blocking === true) {
    const cited = finding.mergeBlockingCriterion;
    const isAllowedMedium =
      finding.severity === 'MEDIUM' &&
      typeof cited === 'string' &&
      (context.mergeBlockingCriteria ?? []).includes(cited);
    if (!isAllowedMedium) {
      push(
        errors,
        `${path}.blocking`,
        'MEDIUM/LOW/SUGGESTION findings are deferred unless an approved merge-blocking criterion is cited',
      );
    }
  }

  if (options.regression) {
    if (!['CRITICAL', 'HIGH'].includes(finding.severity)) {
      push(errors, `${path}.severity`, 'final-review regressions must be CRITICAL or HIGH');
    }
    if (finding.introducedByCorrection !== true) {
      push(errors, `${path}.introducedByCorrection`, 'must be exactly true');
    }
    if (
      !(
        (typeof finding.evidence === 'string' && finding.evidence.trim()) ||
        (isObject(finding.evidence) && Object.keys(finding.evidence).length > 0)
      )
    ) {
      push(
        errors,
        `${path}.evidence`,
        'must identify the correction that introduced the regression',
      );
    }
  }
}

function validateReferencedFindingIds(artifact, defined, errors) {
  walk(artifact, (value, path, key) => {
    if (key === 'findingId' && path.includes('.findings[')) {
      return;
    }
    if (key === 'findingId' && typeof value === 'string' && !defined.has(value)) {
      push(errors, path, `references undefined finding ${JSON.stringify(value)}`);
    }
    if (key && /findingIds$/i.test(key) && Array.isArray(value)) {
      value.forEach((findingId, index) => {
        if (typeof findingId === 'string' && !defined.has(findingId)) {
          push(
            errors,
            `${path}[${index}]`,
            `references undefined finding ${JSON.stringify(findingId)}`,
          );
        }
      });
    }
  });
}

function validateImplementationReport(artifact, context, errors) {
  requireFields(
    artifact,
    [
      'schemaVersion',
      'workflowId',
      'batchId',
      'reportComplete',
      'approvedPlanPath',
      'baseSha',
      'resultingHeadSha',
      'filesChanged',
      'scopeCompliance',
      'acceptanceCriteria',
      'verification',
      'deferredWork',
      'summary',
    ],
    '$',
    errors,
  );
  validateIdentity(artifact, context, errors);
  requireComplete(artifact, 'reportComplete', '$', errors);
  requireString(artifact.approvedPlanPath, '$.approvedPlanPath', errors);
  requireString(artifact.resultingHeadSha, '$.resultingHeadSha', errors);
  requireMatch(artifact.approvedPlanPath, context.approvedPlanPath, '$.approvedPlanPath', errors);
  requireMatch(artifact.resultingHeadSha, context.reviewedHeadSha, '$.resultingHeadSha', errors);
  const files = requireStringArray(artifact.filesChanged, '$.filesChanged', errors);
  const criteria = requireStringArray(artifact.acceptanceCriteria, '$.acceptanceCriteria', errors);
  validateCoverage(files, context.changedFiles, '$.filesChanged', errors);
  validateCoverage(criteria, context.requiredAcceptanceCriteria, '$.acceptanceCriteria', errors);
  if (typeof artifact.scopeCompliance !== 'boolean' && !isObject(artifact.scopeCompliance)) {
    push(errors, '$.scopeCompliance', 'must be a boolean or object');
  }
  validateVerification(artifact.verification, '$.verification', errors);
  if (!Array.isArray(artifact.deferredWork)) {
    push(errors, '$.deferredWork', 'must be an array');
  }
  requireString(artifact.summary, '$.summary', errors);
}

function validateInitialReview(artifact, context, errors) {
  requireFields(
    artifact,
    [
      'schemaVersion',
      'workflowId',
      'batchId',
      'reviewType',
      'reviewRound',
      'baseSha',
      'reviewedHeadSha',
      'filesReviewed',
      'acceptanceCriteriaReviewed',
      'verification',
      'scopeCompliant',
      'reviewComplete',
      'findings',
      'blockingFindingCount',
      'deferredFindingCount',
      'verdict',
    ],
    '$',
    errors,
  );
  validateIdentity(artifact, context, errors);
  requireMatch(artifact.reviewType, 'INITIAL', '$.reviewType', errors);
  requireMatch(artifact.reviewRound, 1, '$.reviewRound', errors);
  requireString(artifact.reviewedHeadSha, '$.reviewedHeadSha', errors);
  requireMatch(artifact.reviewedHeadSha, context.reviewedHeadSha, '$.reviewedHeadSha', errors);
  requireComplete(artifact, 'reviewComplete', '$', errors);
  const files = requireStringArray(artifact.filesReviewed, '$.filesReviewed', errors);
  const criteria = requireStringArray(
    artifact.acceptanceCriteriaReviewed,
    '$.acceptanceCriteriaReviewed',
    errors,
  );
  validateCoverage(files, context.changedFiles, '$.filesReviewed', errors);
  validateCoverage(
    criteria,
    context.requiredAcceptanceCriteria,
    '$.acceptanceCriteriaReviewed',
    errors,
  );
  validateVerification(artifact.verification, '$.verification', errors);
  if (typeof artifact.scopeCompliant !== 'boolean') {
    push(errors, '$.scopeCompliant', 'must be a boolean');
  }
  if (!Array.isArray(artifact.findings)) {
    push(errors, '$.findings', 'must be an array');
    return;
  }

  artifact.findings.forEach((finding, index) =>
    validateFinding(finding, `$.findings[${index}]`, context, errors),
  );
  const findingIds = artifact.findings.map((finding) => finding?.findingId);
  validateUnique(findingIds, '$.findings', errors);
  const defined = new Set(findingIds.filter((findingId) => typeof findingId === 'string'));
  validateReferencedFindingIds(artifact, defined, errors);

  const blockingCount = artifact.findings.filter((finding) => finding?.blocking === true).length;
  const deferredCount = artifact.findings.filter((finding) => finding?.blocking === false).length;
  requireMatch(artifact.blockingFindingCount, blockingCount, '$.blockingFindingCount', errors);
  requireMatch(artifact.deferredFindingCount, deferredCount, '$.deferredFindingCount', errors);
  if (!INITIAL_VERDICTS.has(artifact.verdict)) {
    push(errors, '$.verdict', 'must be APPROVED, NEEDS_REVISION, or BLOCKED');
  }
  if (artifact.verdict === 'NEEDS_REVISION' && blockingCount === 0) {
    push(errors, '$.verdict', 'NEEDS_REVISION requires at least one blocking finding');
  }
  if (artifact.verdict === 'APPROVED' && blockingCount !== 0) {
    push(errors, '$.verdict', 'APPROVED requires zero blocking findings');
  }
}

function validateCorrectionReport(artifact, context, errors) {
  requireFields(
    artifact,
    [
      'schemaVersion',
      'workflowId',
      'batchId',
      'correctionRound',
      'sourceReviewArtifact',
      'baseSha',
      'resultingHeadSha',
      'reviewComplete',
      'dispositions',
      'verification',
    ],
    '$',
    errors,
  );
  validateIdentity(artifact, context, errors);
  requireMatch(artifact.correctionRound, 1, '$.correctionRound', errors);
  requireString(artifact.sourceReviewArtifact, '$.sourceReviewArtifact', errors);
  requireString(artifact.resultingHeadSha, '$.resultingHeadSha', errors);
  requireMatch(
    artifact.sourceReviewArtifact,
    context.sourceInitialReview,
    '$.sourceReviewArtifact',
    errors,
  );
  requireMatch(artifact.resultingHeadSha, context.reviewedHeadSha, '$.resultingHeadSha', errors);
  requireComplete(artifact, 'reviewComplete', '$', errors);
  validateVerification(artifact.verification, '$.verification', errors);
  if (!Array.isArray(artifact.dispositions)) {
    push(errors, '$.dispositions', 'must be an array');
    return;
  }

  const required = new Set(context.originalBlockingFindingIds ?? []);
  const actual = [];
  artifact.dispositions.forEach((disposition, index) => {
    const path = `$.dispositions[${index}]`;
    if (!requireObject(disposition, path, errors)) {
      return;
    }
    requireFields(
      disposition,
      [
        'findingId',
        'disposition',
        'explanation',
        'filesChanged',
        'verificationPerformed',
        'evidence',
      ],
      path,
      errors,
    );
    requireString(disposition.findingId, `${path}.findingId`, errors);
    if (!DISPOSITIONS.has(disposition.disposition)) {
      push(
        errors,
        `${path}.disposition`,
        'must be FIXED, NO_CHANGE_WITH_EVIDENCE, BLOCKED, or SUPERSEDED',
      );
    }
    requireString(disposition.explanation, `${path}.explanation`, errors);
    requireStringArray(disposition.filesChanged, `${path}.filesChanged`, errors);
    validateVerification(
      disposition.verificationPerformed,
      `${path}.verificationPerformed`,
      errors,
    );
    if (
      !(
        (typeof disposition.evidence === 'string' && disposition.evidence.trim()) ||
        (isObject(disposition.evidence) && Object.keys(disposition.evidence).length > 0)
      )
    ) {
      push(errors, `${path}.evidence`, 'must be non-empty');
    }
    if (!required.has(disposition.findingId)) {
      push(errors, `${path}.findingId`, 'does not identify an original blocking finding');
    }
    actual.push(disposition.findingId);
  });
  validateUnique(actual, '$.dispositions', errors);
  validateCoverage(actual, [...required], '$.dispositions', errors);
}

function validateFinalReview(artifact, context, errors) {
  requireFields(
    artifact,
    [
      'schemaVersion',
      'workflowId',
      'batchId',
      'reviewType',
      'reviewRound',
      'sourceInitialReview',
      'sourceCorrectionReport',
      'baseSha',
      'previousReviewedHeadSha',
      'reviewedHeadSha',
      'reviewComplete',
      'findingResults',
      'newRegressionFindings',
      'verification',
      'verdict',
    ],
    '$',
    errors,
  );
  validateIdentity(artifact, context, errors);
  requireMatch(artifact.reviewType, 'FINAL', '$.reviewType', errors);
  requireMatch(artifact.reviewRound, 2, '$.reviewRound', errors);
  requireString(artifact.sourceInitialReview, '$.sourceInitialReview', errors);
  requireString(artifact.sourceCorrectionReport, '$.sourceCorrectionReport', errors);
  requireString(artifact.previousReviewedHeadSha, '$.previousReviewedHeadSha', errors);
  requireString(artifact.reviewedHeadSha, '$.reviewedHeadSha', errors);
  requireMatch(
    artifact.sourceInitialReview,
    context.sourceInitialReview,
    '$.sourceInitialReview',
    errors,
  );
  requireMatch(
    artifact.sourceCorrectionReport,
    context.sourceCorrectionReport,
    '$.sourceCorrectionReport',
    errors,
  );
  requireMatch(
    artifact.previousReviewedHeadSha,
    context.previousReviewedHeadSha,
    '$.previousReviewedHeadSha',
    errors,
  );
  requireMatch(artifact.reviewedHeadSha, context.reviewedHeadSha, '$.reviewedHeadSha', errors);
  requireComplete(artifact, 'reviewComplete', '$', errors);
  validateVerification(artifact.verification, '$.verification', errors);
  if (!FINAL_VERDICTS.has(artifact.verdict)) {
    push(errors, '$.verdict', 'must be APPROVED, HUMAN_DECISION_REQUIRED, or BLOCKED');
  }

  const required = new Set(context.originalBlockingFindingIds ?? []);
  const resultIds = [];
  if (!Array.isArray(artifact.findingResults)) {
    push(errors, '$.findingResults', 'must be an array');
  } else {
    artifact.findingResults.forEach((result, index) => {
      const path = `$.findingResults[${index}]`;
      if (!requireObject(result, path, errors)) {
        return;
      }
      requireFields(
        result,
        ['findingId', 'status', 'explanation', 'verificationPerformed', 'evidence'],
        path,
        errors,
      );
      requireString(result.findingId, `${path}.findingId`, errors);
      if (!required.has(result.findingId)) {
        push(errors, `${path}.findingId`, 'does not identify an original blocking finding');
      }
      if (!FINAL_STATUSES.has(result.status)) {
        push(errors, `${path}.status`, 'is not an allowed final verification status');
      }
      requireString(result.explanation, `${path}.explanation`, errors);
      validateVerification(result.verificationPerformed, `${path}.verificationPerformed`, errors);
      if (result.evidence === undefined || result.evidence === null) {
        push(errors, `${path}.evidence`, 'is required');
      } else if (
        (typeof result.evidence === 'string' && result.evidence.trim().length === 0) ||
        (isObject(result.evidence) && Object.keys(result.evidence).length === 0)
      ) {
        push(errors, `${path}.evidence`, 'must be non-empty');
      }
      resultIds.push(result.findingId);
    });
    validateUnique(resultIds, '$.findingResults', errors);
    validateCoverage(resultIds, [...required], '$.findingResults', errors);
  }

  if (!Array.isArray(artifact.newRegressionFindings)) {
    push(errors, '$.newRegressionFindings', 'must be an array');
  } else {
    artifact.newRegressionFindings.forEach((finding, index) =>
      validateFinding(finding, `$.newRegressionFindings[${index}]`, context, errors, {
        regression: true,
      }),
    );
    validateUnique(
      artifact.newRegressionFindings.map((finding) => finding?.findingId),
      '$.newRegressionFindings',
      errors,
    );
  }

  const results = Array.isArray(artifact.findingResults) ? artifact.findingResults : [];
  const regressions = Array.isArray(artifact.newRegressionFindings)
    ? artifact.newRegressionFindings
    : [];
  const allClosed = results.every((result) => CLOSED_FINAL_STATUSES.has(result?.status));
  const cannotVerify = results.some((result) => result?.status === 'CANNOT_VERIFY');
  const materialBlocker = !allClosed || regressions.length > 0;
  if (artifact.verdict === 'APPROVED' && materialBlocker) {
    push(errors, '$.verdict', 'APPROVED requires all original blockers closed and no regression');
  }
  if (artifact.verdict === 'HUMAN_DECISION_REQUIRED' && !materialBlocker) {
    push(errors, '$.verdict', 'HUMAN_DECISION_REQUIRED requires a remaining material blocker');
  }
  if (artifact.verdict === 'HUMAN_DECISION_REQUIRED' && cannotVerify) {
    push(errors, '$.verdict', 'CANNOT_VERIFY requires the BLOCKED verdict');
  }
  if (artifact.verdict === 'BLOCKED' && !cannotVerify) {
    push(errors, '$.verdict', 'BLOCKED requires at least one CANNOT_VERIFY result');
  }
}

export function detectArtifactType(artifact) {
  if (!isObject(artifact)) {
    throw new ControllerError('ARTIFACT_INVALID', 'Artefact must be a JSON object');
  }
  if (artifact.reviewType === 'INITIAL') {
    return 'initialReview';
  }
  if (artifact.reviewType === 'FINAL') {
    return 'finalReview';
  }
  if ('correctionRound' in artifact || 'sourceReviewArtifact' in artifact) {
    return 'correctionReport';
  }
  if ('approvedPlanPath' in artifact || 'reportComplete' in artifact) {
    return 'implementationReport';
  }
  throw new ControllerError('ARTIFACT_TYPE_UNKNOWN', 'Cannot detect artefact type');
}

export function validateArtifact(artifact, context = {}, expectedType = undefined) {
  const type = detectArtifactType(artifact);
  const errors = [];
  if (expectedType && type !== expectedType) {
    push(errors, '$', `expected ${expectedType}, received ${type}`);
  }
  validateNoContinuationClaims(artifact, errors);
  validateNoControllerAuthority(artifact, errors);

  if (type === 'implementationReport') {
    validateImplementationReport(artifact, context, errors);
  } else if (type === 'initialReview') {
    validateInitialReview(artifact, context, errors);
  } else if (type === 'correctionReport') {
    validateCorrectionReport(artifact, context, errors);
  } else {
    validateFinalReview(artifact, context, errors);
  }

  if (errors.length > 0) {
    throw new ControllerError(
      'ARTIFACT_INVALID',
      `Invalid ${type} artefact (${errors.length} error${errors.length === 1 ? '' : 's'})`,
      errors,
    );
  }
  return { type, artifact };
}

export function parseAndValidateArtifact(source, context = {}, expectedType = undefined) {
  let artifact;
  try {
    artifact = JSON.parse(source.trim());
  } catch {
    throw new ControllerError(
      'ARTIFACT_JSON_INVALID',
      'Agent output must be one raw JSON object with no prose or Markdown fences',
    );
  }
  return validateArtifact(artifact, context, expectedType);
}
