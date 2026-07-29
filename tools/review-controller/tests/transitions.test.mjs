import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { enterPhase, initialiseNextBatch, transitionWithArtifact } from '../lib/transitions.mjs';
import { finding, workflowState } from './helpers.mjs';

const baseSha = 'a'.repeat(40);
const initialPath = '.cowork/reviews/batch-3-initial-review.json';
const correctionPath = '.cowork/reports/batch-3-correction-report.json';

describe('bounded transition model', () => {
  it('moves a valid implementation report to initial review', () => {
    const state = workflowState(baseSha, { phase: 'IMPLEMENT' });
    const next = transitionWithArtifact(
      state,
      'implementationReport',
      { resultingHeadSha: baseSha },
      '.cowork/reports/implementation.json',
    );
    assert.equal(next.phase, 'REVIEW_INITIAL');
    assert.equal(next.authorisedRole, 'REVIEWER');
    assert.equal(next.authorisedAgent, 'claude');
  });

  it('moves an approved initial review directly to READY_TO_COMMIT', () => {
    const state = workflowState(baseSha);
    const next = transitionWithArtifact(
      state,
      'initialReview',
      { findings: [], verdict: 'APPROVED', reviewedHeadSha: baseSha },
      initialPath,
    );
    assert.equal(next.phase, 'READY_TO_COMMIT');
    assert.equal(next.authorisedRole, 'CONTROLLER');
  });

  it('delivers all initial blockers together to the one correction phase', () => {
    const state = workflowState(baseSha);
    const findings = [finding({ findingId: 'B-001' }), finding({ findingId: 'B-002' })];
    const next = transitionWithArtifact(
      state,
      'initialReview',
      { findings, verdict: 'NEEDS_REVISION', reviewedHeadSha: baseSha },
      initialPath,
    );
    assert.equal(next.phase, 'FIX_BLOCKING_FINDINGS');
    assert.deepEqual(next.openBlockingFindingIds, ['B-001', 'B-002']);
  });

  it('allows one correction and enters one final review', () => {
    const state = workflowState(baseSha, {
      phase: 'FIX_BLOCKING_FINDINGS',
      artifacts: {
        implementationReport: 'implementation.json',
        initialReview: initialPath,
        correctionReport: null,
        finalReview: null,
      },
    });
    const next = transitionWithArtifact(
      state,
      'correctionReport',
      { dispositions: [] },
      correctionPath,
    );
    assert.equal(next.phase, 'REVIEW_FINAL');
    assert.equal(next.correctionRound, 1);
  });

  it('has no second correction transition', () => {
    const state = workflowState(baseSha, {
      phase: 'FIX_BLOCKING_FINDINGS',
      correctionRound: 1,
    });
    assert.throws(
      () => transitionWithArtifact(state, 'correctionReport', {}, correctionPath),
      (error) => error.code === 'CORRECTION_LIMIT_REACHED',
    );
  });

  it('has no third reviewer transition', () => {
    const state = workflowState(baseSha, {
      phase: 'REVIEW_FINAL',
      reviewRound: 2,
    });
    assert.throws(
      () =>
        transitionWithArtifact(
          state,
          'finalReview',
          { verdict: 'APPROVED', reviewedHeadSha: baseSha },
          '.cowork/reviews/final.json',
        ),
      (error) => error.code === 'FINAL_REVIEW_LIMIT_REACHED',
    );
  });

  it('routes unresolved final blockers to human decision with no correction loop', () => {
    const state = workflowState(baseSha, {
      phase: 'REVIEW_FINAL',
      reviewRound: 1,
    });
    const next = transitionWithArtifact(
      state,
      'finalReview',
      { verdict: 'HUMAN_DECISION_REQUIRED', reviewedHeadSha: baseSha },
      '.cowork/reviews/final.json',
    );
    assert.equal(next.phase, 'HUMAN_DECISION_REQUIRED');
    assert.equal(next.nextAction, 'AWAIT_HUMAN_DECISION');
  });

  it('prevents a next batch from starting before current closure', () => {
    const state = enterPhase(workflowState(baseSha), 'READY_TO_COMMIT');
    assert.throws(
      () => initialiseNextBatch(state, { batchId: 4, planPath: 'docs/plans/batch-04.md' }, baseSha),
      (error) => error.code === 'TRANSITION_NOT_ALLOWED',
    );
  });

  it('initialises only an approved queued batch from ADVANCE_BATCH', () => {
    const state = enterPhase(workflowState(baseSha), 'ADVANCE_BATCH');
    const next = initialiseNextBatch(
      state,
      {
        batchId: 4,
        planPath: 'docs/plans/batch-04.md',
        acceptanceCriteria: ['batch-4-criterion'],
      },
      baseSha,
    );
    assert.equal(next.phase, 'IMPLEMENT');
    assert.equal(next.activeBatch, 4);
    assert.deepEqual(next.requiredAcceptanceCriteria, ['batch-4-criterion']);
  });
});
