import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError, Option } from 'commander';

import { CLEANUP_TIMEOUT_SEC, VERSION } from '@codemoot/core';

import {
  buildEventCommand,
  buildListCommand,
  buildReviewCommand,
  buildStartCommand,
  buildStatusCommand,
} from './commands/build.js';
import { cleanupCommand } from './commands/cleanup.js';
import { costCommand } from './commands/cost.js';
import {
  debateCompleteCommand,
  debateHistoryCommand,
  debateListCommand,
  debateNextCommand,
  debateStartCommand,
  debateStatusCommand,
  debateTurnCommand,
} from './commands/debate.js';
import { doctorCommand } from './commands/doctor.js';
import { eventsCommand } from './commands/events.js';
import { fixCommand } from './commands/fix.js';
import { initCommand } from './commands/init.js';
import { installSkillsCommand } from './commands/install-skills.js';
import {
  jobsCancelCommand,
  jobsListCommand,
  jobsLogsCommand,
  jobsRetryCommand,
  jobsStatusCommand,
} from './commands/jobs.js';
import { planGenerateCommand, planReviewCommand } from './commands/plan.js';
import {
  reviewWorkflowBatchAttestVerificationCommand,
  reviewWorkflowBatchCompleteImplementationCommand,
  reviewWorkflowBatchFinalAuditCommand,
  reviewWorkflowBatchFindingsCommand,
  reviewWorkflowBatchGateCommand,
  reviewWorkflowBatchImplementCommand,
  reviewWorkflowBatchListCommand,
  reviewWorkflowBatchMarkMergedCommand,
  reviewWorkflowBatchReconcileStaleCommand,
  reviewWorkflowBatchRespondCommand,
  reviewWorkflowBatchResumeImplementationCommand,
  reviewWorkflowBatchReviewCodeCommand,
  reviewWorkflowBatchReviewPlanCommand,
  reviewWorkflowBatchShowCommand,
  reviewWorkflowBatchVerifyCommand,
  reviewWorkflowDecideCommand,
  reviewWorkflowEventsCommand,
  reviewWorkflowExportCommand,
  reviewWorkflowJobsCancelCommand,
  reviewWorkflowJobsListCommand,
  reviewWorkflowJobsRunCommand,
  reviewWorkflowJobsShowCommand,
  reviewWorkflowLogsCommand,
  reviewWorkflowRefineCommand,
  reviewWorkflowRunCommand,
  reviewWorkflowRunResumeCommand,
  reviewWorkflowStartCommand,
  reviewWorkflowStatusCommand,
  reviewWorkflowWatchCommand,
} from './commands/review-workflow.js';
import { reviewCommand } from './commands/review.js';
import { runCommand } from './commands/run.js';
import {
  sessionCloseCommand,
  sessionCurrentCommand,
  sessionListCommand,
  sessionStartCommand,
  sessionStatusCommand,
} from './commands/session.js';
import { shipitCommand } from './commands/shipit.js';
import { startCommand } from './commands/start.js';
import { watchCommand } from './commands/watch.js';
import { workerCommand } from './commands/worker.js';

const program = new Command();

const positiveInteger = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError('Value must be a positive integer');
  }
  return Number.parseInt(value, 10);
};

const parseAttestationMode = (value: string): 'automatic' | 'human' => {
  if (value !== 'automatic' && value !== 'human') {
    throw new InvalidArgumentError("Mode must be 'automatic' or 'human'");
  }
  return value;
};

const parseAttestationDecision = (value: string): 'accepted' | 'rejected' => {
  if (value !== 'accepted' && value !== 'rejected') {
    throw new InvalidArgumentError("Decision must be 'accepted' or 'rejected'");
  }
  return value;
};

program
  .name('codemoot')
  .description('Multi-model collaborative AI development tool')
  .version(VERSION)
  .option('--verbose', 'Enable debug logging');

program
  .command('start')
  .description('First-run setup: verify codex, init config, run quick review')
  .action(startCommand);

program
  .command('doctor')
  .description('Preflight diagnostics: check codex, config, database, git, node')
  .action(doctorCommand);

program
  .command('install-skills')
  .description('Install Claude Code slash commands (/debate, /build, /codex-review, /cleanup)')
  .option('--force', 'Overwrite existing skill files', false)
  .action(installSkillsCommand);

program
  .command('init')
  .description('Initialize CodeMoot in the current project')
  .option('--preset <name>', 'Use preset (cli-first|review-gated)')
  .option('--non-interactive', 'Skip prompts, use defaults')
  .option('--force', 'Overwrite existing .cowork.yml')
  .action(initCommand);

program
  .command('run')
  .description('Run a task through the full workflow')
  .argument('<task>', 'Task description (natural language)')
  .option('--mode <mode>', 'Execution mode (autonomous|interactive)', 'autonomous')
  .option(
    '--max-iterations <n>',
    'Max review loop iterations',
    (v: string) => Number.parseInt(v, 10),
    3,
  )
  .option('--no-stream', 'Disable streaming output')
  .action(runCommand);

program
  .command('review')
  .description('Review code via codex — files, prompts, or diffs')
  .argument('[file-or-glob]', 'File path or glob pattern to review')
  .option('--prompt <instruction>', 'Freeform prompt — codex explores codebase via tools')
  .option('--stdin', 'Read prompt from stdin')
  .option('--diff <revspec>', 'Review a git diff (e.g., HEAD~3..HEAD, origin/main...HEAD)')
  .option(
    '--scope <glob>',
    'Restrict codex exploration to matching files (only with --prompt/--stdin)',
  )
  .addOption(
    new Option('--focus <area>', 'Focus area')
      .choices(['security', 'performance', 'bugs', 'all'])
      .default('all'),
  )
  .option(
    '--preset <name>',
    'Use named preset (security-audit|performance|quick-scan|pre-commit|api-review)',
  )
  .option('--session <id>', 'Use specific session (default: active session)')
  .option('--background', 'Enqueue review and return immediately')
  .option(
    '--timeout <seconds>',
    'Timeout in seconds',
    (v: string) => {
      if (!/^\d+$/.test(v)) throw new InvalidArgumentError('Timeout must be a positive integer');
      const n = Number.parseInt(v, 10);
      if (n <= 0) throw new InvalidArgumentError('Timeout must be a positive integer');
      return n;
    },
    600,
  )
  .action(reviewCommand);

program
  .command('cleanup')
  .description(
    'Scan codebase for AI slop: security vulns, anti-patterns, near-duplicates, dead code, and more',
  )
  .argument('[path]', 'Project path to scan', '.')
  .addOption(
    new Option('--scope <scope>', 'What to scan for')
      .choices([
        'deps',
        'unused-exports',
        'hardcoded',
        'duplicates',
        'deadcode',
        'security',
        'near-duplicates',
        'anti-patterns',
        'all',
      ])
      .default('all'),
  )
  .option(
    '--timeout <seconds>',
    'Codex scan timeout in seconds',
    (v: string) => {
      if (!/^\d+$/.test(v)) throw new InvalidArgumentError('Timeout must be a positive integer');
      const n = Number.parseInt(v, 10);
      if (n <= 0) throw new InvalidArgumentError('Timeout must be a positive integer');
      return n;
    },
    CLEANUP_TIMEOUT_SEC,
  )
  .option(
    '--max-disputes <n>',
    'Max findings to adjudicate',
    (v: string) => {
      if (!/^\d+$/.test(v)) throw new InvalidArgumentError('Must be a non-negative integer');
      return Number.parseInt(v, 10);
    },
    10,
  )
  .option('--host-findings <path>', 'JSON file with host AI findings for 3-way merge')
  .option('--output <path>', 'Write findings report to JSON file')
  .option('--background', 'Enqueue cleanup and return immediately')
  .option('--no-gitignore', 'Skip .gitignore rules (scan everything)')
  .option('--quiet', 'Suppress human-readable summary')
  .action(cleanupCommand);

const plan = program
  .command('plan')
  .description('Plan generation and review — write plans, get GPT review');

plan
  .command('generate')
  .description('Generate a plan using architect + reviewer loop')
  .argument('<task>', 'Task to plan')
  .option('--rounds <n>', 'Max plan-review rounds', (v: string) => Number.parseInt(v, 10), 3)
  .option('--output <file>', 'Save plan to file')
  .action(planGenerateCommand);

plan
  .command('review')
  .description('Send a host-authored plan to codex for review')
  .argument('<plan-file>', 'Plan file to review (use - for stdin)')
  .option('--build <id>', 'Link review to a build ID')
  .option('--phase <id>', 'Phase identifier (e.g. "1", "setup")')
  .option('--timeout <seconds>', 'Review timeout', (v: string) => Number.parseInt(v, 10), 300)
  .option('--output <file>', 'Save review result to file')
  .action(planReviewCommand);

const reviewWorkflow = program
  .command('workflow')
  .description('Review-gated workflow plan intake, refinement, and status');

reviewWorkflow
  .command('start')
  .description('Import an external plan and capture a fresh repository audit')
  .requiredOption('--plan <file>', 'External Markdown plan file')
  .option('--id <workflow-id>', 'Explicit workflow ID')
  .action((options: { readonly plan: string; readonly id?: string }) =>
    reviewWorkflowStartCommand(options.plan, options),
  );

reviewWorkflow
  .command('status')
  .description('Show a review-gated workflow and all batch states')
  .argument('<workflow-id>', 'Review workflow ID')
  .action(reviewWorkflowStatusCommand);

reviewWorkflow
  .command('refine')
  .description('Audit and refine the imported plan into complete batch plans')
  .argument('<workflow-id>', 'Review workflow ID')
  .option('--timeout <seconds>', 'Plan-refiner timeout in seconds', positiveInteger, 900)
  .action(reviewWorkflowRefineCommand);

const reviewWorkflowBatch = program
  .command('batch')
  .description('Inspect and execute review-gated batches');

reviewWorkflowBatch
  .command('list')
  .description('List batches in one review-gated workflow')
  .argument('<workflow-id>', 'Review workflow ID')
  .action(reviewWorkflowBatchListCommand);

reviewWorkflowBatch
  .command('show')
  .description('Show one materialized batch plan and its acceptance criteria')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .action(reviewWorkflowBatchShowCommand);

reviewWorkflowBatch
  .command('review-plan')
  .description('Run an independent structured review of one batch plan')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .option('--round <number>', 'Plan-review round number', positiveInteger, 1)
  .option('--timeout <seconds>', 'Plan-review timeout in seconds', positiveInteger, 900)
  .action(reviewWorkflowBatchReviewPlanCommand);

reviewWorkflowBatch
  .command('implement')
  .description('Execute one completely approved batch through its structured handoff')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .addOption(
    new Option('--commit-mode <mode>', 'Who creates the implementation commit').choices([
      'agent',
      'human',
    ]),
  )
  .option('--timeout <seconds>', 'Implementation timeout in seconds', positiveInteger, 3600)
  .action(reviewWorkflowBatchImplementCommand);

reviewWorkflowBatch
  .command('complete-implementation')
  .description('Validate the implementation commit and complete implementation')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .requiredOption('--commit <sha>', 'Resulting implementation commit SHA')
  .addOption(
    new Option('--commit-mode <mode>', 'Who created the implementation commit')
      .choices(['agent', 'human'])
      .makeOptionMandatory(),
  )
  .action(reviewWorkflowBatchCompleteImplementationCommand);

reviewWorkflowBatch
  .command('review-code')
  .description('Run one bounded independent code-review round for a completed implementation')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .option('--timeout <seconds>', 'Code-review timeout in seconds', positiveInteger, 1800)
  .option('--background', 'Enqueue as a background job and return job and command IDs')
  .action(reviewWorkflowBatchReviewCodeCommand);

reviewWorkflowBatch
  .command('findings')
  .description('List persisted code-review findings, statuses, and disposition decisions')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .action(reviewWorkflowBatchFindingsCommand);

reviewWorkflowBatch
  .command('respond')
  .description('Submit the consolidated disposition result for the correction pass')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .requiredOption('--file <path>', 'Path to the DISPOSITION_RESULT JSON handoff')
  .action(reviewWorkflowBatchRespondCommand);

reviewWorkflowBatch
  .command('resume-implementation')
  .description('Return an awaiting-commit batch to implementation')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .option('--timeout <seconds>', 'Implementer preflight timeout in seconds', positiveInteger, 300)
  .action(reviewWorkflowBatchResumeImplementationCommand);

reviewWorkflowBatch
  .command('verify')
  .description('Execute one approved plan verification command and persist the observed record')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .requiredOption(
    '--command <n>',
    'One-based index into the plan verification commands',
    positiveInteger,
  )
  .option('--timeout <seconds>', 'Verification command timeout in seconds', positiveInteger, 1800)
  .option('--tool-version <version>', 'Observed tool version recorded as evidence')
  .option('--id <command-id>', 'Stable command ID; a same-ID retry replays the persisted record')
  .option('--expected-version <n>', 'Expected batch aggregate version', positiveInteger)
  .option('--background', 'Enqueue as a background job and return job and command IDs')
  .action(reviewWorkflowBatchVerifyCommand);

reviewWorkflowBatch
  .command('attest-verification')
  .description('Attest acceptance or rejection of a persisted verification record')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .requiredOption('--record <id>', 'Verification record ID to attest')
  .requiredOption('--mode <mode>', "Attestation mode: 'automatic' or 'human'", parseAttestationMode)
  .requiredOption('--decision <decision>', "'accepted' or 'rejected'", parseAttestationDecision)
  .requiredOption('--rationale <text>', 'Recorded attestation rationale')
  .action(reviewWorkflowBatchAttestVerificationCommand);

reviewWorkflowBatch
  .command('final-audit')
  .description('Run the single bounded final completeness audit (evidence only, no transition)')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .option('--timeout <seconds>', 'Final-audit timeout in seconds', positiveInteger, 1800)
  .option('--id <command-id>', 'Stable command ID; a same-ID retry replays the persisted audit')
  .option('--expected-version <n>', 'Expected batch aggregate version', positiveInteger)
  .option('--background', 'Enqueue as a background job and return job and command IDs')
  .action(reviewWorkflowBatchFinalAuditCommand);

reviewWorkflowBatch
  .command('gate')
  .description('Evaluate every merge-gate condition; approve for merge only when all pass')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .option('--id <command-id>', 'Stable command ID; a same-ID retry replays the recorded approval')
  .option('--expected-version <n>', 'Expected batch aggregate version', positiveInteger)
  .action(reviewWorkflowBatchGateCommand);

reviewWorkflowBatch
  .command('mark-merged')
  .description('Record an externally performed merge (CodeMoot never executes merges)')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .requiredOption('--merge-sha <sha>', 'Merge commit SHA from the external merge')
  .option('--id <command-id>', 'Stable command ID; a same-ID retry replays the recorded merge')
  .option('--expected-version <n>', 'Expected batch aggregate version', positiveInteger)
  .action(reviewWorkflowBatchMarkMergedCommand);

reviewWorkflowBatch
  .command('reconcile-stale')
  .description('Persist APPROVAL_STALE once an approved batch has drifted from its approved commit')
  .argument('<workflow-id>', 'Review workflow ID')
  .argument('<ordinal>', 'One-based batch ordinal')
  .option('--id <command-id>', 'Stable command ID; a same-ID retry replays the reconciliation')
  .option('--expected-version <n>', 'Expected batch aggregate version', positiveInteger)
  .action(reviewWorkflowBatchReconcileStaleCommand);

const reviewWorkflowJobsCommand = reviewWorkflow
  .command('jobs')
  .description('Background workflow jobs: durable, receipt-bound, replay-safe');

reviewWorkflowJobsCommand
  .command('run')
  .description('Claim and process queued workflow jobs; retries never repeat invocations')
  .option('--worker <id>', 'Stable worker identity for lease ownership')
  .option('--max-jobs <n>', 'Maximum jobs to process before exiting', positiveInteger, 10)
  .option('--lease <seconds>', 'Claim lease duration in seconds', positiveInteger, 1800)
  .action(reviewWorkflowJobsRunCommand);

reviewWorkflowJobsCommand
  .command('list')
  .description('List background jobs for a workflow')
  .argument('<workflow-id>', 'Review workflow ID')
  .action(reviewWorkflowJobsListCommand);

reviewWorkflowJobsCommand
  .command('show')
  .description('Show one background job, including payload and recorded outcome')
  .argument('<job-id>', 'Job ID')
  .action(reviewWorkflowJobsShowCommand);

reviewWorkflowJobsCommand
  .command('cancel')
  .description('Cancel a queued or running background job')
  .argument('<job-id>', 'Job ID')
  .action(reviewWorkflowJobsCancelCommand);

reviewWorkflow
  .command('run')
  .description('Autonomously run a complete review-gated workflow from a Markdown plan')
  .requiredOption('--plan <file>', 'External Markdown plan file')
  .option('--background', 'Run detached and return the workflow ID immediately')
  .option('--timeout <seconds>', 'Per-invocation timeout in seconds', positiveInteger, 1800)
  .option('--id <workflow-id>', 'Explicit workflow ID')
  .action(reviewWorkflowRunCommand);

reviewWorkflow
  .command('run-resume')
  .description('Resume an autonomous workflow (also used by the background worker)')
  .argument('<workflow-id>', 'Review workflow ID')
  .option('--timeout <seconds>', 'Per-invocation timeout in seconds', positiveInteger, 1800)
  .option('--background', 'Resume detached', false)
  .action((workflowId: string, options: { timeout: number; background?: boolean }) =>
    reviewWorkflowRunResumeCommand(workflowId, options),
  );

reviewWorkflow
  .command('watch')
  .description('Stream durable runner progress until the workflow reaches a terminal state')
  .argument('<workflow-id>', 'Review workflow ID')
  .action(reviewWorkflowWatchCommand);

reviewWorkflow
  .command('logs')
  .description('Read the immutable invocation audit (full prompts and responses)')
  .argument('<workflow-id>', 'Review workflow ID')
  .option('--batch <batch-id>', 'Filter by batch ID')
  .option('--phase <phase>', 'Filter by phase')
  .option('--invocation <invocation-id>', 'Filter by invocation ID')
  .action(reviewWorkflowLogsCommand);

reviewWorkflow
  .command('export')
  .description('Export the complete chronological workflow audit to a file')
  .argument('<workflow-id>', 'Review workflow ID')
  .requiredOption('--output <file>', 'Output file path')
  .action(reviewWorkflowExportCommand);

reviewWorkflow
  .command('decide')
  .description('Record the explicit human decision on a stopped autonomous workflow')
  .argument('<workflow-id>', 'Review workflow ID')
  .addOption(
    new Option('--action <action>', 'Human decision')
      .choices(['fix_again', 'accept_risk', 'cancel'])
      .makeOptionMandatory(),
  )
  .requiredOption('--rationale <text>', 'Recorded decision rationale')
  .option('--findings <ids>', 'Comma-separated finding IDs (accept_risk)')
  .option('--actor <name>', 'Deciding human identity')
  .action(reviewWorkflowDecideCommand);

reviewWorkflow
  .command('events')
  .description('Read workflow events incrementally by event-ID cursor')
  .argument('<workflow-id>', 'Review workflow ID')
  .option(
    '--after <event-id>',
    'Read events with an event ID greater than this',
    positiveInteger,
    0,
  )
  .option('--limit <n>', 'Maximum events to return', positiveInteger, 100)
  .option('--cursor <id>', 'Named durable cursor; reading starts after its last position')
  .option('--ack', 'Advance the named cursor past the returned events')
  .option('--tail <count>', 'Return only the most recent events', positiveInteger)
  .action(reviewWorkflowEventsCommand);

const debate = program.command('debate').description('Multi-model debate with session persistence');

debate
  .command('start')
  .description('Start a new debate')
  .argument('<topic>', 'Debate topic or question')
  .option('--max-rounds <n>', 'Max debate rounds', (v: string) => Number.parseInt(v, 10), 5)
  .option('--timeout <seconds>', 'Default timeout for debate turns in seconds', (v: string) => {
    if (!/^\d+$/.test(v)) throw new InvalidArgumentError('Timeout must be a positive integer');
    const n = Number.parseInt(v, 10);
    if (n <= 0) throw new InvalidArgumentError('Timeout must be a positive integer');
    return n;
  })
  .action(debateStartCommand);

debate
  .command('turn')
  .description('Send a prompt to GPT and get critique (with session resume)')
  .argument('<debate-id>', 'Debate ID from start command')
  .argument('<prompt>', 'Prompt to send to GPT')
  .option('--round <n>', 'Round number', (v: string) => Number.parseInt(v, 10))
  .option('--timeout <seconds>', 'Timeout in seconds', (v: string) => Number.parseInt(v, 10))
  .option('--output <file>', 'Write full untruncated response to file')
  .option('--force', 'Continue past token budget limit', false)
  .option('--quiet', 'Suppress non-error stderr output', false)
  .option(
    '--response-cap <bytes>',
    'Max response bytes in JSON output (default: 16384)',
    (v: string) => Number.parseInt(v, 10),
  )
  .action(debateTurnCommand);

debate
  .command('next')
  .description('Continue debate with auto-generated prompt')
  .argument('<debate-id>', 'Debate ID')
  .option('--timeout <seconds>', 'Timeout in seconds', (v: string) => Number.parseInt(v, 10))
  .option('--output <file>', 'Write full untruncated response to file')
  .option('--force', 'Continue past token budget limit', false)
  .option('--quiet', 'Suppress non-error stderr output', false)
  .option(
    '--response-cap <bytes>',
    'Max response bytes in JSON output (default: 16384)',
    (v: string) => Number.parseInt(v, 10),
  )
  .action(debateNextCommand);

debate
  .command('status')
  .description('Show debate status and session info')
  .argument('<debate-id>', 'Debate ID')
  .action(debateStatusCommand);

debate
  .command('list')
  .description('List all debates')
  .option('--status <status>', 'Filter by status (active|completed|stale)')
  .option('--limit <n>', 'Max results', (v: string) => Number.parseInt(v, 10), 20)
  .action(debateListCommand);

debate
  .command('history')
  .description('Show full message history with token budget')
  .argument('<debate-id>', 'Debate ID')
  .option('--output <file>', 'Write full untruncated history to file')
  .action(debateHistoryCommand);

debate
  .command('complete')
  .description('Mark a debate as completed')
  .argument('<debate-id>', 'Debate ID')
  .action(debateCompleteCommand);

const build = program
  .command('build')
  .description('Automated build loop: debate → plan → implement → review → fix');

build
  .command('start')
  .description('Start a new build session')
  .argument('<task>', 'Task description')
  .option('--max-rounds <n>', 'Max debate rounds', (v: string) => Number.parseInt(v, 10), 5)
  .option('--allow-dirty', 'Allow starting with dirty working tree (auto-stashes)')
  .action(buildStartCommand);

build
  .command('status')
  .description('Show build status and event log')
  .argument('<build-id>', 'Build ID')
  .action(buildStatusCommand);

build
  .command('list')
  .description('List all builds')
  .option('--status <status>', 'Filter by status')
  .option('--limit <n>', 'Max results', (v: string) => Number.parseInt(v, 10), 20)
  .action(buildListCommand);

build
  .command('event')
  .description('Record a build event (phase transition)')
  .argument('<build-id>', 'Build ID')
  .argument('<event-type>', 'Event type (plan_approved|impl_completed|fix_completed|etc)')
  .option('--loop <n>', 'Loop index', (v: string) => Number.parseInt(v, 10))
  .option('--tokens <n>', 'Tokens used', (v: string) => Number.parseInt(v, 10))
  .action(buildEventCommand);

build
  .command('review')
  .description('Send implementation to codex for review (with codebase access)')
  .argument('<build-id>', 'Build ID')
  .action(buildReviewCommand);

const session = program
  .command('session')
  .description('Unified session management — persistent GPT context across commands');

session
  .command('start')
  .description('Start a new session')
  .option('--name <name>', 'Session name')
  .action(sessionStartCommand);

session.command('current').description('Show the active session').action(sessionCurrentCommand);

session
  .command('list')
  .description('List all sessions')
  .option('--status <status>', 'Filter by status (active|completed|stale)')
  .option('--limit <n>', 'Max results', (v: string) => Number.parseInt(v, 10), 20)
  .action(sessionListCommand);

session
  .command('status')
  .description('Show detailed session info with events')
  .argument('<session-id>', 'Session ID')
  .action(sessionStatusCommand);

session
  .command('close')
  .description('Mark a session as completed')
  .argument('<session-id>', 'Session ID')
  .action(sessionCloseCommand);

// ── Jobs (background async queue) ──

const jobs = program
  .command('jobs')
  .description('Background job queue — async reviews, cleanups, and more');

jobs
  .command('list')
  .description('List jobs')
  .option('--status <status>', 'Filter by status (queued|running|succeeded|failed|canceled)')
  .option('--type <type>', 'Filter by type (review|cleanup|build-review|composite|watch-review)')
  .option('--limit <n>', 'Max results', (v: string) => Number.parseInt(v, 10), 20)
  .action(jobsListCommand);

jobs
  .command('status')
  .description('Show job details with recent logs')
  .argument('<job-id>', 'Job ID')
  .action(jobsStatusCommand);

jobs
  .command('logs')
  .description('Show job logs')
  .argument('<job-id>', 'Job ID')
  .option(
    '--from-seq <n>',
    'Start from log sequence number',
    (v: string) => Number.parseInt(v, 10),
    0,
  )
  .option('--limit <n>', 'Max log entries', (v: string) => Number.parseInt(v, 10), 100)
  .action(jobsLogsCommand);

jobs
  .command('cancel')
  .description('Cancel a queued or running job')
  .argument('<job-id>', 'Job ID')
  .action(jobsCancelCommand);

jobs
  .command('retry')
  .description('Retry a failed job')
  .argument('<job-id>', 'Job ID')
  .action(jobsRetryCommand);

// ── Fix (autofix loop: review → fix → re-review) ──

program
  .command('fix')
  .description('Autofix loop: review code, apply fixes, re-review until approved')
  .argument('<file-or-glob>', 'File path or glob pattern to fix')
  .option('--max-rounds <n>', 'Max review-fix rounds', (v: string) => Number.parseInt(v, 10), 3)
  .addOption(
    new Option('--focus <area>', 'Focus area')
      .choices(['security', 'performance', 'bugs', 'all'])
      .default('bugs'),
  )
  .option('--timeout <seconds>', 'Timeout per round', (v: string) => Number.parseInt(v, 10), 600)
  .option('--dry-run', 'Review only, do not apply fixes', false)
  .option('--no-stage', 'Do not git-stage applied fixes')
  .option('--diff <revspec>', 'Fix issues in a git diff')
  .option('--session <id>', 'Use specific session')
  .action(fixCommand);

// ── Shipit (composite workflow profiles) ──

program
  .command('shipit')
  .description('Run composite workflow: lint → test → review → cleanup → commit')
  .addOption(
    new Option('--profile <profile>', 'Workflow profile')
      .choices(['fast', 'safe', 'full'])
      .default('safe'),
  )
  .option('--dry-run', 'Print planned steps without executing', false)
  .option('--no-commit', 'Run checks but skip commit step')
  .option('--json', 'Machine-readable JSON output', false)
  .option('--strict-output', 'Strict model output parsing', false)
  .action(shipitCommand);

// ── Cost dashboard ──

program
  .command('cost')
  .description('Token usage and cost dashboard')
  .addOption(
    new Option('--scope <scope>', 'Time scope')
      .choices(['session', 'daily', 'all'])
      .default('daily'),
  )
  .option('--days <n>', 'Number of days for daily scope', (v: string) => Number.parseInt(v, 10), 30)
  .option('--session <id>', 'Session ID for session scope')
  .action(costCommand);

// ── Watch (file change → background review) ──

program
  .command('watch')
  .description('Watch files and enqueue reviews on change')
  .option('--glob <pattern>', 'Glob pattern to watch', '**/*.{ts,tsx,js,jsx}')
  .addOption(
    new Option('--focus <area>', 'Focus area')
      .choices(['security', 'performance', 'bugs', 'all'])
      .default('all'),
  )
  .option('--timeout <seconds>', 'Review timeout', (v: string) => Number.parseInt(v, 10), 600)
  .option(
    '--quiet-ms <ms>',
    'Quiet period before flush',
    (v: string) => Number.parseInt(v, 10),
    800,
  )
  .option(
    '--max-wait-ms <ms>',
    'Max wait before forced flush',
    (v: string) => Number.parseInt(v, 10),
    5000,
  )
  .option('--cooldown-ms <ms>', 'Cooldown after flush', (v: string) => Number.parseInt(v, 10), 1500)
  .action(watchCommand);

// ── Events (tail logs as JSONL) ──

program
  .command('events')
  .description('Stream session events and job logs as JSONL')
  .option('--follow', 'Follow mode — poll for new events', false)
  .option('--since-seq <n>', 'Start from sequence number', (v: string) => Number.parseInt(v, 10), 0)
  .option('--limit <n>', 'Max events per poll', (v: string) => Number.parseInt(v, 10), 100)
  .addOption(
    new Option('--type <type>', 'Event source filter')
      .choices(['all', 'sessions', 'jobs'])
      .default('all'),
  )
  .action(eventsCommand);

// ── Worker (background job processor) ──

jobs
  .command('worker')
  .description('Start background job worker (processes queued jobs)')
  .option('--once', 'Process one job and exit', false)
  .option(
    '--poll-ms <ms>',
    'Poll interval in milliseconds',
    (v: string) => Number.parseInt(v, 10),
    2000,
  )
  .option('--worker-id <id>', 'Worker identifier', `w-${Date.now()}`)
  .action(workerCommand);

// Parse only when executed as the CLI entry point; importing this module (for command-surface
// tests) must never trigger argument parsing.
const entryPath = process.argv[1];
let invokedDirectly = false;
if (entryPath !== undefined) {
  try {
    invokedDirectly = realpathSync(entryPath) === fileURLToPath(import.meta.url);
  } catch {
    invokedDirectly = false;
  }
}
if (invokedDirectly) program.parse();

export { program };
