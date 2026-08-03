// packages/core/src/utils/errors.ts

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ModelError extends Error {
  /**
   * Output the subprocess produced before it failed. A timeout kill is exactly the case
   * where this matters most: without it the audit records an empty response and nobody can
   * tell how far the agent actually got.
   */
  partialOutput?: { readonly stdout: string; readonly stderr: string };

  /**
   * True when the failure is specifically a SESSION RESUME being refused, as opposed to the
   * call itself dying. Callers that store session identity need the distinction: a failed
   * resume means the STORED SESSION is bad (clear it and start fresh next time), while a
   * failed call means the attempt is bad (keep the session, retry the call).
   */
  resumeFailed?: boolean;

  constructor(
    message: string,
    public readonly provider?: string,
    public readonly model?: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }

  get isRateLimit(): boolean {
    return this.statusCode === 429;
  }

  get isTimeout(): boolean {
    return this.message.includes('timeout') || this.message.includes('ETIMEDOUT');
  }

  get isServerError(): boolean {
    return this.statusCode !== undefined && this.statusCode >= 500;
  }
}

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly stepId?: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly operation?: string,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}
