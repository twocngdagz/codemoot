import { createHash } from 'node:crypto';
import { generalPlanVersionSchema, planRequirementSchema } from '../review-workflow/schemas.js';
import type {
  GeneralPlanVersion,
  IdentityEvidence,
  PlanRequirement,
} from '../review-workflow/types.js';

export const REVIEW_WORKFLOW_PLAN_IMPORT_ERROR_CODES = [
  'PLAN_EMPTY',
  'PLAN_REQUIREMENTS_EMPTY',
] as const;

export type ReviewWorkflowPlanImportErrorCode =
  (typeof REVIEW_WORKFLOW_PLAN_IMPORT_ERROR_CODES)[number];

export class ReviewWorkflowPlanImportError extends Error {
  constructor(
    readonly code: ReviewWorkflowPlanImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewWorkflowPlanImportError';
  }
}

export interface GeneralPlanImportInput {
  readonly workflowId: string;
  readonly content: string;
  readonly sourceType: string;
  readonly sourceLocation?: string;
  readonly authorEvidence: readonly IdentityEvidence[];
  readonly createdAt: string;
  readonly version?: number;
}

export interface GeneralPlanImportResult {
  readonly generalPlan: GeneralPlanVersion;
  readonly requirements: readonly PlanRequirement[];
}

interface RequirementSection {
  readonly sourceReference: string;
  readonly statement: string;
}

export function hashPlanContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function importGeneralPlan(input: GeneralPlanImportInput): GeneralPlanImportResult {
  const content = input.content.trim();
  if (content.length === 0) {
    throw new ReviewWorkflowPlanImportError('PLAN_EMPTY', 'An imported plan cannot be empty');
  }
  const contentHash = hashPlanContent(content);
  const generalPlanVersionId = deriveId(
    'general-plan',
    input.workflowId,
    `${input.version ?? 1}:${contentHash}`,
  );
  const generalPlan = generalPlanVersionSchema.parse({
    generalPlanVersionId,
    workflowId: input.workflowId,
    version: input.version ?? 1,
    sourceType: input.sourceType,
    ...(input.sourceLocation === undefined ? {} : { sourceLocation: input.sourceLocation }),
    content,
    contentHash,
    authorEvidence: input.authorEvidence,
    createdAt: input.createdAt,
  });
  const sections = extractRequirementSections(content);
  if (sections.length === 0) {
    throw new ReviewWorkflowPlanImportError(
      'PLAN_REQUIREMENTS_EMPTY',
      'The imported plan did not contain any durable requirement content',
    );
  }
  const requirements = sections.map((section, index) =>
    planRequirementSchema.parse({
      requirementId: deriveId(
        'requirement',
        generalPlanVersionId,
        `${index + 1}:${section.sourceReference}:${section.statement}`,
      ),
      generalPlanVersionId,
      sourceReference: section.sourceReference,
      statement: section.statement,
      required: true,
      createdAt: input.createdAt,
    }),
  );
  return { generalPlan, requirements };
}

function extractRequirementSections(content: string): readonly RequirementSection[] {
  const lines = content.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const match = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    return match === null
      ? []
      : [{ line: index, level: match[1]?.length ?? 0, title: match[2]?.trim() ?? '' }];
  });
  if (headings.length === 0) {
    return [{ sourceReference: 'entire plan', statement: content }];
  }

  const sections: RequirementSection[] = [];
  const preamble = lines
    .slice(0, headings[0]?.line ?? 0)
    .join('\n')
    .trim();
  if (preamble.length > 0) {
    sections.push({ sourceReference: 'plan preamble', statement: preamble });
  }
  headings.forEach((heading, index) => {
    const nextLine = headings[index + 1]?.line ?? lines.length;
    const body = lines
      .slice(heading.line + 1, nextLine)
      .join('\n')
      .trim();
    const sourceReference = `${'#'.repeat(heading.level)} ${heading.title}`;
    sections.push({
      sourceReference,
      statement: body.length === 0 ? heading.title : `${heading.title}\n\n${body}`,
    });
  });
  return sections;
}

function deriveId(kind: string, scope: string, content: string): string {
  const suffix = createHash('sha256').update(`${kind}\0${scope}\0${content}`).digest('hex');
  return `${kind}-${suffix.slice(0, 24)}`;
}
