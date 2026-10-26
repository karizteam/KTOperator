import type { OperatorConfig } from '../config/schema.js';
import type { Ui } from '../cli/ui.js';
import { evaluateTier, TIER_LABEL, type RiskTier } from './policy.js';

/**
 * Approval engine. The model can never approve its own actions — approvals
 * come only from the interactive user prompt or from an explicit CLI
 * `--yes <level>` grant, both bounded by config.security.maxAutoApproveTier.
 */

export interface ApprovalRequest {
  tool: string;
  tier: RiskTier;
  summary: string;
  targets: string[];
  /** Rendered diff/preview for write operations. */
  preview?: string;
  /** Sandbox/audit context lines shown in the prompt box. */
  contextLines?: string[];
}

export type ApprovalMode =
  | { kind: 'interactive' }
  | { kind: 'auto'; maxTier: RiskTier }
  | { kind: 'deny-all' }
  | { kind: 'dry-run' };

export interface ApprovalOutcome {
  approved: boolean;
  reason: string;
  via: 'policy' | 'session-grant' | 'user' | 'auto' | 'dry-run' | 'denied';
}

export class ApprovalEngine {
  private readonly sessionGrants = new Set<string>();

  constructor(
    private readonly mode: ApprovalMode,
    private readonly config: OperatorConfig,
    private readonly ui: Ui,
  ) {}

  static modeFromFlags(options: { interactive: boolean; yesLevel?: string; dryRun?: boolean }, config: OperatorConfig): ApprovalMode {
    if (options.dryRun) return { kind: 'dry-run' };
    if (options.yesLevel !== undefined) {
      const level = options.yesLevel === '' ? 'write' : options.yesLevel;
      const tier = levelToTier(level);
      if (tier === null) {
        throw new Error(`Invalid --yes level "${level}". Use: read, write, all.`);
      }
      // Config bounds unattended approvals; tier 3 never auto-approves via config alone above 2.
      const capped = Math.min(tier, Math.max(config.security.maxAutoApproveTier, tier === 3 ? 3 : tier)) as RiskTier;
      return { kind: 'auto', maxTier: capped };
    }
    if (options.interactive) return { kind: 'interactive' };
    return { kind: 'deny-all' };
  }

  private grantKey(req: ApprovalRequest): string {
    return `${req.tool}:${req.targets.join(',')}`;
  }

  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const verdict = evaluateTier(req.tier, this.config);
    if (verdict.decision === 'allow') {
      return { approved: true, reason: verdict.reason, via: 'policy' };
    }

    if (this.mode.kind === 'dry-run') {
      return { approved: true, reason: 'Dry-run: action simulated, not executed.', via: 'dry-run' };
    }

    if (this.sessionGrants.has(this.grantKey(req))) {
      return { approved: true, reason: 'Covered by an earlier session grant.', via: 'session-grant' };
    }

    if (this.mode.kind === 'auto') {
      if (req.tier <= this.mode.maxTier && req.tier <= 3) {
        return { approved: true, reason: `Auto-approved by --yes (tier ≤ ${this.mode.maxTier}).`, via: 'auto' };
      }
      return {
        approved: false,
        reason: `${TIER_LABEL[req.tier]} operations exceed the --yes auto-approval level and need an interactive terminal.`,
        via: 'denied',
      };
    }

    if (this.mode.kind === 'deny-all') {
      return {
        approved: false,
        reason: 'Approval requires an interactive terminal; re-run without --json or pass --yes <level>.',
        via: 'denied',
      };
    }

    // Interactive prompt.
    const lines = [
      `Operation : ${req.summary}`,
      `Tool      : ${req.tool}`,
      `Risk tier : ${req.tier} (${TIER_LABEL[req.tier]})`,
      `Targets   : ${req.targets.slice(0, 5).join(', ')}${req.targets.length > 5 ? ` (+${req.targets.length - 5} more)` : ''}`,
      ...(req.contextLines ?? []),
    ];
    this.ui.box('APPROVAL REQUIRED', lines);
    if (req.preview) this.ui.printDiffPreview(req.preview);
    const choices = req.tier <= 1
      ? [
          { key: 'y', label: 'yes, once' },
          { key: 'a', label: 'always this session (this tool + target)' },
          { key: 'n', label: 'no' },
        ]
      : [
          { key: 'y', label: 'yes, once' },
          { key: 'n', label: 'no' },
        ];
    const answer = await this.ui.promptChoice(`Approve ${TIER_LABEL[req.tier]}?`, choices);
    if (answer === 'a') {
      this.sessionGrants.add(this.grantKey(req));
      return { approved: true, reason: 'Approved by user (session grant).', via: 'user' };
    }
    if (answer === 'y') return { approved: true, reason: 'Approved by user.', via: 'user' };
    return { approved: false, reason: 'Denied by user.', via: 'denied' };
  }
}

function levelToTier(level: string): RiskTier | null {
  switch (level) {
    case 'read':
      return 0;
    case 'write':
      return 1;
    case 'all':
      return 3;
    default:
      return null;
  }
}
