// Focused coverage for the plan-revision persistence path: an implementer-authored
// PLAN_REVISION_RESULT must pass the refinement-grade semantic invariants, persist a new
// immutable plan version under the authoritative ID, and return the batch to DRAFT through
// the kernel's SUBMIT_REVISED_PLAN command. Everything invalid fails closed.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/schema.js';
import { openDatabase } from '../../../src/memory/database.js';
import { ReviewWorkflowCommandStore } from '../../../src/memory/review-workflow-command-store.js';
import { ReviewWorkflowContractService } from '../../../src/review-workflow-contracts/index.js';
import { createReviewWorkflowConfigurationSnapshot } from '../../../src/review-workflow-identity/service.js';
import {
  ReviewWorkflowPlanService,
  ReviewWorkflowPlanStore,
  deriveBatchPlanVersionId,
} from '../../../src/review-workflow-plan/index.js';
import { transitionBatch } from '../../../src/review-workflow/state-machine.js';
import type { RepositoryAudit } from '../../../src/review-workflow/types.js';

const NOW = '2026-08-02T12:00:00.000Z';
const WORKFLOW_ID = 'workflow-revision';
const BATCH_ID = `${WORKFLOW_ID}:batch:1`;

describe('capturePlanRevision', () => {
  let db: Database.Database;
  let repositoryRoot: string;
  let store: ReviewWorkflowPlanStore;
  let service: ReviewWorkflowPlanService;
  let requirementId: string;
  let headSha: string;

  function owner() {
    return {
      actorExecutionId: `${WORKFLOW_ID}:owner`,
      actorType: 'HUMAN' as const,
      authoritiesExercised: ['WORKFLOW_OWNER' as const],
      identityAssurance: 'CLI_ASSERTED' as const,
      observedEvidence: [],
      startedAt: NOW,
      finishedAt: NOW,
    };
  }

  function reviser() {
    return {
      actorExecutionId: `${BATCH_ID}:reviser`,
      actorType: 'AGENT' as const,
      assignmentId: 'assignment-implementer',
      authoritiesExercised: ['IMPLEMENTER' as const, 'PLAN_REFINER' as const],
      identityAssurance: 'PROCESS_ATTESTED' as const,
      observedEvidence: [],
      startedAt: NOW,
    };
  }

  function revisedDraft(overrides: Record<string, unknown> = {}) {
    return {
      batchPlanVersionId: deriveBatchPlanVersionId(BATCH_ID, 2),
      batchId: BATCH_ID,
      ordinal: 1,
      objective: 'Deliver the revised sample output.',
      currentRepositoryEvidence: [
        { kind: 'FILE', location: 'README.md', description: 'Repository entry point.' },
      ],
      dependencies: [],
      candidateFiles: ['sample.txt'],
      technicalImplementation: ['Create sample.txt with revised content.'],
      userJourney: ['The operator sees sample.txt.'],
      expectedBehaviour: ['sample.txt exists.'],
      acceptanceCriteria: [
        {
          acceptanceCriterionId: 'criterion-revised',
          kind: 'TECHNICAL',
          statement: 'sample.txt exists.',
          required: true,
          passCondition: 'test -f sample.txt exits 0',
          sourceRequirementIds: [requirementId],
        },
      ],
      technicalAcceptanceCriteria: ['criterion-revised'],
      userFacingAcceptanceCriteria: [],
      cliAcceptanceCriteria: [],
      browserAcceptanceCriteria: { applicability: 'NOT_APPLICABLE', reason: 'CLI-only.' },
      verificationCommands: [
        {
          executable: 'test',
          arguments: ['-f', 'sample.txt'],
          workingDirectory: '.',
          verificationType: 'test',
          relatedCriterionIds: ['criterion-revised'],
        },
      ],
      manualVerification: [],
      documentationChanges: [],
      outOfScope: ['Everything else.'],
      rollbackBoundary: 'Revert the batch commit.',
      ...overrides,
    };
  }

  function revisionTranscript(
    draftOverrides: Record<string, unknown> = {},
    contractOverrides: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      schemaVersion: 1,
      contractKind: 'PLAN_REVISION_RESULT',
      batchId: BATCH_ID,
      previousPlanVersionId: deriveBatchPlanVersionId(BATCH_ID, 1),
      summary: 'Revised per the plan review findings.',
      revisedPlan: revisedDraft(draftOverrides),
      findingResponses: [],
      ...contractOverrides,
    });
  }

  function capture(rawTranscript: string) {
    return service.capturePlanRevision({
      workflowId: WORKFLOW_ID,
      batchId: BATCH_ID,
      revisionRound: 1,
      actor: reviser(),
      rawTranscript,
      createdAt: NOW,
    });
  }

  beforeEach(() => {
    repositoryRoot = mkdtempSync(join(tmpdir(), 'codemoot-plan-revision-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repositoryRoot });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repositoryRoot });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repositoryRoot });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'base'], { cwd: repositoryRoot });
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();

    db = openDatabase(':memory:');
    store = new ReviewWorkflowPlanStore(db);
    const commandStore = new ReviewWorkflowCommandStore(db);
    const contractService = new ReviewWorkflowContractService(store.workflowStore);
    const auditCollector = {
      captureRepositoryAudit: (): RepositoryAudit => ({
        repositoryAuditId: `${WORKFLOW_ID}:repository-audit:1`,
        workflowId: WORKFLOW_ID,
        repositoryRoot,
        branch: 'main',
        headSha,
        dirty: false,
        evidence: [],
        actorExecutionId: `${WORKFLOW_ID}:owner`,
        observedAt: NOW,
      }),
    };
    service = new ReviewWorkflowPlanService(store, commandStore, contractService, auditCollector);
    service.initialize({
      workflowId: WORKFLOW_ID,
      planContent: '## Deliver the sample feature\n\nWrite the sample output file.\n',
      sourceType: 'MARKDOWN_FILE',
      authorEvidence: [{ kind: 'LOCAL_CLI', source: 'test', observedAt: NOW }],
      owner: owner(),
      configuration: buildSnapshot(),
      repositoryAuditId: `${WORKFLOW_ID}:repository-audit:1`,
      createdAt: NOW,
    });
    const workflow = store.getWorkflow(WORKFLOW_ID);
    if (workflow === null) throw new Error('workflow missing');
    requirementId =
      store.listRequirements(workflow.generalPlanVersionId)[0]?.requirementId ?? 'missing';

    // Materialize batch 1 via refinement, then reject its plan so it sits in
    // PLAN_NEEDS_REVISION — the only state a revision may be submitted from.
    const refinement = {
      schemaVersion: 1,
      contractKind: 'REFINEMENT_RESULT',
      summary: 'One batch.',
      refinedPlanContent: 'Refined plan.',
      batchPlanVersionIds: [deriveBatchPlanVersionId(BATCH_ID, 1)],
      requirementCoverage: [
        {
          requirementId,
          batchPlanVersionIds: [deriveBatchPlanVersionId(BATCH_ID, 1)],
          acceptanceCriterionIds: ['criterion-revised'],
        },
      ],
      batchPlans: [revisedDraft({ batchPlanVersionId: deriveBatchPlanVersionId(BATCH_ID, 1) })],
    };
    const captureResult = service.captureRefinement({
      transcriptId: `${WORKFLOW_ID}:refinement:1`,
      workflowId: WORKFLOW_ID,
      actorExecutionId: reviser().actorExecutionId,
      rawTranscript: JSON.stringify(refinement),
      createdAt: NOW,
      expectedFirstBatchId: BATCH_ID,
      refinedPlanVersionId: `${WORKFLOW_ID}:refined-plan:1`,
      repositoryAuditId: `${WORKFLOW_ID}:repository-audit:1`,
      version: 1,
      actor: reviser(),
    });
    expect(captureResult.accepted).toBe(true);
    // Reject the plan directly through the kernel to reach PLAN_NEEDS_REVISION.
    rejectPlan(commandStore);
  });

  function rejectPlan(commandStore: ReviewWorkflowCommandStore): void {
    const batch = store.getBatch(BATCH_ID);
    if (batch === null) throw new Error('batch missing');
    const plan = store.getBatchPlan(batch.currentPlanVersionId);
    if (plan === null) throw new Error('plan missing');
    const evidence = {
      reviewedPlanVersionId: plan.batchPlanVersionId,
      currentPlanVersionId: plan.batchPlanVersionId,
      reviewedPlanContentHash: plan.contentHash,
      currentPlanContentHash: plan.contentHash,
      unresolvedFindingCount: 1,
      incompleteDispositionCount: 0,
      roleSeparation: {
        implementerAssignment: buildSnapshot().assignments.implementer,
        reviewerAssignment: buildSnapshot().assignments.reviewer,
        reviewerSessionIdentityId: `${BATCH_ID}:reviewer-session`,
        minimumIdentityAssurance: 'PROCESS_ATTESTED' as const,
      },
    };
    const reviewerActor = {
      actorExecutionId: `${BATCH_ID}:plan-reviewer`,
      actorType: 'AGENT' as const,
      assignmentId: 'assignment-reviewer',
      sessionIdentityId: `${BATCH_ID}:reviewer-session`,
      authoritiesExercised: ['REVIEWER' as const],
      identityAssurance: 'PROCESS_ATTESTED' as const,
      observedEvidence: [],
      startedAt: NOW,
    };
    const roleSeparation = {
      implementerAssignment: buildSnapshot().assignments.implementer,
      reviewerAssignment: buildSnapshot().assignments.reviewer,
      minimumIdentityAssurance: 'PROCESS_ATTESTED' as const,
    };
    issue(
      commandStore,
      { type: 'START_PLAN_REVIEW', roleSeparation },
      reviewerActor,
      'PLAN_REVIEW_STARTED',
    );
    issue(
      commandStore,
      { type: 'REJECT_PLAN', evidence },
      reviewerActor,
      'BATCH_PLAN_NEEDS_REVISION',
    );
    expect(store.getBatch(BATCH_ID)?.persistedState).toBe('PLAN_NEEDS_REVISION');
  }

  function issue(
    commandStore: ReviewWorkflowCommandStore,
    command: Parameters<
      typeof import('../../../src/review-workflow/state-machine.js')['transitionBatch']
    >[0]['command'],
    actor: ReturnType<typeof reviser>,
    eventType: string,
  ): void {
    const batch = store.getBatch(BATCH_ID);
    if (batch === null) throw new Error('batch missing');
    const request = {
      commandId: `${BATCH_ID}:${eventType}:${batch.aggregateVersion}`,
      workflowId: WORKFLOW_ID,
      batchId: BATCH_ID,
      expectedAggregateVersion: batch.aggregateVersion,
      requester: actor,
      authorityExercised: actor.authoritiesExercised[0] ?? 'REVIEWER',
      command,
    };
    commandStore.reserve({
      ...request,
      canonicalRequestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    });
    const transition = transitionBatch({
      currentState: batch.persistedState,
      command,
      actor,
    });
    if (!transition.allowed) throw new Error(`kernel rejected ${command.type}: ${transition.code}`);
    commandStore.succeedWithTransition({
      commandId: request.commandId,
      transition,
      eventType,
      eventPayload: {},
      resultHash: createHash('sha256').update(eventType).digest('hex'),
    });
  }

  afterEach(() => {
    db.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  });

  it('persists the revised plan under the authoritative version ID and returns to DRAFT', () => {
    const result = capture(
      revisionTranscript({
        acceptanceCriteria: [
          {
            acceptanceCriterionId: 'criterion-revised-v2',
            kind: 'TECHNICAL',
            statement: 'sample.txt exists (revised).',
            required: true,
            passCondition: 'test -f sample.txt exits 0',
            sourceRequirementIds: [requirementId],
          },
        ],
        technicalAcceptanceCriteria: ['criterion-revised-v2'],
        verificationCommands: [
          {
            executable: 'test',
            arguments: ['-f', 'sample.txt'],
            workingDirectory: '.',
            verificationType: 'test',
            relatedCriterionIds: ['criterion-revised-v2'],
          },
        ],
      }),
    );
    expect(result.batch.persistedState).toBe('DRAFT');
    expect(result.revisedPlanVersionId).toBe(deriveBatchPlanVersionId(BATCH_ID, 2));
    const batch = store.getBatch(BATCH_ID);
    expect(batch?.currentPlanVersionId).toBe(deriveBatchPlanVersionId(BATCH_ID, 2));
    const plan = store.getBatchPlan(deriveBatchPlanVersionId(BATCH_ID, 2));
    expect(plan?.version).toBe(2);
    expect(plan?.supersedesVersionId).toBe(deriveBatchPlanVersionId(BATCH_ID, 1));
    expect(store.listAcceptanceCriteria(deriveBatchPlanVersionId(BATCH_ID, 2))).toHaveLength(1);
  });

  it('rejects a revision that does not use the authoritative next version ID', () => {
    expect(() =>
      capture(revisionTranscript({ batchPlanVersionId: `${BATCH_ID}:plan:99` })),
    ).toThrow(/authoritative version ID/);
  });

  it('rejects criteria referencing unknown requirements', () => {
    expect(() =>
      capture(
        revisionTranscript({
          acceptanceCriteria: [
            {
              acceptanceCriterionId: 'criterion-revised',
              kind: 'TECHNICAL',
              statement: 'sample.txt exists.',
              required: true,
              passCondition: 'test -f sample.txt exits 0',
              sourceRequirementIds: ['requirement-unknown'],
            },
          ],
        }),
      ),
    ).toThrow(/unknown requirement/);
  });

  it('rejects verification commands referencing undeclared criteria', () => {
    expect(() =>
      capture(
        revisionTranscript({
          verificationCommands: [
            {
              executable: 'test',
              arguments: ['-f', 'sample.txt'],
              workingDirectory: '.',
              verificationType: 'test',
              relatedCriterionIds: ['criterion-undeclared'],
            },
          ],
        }),
      ),
    ).toThrow(/undeclared acceptance criterion|schema validation/);
  });

  it('rejects dependencies on non-earlier batches', () => {
    expect(() =>
      capture(revisionTranscript({ dependencies: ['workflow-revision:batch:9'] })),
    ).toThrow(/earlier batches/);
  });
});

function buildSnapshot() {
  return createReviewWorkflowConfigurationSnapshot(
    validateConfig({
      configVersion: 3,
      workflow: 'review-gated-batches',
      models: {
        implementer: {
          provider: 'anthropic',
          model: 'claude-supported',
          cliAdapter: { kind: 'claude', command: 'claude', args: [], timeout: 600 },
        },
        reviewer: {
          provider: 'openai',
          model: 'codex-supported',
          cliAdapter: { kind: 'codex', command: 'codex', args: ['exec'], timeout: 600 },
        },
      },
      roles: {
        implementer: { model: 'implementer' },
        reviewer: { model: 'reviewer' },
      },
      reviewGated: {
        identity: {
          minimumAssurance: 'process_attested',
          requireDifferentAdapterKinds: true,
          prohibitSharedSessions: true,
        },
        commit: { mode: 'either', agentMayCommit: true },
        gates: {
          planReview: 'required',
          codeReview: 'required',
          verification: 'required',
          humanMerge: 'required',
          blockingSeverities: ['critical', 'high'],
          requireAllFindingResponses: true,
          requireAcceptedAttestations: true,
        },
      },
      debate: { enabled: false },
    }),
    {
      workflowId: WORKFLOW_ID,
      implementerAssignmentId: 'assignment-implementer',
      reviewerAssignmentId: 'assignment-reviewer',
      assignedAt: NOW,
    },
  );
}
