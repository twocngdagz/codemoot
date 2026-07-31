// packages/core/src/roles -- Role resolution and prompt templates

export { RoleManager } from './role-manager.js';
export type { ResolvedRoleAdapter, ReviewWorkflowRoleResolution } from './role-manager.js';
export {
  ROLE_INVOCATION_ERROR_CODES,
  SESSION_CONTINUITY_ERROR_CODES,
  RoleInvocationError,
  RoleInvocationService,
  isSessionContinuityError,
} from './role-invocation.js';
export type {
  PreparedRoleInvocation,
  RoleInvocationErrorCode,
  RoleInvocationInput,
  RoleInvocationResult,
  RoleSessionBinding,
  SessionContinuityErrorCode,
} from './role-invocation.js';
export { renderPrompt } from './prompts.js';
export type { PromptType, PromptVariables } from './prompts.js';
