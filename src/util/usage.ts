/**
 * Token and cost accounting.
 *
 * Providers differ: OpenRouter reports a real USD cost per request, most others
 * report only tokens. Both are accumulated the same way and rendered with the
 * unit that is actually known, so the corner of the chat box never shows a
 * number that was invented.
 */

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from provider prompt cache (cheaper). */
  cachedTokens: number;
  /** Model requests counted. */
  requests: number;
  /** Sum of provider-reported cost. Zero means "not reported", not "free". */
  costUsd: number;
}

export interface UsageDelta {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  costUsd?: number | undefined;
  cachedTokens?: number | undefined;
}

export function emptyTotals(): UsageTotals {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, requests: 0, costUsd: 0 };
}

export function addUsage(total: UsageTotals, usage: UsageDelta | undefined): void {
  if (usage === undefined) return;
  total.promptTokens += usage.promptTokens ?? 0;
  total.completionTokens += usage.completionTokens ?? 0;
  total.cachedTokens += usage.cachedTokens ?? 0;
  if ((usage.promptTokens ?? 0) > 0 || (usage.completionTokens ?? 0) > 0) total.requests += 1;
  total.costUsd += usage.costUsd ?? 0;
}

/** Cached share of prompt tokens, 0–100. */
export function cacheHitRate(total: UsageTotals): number {
  if (total.promptTokens <= 0) return 0;
  return Math.min(100, Math.max(0, (total.cachedTokens / total.promptTokens) * 100));
}

/**
 * Human-readable breakdown used by /usage, /status and `operator usage`.
 * Pure so tests can assert the numbers without a terminal.
 */
export function usageSummaryLines(total: UsageTotals, options: { tokenBudget?: number | undefined; contextTokens?: number | undefined; costCapUsd?: number | undefined } = {}): string[] {
  const lines: string[] = [];
  lines.push(`tokens       ${formatTokens(total.promptTokens)} in · ${formatTokens(total.completionTokens)} out · ${formatTokens(totalTokens(total))} total`);
  if (total.cachedTokens > 0) lines.push(`cached       ${formatTokens(total.cachedTokens)} prompt tokens from cache (${cacheHitRate(total).toFixed(0)}% hit rate)`);
  lines.push(`cost         ${total.costUsd > 0 ? formatCost(total.costUsd) : 'not reported by provider'}`);
  if (options.costCapUsd !== undefined && total.costUsd > 0) lines.push(`cost cap     ${formatCost(options.costCapUsd)} · ${formatCost(Math.max(0, options.costCapUsd - total.costUsd))} remaining`);
  lines.push(`requests     ${total.requests}`);
  if (options.contextTokens !== undefined) {
    const budget = options.tokenBudget ?? 30_000;
    const pct = budget > 0 ? Math.min(100, Math.round((options.contextTokens / budget) * 100)) : 0;
    lines.push(`context      ~${formatTokens(options.contextTokens)} of ${formatTokens(budget)} budget (${pct}% used)`);
  }
  return lines;
}

export function totalTokens(total: UsageTotals): number {
  return total.promptTokens + total.completionTokens;
}

/** 999 · 12.4k · 1.2M — short enough for a box border. */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Small amounts keep their precision: $0.0042 is not $0.00. */
export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * The label shown in the top-right corner of the chat box: cost when the
 * provider reports it, otherwise the token count, otherwise nothing.
 */
export function usageLabel(total: UsageTotals): string {
  if (total.costUsd > 0) return formatCost(total.costUsd);
  const tokens = totalTokens(total);
  return tokens > 0 ? `${formatTokens(tokens)} tok` : '';
}
