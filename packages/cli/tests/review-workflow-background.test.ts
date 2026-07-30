// Command-surface and behavioral coverage for background workflow execution: the REAL
// Commander program is inspected (importing the CLI never parses argv), and `batch verify
// --background` is executed end-to-end against a seeded temporary project.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  openDatabase,
  reviewWorkflowIdentity,
  reviewWorkflowJobs,
  reviewWorkflowPersistence,
  reviewWorkflowPlan,
} from '@codemoot/core';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requireBatchMatchingJob,
  reviewWorkflowBatchVerifyCommand,
} from '../src/commands/review-workflow.js';
import { program } from '../src/index.js';
import { getDbPath } from '../src/utils.js';

const NOW = '2026-07-31T12:00:00.000Z';
const WORKFLOW_ID = 'workflow-13';
const BATCH_ID = 'workflow-13:batch:13';

const CONFIG_FILE_CONTENT = JSON.stringify({
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
});

function findCommand(parent: Command, name: string): Command {
  const found = parent.commands.find((candidate) => candidate.name() === name);
  if (found === undefined) throw new Error(`Command ${name} is not registered`);
  return found;
}

describe('review workflow CLI command surface', () => {
  it('registers --background, --id, and --expected-version on the real batch verify command', () => {
    const verify = findCommand(findCommand(program, 'batch'), 'verify');
    const options = verify.options.map((option) => option.long);
    expect(options).toContain('--background');
    expect(options).toContain('--id');
    expect(options).toContain('--expected-version');
    expect(options).toContain('--command');
  });

  it('registers --background on final-audit and review-code, and the jobs/events surface', () => {
    const batch = findCommand(program, 'batch');
    for (const name of ['final-audit', 'review-code']) {
      const options = findCommand(batch, name).options.map((option) => option.long);
      expect(options, name).toContain('--background');
    }
    const workflow = findCommand(program, 'workflow');
    const jobs = findCommand(workflow, 'jobs');
    for (const name of ['run', 'list', 'show', 'cancel']) {
      expect(
        jobs.commands.some((candidate) => candidate.name() === name),
        name,
      ).toBe(true);
    }
    const events = findCommand(workflow, 'events');
    const eventOptions = events.options.map((option) => option.long);
    expect(eventOptions).toContain('--after');
    expect(eventOptions).toContain('--cursor');
    expect(eventOptions).toContain('--ack');
  });
});

describe('batch verify --background', () => {
  let projectDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'codemoot-background-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir });
    writeFileSync(join(projectDir, '.cowork.yml'), CONFIG_FILE_CONTENT);

    const config = loadConfig({ projectDir });
    const snapshot = reviewWorkflowIdentity.createReviewWorkflowConfigurationSnapshot(config, {
      workflowId: WORKFLOW_ID,
      implementerAssignmentId: `${WORKFLOW_ID}:assignment:implementer`,
      reviewerAssignmentId: `${WORKFLOW_ID}:assignment:reviewer`,
      assignedAt: NOW,
    });
    const db = openDatabase(getDbPath(projectDir));
    const store = new reviewWorkflowPersistence.ReviewWorkflowStore(db);
    store.createWorkflow({
      workflowId: WORKFLOW_ID,
      status: 'ACTIVE',
      generalPlanVersionId: `${WORKFLOW_ID}:general-plan`,
      implementerAssignmentId: snapshot.assignments.implementer.assignmentId,
      reviewerAssignmentId: snapshot.assignments.reviewer.assignmentId,
      configurationHash: snapshot.configurationHash,
      createdAt: NOW,
      updatedAt: NOW,
    });
    store.saveEntity({ kind: 'AGENT_ASSIGNMENT', value: snapshot.assignments.implementer });
    store.saveEntity({ kind: 'AGENT_ASSIGNMENT', value: snapshot.assignments.reviewer });
    store.createBatch({
      batchId: BATCH_ID,
      workflowId: WORKFLOW_ID,
      ordinal: 13,
      persistedState: 'VERIFYING',
      aggregateVersion: 0,
      currentPlanVersionId: `${BATCH_ID}:plan:1`,
      implementerAssignmentId: snapshot.assignments.implementer.assignmentId,
      reviewerAssignmentId: snapshot.assignments.reviewer.assignmentId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.close();
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('enqueues a background verification and returns job and command IDs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await reviewWorkflowBatchVerifyCommand(WORKFLOW_ID, '13', {
      command: 1,
      timeout: 600,
      background: true,
    });
    const printed = logSpy.mock.calls.at(-1)?.[0];
    expect(typeof printed).toBe('string');
    if (typeof printed !== 'string') return;
    const output: unknown = JSON.parse(printed);
    expect(output).toEqual({
      status: 'QUEUED',
      jobId: `${BATCH_ID}:verify:1:job`,
      commandId: `${BATCH_ID}:verify:1`,
    });

    const db = openDatabase(getDbPath(projectDir));
    const jobStore = new reviewWorkflowJobs.ReviewWorkflowJobStore(db);
    const job = jobStore.require(`${BATCH_ID}:verify:1:job`);
    expect(job.status).toBe('QUEUED');
    expect(job.jobType).toBe('VERIFICATION');
    expect(job.commandId).toBe(`${BATCH_ID}:verify:1`);
    expect(job.expectedReceipt).toEqual({
      commandType: 'START_CODE_REVIEW',
      sideEffectKind: 'VERIFICATION_EXECUTION',
      sideEffectIdentity: `${BATCH_ID}:verify:1:record`,
    });
    expect(job.payload).toEqual({ ordinal: 13, command: 1, timeout: 600 });
    db.close();
  });

  it('refuses a job payload whose ordinal targets a different batch', () => {
    const db = openDatabase(getDbPath(projectDir));
    const store = new reviewWorkflowPersistence.ReviewWorkflowStore(db);
    store.createBatch({
      batchId: `${WORKFLOW_ID}:batch:14`,
      workflowId: WORKFLOW_ID,
      ordinal: 14,
      persistedState: 'DRAFT',
      aggregateVersion: 0,
      currentPlanVersionId: `${WORKFLOW_ID}:batch:14:plan:1`,
      implementerAssignmentId: `${WORKFLOW_ID}:assignment:implementer`,
      reviewerAssignmentId: `${WORKFLOW_ID}:assignment:reviewer`,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const planStore = new reviewWorkflowPlan.ReviewWorkflowPlanStore(db);
    // Ordinal 14 resolves to a real batch — but not the job's authoritative batch.
    expect(() => requireBatchMatchingJob(planStore, WORKFLOW_ID, 14, BATCH_ID)).toThrowError(
      /resolves to batch .*, not the job's batch/,
    );
    const matched = requireBatchMatchingJob(planStore, WORKFLOW_ID, 13, BATCH_ID);
    expect(matched.batchId).toBe(BATCH_ID);
    db.close();
  });
});
