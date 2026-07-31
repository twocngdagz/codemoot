// packages/core/src/models/bridge.ts — Generic bridge interface for CLI-to-CLI communication

import type { ModelCallResult } from '../types/models.js';
import type { ProgressCallbacks } from './cli-adapter.js';

export type BridgeAdapterKind = 'CLAUDE' | 'CODEX';

/** Capabilities that a bridge implementation advertises. */
export interface BridgeCapabilities {
  /** Whether the bridge supports session resume (multi-turn statefulness). */
  supportsResume: boolean;
  /** Whether the bridge supports streaming output. */
  supportsStream: boolean;
  /** Maximum context window in tokens. */
  maxContextTokens: number;
  /** Whether the bridge can use tools (read files, run commands). */
  supportsTools: boolean;
  /** Whether the bridge can access the project working directory. */
  supportsCwd: boolean;
}

/** Options for a bridge send/resume call. */
export interface BridgeOptions extends ProgressCallbacks {
  timeout?: number;
  maxOutputBytes?: number;
  idleTimeout?: number;
  signal?: AbortSignal;
  /** Extra environment entries for the CLI subprocess (e.g. a guarded PATH). */
  env?: Readonly<Record<string, string>>;
  /**
   * Forbids any fallback to a fresh session when a resume fails. Mandatory role-session
   * continuity sets this: a failed resume must surface as a failure, never as a silently
   * created new vendor session.
   */
  strictResume?: boolean;
}

/** Options for a bridge resume call. */
export interface BridgeResumeOptions extends BridgeOptions {
  sessionId: string;
}

/**
 * Process evidence observed by CodeMoot for a successful bridge invocation.
 *
 * Account identity is deliberately absent: adapters may only attach an authenticated subject
 * after the CLI exposes one through a supported protocol.
 */
export interface BridgeInvocationEvidence {
  readonly adapterKind: BridgeAdapterKind;
  readonly executablePath: string;
  readonly executableHash?: string;
  readonly cliVersion: string;
  readonly configuredModel: string;
  readonly reportedModel?: string;
  readonly workingDirectory: string;
  readonly processId: number;
  readonly processInstanceFingerprint: string;
  readonly identityAssurance: 'PROCESS_ATTESTED';
  readonly authenticationSource?: string;
  readonly permissionMode?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly resultStatus: 'SUCCEEDED';
}

export interface BridgeSessionEvidence {
  readonly providerOrAdapter: string;
  readonly vendorSessionId: string;
  readonly resumedFromSessionId?: string;
}

/** Common result returned by role-capable bridges. */
export interface BridgeCallResult extends ModelCallResult {
  readonly invocationEvidence?: BridgeInvocationEvidence;
  readonly sessionEvidence?: BridgeSessionEvidence;
}

/**
 * Generic interface for bridging communication between two CLI tools.
 * Each implementation handles its own CLI's quirks (JSONL parsing, session format, auth).
 */
export interface CliBridge {
  /** Human-readable bridge name (e.g., 'codex', 'gemini', 'claude'). */
  readonly name: string;
  /** Model identifier. */
  readonly model: string;
  /** Advertised capabilities. */
  readonly capabilities: BridgeCapabilities;
  /** Send a prompt and get a response. */
  send(prompt: string, options?: BridgeOptions): Promise<BridgeCallResult>;
  /** Resume a previous session with a new prompt. Falls back to send() if resume unsupported. */
  resume(sessionId: string, prompt: string, options?: BridgeOptions): Promise<BridgeCallResult>;
}

/** Invoke a bridge while keeping legacy optional-session call sites adapter-neutral. */
export function callBridge(
  bridge: CliBridge,
  prompt: string,
  options?: BridgeOptions & { readonly sessionId?: string },
): Promise<BridgeCallResult> {
  const { sessionId, ...bridgeOptions } = options ?? {};
  return sessionId === undefined
    ? bridge.send(prompt, bridgeOptions)
    : bridge.resume(sessionId, prompt, bridgeOptions);
}
