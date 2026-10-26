import type { JSONSchema } from './json-schema.js';
import type { RiskTier } from '../security/policy.js';
import type { WorkspaceBoundary } from '../security/path-validation.js';
import type { PathAccess } from '../security/access.js';
import type { ApprovalEngine } from '../security/approval.js';
import type { AuditLog } from '../security/audit.js';
import type { BackupManager } from '../recovery/backups.js';
import type { SandboxManager } from '../sandbox/manager.js';
import type { OperatorConfig } from '../config/schema.js';

export interface ToolContext {
  config: OperatorConfig;
  workspace: WorkspaceBoundary | null;
  /** Read-only grants for folders outside the workspace (session scope). */
  access: PathAccess;
  approval: ApprovalEngine;
  audit: AuditLog;
  backups: BackupManager;
  sandbox: SandboxManager;
  sessionId: string;
  dryRun: boolean;
  signal?: AbortSignal | undefined;
  /** Live provider metadata for the running model (provider+model ids). */
  agentLabel?: string;
}

export interface ToolResult {
  ok: boolean;
  /** Compact human/agent-readable summary of what happened. */
  summary: string;
  /** Structured payload (already size-capped). */
  data?: unknown;
  error?: string;
}

/** One-line description of an action for approval prompts, with an optional diff. */
export interface ToolDescription {
  summary: string;
  targets: string[];
  /** Unified diff (or other preview) shown to the user before approval. */
  preview?: string;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema = both validation and model-facing definition. */
  readonly schema: JSONSchema;
  /** True when the tool needs an explicit workspace (almost all fs tools). */
  readonly requiresWorkspace?: boolean;
  /** Read-only tools may also work in folders granted via request_path_access. */
  readonly workspaceOptional?: boolean;
  /** Escalate the base tier from concrete arguments (e.g. overwrite). */
  escalateTier?: (input: Record<string, unknown>) => RiskTier | null;
  /** One-line plain description of the action for approval prompts. May read
   *  the workspace (read-only) to build a real diff preview for the prompt. */
  describe?: (input: Record<string, unknown>, ctx: ToolContext) => ToolDescription | Promise<ToolDescription>;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
