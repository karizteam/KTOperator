import type { ManagedProcessResult } from '../core/execution/managed-process.js';

/**
 * Sandbox abstraction. ALL AI-directed command execution goes through a
 * SandboxBackend. The manager (not the AI) selects and configures backends.
 */

export interface SandboxLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

export interface SandboxExecSpec {
  argv: string[];
  /** Host workspace root; mounted at /work. */
  workspaceRoot: string;
  /** Working directory relative to the workspace root. */
  workdir?: string;
  writable: boolean;
  network: boolean;
  limits: SandboxLimits;
  /** Minimal env allowlist (name → value); never the full host env. */
  env: Record<string, string>;
  signal?: AbortSignal;
}

export interface BackendStatus {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  capabilities: string[];
  limitations: string[];
}

export interface SandboxBackend {
  readonly id: string;
  readonly label: string;
  status(): Promise<BackendStatus>;
  run(spec: SandboxExecSpec): Promise<ManagedProcessResult>;
}
