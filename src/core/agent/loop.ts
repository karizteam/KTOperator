import { ProviderError } from '../../errors/errors.js';
import type { AIProvider, ChatMessage, ToolDefinition, Usage } from '../../providers/interfaces/types.js';
import type { ToolRegistry, ToolContext } from '../../tools/index.js';

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
  stream?: boolean;
  signal?: AbortSignal | undefined;
  onText?: (delta: string) => void;
  onTextDone?: () => void;
  /** Called right before each model request (the model is "thinking"). */
  onModelRequest?: (iteration: number) => void;
  onToolEvent?: (event: { type: 'start' | 'done'; name: string; ok?: boolean; summary?: string }) => void;
  onUsage?: (usage: Usage) => void;
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
  usage: { promptTokens: number; completionTokens: number };
  durationMs: number;
  limitReason?: string;
}

const MAX_CONTEXT_CHARS = 120_000;
const STALL_REPEAT_LIMIT = 3;

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
      trimContext(messages);

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
        options.onUsage?.(result.usage);
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

      for (const call of result.toolCalls) {
        checkCancelled();
        toolCallsTotal += 1;
        if (toolCallsTotal > options.maxToolCalls) {
          return report('limit', { limitReason: `Tool-call budget (${options.maxToolCalls}) exhausted.` });
        }

        // Stall detection: identical (tool, args) repeatedly means no progress.
        const signature = `${call.name}:${stableStringify(call.arguments)}`;
        const seen = (signatureCounts.get(signature) ?? 0) + 1;
        signatureCounts.set(signature, seen);
        if (seen > STALL_REPEAT_LIMIT) {
          return report('limit', { limitReason: `Stall detected: ${call.name} was called ${seen} times with identical arguments.` });
        }

        options.onToolEvent?.({ type: 'start', name: call.name });
        let toolResult;
        try {
          toolResult = await options.registry.execute(call.name, call.arguments, options.toolContext);
        } catch (err) {
          toolResult = { ok: false, summary: `Tool crashed: ${(err as Error).message}`, error: (err as Error).message };
        }
        if (!toolResult.ok && toolResult.summary.startsWith('Action denied')) deniedCount += 1;
        if (deniedCount >= 3) {
          const toolMsg: ChatMessage = { role: 'tool', toolCallId: call.id, name: call.name, content: options.registry.renderForModel(call.name, toolResult) };
          messages.push(toolMsg);
          options.onMessage?.(toolMsg);
          step.toolCalls.push({ name: call.name, ok: false, summary: toolResult.summary, args: compactArgs(call.arguments) });
          return report('limit', { limitReason: 'Three actions were denied; stopping instead of pushing against the security policy.' });
        }
        options.onToolEvent?.({ type: 'done', name: call.name, ok: toolResult.ok, summary: toolResult.summary });
        step.toolCalls.push({ name: call.name, ok: toolResult.ok, summary: toolResult.summary, args: compactArgs(call.arguments) });
        const toolMsg: ChatMessage = {
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: options.registry.renderForModel(call.name, toolResult),
        };
        messages.push(toolMsg);
        options.onMessage?.(toolMsg);
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
      usage: { promptTokens, completionTokens },
      durationMs: Date.now() - startedAt,
      ...(extra.limitReason ? { limitReason: extra.limitReason } : {}),
    };
  }
}

/** Drop old tool outputs when the context grows too large. */
function trimContext(messages: ChatMessage[]): void {
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= MAX_CONTEXT_CHARS) return;
  for (const m of messages) {
    if (m.role === 'tool' && m.content.length > 2000) {
      m.content = `${m.content.slice(0, 2000)}\n[older tool output truncated to keep the context within limits]`;
    }
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
