import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateArtifact } from '../lib/validators.mjs';
import { correctionReport, finalReview, finding, initialReview } from './helpers.mjs';

const snapshot = {
  headSha: 'head-sha',
  changedFiles: ['a.ts', 'b.ts'],
};
const initialPath = '.cowork/reviews/batch-3-initial-review.json';
const correctionPath = '.cowork/reports/batch-3-correction-report.json';
const context = {
  workflowId: 'workflow-test',
  batchId: 3,
  baseSha: 'base-sha',
  reviewedHeadSha: 'head-sha',
  changedFiles: snapshot.changedFiles,
  requiredAcceptanceCriteria: ['criterion-1'],
  mergeBlockingCriteria: ['explicit merge blocker'],
  approvedPlanPath: 'docs/plans/batch-03.md',
  sourceInitialReview: initialPath,
  sourceCorrectionReport: correctionPath,
  previousReviewedHeadSha: 'head-sha',
  originalBlockingFindingIds: ['B-001'],
};

function approvedReview(overrides = {}) {
  return initialReview(snapshot, { baseSha: 'base-sha', ...overrides });
}

function blockingReview(overrides = {}) {
  return approvedReview({ findings: [finding()], verdict: 'NEEDS_REVISION', ...overrides });
}

function expectInvalid(artifact, expectedType, pattern) {
  assert.throws(
    () => validateArtifact(artifact, context, expectedType),
    (error) => {
      assert.equal(error.code, 'ARTIFACT_INVALID');
      assert.match(JSON.stringify(error.details), pattern);
      return true;
    },
  );
}

describe('initial review completeness', () => {
  it('accepts one complete review of every changed file and criterion', () => {
    assert.equal(
      validateArtifact(approvedReview(), context, 'initialReview').type,
      'initialReview',
    );
  });

  it('rejects reviewComplete false', () => {
    expectInvalid(approvedReview({ reviewComplete: false }), 'initialReview', /exactly true/);
  });

  it('rejects a reference to a missing finding definition', () => {
    expectInvalid(
      approvedReview({ verification: { findingId: 'B-404' } }),
      'initialReview',
      /undefined finding/,
    );
  });

  it('rejects duplicate finding IDs', () => {
    expectInvalid(
      blockingReview({ findings: [finding(), finding()] }),
      'initialReview',
      /duplicates/,
    );
  });

  it('rejects incorrect finding counts', () => {
    expectInvalid(blockingReview({ blockingFindingCount: 0 }), 'initialReview', /must equal/);
  });

  it('rejects NEEDS_REVISION with zero blockers', () => {
    expectInvalid(approvedReview({ verdict: 'NEEDS_REVISION' }), 'initialReview', /requires/);
  });

  it('rejects APPROVED with a blocker', () => {
    expectInvalid(blockingReview({ verdict: 'APPROVED' }), 'initialReview', /zero blocking/);
  });

  it('rejects a missing changed file', () => {
    expectInvalid(approvedReview({ filesReviewed: ['a.ts'] }), 'initialReview', /b\.ts/);
  });

  it('rejects a missing acceptance criterion', () => {
    expectInvalid(
      approvedReview({ acceptanceCriteriaReviewed: [] }),
      'initialReview',
      /criterion-1/,
    );
  });

  it('rejects output claiming more findings will follow', () => {
    expectInvalid(
      approvedReview({ verification: { note: 'More findings will follow.' } }),
      'initialReview',
      /incremental output/,
    );
  });

  it('defers medium findings unless an approved merge blocker is cited', () => {
    expectInvalid(
      blockingReview({
        findings: [finding({ severity: 'MEDIUM', blocking: true })],
      }),
      'initialReview',
      /merge-blocking criterion/,
    );

    const medium = finding({
      severity: 'MEDIUM',
      blocking: true,
      mergeBlockingCriterion: 'explicit merge blocker',
    });
    assert.equal(
      validateArtifact(blockingReview({ findings: [medium] }), context, 'initialReview').type,
      'initialReview',
    );
  });

  it('rejects an agent attempt to authorise the next batch', () => {
    expectInvalid(approvedReview({ mayStartNextBatch: true }), 'initialReview', /controller-owned/);
  });
});

describe('correction report completeness', () => {
  function completeCorrection(overrides = {}) {
    return correctionReport(snapshot, initialPath, ['B-001'], {
      baseSha: 'base-sha',
      ...overrides,
    });
  }

  it('accepts every original blocker exactly once', () => {
    assert.equal(
      validateArtifact(completeCorrection(), context, 'correctionReport').type,
      'correctionReport',
    );
  });

  it('rejects a missing disposition', () => {
    expectInvalid(completeCorrection({ dispositions: [] }), 'correctionReport', /B-001/);
  });

  it('rejects a duplicate disposition', () => {
    const disposition = completeCorrection().dispositions[0];
    expectInvalid(
      completeCorrection({ dispositions: [disposition, disposition] }),
      'correctionReport',
      /duplicates/,
    );
  });

  it('rejects an unknown finding disposition', () => {
    const unknown = {
      ...completeCorrection().dispositions[0],
      findingId: 'B-999',
    };
    expectInvalid(
      completeCorrection({ dispositions: [unknown] }),
      'correctionReport',
      /original blocking/,
    );
  });

  it('rejects an incremental correction report', () => {
    expectInvalid(
      completeCorrection({ verification: { note: 'Remaining findings continue later' } }),
      'correctionReport',
      /incremental output/,
    );
  });
});

describe('bounded final re-review', () => {
  function completeFinal(overrides = {}) {
    return finalReview(snapshot, initialPath, correctionPath, ['B-001'], {
      baseSha: 'base-sha',
      previousReviewedHeadSha: 'head-sha',
      ...overrides,
    });
  }

  function regression(severity) {
    return finding({
      findingId: `R-${severity}`,
      severity,
      blocking: severity === 'CRITICAL' || severity === 'HIGH',
      introducedByCorrection: true,
      evidence: 'The correction changed this exact guard',
    });
  }

  it('accepts verification of every original blocker', () => {
    assert.equal(validateArtifact(completeFinal(), context, 'finalReview').type, 'finalReview');
  });

  for (const severity of ['CRITICAL', 'HIGH']) {
    it(`accepts a new ${severity} correction regression`, () => {
      const artifact = completeFinal({
        newRegressionFindings: [regression(severity)],
        verdict: 'HUMAN_DECISION_REQUIRED',
      });
      assert.equal(validateArtifact(artifact, context, 'finalReview').type, 'finalReview');
    });
  }

  for (const severity of ['MEDIUM', 'LOW', 'SUGGESTION']) {
    it(`rejects a new ${severity} final-review finding`, () => {
      expectInvalid(
        completeFinal({
          newRegressionFindings: [regression(severity)],
          verdict: 'HUMAN_DECISION_REQUIRED',
        }),
        'finalReview',
        /must be CRITICAL or HIGH/,
      );
    });
  }

  it('rejects NEEDS_REVISION as a final verdict', () => {
    expectInvalid(completeFinal({ verdict: 'NEEDS_REVISION' }), 'finalReview', /must be APPROVED/);
  });

  it('accepts unresolved material blockers only as HUMAN_DECISION_REQUIRED', () => {
    const unresolved = completeFinal({
      findingResults: [
        {
          ...completeFinal().findingResults[0],
          status: 'NOT_FIXED',
        },
      ],
      verdict: 'HUMAN_DECISION_REQUIRED',
    });
    assert.equal(validateArtifact(unresolved, context, 'finalReview').type, 'finalReview');
  });

  it('requires BLOCKED to represent verification that cannot proceed', () => {
    expectInvalid(completeFinal({ verdict: 'BLOCKED' }), 'finalReview', /CANNOT_VERIFY/);
  });
});

describe('implementation report', () => {
  const report = {
    schemaVersion: 1,
    workflowId: 'workflow-test',
    batchId: 3,
    reportComplete: true,
    approvedPlanPath: 'docs/plans/batch-03.md',
    baseSha: 'base-sha',
    resultingHeadSha: 'head-sha',
    filesChanged: ['a.ts', 'b.ts'],
    scopeCompliance: true,
    acceptanceCriteria: ['criterion-1'],
    verification: { commands: ['node --test'] },
    deferredWork: [],
    summary: 'The complete approved batch is implemented.',
  };

  it('accepts a complete whole-batch report', () => {
    assert.equal(
      validateArtifact(report, context, 'implementationReport').type,
      'implementationReport',
    );
  });

  it('rejects a partial progress report', () => {
    expectInvalid(
      { ...report, summary: 'Partial report; more work will follow' },
      'implementationReport',
      /incremental output/,
    );
  });
});
