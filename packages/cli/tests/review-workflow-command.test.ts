import type { reviewWorkflow } from '@codemoot/core';
import { describe, expect, it } from 'vitest';
import {
  buildFinalAuditPrompt,
  buildImplementationPreflightPrompt,
  buildImplementationPrompt,
  buildImplementationResumePrompt,
  buildPlanReviewPrompt,
  buildRefinementPrompt,
  deriveVerificationAttestationPolicy,
  deriveVerifyCommandId,
  resolvePlanVerificationCommand,
} from '../src/commands/review-workflow.js';

const PLAN_FIXTURE: reviewWorkflow.BatchPlanVersion = {
  batchPlanVersionId: 'workflow-1:batch:12:plan:1',
  workflowId: 'workflow-1',
  batchId: 'workflow-1:batch:12',
  version: 1,
  contentHash: 'plan-content-hash',
  repositoryContextSha: 'a'.repeat(40),
  objective: 'Implement and gate the approved batch.',
  currentRepositoryEvidence: [
    { kind: 'FILE', location: 'src/example.txt', description: 'Current target.' },
  ],
  dependencies: [],
  candidateFiles: ['src/example.txt'],
  technicalImplementation: ['Update the target.'],
  userJourney: ['The operator runs the merge gate.'],
  expectedBehaviour: ['The batch merges only through the gate.'],
  technicalAcceptanceCriteria: ['criterion-required'],
  userFacingAcceptanceCriteria: [],
  cliAcceptanceCriteria: [],
  browserAcceptanceCriteria: { applicability: 'NOT_APPLICABLE', reason: 'No browser behavior.' },
  verificationCommands: [
    {
      executable: 'pnpm',
      arguments: ['test'],
      workingDirectory: '.',
      verificationType: 'test',
      relatedCriterionIds: ['criterion-required', 'criterion-manual'],
    },
  ],
  manualVerification: [],
  documentationChanges: [],
  outOfScope: ['Merge automation.'],
  rollbackBoundary: 'Revert the implementation commit.',
  addressedFindingIds: [],
  actorExecutionId: 'plan-author',
  createdAt: '2026-07-30T12:00:00.000Z',
};

const RECORD_FIXTURE: reviewWorkflow.VerificationRecord = {
  verificationRecordId: 'record-1',
  command: 'pnpm',
  arguments: ['test'],
  workingDirectory: '.',
  startedAt: '2026-07-30T12:00:00.000Z',
  finishedAt: '2026-07-30T12:01:00.000Z',
  outcome: { kind: 'EXITED', exitCode: 0 },
  outputSummary: 'All checks passed.',
  fullLogLocation: 'memory://verification/log',
  fullLogHash: 'b'.repeat(64),
  relatedCriterionIds: ['criterion-required', 'criterion-manual'],
  relatedFindingIds: [],
  commitSha: 'c'.repeat(40),
  executorActorExecutionId: 'executor-1',
  executorActorType: 'HUMAN',
  verificationType: 'test',
  toolVersion: 'echoed-from-record-9.9.9',
  configurationHash: 'echoed-configuration-hash',
  observedStatus: 'SUCCEEDED',
};

const CRITERIA_FIXTURE: readonly reviewWorkflow.AcceptanceCriterion[] = [
  {
    acceptanceCriterionId: 'criterion-required',
    batchPlanVersionId: PLAN_FIXTURE.batchPlanVersionId,
    kind: 'TECHNICAL',
    statement: 'The technical criterion holds.',
    required: true,
    passCondition: 'Verified by an accepted record.',
    status: 'PENDING',
    sourceRequirementIds: [],
    createdAt: '2026-07-30T12:00:00.000Z',
  },
  {
    acceptanceCriterionId: 'criterion-manual',
    batchPlanVersionId: PLAN_FIXTURE.batchPlanVersionId,
    kind: 'MANUAL',
    statement: 'The manual behaviour is confirmed.',
    required: true,
    passCondition: 'Confirmed independently.',
    status: 'PENDING',
    sourceRequirementIds: [],
    createdAt: '2026-07-30T12:00:00.000Z',
  },
];

describe('review workflow gate CLI behavior', () => {
  it('derives a stable verify command identity so a retry replays instead of re-running', () => {
    expect(deriveVerifyCommandId('workflow-1:batch:12', 1)).toBe('workflow-1:batch:12:verify:1');
    expect(deriveVerifyCommandId('workflow-1:batch:12', 1)).toBe(
      deriveVerifyCommandId('workflow-1:batch:12', 1),
    );
  });

  it('resolves verification commands only from the approved plan', () => {
    const command = resolvePlanVerificationCommand(PLAN_FIXTURE, 1);
    expect(command.executable).toBe('pnpm');
    expect(() => resolvePlanVerificationCommand(PLAN_FIXTURE, 2)).toThrowError(
      /has no verification command 2/,
    );
  });

  it('derives the attestation policy from authoritative sources, never record echoes', () => {
    const policy = deriveVerificationAttestationPolicy({
      plan: PLAN_FIXTURE,
      criteria: CRITERIA_FIXTURE,
      record: RECORD_FIXTURE,
      approvedReviewedCommitSha: 'd'.repeat(40),
      configurationHash: 'authoritative-configuration-hash',
    });
    // The pinned commit is the approved review target, not the record's own commit echo.
    expect(policy.expectedCommitSha).toBe('d'.repeat(40));
    expect(policy.expectedCommitSha).not.toBe(RECORD_FIXTURE.commitSha);
    // The configuration hash is the freshly derived one, not the record's echo.
    expect(policy.expectedVerificationConfigurationHash).toBe('authoritative-configuration-hash');
    expect(policy.expectedVerificationConfigurationHash).not.toBe(RECORD_FIXTURE.configurationHash);
    // The approved command comes from the plan, and criterion policies follow criterion kinds.
    expect(policy.approvedCommand).toBe(PLAN_FIXTURE.verificationCommands[0]);
    expect(policy.criterionPolicies).toEqual([
      {
        criterionId: 'criterion-required',
        allowsAutomaticAcceptance: true,
        requiresIndependentAttestation: false,
      },
      {
        criterionId: 'criterion-manual',
        allowsAutomaticAcceptance: false,
        requiresIndependentAttestation: true,
      },
    ]);
  });

  it('denies automatic acceptance whenever the policy facts have no durable evidence', () => {
    const policy = deriveVerificationAttestationPolicy({
      plan: PLAN_FIXTURE,
      criteria: CRITERIA_FIXTURE,
      record: RECORD_FIXTURE,
      approvedReviewedCommitSha: 'd'.repeat(40),
      configurationHash: 'authoritative-configuration-hash',
    });
    // No durable evidence source captures tool versions, so the pin can never match a
    // record's operator-supplied value — even one crafted to collide with the sentinel is
    // still denied by the unconditional judgment requirement below.
    expect(policy.expectedToolVersion).toBe('UNPROVEN:tool-version-has-no-durable-evidence-source');
    expect(policy.expectedToolVersion).not.toBe(RECORD_FIXTURE.toolVersion);
    expect(policy.parserAmbiguityRequiresJudgment).toBe(true);
    // Baseline comparison derives from the approved command's verification type.
    expect(policy.baselineComparison).toBe(false);
    const lintPolicy = deriveVerificationAttestationPolicy({
      plan: {
        ...PLAN_FIXTURE,
        verificationCommands: [
          { ...PLAN_FIXTURE.verificationCommands[0], verificationType: 'lint' },
        ],
      },
      criteria: CRITERIA_FIXTURE,
      record: { ...RECORD_FIXTURE, verificationType: 'lint' },
      approvedReviewedCommitSha: 'd'.repeat(40),
      configurationHash: 'authoritative-configuration-hash',
    });
    expect(lintPolicy.baselineComparison).toBe(true);
  });

  it('refuses to attest a record whose command is not in the approved plan', () => {
    expect(() =>
      deriveVerificationAttestationPolicy({
        plan: PLAN_FIXTURE,
        criteria: CRITERIA_FIXTURE,
        record: { ...RECORD_FIXTURE, arguments: ['test', '--', '--unapproved'] },
        approvedReviewedCommitSha: 'd'.repeat(40),
        configurationHash: 'authoritative-configuration-hash',
      }),
    ).toThrowError(/does not match any approved plan verification command/);
  });

  it('binds the final-audit prompt to the authoritative target and exact ID sets', () => {
    const prompt = buildFinalAuditPrompt({
      workflowId: 'workflow-1',
      batchPlan: PLAN_FIXTURE,
      evidence: {
        target: {
          kind: 'FINAL_AUDIT',
          reviewedCommitSha: 'd'.repeat(40),
          repositoryContextSha: 'd'.repeat(40),
          reviewRangeEvidenceId: 'workflow-1:batch:12:range:final-gate',
          patchHash: 'e'.repeat(64),
          refinedPlanVersionId: 'refined-plan-1',
        },
        requirementIds: ['requirement-1'],
        acceptanceCriterionIds: ['criterion-required', 'criterion-manual'],
        cumulativePatch: 'diff --git a/src/example.txt b/src/example.txt',
        deferredFindings: [],
      },
    });
    expect(prompt).toContain('"kind": "FINAL_AUDIT"');
    expect(prompt).toContain(`"patchHash": "${'e'.repeat(64)}"`);
    expect(prompt).toContain('["requirement-1"]');
    expect(prompt).toContain('["criterion-required","criterion-manual"]');
    expect(prompt).toContain('Never modify repository');
    expect(prompt).toContain('critical or high');
  });
});

describe('review workflow CLI prompts', () => {
  it('binds refinement output to authoritative sequential IDs and imported requirements', () => {
    const prompt = buildRefinementPrompt({
      workflowId: 'workflow-1',
      repositoryAudit: {
        repositoryAuditId: 'audit-1',
        headSha: 'a'.repeat(40),
        dirty: false,
      },
      generalPlanContent: 'Implement the approved product plan.',
      requirements: [
        {
          requirementId: 'requirement-1',
          sourceReference: '## Required behavior',
          statement: 'The behavior must be reviewed before implementation.',
        },
      ],
    });

    expect(prompt).toContain('Output exactly one JSON object and nothing else.');
    expect(prompt).toContain('workflow-1:batch:N');
    expect(prompt).toContain('workflow-1:batch:N:plan:1');
    expect(prompt).toContain('"requirementId": "requirement-1"');
    expect(prompt).toContain('Do not include implementation work');
  });

  it('binds plan review to the exact persisted plan target', () => {
    const prompt = buildPlanReviewPrompt({
      workflowId: 'workflow-1',
      batchPlan: {
        batchPlanVersionId: 'workflow-1:batch:1:plan:1',
        contentHash: 'b'.repeat(64),
        repositoryContextSha: 'a'.repeat(40),
      },
      acceptanceCriteria: [],
    });

    expect(prompt).toContain('"kind": "PLAN"');
    expect(prompt).toContain('"planVersionId": "workflow-1:batch:1:plan:1"');
    expect(prompt).toContain(`"planContentHash": "${'b'.repeat(64)}"`);
    expect(prompt).toContain('one consolidated finding list');
    expect(prompt).toContain('Do not implement or modify code.');
  });

  it('keeps implementation preflight read-only and requires one exact response', () => {
    const prompt = buildImplementationPreflightPrompt({
      workflowId: 'workflow-1',
      batchId: 'workflow-1:batch:1',
      planVersionId: 'workflow-1:batch:1:plan:1',
    });

    expect(prompt).toContain('Do not inspect files, run commands, use tools, edit');
    expect(prompt).toContain('Output exactly READY and nothing else.');
  });

  it('keeps awaiting-commit resume read-only before returning to implementation', () => {
    const prompt = buildImplementationResumePrompt({
      workflowId: 'workflow-1',
      batchId: 'workflow-1:batch:1',
    });

    expect(prompt).toContain('AWAITING_COMMIT to IMPLEMENTING');
    expect(prompt).toContain('Do not inspect files, run commands, use tools, edit');
    expect(prompt).toContain('Output exactly READY and nothing else.');
  });

  it.each<['AGENT_AUTHORIZED' | 'HUMAN_CREATED', string, string]>([
    ['AGENT_AUTHORIZED', 'create one commit', 'leave the worktree clean'],
    ['HUMAN_CREATED', 'not authorized to commit', 'leave all intended changes uncommitted'],
  ])('binds implementation output and %s commit ownership', (creationMode, ...phrases) => {
    const prompt = buildImplementationPrompt({
      workflowId: 'workflow-1',
      batchPlan: { batchPlanVersionId: 'workflow-1:batch:1:plan:1' },
      acceptanceCriteria: [{ acceptanceCriterionId: 'criterion-1' }],
      originalBatchBaseSha: 'a'.repeat(40),
      creationMode,
    });

    expect(prompt).toContain('complete approved batch as one atomic unit');
    expect(prompt).toContain('IMPLEMENTATION_RESULT schemaVersion 1');
    expect(prompt).toContain('changedFiles must exactly list');
    for (const phrase of phrases) expect(prompt).toContain(phrase);
  });
});
