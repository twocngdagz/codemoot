// Prompt framing for model invocations that must return a structured contract.

import type { ReviewWorkflowContractKind } from './types.js';

export interface StructuredHandoffPromptInput {
  readonly contractKind: ReviewWorkflowContractKind;
  readonly task: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export function buildStructuredHandoffPrompt(input: StructuredHandoffPromptInput): string {
  return [
    input.task,
    '',
    'Return exactly one JSON object. Do not use Markdown fences or add prose.',
    `The object must include "schemaVersion": 1 and "contractKind": "${input.contractKind}".`,
    'Treat the supplied target and identifiers as immutable authority; echo them exactly.',
    '',
    'Context:',
    JSON.stringify(input.context, null, 2),
  ].join('\n');
}
