import { createHash } from 'node:crypto';
import {
  actorExecutionIdentitySchema,
  agentAssignmentSchema,
  invocationIdentitySchema,
  sessionIdentitySchema,
} from '../review-workflow/schemas.js';
import type {
  AgentAdapterKind,
  AgentAssignment,
  CommitPolicy,
  FindingSeverity,
  IdentityAssuranceLevel,
} from '../review-workflow/types.js';
import type {
  CliAdapterKind,
  ModelConfig,
  ProjectConfig,
  ReviewGatedConfig,
  ReviewGatedIdentityAssurance,
} from '../types/config.js';
import { createAuthorityGrantSnapshot } from './authority-policy.js';
import {
  identityAssuranceEvaluationSchema,
  reviewWorkflowConfigurationSnapshotSchema,
  reviewWorkflowIdentityPolicySnapshotSchema,
} from './schemas.js';
import type {
  AgentExecutionEvidence,
  ConfigurationSnapshotInput,
  IdentityAssuranceEvaluation,
  IdentityAssuranceEvaluationInput,
  IdentityAssuranceViolation,
  IdentityAssuranceViolationCode,
  ReviewWorkflowConfigurationSnapshot,
} from './types.js';

const ASSURANCE_ORDER: Record<IdentityAssuranceLevel, number> = {
  CONFIG_ONLY: 0,
  PROCESS_ATTESTED: 1,
  CLI_ASSERTED: 2,
  AUTHENTICATED_SUBJECT: 3,
};

const CONFIG_ASSURANCE_TO_DOMAIN: Record<ReviewGatedIdentityAssurance, IdentityAssuranceLevel> = {
  config_only: 'CONFIG_ONLY',
  process_attested: 'PROCESS_ATTESTED',
  cli_asserted: 'CLI_ASSERTED',
  authenticated_subject: 'AUTHENTICATED_SUBJECT',
};

const CONFIG_COMMIT_TO_DOMAIN: Record<ReviewGatedConfig['commit']['mode'], CommitPolicy> = {
  human_required: 'HUMAN_REQUIRED',
  agent_authorized: 'AGENT_AUTHORIZED',
  either: 'EITHER',
};

const CONFIG_SEVERITY_TO_DOMAIN: Record<
  ReviewGatedConfig['gates']['blockingSeverities'][number],
  FindingSeverity
> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

export class ReviewWorkflowIdentityError extends Error {
  constructor(
    readonly code:
      | 'REVIEW_GATED_CONFIG_REQUIRED'
      | 'ASSIGNMENT_CONFIG_INVALID'
      | 'ROLE_CONFIG_MISSING'
      | 'MODEL_CONFIG_MISSING',
    message: string,
  ) {
    super(message);
    this.name = 'ReviewWorkflowIdentityError';
  }
}

const ADAPTER_KIND_TO_DOMAIN: Readonly<Record<CliAdapterKind, AgentAdapterKind>> = {
  claude: 'CLAUDE',
  codex: 'CODEX',
  cursor: 'CURSOR',
};

export function resolveConfiguredAdapterKind(model: ModelConfig): AgentAdapterKind {
  // A total map, not a binary: the previous `claude ? 'CLAUDE' : 'CODEX'` would have
  // silently labelled every Cursor assignment CODEX — and adapter kind is what
  // requireDifferentAdapterKinds compares to prove reviewer independence.
  const configuredKind: CliAdapterKind =
    model.cliAdapter?.kind ??
    (model.provider === 'anthropic' ? 'claude' : model.provider === 'cursor' ? 'cursor' : 'codex');
  return ADAPTER_KIND_TO_DOMAIN[configuredKind];
}

/**
 * Hashes the configuration the ROLE ASSIGNMENTS depend on — deliberately not the whole file.
 *
 * This hash answers one question: are the assignments recorded for this workflow still the
 * ones the current configuration would produce? Models, roles, the workflow kind and the
 * identity policy decide that. `reviewGated.autonomous` does not — those are operational
 * limits, and they are frozen separately into runner state at start.
 *
 * Hashing the entire ProjectConfig conflated the two, so raising a token budget invalidated
 * the assignments and blocked resume. A workflow that hit a limit which turned out to be
 * structurally too small could not be continued at all: the limit was frozen, and editing it
 * broke the hash. Two things frozen for different reasons should not share one check.
 */
export function hashReviewWorkflowConfiguration(config: ProjectConfig): string {
  // `operatorMode` is excluded for the same reason `autonomous` is: it says nothing about
  // which model holds which role. It is ALSO the setting most wanted mid-flight — a stuck
  // workflow is exactly when an operator reaches for trusted_local — so including it made
  // the rescue hatch itself invalidating.
  const {
    autonomous: _operationalLimits,
    operatorMode: _operatorMode,
    ...assignmentPolicy
  } = config.reviewGated ?? {};
  return createHash('sha256')
    .update(
      canonicalJson({
        workflow: config.workflow,
        models: config.models,
        roles: config.roles,
        reviewGated: config.reviewGated === undefined ? undefined : assignmentPolicy,
      }),
    )
    .digest('hex');
}

export function createReviewWorkflowConfigurationSnapshot(
  config: ProjectConfig,
  input: ConfigurationSnapshotInput,
): ReviewWorkflowConfigurationSnapshot {
  const policy = config.reviewGated;
  if (policy === undefined || config.workflow !== 'review-gated-batches') {
    throw new ReviewWorkflowIdentityError(
      'REVIEW_GATED_CONFIG_REQUIRED',
      'workflow "review-gated-batches" and reviewGated configuration are required',
    );
  }
  // Trusted-operator mode accepts cli_asserted: attestation proves WHICH PROCESS spoke, and
  // in a single-operator local run the operator watched it speak. Session isolation is NOT
  // relaxed — that is reviewer independence, which is the product rather than a guard.
  const trustedLocal = policy.operatorMode === 'trusted_local';
  if (
    (policy.identity.minimumAssurance === 'config_only' && !trustedLocal) ||
    !policy.identity.prohibitSharedSessions
  ) {
    throw new ReviewWorkflowIdentityError(
      'ASSIGNMENT_CONFIG_INVALID',
      'Review-gated identity policy requires isolated sessions and process-attested assurance or stronger',
    );
  }

  const implementer = resolveAssignment(config, 'implementer', input, policy);
  const reviewer = resolveAssignment(config, 'reviewer', input, policy);
  assertAssignmentConfiguration(implementer, reviewer, policy);

  const commitPolicy = CONFIG_COMMIT_TO_DOMAIN[policy.commit.mode];
  const snapshot = {
    workflowId: input.workflowId,
    ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
    configurationHash: implementer.configurationHash,
    identityPolicy: {
      minimumAssurance: CONFIG_ASSURANCE_TO_DOMAIN[policy.identity.minimumAssurance],
      requireDifferentAdapterKinds: policy.identity.requireDifferentAdapterKinds,
      prohibitSharedSessions: true,
    },
    commitPolicy,
    agentMayCommit: policy.commit.agentMayCommit,
    gates: {
      planReviewRequired: policy.gates.planReview === 'required',
      codeReviewRequired: policy.gates.codeReview === 'required',
      verificationRequired: policy.gates.verification === 'required',
      humanMergeRequired: policy.gates.humanMerge === 'required',
      blockingSeverities: policy.gates.blockingSeverities.map(
        (severity) => CONFIG_SEVERITY_TO_DOMAIN[severity],
      ),
      requireAllFindingResponses: policy.gates.requireAllFindingResponses,
      requireAcceptedAttestations: policy.gates.requireAcceptedAttestations,
    },
    pacing: {
      maxCodeReviewRounds: policy.pacing.maxCodeReviewRounds,
      maxCorrectionPasses: policy.pacing.maxCorrectionPasses,
      deferNonBlockingFindings: policy.pacing.deferNonBlockingFindings,
      unresolvedAfterFinalReview: policy.pacing.unresolvedAfterFinalReview,
    },
    assignments: { implementer, reviewer },
    authorityGrants: createAuthorityGrantSnapshot(commitPolicy),
  };
  return reviewWorkflowConfigurationSnapshotSchema.parse(snapshot);
}

export function evaluateIdentityAssurance(
  input: IdentityAssuranceEvaluationInput,
): IdentityAssuranceEvaluation {
  const normalizedInput = normalizeEvaluationInput(input);
  const violations: IdentityAssuranceViolation[] = [];
  const add = (code: IdentityAssuranceViolationCode, message: string): void => {
    violations.push({ code, message });
  };

  collectAssignmentViolations(normalizedInput, add);
  collectExecutionViolations(normalizedInput, add);

  const effectiveAssurance = effectiveAssuranceFor(normalizedInput, add);
  const minimumAssuranceSatisfied =
    ASSURANCE_ORDER[effectiveAssurance] >= ASSURANCE_ORDER[normalizedInput.policy.minimumAssurance];
  if (!minimumAssuranceSatisfied) {
    add(
      'IDENTITY_ASSURANCE_INSUFFICIENT',
      `Effective identity assurance ${effectiveAssurance} does not satisfy ${normalizedInput.policy.minimumAssurance}`,
    );
  }

  const subjectSeparation = authenticatedSubjectSeparationFor(normalizedInput);
  if (subjectSeparation === 'REUSED') {
    add(
      'AUTHENTICATED_SUBJECT_REUSED',
      'Implementer and reviewer invocations report the same authenticated subject hash',
    );
  }

  return identityAssuranceEvaluationSchema.parse({
    valid: violations.length === 0,
    effectiveAssurance,
    minimumAssuranceSatisfied,
    authenticatedSubjectSeparation: subjectSeparation,
    violations,
  });
}

function normalizeEvaluationInput(
  input: IdentityAssuranceEvaluationInput,
): IdentityAssuranceEvaluationInput {
  return {
    policy: reviewWorkflowIdentityPolicySnapshotSchema.parse(input.policy),
    implementerAssignment: agentAssignmentSchema.parse(input.implementerAssignment),
    reviewerAssignment: agentAssignmentSchema.parse(input.reviewerAssignment),
    ...(input.implementer === undefined
      ? {}
      : { implementer: parseExecutionEvidence(input.implementer) }),
    ...(input.reviewer === undefined ? {} : { reviewer: parseExecutionEvidence(input.reviewer) }),
  };
}

function resolveAssignment(
  config: ProjectConfig,
  roleName: 'implementer' | 'reviewer',
  input: ConfigurationSnapshotInput,
  policy: ReviewGatedConfig,
): AgentAssignment {
  const role = config.roles[roleName];
  if (role === undefined) {
    throw new ReviewWorkflowIdentityError(
      'ROLE_CONFIG_MISSING',
      `Review-gated workflow requires roles.${roleName}`,
    );
  }
  const model = config.models[role.model];
  if (model === undefined) {
    throw new ReviewWorkflowIdentityError(
      'MODEL_CONFIG_MISSING',
      `Role "${roleName}" references missing model "${role.model}"`,
    );
  }
  const configurationHash = hashReviewWorkflowConfiguration(config);
  const adapterKind = resolveConfiguredAdapterKind(model);
  const assignment = {
    assignmentId:
      roleName === 'implementer' ? input.implementerAssignmentId : input.reviewerAssignmentId,
    workflowId: input.workflowId,
    ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
    assignedRole: roleName === 'implementer' ? 'IMPLEMENTER' : 'REVIEWER',
    configuredAgentKey: role.model,
    configuredModelAlias: role.model,
    expectedAdapterKind: adapterKind,
    provider: model.provider,
    configuredModel: model.model,
    executable: model.cliAdapter?.command ?? (adapterKind === 'CLAUDE' ? 'claude' : 'codex'),
    ...(model.cliAdapter?.versionConstraint === undefined
      ? {}
      : { versionConstraint: model.cliAdapter.versionConstraint }),
    commitPermission:
      roleName === 'implementer' && policy.commit.agentMayCommit ? 'AUTHORIZED' : 'DENIED',
    configurationHash,
    assignedAt: input.assignedAt,
  };
  return agentAssignmentSchema.parse(assignment);
}

function assertAssignmentConfiguration(
  implementer: AgentAssignment,
  reviewer: AgentAssignment,
  policy: ReviewGatedConfig,
): void {
  if (
    implementer.assignmentId === reviewer.assignmentId ||
    implementer.configuredAgentKey === reviewer.configuredAgentKey
  ) {
    throw new ReviewWorkflowIdentityError(
      'ASSIGNMENT_CONFIG_INVALID',
      'Implementer and reviewer must use different assignment IDs and configured agent keys',
    );
  }
  if (
    policy.identity.requireDifferentAdapterKinds &&
    implementer.expectedAdapterKind === reviewer.expectedAdapterKind
  ) {
    throw new ReviewWorkflowIdentityError(
      'ASSIGNMENT_CONFIG_INVALID',
      'Identity policy requires different implementer and reviewer adapter kinds',
    );
  }
}

function collectAssignmentViolations(
  input: IdentityAssuranceEvaluationInput,
  add: (code: IdentityAssuranceViolationCode, message: string) => void,
): void {
  const { implementerAssignment: implementer, reviewerAssignment: reviewer } = input;
  if (implementer.assignmentId === reviewer.assignmentId) {
    add('ASSIGNMENT_ID_REUSED', 'Implementer and reviewer assignment IDs must differ');
  }
  if (implementer.configuredAgentKey === reviewer.configuredAgentKey) {
    add('CONFIGURED_AGENT_REUSED', 'Implementer and reviewer configured agent keys must differ');
  }
  if (
    input.policy.requireDifferentAdapterKinds &&
    implementer.expectedAdapterKind === reviewer.expectedAdapterKind
  ) {
    add('ADAPTER_KIND_REUSED', 'Implementer and reviewer adapter kinds must differ');
  }
  if (implementer.assignedRole !== 'IMPLEMENTER' || reviewer.assignedRole !== 'REVIEWER') {
    add('ASSIGNED_ROLE_INVALID', 'Assignments must carry implementer and reviewer roles');
  }
  if (implementer.workflowId !== reviewer.workflowId) {
    add('WORKFLOW_MISMATCH', 'Implementer and reviewer assignments must share a workflow');
  }
  if (implementer.batchId !== reviewer.batchId) {
    add('BATCH_SCOPE_MISMATCH', 'Implementer and reviewer assignments target different batches');
  }
  if (implementer.configurationHash !== reviewer.configurationHash) {
    add(
      'CONFIGURATION_HASH_MISMATCH',
      'Implementer and reviewer assignments must share a configuration snapshot',
    );
  }
}

function collectExecutionViolations(
  input: IdentityAssuranceEvaluationInput,
  add: (code: IdentityAssuranceViolationCode, message: string) => void,
): void {
  if (input.implementer === undefined || input.reviewer === undefined) {
    add('EXECUTION_REQUIRED', 'Both agent executions are required by the identity policy');
  }
  if (input.implementer === undefined || input.reviewer === undefined) return;

  const implementer = input.implementer;
  const reviewer = input.reviewer;
  collectExecutionRoleViolations(implementer, input.implementerAssignment, 'IMPLEMENTER', add);
  collectExecutionRoleViolations(reviewer, input.reviewerAssignment, 'REVIEWER', add);

  if (implementer.execution.actorExecutionId === reviewer.execution.actorExecutionId) {
    add('EXECUTION_ID_REUSED', 'Implementer and reviewer execution IDs must differ');
  }
  if (
    implementer.execution.invocationIdentityId !== undefined &&
    implementer.execution.invocationIdentityId === reviewer.execution.invocationIdentityId
  ) {
    add('INVOCATION_ID_REUSED', 'Implementer and reviewer invocation IDs must differ');
  }
  if (
    input.policy.prohibitSharedSessions &&
    implementer.execution.sessionIdentityId !== undefined &&
    implementer.execution.sessionIdentityId === reviewer.execution.sessionIdentityId
  ) {
    add('SESSION_ID_REUSED', 'Implementer and reviewer session identities must differ');
  }
  if (
    input.policy.prohibitSharedSessions &&
    implementer.session !== undefined &&
    reviewer.session !== undefined &&
    implementer.session.providerOrAdapter === reviewer.session.providerOrAdapter &&
    implementer.session.vendorSessionId === reviewer.session.vendorSessionId
  ) {
    add('VENDOR_SESSION_REUSED', 'Implementer and reviewer reused the same vendor session');
  }
}

function parseExecutionEvidence(
  evidence: NonNullable<IdentityAssuranceEvaluationInput['implementer']>,
): NonNullable<IdentityAssuranceEvaluationInput['implementer']> {
  return {
    execution: actorExecutionIdentitySchema.parse(evidence.execution),
    ...(evidence.invocation === undefined
      ? {}
      : { invocation: invocationIdentitySchema.parse(evidence.invocation) }),
    ...(evidence.session === undefined
      ? {}
      : { session: sessionIdentitySchema.parse(evidence.session) }),
  };
}

function collectExecutionRoleViolations(
  evidence: NonNullable<IdentityAssuranceEvaluationInput['implementer']>,
  assignment: AgentAssignment,
  role: 'IMPLEMENTER' | 'REVIEWER',
  add: (code: IdentityAssuranceViolationCode, message: string) => void,
): void {
  if (evidence.execution.actorType !== 'AGENT') {
    add('EXECUTION_ACTOR_TYPE_INVALID', `${role} execution must be an AGENT`);
  }
  if (evidence.execution.assignmentId !== assignment.assignmentId) {
    add('EXECUTION_ASSIGNMENT_MISMATCH', `${role} execution does not match its assignment`);
  }
  if (!evidence.execution.authoritiesExercised.includes(role)) {
    add('EXECUTION_AUTHORITY_MISSING', `${role} execution does not exercise ${role} authority`);
  }
  if (evidence.execution.invocationIdentityId !== evidence.invocation?.invocationId) {
    add('INVOCATION_ID_MISMATCH', `${role} execution and invocation IDs do not match`);
  }
  if (evidence.invocation === undefined && evidence.execution.identityAssurance !== 'CONFIG_ONLY') {
    add('INVOCATION_REQUIRED', `${role} execution requires invocation identity evidence`);
  }
  if (
    evidence.invocation?.adapterKind !== undefined &&
    evidence.invocation.adapterKind !== assignment.expectedAdapterKind
  ) {
    add('INVOCATION_ADAPTER_MISMATCH', `${role} invocation used an unexpected adapter kind`);
  }
  if (
    evidence.invocation?.configuredModel !== undefined &&
    evidence.invocation.configuredModel !== assignment.configuredModel
  ) {
    add('INVOCATION_MODEL_MISMATCH', `${role} invocation used an unexpected configured model`);
  }
  if (
    evidence.execution.identityAssurance === 'AUTHENTICATED_SUBJECT' &&
    evidence.invocation?.authenticatedSubject === undefined
  ) {
    add(
      'AUTHENTICATED_SUBJECT_REQUIRED',
      `${role} execution claims authenticated-subject assurance without subject evidence`,
    );
  }
  if (evidence.execution.sessionIdentityId !== evidence.session?.sessionIdentityId) {
    if (evidence.execution.sessionIdentityId !== undefined || evidence.session !== undefined) {
      add('SESSION_ID_MISMATCH', `${role} execution and session IDs do not match`);
    }
  }
  if (evidence.session !== undefined && evidence.session.assignedRole !== role) {
    add('SESSION_ROLE_MISMATCH', `${role} session is assigned to a different role`);
  }
  if (evidence.session !== undefined && evidence.session.workflowId !== assignment.workflowId) {
    add('SESSION_WORKFLOW_MISMATCH', `${role} session belongs to a different workflow`);
  }
  if (
    evidence.session !== undefined &&
    evidence.session.creatingInvocationId !== evidence.invocation?.invocationId
  ) {
    add('SESSION_INVOCATION_MISMATCH', `${role} session does not match its creating invocation`);
  }
}

function effectiveAssuranceFor(
  input: IdentityAssuranceEvaluationInput,
  add: (code: IdentityAssuranceViolationCode, message: string) => void,
): IdentityAssuranceLevel {
  if (input.implementer === undefined || input.reviewer === undefined) return 'CONFIG_ONLY';
  const implementer = supportedAssuranceFor(input.implementer, 'IMPLEMENTER', add);
  const reviewer = supportedAssuranceFor(input.reviewer, 'REVIEWER', add);
  return ASSURANCE_ORDER[implementer] <= ASSURANCE_ORDER[reviewer] ? implementer : reviewer;
}

function supportedAssuranceFor(
  evidence: AgentExecutionEvidence,
  role: 'IMPLEMENTER' | 'REVIEWER',
  add: (code: IdentityAssuranceViolationCode, message: string) => void,
): IdentityAssuranceLevel {
  const declared = evidence.execution.identityAssurance;
  const invocation = evidence.invocation;
  const processEvidenceComplete =
    invocation !== undefined &&
    invocation.adapterKind !== undefined &&
    invocation.executablePath !== undefined &&
    invocation.cliVersion !== undefined &&
    invocation.configuredModel !== undefined &&
    invocation.processId !== undefined &&
    evidence.session !== undefined;
  const cliIdentityAsserted = evidence.execution.observedEvidence.some(
    (item) => item.kind === 'CLI_ASSERTED_IDENTITY',
  );
  const authenticatedSubjectObserved = invocation?.authenticatedSubject !== undefined;

  let supported: IdentityAssuranceLevel = 'CONFIG_ONLY';
  if (processEvidenceComplete) supported = 'PROCESS_ATTESTED';
  if (processEvidenceComplete && cliIdentityAsserted) supported = 'CLI_ASSERTED';
  if (processEvidenceComplete && authenticatedSubjectObserved) supported = 'AUTHENTICATED_SUBJECT';

  if (ASSURANCE_ORDER[declared] > ASSURANCE_ORDER[supported]) {
    add(
      'ASSURANCE_EVIDENCE_INCOMPLETE',
      `${role} declared ${declared} but supplied evidence supports only ${supported}`,
    );
  }
  return ASSURANCE_ORDER[declared] <= ASSURANCE_ORDER[supported] ? declared : supported;
}

function authenticatedSubjectSeparationFor(
  input: IdentityAssuranceEvaluationInput,
): 'PROVEN_DISTINCT' | 'REUSED' | 'PARTIAL' | 'UNAVAILABLE' {
  const implementer = input.implementer?.invocation?.authenticatedSubject?.subjectIdHash;
  const reviewer = input.reviewer?.invocation?.authenticatedSubject?.subjectIdHash;
  if (implementer === undefined && reviewer === undefined) return 'UNAVAILABLE';
  if (implementer === undefined || reviewer === undefined) return 'PARTIAL';
  return implementer === reviewer ? 'REUSED' : 'PROVEN_DISTINCT';
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .filter(([, entryValue]) => entryValue !== undefined)
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
    .join(',')}}`;
}
