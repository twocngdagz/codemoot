import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ControllerError } from './errors.mjs';

const AUTHORIZATIONS = Object.freeze({
  IMPLEMENT: {
    role: 'IMPLEMENTER',
    action: 'IMPLEMENT_COMPLETE_BATCH',
    mayModifyFiles: true,
    stopAfter: 'COMPLETE_IMPLEMENTATION_REPORT',
    template: 'implement.md',
  },
  REVIEW_INITIAL: {
    role: 'REVIEWER',
    action: 'REVIEW_COMPLETE_BATCH',
    mayModifyFiles: false,
    stopAfter: 'COMPLETE_REVIEW_ARTIFACT',
    template: 'review-initial.md',
  },
  FIX_BLOCKING_FINDINGS: {
    role: 'IMPLEMENTER',
    action: 'FIX_ALL_BLOCKING_FINDINGS',
    mayModifyFiles: true,
    stopAfter: 'COMPLETE_CORRECTION_REPORT',
    template: 'fix-blocking-findings.md',
  },
  REVIEW_FINAL: {
    role: 'REVIEWER',
    action: 'VERIFY_BLOCKING_FINDINGS',
    mayModifyFiles: false,
    stopAfter: 'COMPLETE_FINAL_REVIEW_ARTIFACT',
    template: 'review-final.md',
  },
});
const TEMPLATE_ROOT = fileURLToPath(new URL('../prompts/', import.meta.url));

export function authorizationFor(state) {
  const definition = AUTHORIZATIONS[state.phase];
  if (!definition) {
    throw new ControllerError(
      'NO_AGENT_ACTION',
      `Phase ${state.phase} does not authorise an agent action`,
    );
  }
  const agent = definition.role === 'IMPLEMENTER' ? state.implementer : state.reviewer;
  return {
    workflowId: state.workflowId,
    batchId: state.activeBatch,
    phase: state.phase,
    authorisedRole: definition.role,
    authorisedAgent: agent,
    allowedAction: definition.action,
    mayModifyFiles: definition.mayModifyFiles,
    mayCommit: false,
    mayPush: false,
    mayStartNextBatch: false,
    stopAfter: definition.stopAfter,
  };
}

function artifactReferences(state, repositoryRoot) {
  return Object.entries(state.artifacts)
    .filter(([, path]) => typeof path === 'string')
    .map(
      ([name, path]) =>
        `- ${name}: ${path.startsWith('/') ? relative(repositoryRoot, path) : path}`,
    )
    .join('\n');
}

export async function buildPrompt(config, state, snapshot, options = {}) {
  const authorization = authorizationFor(state);
  const definition = AUTHORIZATIONS[state.phase];
  const templatePath = join(TEMPLATE_ROOT, definition.template);
  const template = await readFile(templatePath, 'utf8');
  const skillInvocation =
    authorization.authorisedAgent === 'codex' ? '$review-gated-batch' : '/review-gated-batch';
  const references = artifactReferences(state, config.repositoryRoot) || '- none';
  const changedFiles = snapshot.changedFiles.map((path) => `- ${path}`).join('\n') || '- none';
  const criteria =
    state.requiredAcceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n') || '- none';

  return `${template.trim()}

Invoke repository skill: ${skillInvocation}

Single-use authorisation envelope:
\`\`\`json
${JSON.stringify(authorization, null, 2)}
\`\`\`

Canonical inputs:
- live state: ${relative(config.repositoryRoot, config.stateFile)}
- approved plan: ${state.batchPlanPath}
- base SHA: ${state.baseSha}
- current HEAD: ${snapshot.headSha}
- worktree fingerprint: ${snapshot.fingerprint}
- output schema: ${options.schemaPath ?? 'selected by the controller'}

Changed files to inspect or account for:
${changedFiles}

Required acceptance criteria:
${criteria}

Prior artefacts:
${references}

Perform only the authorised action. Do not edit controller state. Do not start another phase.
Do not begin another batch. Return exactly one complete raw JSON artefact and no prose. Stop
immediately after the artefact.
`;
}

export function buildRepairPrompt(state, invalidRawPath, schemaPath) {
  return `Invoke the repository review-gated skill in ${state.phase} mode.

Your prior work is complete, but its output did not validate. Do not repeat the implementation
or review and do not inspect for additional findings. Using only the existing analysis, return
one complete raw JSON artefact matching:

- schema: ${schemaPath}
- invalid raw output: ${invalidRawPath}
- workflowId: ${state.workflowId}
- batchId: ${state.activeBatch}

Do not edit files or controller state. Do not choose a phase, commit, push, or start another
batch. Return JSON only, then stop.
`;
}
