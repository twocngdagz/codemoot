// packages/core/src/roles -- Role resolution and prompt templates

export { RoleManager } from './role-manager.js';
export type { ResolvedRoleAdapter, ReviewWorkflowRoleResolution } from './role-manager.js';
export {
  ROLE_INVOCATION_ERROR_CODES,
  RoleInvocationError,
  RoleInvocationService,
} from './role-invocation.js';
export type {
  RoleInvocationErrorCode,
  RoleInvocationInput,
  RoleInvocationResult,
} from './role-invocation.js';
export { renderPrompt } from './prompts.js';
export type { PromptType, PromptVariables } from './prompts.js';
