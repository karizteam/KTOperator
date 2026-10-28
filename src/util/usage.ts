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
  /** Sum of provider-reported cost. Zero means "not reported", not "free". */
  costUsd: number;
}

export interface UsageDelta {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  costUsd?: number | undefined;
}

export function emptyTotals(): UsageTotals {
  return { promptTokens: 0, completionTokens: 0, costUsd: 0 };
}

export function addUsage(total: UsageTotals, usage: UsageDelta | undefined): void {
  if (usage === undefined) return;
  total.promptTokens += usage.promptTokens ?? 0;
  total.completionTokens += usage.completionTokens ?? 0;
  total.costUsd += usage.costUsd ?? 0;
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
