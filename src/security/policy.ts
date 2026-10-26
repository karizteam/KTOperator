import type { OperatorConfig } from '../config/schema.js';

/**
 * Independent permission engine. The AI model has no say here: every tool
 * call is classified into a risk tier, and the tier — plus a few hard rules
 * — decides whether the action is allowed, needs approval, or is denied.
 *
 *   Tier 0  Read-only operations
 *   Tier 1  Low-risk, reversible modifications
 *   Tier 2  Destructive or high-impact modifications
 *   Tier 3  Privileged, external, or security-sensitive operations
 */
export type RiskTier = 0 | 1 | 2 | 3;

export const TIER_LABEL: Record<RiskTier, string> = {
  0: 'read-only',
  1: 'reversible modification',
  2: 'destructive / high-impact',
  3: 'privileged / external',
};

/** Base tier each tool starts from; individual calls may escalate it. */
export const TOOL_BASE_TIER: Record<string, RiskTier> = {
  list_directory: 0,
  read_file: 0,
  search_files: 0,
  search_text: 0,
  inspect_file_metadata: 0,
  generate_diff: 0,
  inspect_project: 0,
  detect_project_type: 0,
  inspect_package_json: 0,
  inspect_git_status: 0,
  get_operating_system: 0,
  get_runtime_versions: 0,
  get_cpu_summary: 0,
  get_memory_summary: 0,
  get_disk_usage: 0,
  get_process_summary: 0,
  inspect_command_result: 0,
  web_search: 0,
  web_fetch: 0,
  create_file: 1,
  edit_file: 1,
  move_file: 1,
  terminate_managed_process: 2,
  delete_file: 2,
  run_tests: 3,
  run_typecheck: 3,
  run_linter: 3,
  run_build: 3,
  execute_approved_command: 3,
  launch_app: 3,
  open_url: 3,
  request_path_access: 3,
};

export type PolicyDecision = 'allow' | 'requires-approval' | 'deny';

export interface PolicyVerdict {
  decision: PolicyDecision;
  tier: RiskTier;
  reason: string;
}

/**
 * Evaluate an action. Tool names are resolved against the base matrix; the
 * caller passes any escalation (e.g. overwrite → tier 2) already applied.
 */
// `config` is reserved for future policy knobs (e.g. per-tier rules).
export function evaluateTier(tier: RiskTier, _config: OperatorConfig): PolicyVerdict {
  switch (tier) {
    case 0:
      return { decision: 'allow', tier, reason: 'Read-only inspection is allowed within the workspace.' };
    case 1:
      return { decision: 'requires-approval', tier, reason: 'Modifies workspace content (reversible, backed up).' };
    case 2:
      return { decision: 'requires-approval', tier, reason: 'Destructive or high-impact change.' };
    case 3:
      return { decision: 'requires-approval', tier, reason: 'Privileged, external, or security-sensitive operation.' };
  }
}

/**
 * Placeholder-free escalation helpers: individual tools call these to raise
 * their tier based on the concrete call arguments.
 */
export function escalate(tier: RiskTier, to: RiskTier): RiskTier {
  return Math.max(tier, to) as RiskTier;
}

/** Actions that are never permitted regardless of approvals. */
export function isHardDenied(action: { kind: string; targetInsideWorkspace: boolean; runsAsRoot?: boolean }): string | null {
  if (!action.targetInsideWorkspace && action.kind !== 'network' && action.kind !== 'system-info') {
    return 'Access outside the authorized workspace is denied.';
  }
  if (action.runsAsRoot) return 'Administrator/root execution is disabled.';
  return null;
}

export const MAX_AUTO_TIER: RiskTier = 3;
