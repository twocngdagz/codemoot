import type { z } from 'zod';
import type {
  ActorExecutionIdentity,
  AgentAssignment,
  InvocationIdentity,
  SessionIdentity,
} from '../review-workflow/types.js';
import type * as schemas from './schemas.js';

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export const IDENTITY_ASSURANCE_VIOLATION_CODES = [
  'ASSIGNMENT_ID_REUSED',
  'CONFIGURED_AGENT_REUSED',
  'ADAPTER_KIND_REUSED',
  'ASSIGNED_ROLE_INVALID',
  'WORKFLOW_MISMATCH',
  'BATCH_SCOPE_MISMATCH',
  'CONFIGURATION_HASH_MISMATCH',
  'EXECUTION_REQUIRED',
  'EXECUTION_ACTOR_TYPE_INVALID',
  'EXECUTION_ASSIGNMENT_MISMATCH',
  'EXECUTION_ID_REUSED',
  'EXECUTION_AUTHORITY_MISSING',
  'INVOCATION_REQUIRED',
  'INVOCATION_ID_MISMATCH',
  'INVOCATION_ID_REUSED',
  'INVOCATION_ADAPTER_MISMATCH',
  'INVOCATION_MODEL_MISMATCH',
  'AUTHENTICATED_SUBJECT_REQUIRED',
  'SESSION_ID_MISMATCH',
  'SESSION_ID_REUSED',
  'SESSION_ROLE_MISMATCH',
  'SESSION_WORKFLOW_MISMATCH',
  'SESSION_INVOCATION_MISMATCH',
  'VENDOR_SESSION_REUSED',
  'ASSURANCE_EVIDENCE_INCOMPLETE',
  'IDENTITY_ASSURANCE_INSUFFICIENT',
  'AUTHENTICATED_SUBJECT_REUSED',
] as const;

export type IdentityAssuranceViolationCode = (typeof IDENTITY_ASSURANCE_VIOLATION_CODES)[number];

export type ReviewWorkflowIdentityPolicySnapshot = DeepReadonly<
  z.infer<typeof schemas.reviewWorkflowIdentityPolicySnapshotSchema>
>;
export type ReviewWorkflowGatePolicySnapshot = DeepReadonly<
  z.infer<typeof schemas.reviewWorkflowGatePolicySnapshotSchema>
>;
export type AuthorityGrantSnapshot = DeepReadonly<
  z.infer<typeof schemas.authorityGrantSnapshotSchema>
>;
export type ReviewWorkflowConfigurationSnapshot = DeepReadonly<
  z.infer<typeof schemas.reviewWorkflowConfigurationSnapshotSchema>
>;
export type IdentityAssuranceViolation = DeepReadonly<
  z.infer<typeof schemas.identityAssuranceViolationSchema>
>;
export type IdentityAssuranceEvaluation = DeepReadonly<
  z.infer<typeof schemas.identityAssuranceEvaluationSchema>
>;

export interface AgentExecutionEvidence {
  readonly execution: ActorExecutionIdentity;
  readonly invocation?: InvocationIdentity;
  readonly session?: SessionIdentity;
}

export interface IdentityAssuranceEvaluationInput {
  readonly policy: ReviewWorkflowIdentityPolicySnapshot;
  readonly implementerAssignment: AgentAssignment;
  readonly reviewerAssignment: AgentAssignment;
  readonly implementer?: AgentExecutionEvidence;
  readonly reviewer?: AgentExecutionEvidence;
}

export interface ConfigurationSnapshotInput {
  readonly workflowId: string;
  readonly batchId?: string;
  readonly implementerAssignmentId: string;
  readonly reviewerAssignmentId: string;
  readonly assignedAt: string;
}
