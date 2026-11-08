import { ProviderError } from '../../errors/errors.js';
import { TOOL_BASE_TIER } from '../../security/policy.js';
import type { AIProvider, ChatMessage, ToolDefinition, Usage } from '../../providers/interfaces/types.js';
import type { ToolRegistry, ToolContext, ToolResult } from '../../tools/index.js';

/**
 * Bounded agent loop:
 *   model → (tool calls → policy/approval → execution → results) → model → …
 * until the model finishes, the user cancels, or a configured limit trips.
 * Stall detection stops repeated identical tool calls and repeated denials.
 */

export interface AgentLoopOptions {
  provider: AIProvider;
  model: string;
  system: string;
  userTask: string;
  history?: ChatMessage[];
  registry: ToolRegistry;
  toolContext: ToolContext;
  maxIterations: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxTokens?: number | undefined;
  /** Token budget for the context (chars/4 estimate). Older turns compress first. */
  tokenBudget?: number | undefined;
  /** Stop the run when provider-reported cost exceeds this (USD). */
  costCapUsd?: number | undefined;
  /** Run consecutive read-only (tier 0) tool calls in parallel. Default true. */
  parallelTools?: boolean | undefined;
  stream?: boolean;
  signal?: AbortSignal | undefined;
  onText?: (delta: string) => void;
  onTextDone?: () => void;
  /** Called right before each model request (the model is "thinking"). */
  onModelRequest?: (iteration: number) => void;
  onToolEvent?: (event: { type: 'start' | 'done'; name: string; ok?: boolean; summary?: string }) => void;
  onUsage?: (usage: Usage) => void;
  /** Called each iteration with the compressed context estimate vs budget. */
  onContextUsage?: (info: { estimatedTokens: number; budget: number; percent: number }) => void;
  /** Called for each new conversation message (assistant/tool) for persistence. */
  onMessage?: (message: ChatMessage) => void;
}

export interface AgentStep {
  iteration: number;
  /**
   * What this step actually did. `args` is a compact copy of the call
   * arguments (long strings capped) — enough for the run summary to report
   * the paths, apps and commands that changed without re-reading the session.
   */
  toolCalls: { name: string; ok: boolean; summary: string; args: Record<string, unknown> }[];
  assistantText: string;
}

export interface AgentReport {
  status: 'completed' | 'cancelled' | 'limit' | 'error';
  finalText: string;
  /** True when finalText already reached the caller through onText/onToken. */
  finalTextDelivered: boolean;
  iterations: number;
  toolCallsTotal: number;
  deniedCount: number;
  steps: AgentStep[];
  /** Summed across every model request in the run; cost only when reported. */
  usage: { promptTokens: number; completionTokens: number; cachedTokens?: number; costUsd?: number };
  durationMs: number;
  limitReason?: string;
}

const DEFAULT_TOKEN_BUDGET = 30_000;
const CHARS_PER_TOKEN = 4;
const STALL_REPEAT_LIMIT = 3;

/* ------------------------------------------------------------------ */
/* Exact-destination guard                                            */
/* ------------------------------------------------------------------ */

/** Absolute paths mentioned in the user's request (Windows, UNC, POSIX). */
export function extractAbsoluteDestinations(text: string): string[] {
  const found = new Set<string>();
  // C:\... or C:/... plus UNC \\server\share\...
  for (const m of text.matchAll(/[A-Za-z]:[\\/][^\s"'`)\]}>,;]+/g)) found.add(m[0]);
  for (const m of text.matchAll(/\\\\[^\s"'`)\]}>,;]+/g)) found.add(m[0]);
  // /home/..., /Users/..., /tmp/... (at least two segments)
  for (const m of text.matchAll(/(?<![\w/])\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g)) found.add(m[0]);
  return [...found];
}

function normalizeDest(p: string): string {
  const isWin = /^[A-Za-z]:[\\/]|^\\\\/.test(p);
  const unified = p.replace(/\\/g, '/');
  return isWin ? unified.toLowerCase() : unified;
}

/** Tool-call arguments arrive as a JSON string from providers. */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
}

function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter((s) => s !== '');
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/**
 * If the user named an absolute destination file ("make notes.txt on
 * D:\\docs\\notes.txt"), a create_file for that file name MUST use exactly
 * that path. Anything else — a bare name, a workspace-relative path, or a
 * different absolute path with the same file name — is the duplicate-copy
 * bug: one file at the destination, one in the terminal/workspace folder.
 * Returns a blocking message, or null when the call is allowed.
 */
export function exactDestinationBlock(userTask: string, toolName: string, args: Record<string, unknown>): string | null {
  if (toolName !== 'create_file' && toolName !== 'move_file') return null;
  const requested =
    typeof args['path'] === 'string' ? (args['path'] as string) : typeof args['destination'] === 'string' ? (args['destination'] as string) : '';
  if (requested === '') return null;
  const destinations = extractAbsoluteDestinations(userTask);
  if (destinations.length === 0) return null;
  const reqBase = baseName(requested);
  const sameName = destinations.filter((d) => baseName(d) === reqBase);
  if (sameName.length === 0) return null; // a different file — user may create it anywhere allowed
  const reqIsAbsolute = /^[A-Za-z]:[\\/]|^\\\\|^\//.test(requested);
  const exact = sameName.find((d) => normalizeDest(d) === normalizeDest(requested));
  if (exact !== undefined) return null;
  return (
    `create_file blocked: the user explicitly named the destination "${sameName[0]}". ` +
    (reqIsAbsolute
      ? `The requested path "${requested}" is a different location with the same file name — creating it there would leave a duplicate copy. `
      : `The requested path "${requested}" is relative, so it would land in the workspace/terminal folder, not where the user asked. `) +
    `Create the file ONLY at the exact destination: create_file path="${sameName[0]}". ` +
    `If that folder needs write access first, call request_path_access with that exact folder and write=true, wait for approval, then create it once.`
  );
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentReport> {
  const startedAt = Date.now();
  const messages: ChatMessage[] = [{ role: 'system', content: options.system }, ...(options.history ?? []), { role: 'user', content: options.userTask }];
  const steps: AgentStep[] = [];
  const tools: ToolDefinition[] = options.registry.toDefinition();
  const stream = options.stream ?? false;
  let toolCallsTotal = 0;
  let deniedCount = 0;
  let finalText = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  const signatureCounts = new Map<string, number>();
  const deadline = startedAt + options.maxDurationMs;

  const checkCancelled = () => {
    if (options.signal?.aborted) throw new ProviderError('aborted', 'Cancelled by user.');
  };

  try {
    for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
      checkCancelled();
      if (Date.now() > deadline) {
        return report('limit', { limitReason: `Time budget of ${options.maxDurationMs} ms exhausted.` });
      }
      const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
      trimContext(messages, budget * CHARS_PER_TOKEN);
      if (options.onContextUsage) {
        const estimated = estimateTokens(messages);
        options.onContextUsage({ estimatedTokens: estimated, budget, percent: budget > 0 ? Math.min(100, Math.round((estimated / budget) * 100)) : 0 });
      }

      // Track delivery per request so the caller never prints the same answer twice.
      let textDelivered = false;
      const emitText = (delta: string) => {
        if (delta === '') return;
        textDelivered = true;
        options.onText?.(delta);
      };

      let result;
      try {
        options.onModelRequest?.(iteration);
        result = await options.provider.chat({
          model: options.model,
          messages,
          tools,
          stream,
          ...(stream ? { onToken: emitText } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'aborted') return report('cancelled', {});
        throw err;
      }

      if (result.usage) {
        promptTokens += result.usage.promptTokens ?? 0;
        completionTokens += result.usage.completionTokens ?? 0;
        cachedTokens += result.usage.cachedTokens ?? 0;
        costUsd += result.usage.costUsd ?? 0;
        options.onUsage?.(result.usage);
      }
      if (options.costCapUsd !== undefined && costUsd > options.costCapUsd) {
        return report('limit', { limitReason: `Cost cap reached: $${costUsd.toFixed(4)} spent (cap $${options.costCapUsd}).` });
      }
      if (!stream && result.text) emitText(result.text);
      if (result.text) options.onTextDone?.();

      steps.push({
        iteration,
        assistantText: result.text,
        toolCalls: [],
      });
      const step = steps[steps.length - 1]!;

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: result.text,
        ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
      };
      messages.push(assistantMsg);
      options.onMessage?.(assistantMsg);

      if (result.toolCalls.length === 0) {
        finalText = result.text;
        return report('completed', { finalTextDelivered: textDelivered });
      }

      // Group consecutive read-only (tier 0) calls and run them in parallel;
      // anything that needs approval stays strictly sequential so the user
      // sees one decision at a time, in order.
      const groups: { parallel: boolean; calls: typeof result.toolCalls }[] = [];
      for (const call of result.toolCalls) {
        const ro = options.parallelTools !== false && (TOOL_BASE_TIER[call.name] ?? 2) === 0;
        const last = groups[groups.length - 1];
        if (ro && last?.parallel) last.calls.push(call);
        else groups.push({ parallel: ro, calls: [call] });
      }
      for (const group of groups) {
        const outcomes = await Promise.all(
          group.calls.map(async (call) => {
            checkCancelled();
            const signature = `${call.name}:${stableStringify(call.arguments)}`;
            const seen = (signatureCounts.get(signature) ?? 0) + 1;
            signatureCounts.set(signature, seen);
            if (seen > STALL_REPEAT_LIMIT) return { call, stall: true as const, seen };
            options.onToolEvent?.({ type: 'start', name: call.name });
            // Exact-destination guard: never let a same-named file be created
            // relative to the workspace/terminal when the user named a path.
            const blocked = exactDestinationBlock(options.userTask, call.name, parseToolArgs(call.arguments));
            if (blocked !== null) {
              return { call, stall: false as const, toolResult: { ok: false, summary: blocked, error: blocked } satisfies ToolResult };
            }
            let toolResult: ToolResult;
            try {
              toolResult = await options.registry.execute(call.name, call.arguments, options.toolContext);
            } catch (err) {
              toolResult = { ok: false, summary: `Tool crashed: ${(err as Error).message}`, error: (err as Error).message };
            }
            return { call, stall: false as const, toolResult };
          }),
        );
        for (const outcome of outcomes) {
          const { call } = outcome;
          toolCallsTotal += 1;
          if (toolCallsTotal > options.maxToolCalls) {
            return report('limit', { limitReason: `Tool-call budget (${options.maxToolCalls}) exhausted.` });
          }
          if (outcome.stall) {
            return report('limit', { limitReason: `Stall detected: ${call.name} was called ${outcome.seen} times with identical arguments.` });
          }
          const toolResult = outcome.toolResult;
          if (!toolResult.ok && toolResult.summary.startsWith('Action denied')) deniedCount += 1;
          const toolMsg: ChatMessage = { role: 'tool', toolCallId: call.id, name: call.name, content: options.registry.renderForModel(call.name, toolResult) };
          messages.push(toolMsg);
          options.onMessage?.(toolMsg);
          step.toolCalls.push({ name: call.name, ok: toolResult.ok, summary: toolResult.summary, args: compactArgs(call.arguments) });
          options.onToolEvent?.({ type: 'done', name: call.name, ok: toolResult.ok, summary: toolResult.summary });
          if (deniedCount >= 3) {
            return report('limit', { limitReason: 'Three actions were denied; stopping instead of pushing against the security policy.' });
          }
        }
      }
    }
    return report('limit', { limitReason: `Iteration budget (${options.maxIterations}) exhausted.` });
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'aborted') return report('cancelled', {});
    return report('error', { limitReason: (err as Error).message });
  }

  function report(status: AgentReport['status'], extra: { limitReason?: string; finalTextDelivered?: boolean }): AgentReport {
    return {
      status,
      finalText,
      finalTextDelivered: extra.finalTextDelivered ?? false,
      iterations: steps.length,
      toolCallsTotal,
      deniedCount,
      steps,
      usage: { promptTokens, completionTokens, ...(cachedTokens > 0 ? { cachedTokens } : {}), ...(costUsd > 0 ? { costUsd } : {}) },
      durationMs: Date.now() - startedAt,
      ...(extra.limitReason ? { limitReason: extra.limitReason } : {}),
    };
  }
}

/** Rough token estimate (chars/4) used for context budgeting. */
export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
}

/**
 * Token-budgeted context compression (cheapest first):
 * 1) shrink the oldest large tool outputs to a one-line summary;
 * 2) only then drop the oldest assistant/tool pairs.
 * The system message and the most recent turns are never touched, so the
 * model keeps the task, the rules, and its latest working state.
 */
function trimContext(messages: ChatMessage[], maxChars = DEFAULT_TOKEN_BUDGET * CHARS_PER_TOKEN): void {
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= maxChars) return;
  for (let i = 1; i < messages.length - 1 && total > maxChars; i++) {
    const m = messages[i]!;
    if (m.role === 'tool' && m.content.length > 500 && !m.content.startsWith('[compressed]')) {
      const firstLine = m.content.split('\n')[0]?.slice(0, 100) ?? '';
      const oldLength = m.content.length;
      m.content = `[compressed ${m.name ?? 'tool'}: ${firstLine} … original ${oldLength} chars]`;
      total += m.content.length - oldLength;
    }
  }
  while (total > maxChars && messages.length > 4) {
    const dropped = messages.splice(2, 2);
    total -= dropped.reduce((n, m) => n + m.content.length, 0);
  }
}

/**
 * A small, size-bounded copy of a tool call's JSON arguments, kept on the step
 * so the run summary can list changed paths/apps/commands. File contents are
 * capped, so a 2 MB `create_file` never lands in the session report.
 */
function compactArgs(rawArguments: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return compactValue(parsed, 0) as Record<string, unknown>;
}

const MAX_ARG_STRING = 240;
const MAX_ARG_ITEMS = 30;
const MAX_ARG_DEPTH = 3;

function compactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.length > MAX_ARG_STRING ? `${value.slice(0, MAX_ARG_STRING)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_ARG_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, MAX_ARG_ITEMS).map((v) => compactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = compactValue(v, depth + 1);
  return out;
}

function stableStringify(s: string): string {
  try {
    const parsed = JSON.parse(s) as unknown;
    return JSON.stringify(parsed, Object.keys(parsed as object).sort());
  } catch {
    return s;
  }
}
