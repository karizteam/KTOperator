/**
 * Typed error hierarchy for KarizTeam Operator.
 * Every expected failure mode carries a stable code, an optional remediation
 * hint, and a process exit code so the CLI can fail clearly and scripts can
 * branch on machine-readable causes.
 */

export type ErrorCode =
  | 'CONFIG'
  | 'WORKSPACE'
  | 'PATH_SECURITY'
  | 'POLICY_DENIED'
  | 'APPROVAL_DENIED'
  | 'SANDBOX'
  | 'PROVIDER'
  | 'TOOL'
  | 'CANCELLED'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'INTERNAL';

export class OperatorError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly exitCode: number;
  /** Safe, already-redacted details attached for structured output. */
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options?: { hint?: string; exitCode?: number; details?: Record<string, unknown>; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OperatorError';
    this.code = code;
    this.hint = options?.hint;
    this.exitCode = options?.exitCode ?? 1;
    this.details = options?.details;
  }
}

export class ConfigError extends OperatorError {
  constructor(message: string, options?: { hint?: string; details?: Record<string, unknown>; cause?: unknown }) {
    super('CONFIG', message, { ...options, exitCode: 2 });
    this.name = 'ConfigError';
  }
}

export class WorkspaceError extends OperatorError {
  constructor(message: string, options?: { hint?: string; details?: Record<string, unknown>; cause?: unknown }) {
    super('WORKSPACE', message, { ...options, exitCode: 3 });
    this.name = 'WorkspaceError';
  }
}

/** Raised when a path escapes the workspace or targets a forbidden file kind. */
export class PathSecurityError extends OperatorError {
  constructor(message: string, options?: { hint?: string; details?: Record<string, unknown>; cause?: unknown }) {
    super('PATH_SECURITY', message, { ...options, exitCode: 4 });
    this.name = 'PathSecurityError';
  }
}

export class PolicyDeniedError extends OperatorError {
  constructor(message: string, options?: { hint?: string; details?: Record<string, unknown> }) {
    super('POLICY_DENIED', message, { ...options, exitCode: 5 });
    this.name = 'PolicyDeniedError';
  }
}

export class ApprovalDeniedError extends OperatorError {
  constructor(message: string, options?: { hint?: string; details?: Record<string, unknown> }) {
    super('APPROVAL_DENIED', message, { ...options, exitCode: 6 });
    this.name = 'ApprovalDeniedError';
  }
}

export type SandboxErrorKind = 'unavailable' | 'execution' | 'misconfigured';

export class SandboxError extends OperatorError {
  readonly kind: SandboxErrorKind;
  constructor(kind: SandboxErrorKind, message: string, options?: { hint?: string; details?: Record<string, unknown>; cause?: unknown }) {
    super('SANDBOX', message, { ...options, exitCode: 7 });
    this.name = 'SandboxError';
    this.kind = kind;
  }
}

export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'insufficient_credits'
  | 'invalid_model'
  | 'invalid_request'
  | 'network'
  | 'timeout'
  | 'provider'
  | 'unsupported'
  | 'aborted';

export class ProviderError extends OperatorError {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: ProviderErrorKind, message: string, options?: { hint?: string; status?: number; retryAfterMs?: number; details?: Record<string, unknown>; cause?: unknown }) {
    super('PROVIDER', message, { ...options, exitCode: 8 });
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export class ToolExecutionError extends OperatorError {
  readonly toolName: string;
  constructor(toolName: string, message: string, options?: { hint?: string; details?: Record<string, unknown>; cause?: unknown }) {
    super('TOOL', message, { ...options, exitCode: 9 });
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
  }
}

export class UserCancelledError extends OperatorError {
  constructor(message = 'Operation cancelled by user.') {
    super('CANCELLED', message, { exitCode: 130 });
    this.name = 'UserCancelledError';
  }
}

export function isOperatorError(err: unknown): err is OperatorError {
  return err instanceof OperatorError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
