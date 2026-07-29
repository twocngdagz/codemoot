export class ControllerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ControllerError';
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details = undefined) {
  if (!condition) {
    throw new ControllerError(code, message, details);
  }
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
