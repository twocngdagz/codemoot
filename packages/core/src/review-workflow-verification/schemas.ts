import { z } from 'zod';
import {
  contentHashSchema,
  gitShaSchema,
  verificationCommandSpecSchema,
} from '../review-workflow/schemas.js';

export const verificationCriterionAcceptancePolicySchema = z
  .object({
    criterionId: z.string().min(1),
    allowsAutomaticAcceptance: z.boolean(),
    requiresIndependentAttestation: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.allowsAutomaticAcceptance && value.requiresIndependentAttestation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A criterion cannot allow automatic acceptance and require independent review',
      });
    }
  });

export const verificationAttestationPolicySchema = z
  .object({
    policyConfigurationHash: contentHashSchema,
    expectedVerificationConfigurationHash: contentHashSchema,
    expectedCommitSha: gitShaSchema,
    approvedCommand: verificationCommandSpecSchema,
    expectedToolVersion: z.string().min(1),
    criterionPolicies: z.array(verificationCriterionAcceptancePolicySchema),
    parserAmbiguityRequiresJudgment: z.boolean(),
    baselineComparison: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const criterionIds = value.criterionPolicies.map((criterion) => criterion.criterionId);
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criterionPolicies'],
        message: 'Verification criterion acceptance policies must be unique',
      });
    }
  });
