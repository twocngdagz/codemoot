// packages/core/src/roles/role-manager.ts

import type { ModelAdapter, ModelRegistry } from '../models/registry.js';
import { resolveModelAdapterKind } from '../models/registry.js';
import { hashReviewWorkflowConfiguration } from '../review-workflow-identity/service.js';
import type { ReviewWorkflowConfigurationSnapshot } from '../review-workflow-identity/types.js';
import type { AgentAssignment, AssignedRole } from '../review-workflow/types.js';
import type { ProjectConfig, RoleConfig } from '../types/config.js';
import type { ChatMessage } from '../types/models.js';
import type { BuiltInRole, Role } from '../types/roles.js';
import { DEFAULT_MAX_TOKENS } from '../utils/constants.js';
import { ModelError } from '../utils/errors.js';
import type { PromptType, PromptVariables } from './prompts.js';
import { renderPrompt } from './prompts.js';

/**
 * Built-in role definitions with default descriptions.
 */
const BUILT_IN_ROLES: Record<BuiltInRole, { description: string }> = {
  architect: { description: 'Plans implementation strategy and technical approach' },
  reviewer: { description: 'Reviews plans and code for correctness, quality, and risks' },
  implementer: { description: 'Writes production code based on approved plans' },
};

export interface ResolvedRoleAdapter {
  readonly role: 'implementer' | 'reviewer';
  readonly assignment: AgentAssignment;
  readonly adapter: ModelAdapter;
}

export interface ReviewWorkflowRoleResolution {
  readonly implementer: ResolvedRoleAdapter;
  readonly reviewer: ResolvedRoleAdapter;
}

/**
 * Resolves roles from config, provides prompt rendering and message assembly.
 */
export class RoleManager {
  constructor(private config: ProjectConfig) {}

  /**
   * Resolve a role name to a fully hydrated Role object.
   * Merges built-in defaults with config overrides.
   */
  getRole(roleName: string): Role {
    const roleConfig = this.config.roles[roleName];
    if (!roleConfig) {
      throw new ModelError(
        `Unknown role: "${roleName}". Available: ${Object.keys(this.config.roles).join(', ')}`,
      );
    }

    const builtIn = BUILT_IN_ROLES[roleName as BuiltInRole];
    const modelConfig = this.config.models[roleConfig.model];

    return {
      id: roleName,
      description: builtIn?.description ?? `Custom role: ${roleName}`,
      modelAlias: roleConfig.model,
      systemPrompt: buildRoleIdentity(roleName, builtIn?.description),
      temperature: roleConfig.temperature ?? modelConfig?.temperature ?? 0.7,
      maxTokens: roleConfig.maxTokens ?? modelConfig?.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  }

  /**
   * Build a ChatMessage[] for a model call.
   * Renders the appropriate prompt template with project context and variables.
   */
  buildMessages(promptType: PromptType, vars: PromptVariables): ChatMessage[] {
    return renderPrompt(promptType, {
      ...vars,
      projectName: vars.projectName ?? this.config.project.name,
      projectDescription: vars.projectDescription ?? this.config.project.description,
    });
  }

  /** List all configured role names. */
  listRoles(): string[] {
    return Object.keys(this.config.roles);
  }

  /** Get the RoleConfig for a role name. */
  getRoleConfig(roleName: string): RoleConfig {
    const roleConfig = this.config.roles[roleName];
    if (!roleConfig) {
      throw new ModelError(`Unknown role: "${roleName}"`);
    }
    return roleConfig;
  }

  /**
   * Resolve the immutable review-workflow assignments to their concrete runtime bridges.
   * Configuration aliases are checked again here because the assignment snapshot, not the
   * caller's requested alias, is the authority for an invocation.
   */
  resolveReviewWorkflowRoles(
    snapshot: ReviewWorkflowConfigurationSnapshot,
    registry: ModelRegistry,
  ): ReviewWorkflowRoleResolution {
    const configurationHash = hashReviewWorkflowConfiguration(this.config);
    if (
      snapshot.configurationHash !== configurationHash ||
      snapshot.assignments.implementer.configurationHash !== configurationHash ||
      snapshot.assignments.reviewer.configurationHash !== configurationHash
    ) {
      throw new ModelError('Review workflow assignments do not match the active configuration');
    }
    const implementer = this.resolveAssignedRole(
      'implementer',
      snapshot.assignments.implementer,
      registry,
    );
    const reviewer = this.resolveAssignedRole('reviewer', snapshot.assignments.reviewer, registry);
    if (
      implementer.assignment.assignmentId === reviewer.assignment.assignmentId ||
      implementer.assignment.configuredAgentKey === reviewer.assignment.configuredAgentKey
    ) {
      throw new ModelError('Review workflow roles must resolve to different agent assignments');
    }
    if (
      snapshot.identityPolicy.requireDifferentAdapterKinds &&
      implementer.assignment.expectedAdapterKind === reviewer.assignment.expectedAdapterKind
    ) {
      throw new ModelError('Review workflow roles must resolve to different adapter kinds');
    }
    return { implementer, reviewer };
  }

  private resolveAssignedRole(
    roleName: 'implementer' | 'reviewer',
    assignment: AgentAssignment,
    registry: ModelRegistry,
  ): ResolvedRoleAdapter {
    const roleConfig = this.getRoleConfig(roleName);
    const modelConfig = registry.getModelConfig(roleConfig.model);
    const adapter = registry.getAdapter(roleConfig.model);
    const assignedRole: AssignedRole = roleName === 'implementer' ? 'IMPLEMENTER' : 'REVIEWER';
    const adapterKind = resolveModelAdapterKind(modelConfig).toUpperCase();
    if (
      assignment.assignedRole !== assignedRole ||
      assignment.configuredAgentKey !== roleConfig.model ||
      assignment.configuredModelAlias !== roleConfig.model ||
      assignment.expectedAdapterKind !== adapterKind ||
      assignment.configuredModel !== modelConfig.model ||
      adapter.model !== modelConfig.model ||
      adapter.name.toUpperCase() !== adapterKind
    ) {
      throw new ModelError(`Runtime adapter does not match the ${roleName} assignment snapshot`);
    }
    return { role: roleName, assignment, adapter };
  }
}

function buildRoleIdentity(roleName: string, description?: string): string {
  if (description) {
    return `You are a ${roleName}. ${description}.`;
  }
  return `You are a ${roleName}.`;
}
