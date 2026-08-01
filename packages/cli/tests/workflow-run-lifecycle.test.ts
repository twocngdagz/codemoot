// Real-command end-to-end coverage of the autonomous review-gated workflow runner's SUCCESS
// path: a temporary Git project with a bare local remote, the REAL coordinators and SQLite
// store, and scenario-driven fake Claude (implementer) and Codex (reviewer) executables that
// speak the exact adapter protocols. The scripted implementer really edits files and commits
// through the guarded PATH; the scripted reviewer echoes the authoritative targets from its
// own prompts. Covered here:
//
// 1. One batch through the complete lifecycle: refinement -> plan review APPROVED ->
//    implementation (real commit) -> code review round 1 NEEDS_REVISION (one blocking
//    merge-blocking-criterion finding; see codeReviewNeedsRevisionStep for why not high)
//    -> correction pass (real fix commit + implementer-authored DISPOSITION_RESULT) ->
//    code review round 2 APPROVED -> verification command + reviewer acceptance -> final
//    audit APPROVED -> merge gate -> gated push to the bare remote -> workflow-level audit
//    -> READY_FOR_HUMAN_VERIFICATION.
// 2. Interrupt/restart: the gated push fails mid-workflow (read-only remote), the worker is
//    recovered through the PUBLIC human-decision command (fix_again) and run-resume,
//    and `workflow run-resume` re-enters at the DOMAIN-derived stage (PUSH) and completes
//    without repeating any finished phase — proven by per-phase invocation-audit counts and
//    the untouched fake-CLI call counters.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, reviewWorkflowPlan, reviewWorkflowRunner } from '@codemoot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reviewWorkflowDecideCommand,
  reviewWorkflowPauseCommand,
  reviewWorkflowResumeCommand,
  reviewWorkflowRunCommand,
  reviewWorkflowRunResumeCommand,
} from '../src/commands/review-workflow.js';
import { getDbPath } from '../src/utils.js';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-lifecycle.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex-lifecycle.mjs', import.meta.url));

const PLAN_CONTENT = '## Deliver the sample feature\n\nWrite the sample output file.\n';
// What the MODEL returns in its batch plan. Assembly namespaces every criterion ID by its
// batch, so anything downstream — findings, final-audit checks — must reference the
// materialized form instead. Keeping the two distinct is what proves the rename works.
const CRITERION_ID = 'criterion-sample-output';
function materializedCriterionId(workflowId: string): string {
  return `${workflowId}:batch:1:criterion:1`;
}

function git(projectDir: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: projectDir, encoding: 'utf8' }).trim();
}

function buildConfig(): string {
  return JSON.stringify({
    configVersion: 3,
    workflow: 'review-gated-batches',
    models: {
      implementer: {
        provider: 'anthropic',
        model: 'claude-supported',
        cliAdapter: {
          kind: 'claude',
          command: process.execPath,
          args: [FAKE_CLAUDE],
          timeout: 120,
        },
      },
      reviewer: {
        provider: 'openai',
        model: 'codex-supported',
        cliAdapter: {
          kind: 'codex',
          command: FAKE_CODEX,
          args: ['exec'],
          timeout: 120,
        },
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
  });
}

/** The requirement id the plan importer derives — needed for the final-audit checks. */
function importedRequirementId(workflowId: string): string {
  const imported = reviewWorkflowPlan.importGeneralPlan({
    workflowId,
    content: PLAN_CONTENT,
    sourceType: 'MARKDOWN_FILE',
    authorEvidence: [
      {
        kind: 'LOCAL_CLI',
        source: 'codemoot workflow run',
        observedAt: '2026-08-02T12:00:00.000Z',
      },
    ],
    createdAt: '2026-08-02T12:00:00.000Z',
  });
  const requirementId = imported.requirements[0]?.requirementId;
  if (requirementId === undefined) throw new Error('Plan fixture produced no requirement');
  return requirementId;
}

/**
 * Refinement is per batch: the implementer returns an OUTLINE first, then one BATCH_PLAN
 * per batch. This helper yields both scenario steps in order.
 */
function buildRefinementSteps(
  workflowId: string,
  extraVerificationCommands: readonly Record<string, unknown>[] = [],
): readonly { response: Record<string, unknown> }[] {
  const full = buildRefinementContract(workflowId, extraVerificationCommands);
  const batchPlans = full.batchPlans as Record<string, unknown>[];
  const outline = {
    schemaVersion: 1,
    contractKind: 'REFINEMENT_OUTLINE_RESULT',
    summary: full.summary,
    refinedPlanContent: full.refinedPlanContent,
    batches: batchPlans.map((plan) => ({
      batchId: plan.batchId,
      batchPlanVersionId: plan.batchPlanVersionId,
      ordinal: plan.ordinal,
      objective: plan.objective,
    })),
    // NO requirementCoverage: the outline is authored before any batch plan exists, so it
    // could only guess. Coverage is derived from the batch plans at assembly.
  };
  return [
    { response: outline },
    ...batchPlans.map((batchPlan) => ({
      response: { schemaVersion: 1, contractKind: 'BATCH_PLAN_RESULT', batchPlan },
    })),
  ];
}

/** The complete refinement, used to derive the per-batch scenario steps above. */
function buildRefinementContract(
  workflowId: string,
  extraVerificationCommands: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  const requirementId = importedRequirementId(workflowId);
  const batchId = `${workflowId}:batch:1`;
  const planVersionId = `${batchId}:plan:1`;
  return {
    schemaVersion: 1,
    contractKind: 'REFINEMENT_RESULT',
    summary: 'One batch delivering the sample output file.',
    refinedPlanContent: 'Refined plan: implement the sample output file in a single batch.',
    batchPlanVersionIds: [planVersionId],
    requirementCoverage: [
      {
        requirementId,
        batchPlanVersionIds: [planVersionId],
        acceptanceCriterionIds: [CRITERION_ID],
      },
    ],
    batchPlans: [
      {
        batchPlanVersionId: planVersionId,
        batchId,
        ordinal: 1,
        objective: 'Write the sample output file.',
        currentRepositoryEvidence: [
          { kind: 'FILE', location: 'README.md', description: 'Current repository entry point.' },
        ],
        dependencies: [],
        candidateFiles: ['sample.txt'],
        technicalImplementation: ['Create sample.txt with the expected content.'],
        userJourney: ['The operator sees sample.txt after the batch lands.'],
        expectedBehaviour: ['sample.txt exists with the expected content.'],
        acceptanceCriteria: [
          {
            acceptanceCriterionId: CRITERION_ID,
            kind: 'TECHNICAL',
            statement: 'sample.txt exists.',
            required: true,
            passCondition: 'test -f sample.txt exits 0',
            sourceRequirementIds: [requirementId],
          },
        ],
        technicalAcceptanceCriteria: [CRITERION_ID],
        userFacingAcceptanceCriteria: [],
        cliAcceptanceCriteria: [],
        browserAcceptanceCriteria: { applicability: 'NOT_APPLICABLE', reason: 'CLI-only change.' },
        verificationCommands: [
          {
            executable: 'test',
            arguments: ['-f', 'sample.txt'],
            workingDirectory: '.',
            verificationType: 'test',
            relatedCriterionIds: [CRITERION_ID],
          },
          ...extraVerificationCommands,
        ],
        manualVerification: [],
        documentationChanges: [],
        outOfScope: ['Everything else.'],
        rollbackBoundary: 'Revert the batch commit.',
      },
    ],
  };
}

const PREFLIGHT_READY_STEP = { response: 'READY' };

const IMPLEMENTATION_STEP = {
  response: {
    schemaVersion: 1,
    contractKind: 'IMPLEMENTATION_RESULT',
    outcome: 'COMPLETE',
    summary: 'Created sample.txt and committed the batch as one atomic unit.',
    changedFiles: ['sample.txt'],
    verificationRecordIds: [],
  },
  shell: "printf 'content\\n' > sample.txt && git add sample.txt && git commit -q -m impl",
};

const CORRECTION_STEP = {
  response: {
    schemaVersion: 1,
    contractKind: 'IMPLEMENTATION_RESULT',
    outcome: 'COMPLETE',
    summary: 'Rewrote sample.txt to resolve the blocking finding and committed the fix.',
    changedFiles: ['sample.txt'],
    verificationRecordIds: [],
  },
  shell: "printf 'content fixed\\n' > sample.txt && git add sample.txt && git commit -q -m fix",
};

const DISPOSITION_STEP = {
  response: {
    schemaVersion: 1,
    contractKind: 'DISPOSITION_RESULT',
    target: { kind: 'CODE', resultingCommitSha: '{{HEAD}}' },
    summary: 'Fixed the blocking finding by rewriting sample.txt in the correction commit.',
    dispositions: [
      {
        findingId: '{{FINDING_ID}}',
        disposition: 'FIXED',
        explanation: 'Rewrote sample.txt with the corrected content the plan expects.',
        filesChanged: ['sample.txt'],
        verificationRecordIds: [],
        evidence: [
          {
            kind: 'DIFF',
            location: 'sample.txt',
            description: 'The correction commit rewrites the file content.',
          },
        ],
      },
    ],
  },
};

const PLAN_REVIEW_APPROVED_STEP = {
  response: {
    schemaVersion: 1,
    contractKind: 'REVIEW_RESULT',
    target: '{{TARGET}}',
    verdict: 'APPROVED',
    summary: 'The batch plan is complete, grounded, and verifiable.',
    findings: [],
  },
};

// The blocking round-1 finding is a MEDIUM finding citing a merge-blocking (required)
// acceptance criterion: the code-review policy blocks it exactly like critical/high, so the
// full correction loop (correction pass + disposition + bounded final review) runs. A
// critical/high finding cannot be used here: production findings are never re-statused from
// OPEN, and the CLI's workflow-level audit (`workflowAudit` in review-workflow.ts) counts
// every OPEN critical/high finding as unresolved even after its disposition was
// reviewer-ACCEPTED — so a high-finding correction loop can never reach
// READY_FOR_HUMAN_VERIFICATION without an explicit accept-risk decision.
function codeReviewNeedsRevisionStep(workflowId: string): Record<string, unknown> {
  return {
    response: {
      schemaVersion: 1,
      contractKind: 'REVIEW_RESULT',
      target: '{{TARGET}}',
      verdict: 'NEEDS_REVISION',
      summary: 'The committed sample.txt content does not match the planned behaviour.',
      findings: [
        {
          findingKey: 'SAMPLE-CONTENT-1',
          severity: 'medium',
          acceptanceCriterionId: materializedCriterionId(workflowId),
          category: 'correctness',
          title: 'sample.txt carries placeholder content',
          description: 'The committed file content does not match the expected behaviour.',
          repositoryEvidence: [
            { kind: 'FILE', location: 'sample.txt', description: 'Observed committed content.' },
          ],
          affectedFiles: ['sample.txt'],
          expectedResult: 'sample.txt contains the corrected content.',
          observedResult: 'sample.txt contains placeholder content.',
          requiredAction: 'Rewrite sample.txt with the corrected content and commit the fix.',
          occurrenceLinks: [],
        },
      ],
    },
  };
}

const CODE_REVIEW_APPROVED_STEP = {
  response: {
    schemaVersion: 1,
    contractKind: 'REVIEW_RESULT',
    target: '{{TARGET}}',
    verdict: 'APPROVED',
    summary: 'The reviewed implementation satisfies the approved plan.',
    findings: [],
  },
};

const VERIFICATION_ACCEPT_STEP = {
  response: {
    accept: true,
    rationale: 'The verification command succeeded at the reviewed commit.',
  },
};

function finalAuditApprovedStep(workflowId: string): Record<string, unknown> {
  return {
    response: {
      schemaVersion: 1,
      contractKind: 'FINAL_AUDIT_RESULT',
      target: '{{TARGET}}',
      verdict: 'APPROVED',
      summary: 'Every requirement and acceptance criterion is delivered.',
      findings: [],
      requirementChecks: [
        {
          subjectId: importedRequirementId(workflowId),
          status: 'PASSED',
          explanation: 'sample.txt is delivered exactly as the refined plan requires.',
          evidence: [
            { kind: 'FILE', location: 'sample.txt', description: 'The delivered output file.' },
          ],
        },
      ],
      acceptanceCriterionChecks: [
        {
          subjectId: materializedCriterionId(workflowId),
          status: 'PASSED',
          explanation: 'test -f sample.txt exits 0 at the reviewed commit.',
          evidence: [
            {
              kind: 'COMMAND',
              location: 'test -f sample.txt',
              description: 'The approved verification command evidence.',
            },
          ],
        },
      ],
      scopeComplete: true,
      documentationComplete: true,
    },
  };
}

interface ProjectFixture {
  readonly projectDir: string;
  readonly remoteDir: string;
}

describe('codemoot workflow run lifecycle (real command, scenario-driven adapters)', () => {
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    originalCwd = process.cwd();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    for (const directory of cleanupDirs) {
      try {
        execFileSync('chmod', ['-R', 'u+w', directory]);
      } catch {
        // best effort — the directory may already be writable or gone
      }
      rmSync(directory, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  function createProject(): ProjectFixture {
    const projectDir = mkdtempSync(join(tmpdir(), 'codemoot-lifecycle-'));
    const remoteDir = mkdtempSync(join(tmpdir(), 'codemoot-lifecycle-remote-'));
    cleanupDirs.push(projectDir, remoteDir);
    execFileSync('git', ['init', '--bare'], { cwd: remoteDir });
    git(projectDir, ['init', '-b', 'main']);
    git(projectDir, ['config', 'user.email', 'test@example.com']);
    git(projectDir, ['config', 'user.name', 'Test']);
    writeFileSync(join(projectDir, 'README.md'), '# Sample project\n');
    writeFileSync(join(projectDir, 'plan.md'), PLAN_CONTENT);
    writeFileSync(join(projectDir, '.cowork.yml'), buildConfig());
    // `.codemoot/` holds the patch/verification-log artifact sinks the gate writes during
    // review capture; both stores must stay invisible to worktree cleanliness evidence.
    writeFileSync(join(projectDir, '.gitignore'), '.cowork/\n.codemoot/\n');
    git(projectDir, ['add', '-A']);
    git(projectDir, ['commit', '-m', 'initial']);
    git(projectDir, ['remote', 'add', 'origin', remoteDir]);
    git(projectDir, ['push', '-u', 'origin', 'main']);
    mkdirSync(join(projectDir, '.cowork', 'scenario'), { recursive: true });
    process.chdir(projectDir);
    return { projectDir, remoteDir };
  }

  function writeSteps(projectDir: string, role: 'claude' | 'codex', steps: readonly unknown[]) {
    steps.forEach((step, index) => {
      writeFileSync(
        join(projectDir, '.cowork', 'scenario', `${role}-${index + 1}.json`),
        JSON.stringify(step),
      );
    });
  }

  function scenarioCallCount(projectDir: string, role: 'claude' | 'codex'): number {
    const counterFile = join(projectDir, '.cowork', 'scenario', `${role}-calls`);
    return existsSync(counterFile)
      ? Number.parseInt(readFileSync(counterFile, 'utf8').trim(), 10)
      : 0;
  }

  /** Fails with the runner's own durable diagnostics when the run did not reach READY. */
  function requireReady(
    db: ReturnType<typeof openDatabase>,
    workflowId: string,
  ): reviewWorkflowRunner.RunnerState {
    const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);
    const state = runnerStore.require(workflowId);
    if (state.status !== 'READY_FOR_HUMAN_VERIFICATION') {
      const planStore = new reviewWorkflowPlan.ReviewWorkflowPlanStore(db);
      const failures = planStore.workflowStore
        .listInvocationAudit(workflowId)
        .filter((row) => row.resultStatus === 'FAILED')
        .map((row) => `${row.phase ?? 'unknown-phase'}: ${row.failure?.message ?? 'no message'}`);
      const log = runnerStore
        .listLog(workflowId, { limit: 1000 })
        .filter((entry) => entry.entryType !== 'HEARTBEAT')
        .map((entry) => `${entry.entryType} ${entry.phase ?? ''} ${entry.message}`);
      throw new Error(
        `Runner stopped with ${state.status} (${state.stopReason ?? 'no reason'}): ${
          state.stopDetails ?? 'no details'
        }\nFailed invocations:\n${failures.join('\n')}\nRunner log:\n${log.join('\n')}`,
      );
    }
    return state;
  }

  function phaseCounts(
    db: ReturnType<typeof openDatabase>,
    workflowId: string,
  ): Record<string, number> {
    const planStore = new reviewWorkflowPlan.ReviewWorkflowPlanStore(db);
    const counts: Record<string, number> = {};
    for (const row of planStore.workflowStore.listInvocationAudit(workflowId)) {
      const phase = row.phase ?? 'unknown';
      counts[phase] = (counts[phase] ?? 0) + 1;
    }
    return counts;
  }

  it(
    'completes one batch end to end: refinement, plan review, implementation, correction loop, verification, final audit, gate, push',
    { timeout: 120_000 },
    async () => {
      const { projectDir, remoteDir } = createProject();
      const workflowId = 'workflow-lifecycle-success';
      writeSteps(projectDir, 'claude', [
        ...buildRefinementSteps(workflowId),
        PREFLIGHT_READY_STEP,
        IMPLEMENTATION_STEP,
        PREFLIGHT_READY_STEP, // correction-pass resume gate
        CORRECTION_STEP,
        DISPOSITION_STEP,
      ]);
      writeSteps(projectDir, 'codex', [
        PLAN_REVIEW_APPROVED_STEP,
        codeReviewNeedsRevisionStep(workflowId),
        CODE_REVIEW_APPROVED_STEP,
        VERIFICATION_ACCEPT_STEP,
        finalAuditApprovedStep(workflowId),
      ]);
      const baseShaBefore = git(projectDir, ['rev-parse', 'main']);

      await reviewWorkflowRunCommand({ plan: 'plan.md', timeout: 120, id: workflowId });

      const db = openDatabase(getDbPath(projectDir));
      try {
        const state = requireReady(db, workflowId);
        const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);
        const planStore = new reviewWorkflowPlan.ReviewWorkflowPlanStore(db);

        // The delivered artefact really exists with the CORRECTED content.
        expect(readFileSync(join(projectDir, 'sample.txt'), 'utf8')).toBe('content fixed\n');

        // The workflow branch was pushed and the remote HEAD matches the local HEAD.
        const localHead = git(projectDir, ['rev-parse', 'HEAD']);
        const remoteHead = git(projectDir, [
          'ls-remote',
          'origin',
          `refs/heads/${state.branch}`,
        ]).split('\t')[0];
        expect(remoteHead).toBe(localHead);

        // The base branch never moved, locally or on the remote.
        expect(git(projectDir, ['rev-parse', 'main'])).toBe(baseShaBefore);
        expect(git(projectDir, ['ls-remote', 'origin', 'refs/heads/main']).split('\t')[0]).toBe(
          baseShaBefore,
        );

        // The batch reached the gate-approved terminal state.
        const batches = planStore.listBatches(workflowId);
        expect(batches).toHaveLength(1);
        expect(['APPROVED_FOR_MERGE', 'MERGED']).toContain(batches[0]?.persistedState);

        // Every lifecycle phase is fully audited with the exact expected invocation counts,
        // and no invocation failed anywhere in the success path.
        const audit = planStore.workflowStore.listInvocationAudit(workflowId);
        expect(audit.filter((row) => row.resultStatus === 'FAILED')).toHaveLength(0);
        expect(phaseCounts(db, workflowId)).toEqual({
          PLAN_REFINEMENT: 2,
          PLAN_REVIEW: 1,
          // preflight + implementation + correction resume + correction implementation
          IMPLEMENTATION: 4,
          CODE_REVIEW: 2,
          CORRECTION: 1, // the implementer-authored disposition result
          VERIFICATION: 1, // the reviewer's verification assessment
          FINAL_AUDIT: 1,
        });

        // The correction loop really happened: two review rounds, one correction pass, and
        // the blocking finding is no longer open.
        expect(state.counters.completedBatches).toHaveLength(1);
        const summary = state.counters.completedBatches[0];
        expect(summary?.codeReviewRounds).toBe(2);
        expect(summary?.correctionPasses).toBe(1);
        expect(summary?.deferredFindingIds).toHaveLength(0);
        expect(summary?.pushedCommitSha).toBe(localHead);
        expect(state.counters.completedOrdinals).toEqual([1]);
        expect(state.totalBatches).toBe(1);

        // The completion notification is durable.
        const notifications = runnerStore.listLog(workflowId, { types: ['NOTIFICATION'] });
        expect(notifications).toHaveLength(1);
        expect(notifications[0]?.message).toContain('ready for human verification');

        // The scripted adapters were consumed exactly once per lifecycle step.
        // 7 = outline + 1 batch plan (refinement is per batch) + preflight + implement
        // + correction + dispositions + resume.
        expect(scenarioCallCount(projectDir, 'claude')).toBe(7);
        expect(scenarioCallCount(projectDir, 'codex')).toBe(5);

        // The remote directory really is the pushed destination (sanity for the fixture).
        expect(
          execFileSync('git', ['rev-parse', state.branch], {
            cwd: remoteDir,
            encoding: 'utf8',
          }).trim(),
        ).toBe(localHead);
      } finally {
        db.close();
      }
    },
  );

  it(
    'resumes an interrupted workflow at the domain-derived stage without repeating completed phases',
    { timeout: 120_000 },
    async () => {
      const { projectDir, remoteDir } = createProject();
      const workflowId = 'workflow-lifecycle-restart';
      // Straight success path (round-1 approval, no correction) so the interruption is the
      // only variable: the gated push fails because the remote is temporarily read-only.
      writeSteps(projectDir, 'claude', [
        ...buildRefinementSteps(workflowId),
        PREFLIGHT_READY_STEP,
        IMPLEMENTATION_STEP,
      ]);
      writeSteps(projectDir, 'codex', [
        PLAN_REVIEW_APPROVED_STEP,
        CODE_REVIEW_APPROVED_STEP,
        VERIFICATION_ACCEPT_STEP,
        finalAuditApprovedStep(workflowId),
      ]);
      execFileSync('chmod', ['-R', 'a-w', remoteDir]);

      await reviewWorkflowRunCommand({ plan: 'plan.md', timeout: 120, id: workflowId });

      let countsBeforeResume: Record<string, number>;
      const dbAfterStop = openDatabase(getDbPath(projectDir));
      try {
        const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(dbAfterStop);
        const planStore = new reviewWorkflowPlan.ReviewWorkflowPlanStore(dbAfterStop);
        const stopped = runnerStore.require(workflowId);
        expect(stopped.status).toBe('HUMAN_DECISION_REQUIRED');
        expect(stopped.stopReason).toBe('PUSH_FAILED');
        // Everything up to the push already completed in the domain: the batch is
        // gate-approved, so the derived resume stage is PUSH.
        expect(planStore.listBatches(workflowId)[0]?.persistedState).toBe('APPROVED_FOR_MERGE');
        countsBeforeResume = phaseCounts(dbAfterStop, workflowId);
        expect(countsBeforeResume).toEqual({
          PLAN_REFINEMENT: 2,
          PLAN_REVIEW: 1,
          IMPLEMENTATION: 2,
          CODE_REVIEW: 1,
          VERIFICATION: 1,
          FINAL_AUDIT: 1,
        });
      } finally {
        dbAfterStop.close();
      }
      execFileSync('chmod', ['-R', 'u+w', remoteDir]);

      // The SUPPORTED recovery path, exactly as a human would drive it: an explicit
      // FIX_AGAIN decision through the public decide command, then a resume — no internal
      // state is ever rewritten.
      await reviewWorkflowDecideCommand(workflowId, {
        action: 'fix_again',
        rationale: 'The remote is writable again; retry the gated push.',
      });
      await reviewWorkflowRunResumeCommand(workflowId, { timeout: 120 });

      const db = openDatabase(getDbPath(projectDir));
      try {
        const state = requireReady(db, workflowId);
        const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);

        // The resumed worker re-entered at PUSH: not one additional agent invocation was
        // made in any phase, and the fake CLIs were never called again.
        expect(phaseCounts(db, workflowId)).toEqual(countsBeforeResume);
        // 4 = outline + 1 batch plan + preflight + implement.
        expect(scenarioCallCount(projectDir, 'claude')).toBe(4);
        expect(scenarioCallCount(projectDir, 'codex')).toBe(4);

        // The push now succeeded and the workflow completed.
        const localHead = git(projectDir, ['rev-parse', 'HEAD']);
        expect(
          git(projectDir, ['ls-remote', 'origin', `refs/heads/${state.branch}`]).split('\t')[0],
        ).toBe(localHead);
        expect(state.counters.completedOrdinals).toEqual([1]);
        expect(state.counters.completedBatches).toHaveLength(1);
        expect(readFileSync(join(projectDir, 'sample.txt'), 'utf8')).toBe('content\n');

        // Durable evidence of both the interruption and the completed resume.
        const stops = runnerStore.listLog(workflowId, { types: ['STOP'] });
        expect(stops.some((entry) => entry.message.startsWith('PUSH_FAILED'))).toBe(true);
        const checkpoints = runnerStore.listLog(workflowId, { types: ['CHECKPOINT'] });
        expect(checkpoints.some((entry) => entry.message.startsWith('Pushed '))).toBe(true);
      } finally {
        db.close();
      }
    },
  );

  it(
    'never reports READY when a zero-exit verification command dirties the worktree at completion',
    { timeout: 120_000 },
    async () => {
      const { projectDir } = createProject();
      const workflowId = 'workflow-lifecycle-dirty-verify';
      // The second verification command is clean during the batch (it only touches a
      // gitignored marker) but WRITES a tracked-location file on its completion re-run —
      // while still exiting zero.
      const sideEffectCommand = {
        executable: 'sh',
        arguments: [
          '-c',
          'if [ -f .cowork/final-verify-marker ]; then touch verify-side-effect.txt; fi; touch .cowork/final-verify-marker; exit 0',
        ],
        workingDirectory: '.',
        verificationType: 'test',
        relatedCriterionIds: [CRITERION_ID],
      };
      writeSteps(projectDir, 'claude', [
        ...buildRefinementSteps(workflowId, [sideEffectCommand]),
        PREFLIGHT_READY_STEP,
        IMPLEMENTATION_STEP,
      ]);
      writeSteps(projectDir, 'codex', [
        PLAN_REVIEW_APPROVED_STEP,
        CODE_REVIEW_APPROVED_STEP,
        VERIFICATION_ACCEPT_STEP,
        VERIFICATION_ACCEPT_STEP,
        finalAuditApprovedStep(workflowId),
      ]);

      await reviewWorkflowRunCommand({ plan: 'plan.md', timeout: 120, id: workflowId });

      const db = openDatabase(getDbPath(projectDir));
      try {
        const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(db);
        const state = runnerStore.require(workflowId);
        // The batch itself completed and pushed — the defect window is completion-time.
        expect(state.counters.completedOrdinals).toEqual([1]);
        // But READY was refused: the zero-exit command dirtied the worktree.
        expect(state.status).toBe('HUMAN_DECISION_REQUIRED');
        expect(state.status).not.toBe('READY_FOR_HUMAN_VERIFICATION');
        expect(state.stopDetails ?? '').toMatch(/uncommitted changes|clean worktree/);
        // The unexpected change was preserved for inspection — never cleaned or reset.
        expect(existsSync(join(projectDir, 'verify-side-effect.txt'))).toBe(true);
      } finally {
        db.close();
      }
    },
  );

  it(
    'pauses gracefully mid-run through the public commands and resumes without repeating phases',
    { timeout: 180_000 },
    async () => {
      const { projectDir, remoteDir } = createProject();
      const workflowId = 'workflow-lifecycle-pause';
      // Round-1-approved success path, with a deliberate delay inside the implementation
      // step so the concurrent pause command deterministically lands while an atomic
      // action is in flight.
      writeSteps(projectDir, 'claude', [
        ...buildRefinementSteps(workflowId),
        PREFLIGHT_READY_STEP,
        {
          ...IMPLEMENTATION_STEP,
          shell: `sleep 4; ${IMPLEMENTATION_STEP.shell}`,
        },
      ]);
      writeSteps(projectDir, 'codex', [
        PLAN_REVIEW_APPROVED_STEP,
        CODE_REVIEW_APPROVED_STEP,
        VERIFICATION_ACCEPT_STEP,
        finalAuditApprovedStep(workflowId),
      ]);

      // Fire the worker, then pause through the PUBLIC command once plan review is durably
      // recorded (the implementation action is running or about to).
      const runPromise = reviewWorkflowRunCommand({
        plan: 'plan.md',
        timeout: 120,
        id: workflowId,
      });
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error('plan review never appeared in the audit');
        const probe = openDatabase(getDbPath(projectDir));
        try {
          const planStore = new reviewWorkflowPlan.ReviewWorkflowPlanStore(probe);
          const reviewed = planStore.workflowStore
            .listInvocationAudit(workflowId)
            .some((row) => row.phase === 'PLAN_REVIEW');
          if (reviewed) break;
        } finally {
          probe.close();
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
      }
      await reviewWorkflowPauseCommand(workflowId);
      await runPromise;

      const pausedDb = openDatabase(getDbPath(projectDir));
      let countsAtPause: Record<string, number>;
      try {
        const runnerStore = new reviewWorkflowRunner.ReviewWorkflowRunnerStore(pausedDb);
        const paused = runnerStore.require(workflowId);
        // The in-flight atomic action finished and settled; the workflow is durably paused
        // with branch, sessions, findings, and counters intact.
        expect(paused.status).toBe('PAUSED_BY_USER');
        expect(reviewWorkflowRunner.deriveObservedStatus(paused, 120, new Date()).status).toBe(
          'PAUSED_BY_USER',
        );
        countsAtPause = phaseCounts(pausedDb, workflowId);
        expect(countsAtPause.PLAN_REVIEW).toBe(1);
      } finally {
        pausedDb.close();
      }

      // `run --plan` NEVER silently resumes an existing workflow.
      await expect(
        reviewWorkflowRunCommand({ plan: 'plan.md', timeout: 120, id: workflowId }),
      ).rejects.toThrow(/already exists.*resume/);

      // The public resume continues from the next unfinished action to READY.
      await reviewWorkflowResumeCommand(workflowId, { timeout: 120 });

      const db = openDatabase(getDbPath(projectDir));
      try {
        const state = requireReady(db, workflowId);
        const planStore = new reviewWorkflowPlan.ReviewWorkflowPlanStore(db);
        // Exactly the single-run baseline: no phase was ever repeated across the pause.
        expect(phaseCounts(db, workflowId)).toEqual({
          PLAN_REFINEMENT: 2,
          PLAN_REVIEW: 1,
          IMPLEMENTATION: 2,
          CODE_REVIEW: 1,
          VERIFICATION: 1,
          FINAL_AUDIT: 1,
        });
        // The SAME batch role sessions were reused — never replaced.
        const batchId = `${workflowId}:batch:1`;
        expect(planStore.workflowStore.getBatchRoleSession(batchId, 'IMPLEMENTER')).not.toBeNull();
        expect(planStore.workflowStore.getBatchRoleSession(batchId, 'REVIEWER')).not.toBeNull();
        const continuity = planStore.workflowStore.listSessionContinuity(batchId);
        expect(continuity.some((row) => row.outcome === 'RESUMED')).toBe(true);
        expect(continuity.every((row) => row.outcome !== 'FAILED')).toBe(true);
        // Counters and limits were preserved, never reset.
        expect(state.counters.completedBatches[0]?.planReviewRounds).toBe(1);
        expect(state.counters.completedBatches[0]?.codeReviewRounds).toBe(1);
        const localHead = git(projectDir, ['rev-parse', 'HEAD']);
        expect(
          execFileSync('git', ['rev-parse', state.branch], {
            cwd: remoteDir,
            encoding: 'utf8',
          }).trim(),
        ).toBe(localHead);

        // Repeated resume on a finished workflow is refused with a clear message.
        await expect(reviewWorkflowResumeCommand(workflowId, { timeout: 120 })).rejects.toThrow(
          /READY_FOR_HUMAN_VERIFICATION/,
        );
      } finally {
        db.close();
      }
    },
  );
});
