import { z } from 'zod';
import {
  agentAssignmentSchema,
  contentHashSchema,
  identityAssuranceLevelSchema,
} from '../review-workflow/schemas.js';
import {
  ACTOR_TYPES,
  ASSIGNED_ROLES,
  AUTHORITIES,
  FINDING_SEVERITIES,
  IDENTITY_ASSURANCE_LEVELS,
} from '../review-workflow/types.js';
import { authorityGrantSnapshotMatchesPolicy } from './authority-policy.js';
import { IDENTITY_ASSURANCE_VIOLATION_CODES } from './types.js';

export const reviewWorkflowIdentityPolicySnapshotSchema = z
  .object({
    minimumAssurance: identityAssuranceLevelSchema.refine(
      (value) => value !== 'CONFIG_ONLY',
      'Review-workflow snapshots require process-attested identity assurance or stronger',
    ),
    requireDifferentAdapterKinds: z.boolean(),
    prohibitSharedSessions: z.literal(true),
  })
  .strict();

export const reviewWorkflowGatePolicySnapshotSchema = z
  .object({
    planReviewRequired: z.literal(true),
    codeReviewRequired: z.literal(true),
    verificationRequired: z.literal(true),
    humanMergeRequired: z.literal(true),
    // Plan-as-is does NOT relax planReviewRequired above: the literal stays true because the
    // per-batch plan-review GATE machinery is unchanged — in plan-as-is mode the batch never
    // enters PLAN_REVIEW at all; it is approved by the explicit operator-authority
    // ACCEPT_PLAN_AS_IS transition instead. This field records the mode in the snapshot.
    planAsIs: z.boolean(),
    blockingSeverities: z.array(z.enum(FINDING_SEVERITIES)).min(1),
    requireAllFindingResponses: z.boolean(),
    requireAcceptedAttestations: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.blockingSeverities).size !== value.blockingSeverities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockingSeverities'],
        message: 'Blocking severities must be unique',
      });
    }
  });

export const authorityGrantSnapshotSchema = z
  .object({
    authority: z.enum(AUTHORITIES),
    permittedActorTypes: z.array(z.enum(ACTOR_TYPES)).min(1),
    assignedRole: z.enum(ASSIGNED_ROLES).optional(),
  })
  .strict();

export const reviewWorkflowConfigurationSnapshotSchema = z
  .object({
    workflowId: z.string().min(1),
    batchId: z.string().min(1).optional(),
    configurationHash: contentHashSchema,
    identityPolicy: reviewWorkflowIdentityPolicySnapshotSchema,
    commitPolicy: z.enum(['HUMAN_REQUIRED', 'AGENT_AUTHORIZED', 'EITHER']),
    agentMayCommit: z.boolean(),
    gates: reviewWorkflowGatePolicySnapshotSchema,
    pacing: z
      .object({
        maxCodeReviewRounds: z.number().int().min(1).max(5),
        maxCorrectionPasses: z.number().int().min(0).max(4),
        deferNonBlockingFindings: z.literal(true),
        unresolvedAfterFinalReview: z.literal('human_decision_required'),
      })
      .strict()
      .default({
        maxCodeReviewRounds: 3,
        maxCorrectionPasses: 2,
        deferNonBlockingFindings: true,
        unresolvedAfterFinalReview: 'human_decision_required',
      }),
    assignments: z
      .object({
        implementer: agentAssignmentSchema,
        reviewer: agentAssignmentSchema,
      })
      .strict(),
    authorityGrants: z.array(authorityGrantSnapshotSchema).length(AUTHORITIES.length),
  })
  .strict()
  .superRefine((value, context) => {
    const agentCommitAllowed = value.commitPolicy !== 'HUMAN_REQUIRED';
    if (value.agentMayCommit !== agentCommitAllowed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentMayCommit'],
        message: 'Snapshot commit permission must agree with commit policy',
      });
    }
    const { implementer, reviewer } = value.assignments;
    if (
      implementer.assignmentId === reviewer.assignmentId ||
      implementer.configuredAgentKey === reviewer.configuredAgentKey
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assignments', 'reviewer'],
        message: 'Implementer and reviewer assignment identities must differ',
      });
    }
    if (
      value.identityPolicy.requireDifferentAdapterKinds &&
      implementer.expectedAdapterKind === reviewer.expectedAdapterKind
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assignments', 'reviewer', 'expectedAdapterKind'],
        message: 'Implementer and reviewer adapter kinds must differ when the policy requires it',
      });
    }
    if (implementer.assignedRole !== 'IMPLEMENTER' || reviewer.assignedRole !== 'REVIEWER') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assignments'],
        message: 'Snapshot assignments must use implementer and reviewer roles',
      });
    }
    for (const [role, assignment] of Object.entries(value.assignments)) {
      if (
        assignment.workflowId !== value.workflowId ||
        assignment.batchId !== value.batchId ||
        assignment.configurationHash !== value.configurationHash
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assignments', role],
          message: 'Assignment scope and configuration hash must match the snapshot',
        });
      }
    }
    if (
      implementer.commitPermission !== (value.agentMayCommit ? 'AUTHORIZED' : 'DENIED') ||
      reviewer.commitPermission !== 'DENIED'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assignments'],
        message: 'Assignment commit permissions must match the snapshot commit policy',
      });
    }
    if (!authorityGrantSnapshotMatchesPolicy(value.authorityGrants, value.commitPolicy)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorityGrants'],
        message: 'Authority grants must match the approved actor-authority matrix',
      });
    }
    const authorities = value.authorityGrants.map((grant) => grant.authority);
    if (new Set(authorities).size !== AUTHORITIES.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorityGrants'],
        message: 'Authority snapshot must contain every authority exactly once',
      });
    }
  });

export const identityAssuranceViolationSchema = z
  .object({
    code: z.enum(IDENTITY_ASSURANCE_VIOLATION_CODES),
    message: z.string().min(1),
  })
  .strict();

export const identityAssuranceEvaluationSchema = z
  .object({
    valid: z.boolean(),
    effectiveAssurance: z.enum(IDENTITY_ASSURANCE_LEVELS),
    minimumAssuranceSatisfied: z.boolean(),
    authenticatedSubjectSeparation: z.enum(['PROVEN_DISTINCT', 'REUSED', 'PARTIAL', 'UNAVAILABLE']),
    violations: z.array(identityAssuranceViolationSchema),
  })
  .strict();
