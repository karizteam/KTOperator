import { ProviderError, type ProviderErrorKind } from '../errors/errors.js';
import type { AIProvider, ChatMessage, ChatRequest, ChatResult, ConnectionTestResult, ModelInfo, ProviderCapabilities, ProviderDeps, ToolCall, Usage } from './interfaces/types.js';
import { httpJson, httpRequest } from './http.js';
import { parseSse } from './sse.js';
import { validateProviderBaseUrl, type UrlPolicy } from './ssrf.js';

/**
 * Base adapter for the OpenAI chat-completions wire format, shared by
 * OpenRouter, OpenAI, generic OpenAI-compatible endpoints, and Ollama's
 * compatibility API.
 */
export interface OpenAiCompatOptions extends ProviderDeps {
  type: string;
  label: string;
  baseUrl: string;
  apiKey?: string | null;
  policy: UrlPolicy;
  /** Extra headers (e.g. OpenRouter attribution). */
  extraHeaders?: Record<string, string>;
  /** Extra JSON fields merged into every chat request (e.g. usage include). */
  extraBody?: Record<string, unknown>;
  capabilities?: Partial<ProviderCapabilities>;
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export class OpenAiCompatProvider implements AIProvider {
  readonly type: string;
  readonly label: string;
  protected readonly baseUrl: string;
  protected readonly apiKey: string | null;
  protected readonly deps: ProviderDeps;
  protected readonly extraHeaders: Record<string, string>;
  protected readonly extraBody: Record<string, unknown>;
  private readonly declaredCaps: Partial<ProviderCapabilities>;
  private validatedBase: Promise<URL> | null = null;
  private readonly policy: UrlPolicy;

  constructor(options: OpenAiCompatOptions) {
    this.type = options.type;
    this.label = options.label;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? null;
    this.deps = options;
    this.extraHeaders = options.extraHeaders ?? {};
    this.extraBody = options.extraBody ?? {};
    this.declaredCaps = options.capabilities ?? {};
    this.policy = options.policy;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: this.declaredCaps.streaming ?? true,
      toolCalling: this.declaredCaps.toolCalling ?? true,
      structuredOutputs: this.declaredCaps.structuredOutputs ?? true,
      modelListing: this.declaredCaps.modelListing ?? true,
    };
  }

  protected async endpoint(path: string): Promise<string> {
    this.validatedBase ??= validateProviderBaseUrl(this.baseUrl, this.policy, this.deps.lookupImpl);
    const base = await this.validatedBase;
    return `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`;
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = { ...this.extraHeaders };
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
    return headers;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const url = await this.endpoint('/chat/completions');
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toWireMessage),
      ...this.extraBody,
    };
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body['tool_choice'] = 'auto';
    }
    if (request.maxTokens !== undefined) body['max_tokens'] = request.maxTokens;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.responseFormat === 'json') body['response_format'] = { type: 'json_object' };

    if (request.stream) {
      body['stream'] = true;
      body['stream_options'] = { include_usage: true };
      const res = await httpRequest(url, this.reqOptions(body, request.signal));
      return this.consumeStream(res, request);
    }
    const json = (await httpJson(url, this.reqOptions(body, request.signal))) as Record<string, unknown>;
    return parseWireCompletion(json);
  }

  private reqOptions(body: unknown, signal?: AbortSignal) {
    return {
      body,
      headers: this.headers(),
      ...(signal ? { signal } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
      ...(this.deps.maxRetries !== undefined ? { maxRetries: this.deps.maxRetries } : {}),
    };
  }

  protected async consumeStream(res: Response, request: ChatRequest): Promise<ChatResult> {
    const textParts: string[] = [];
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let finish: ChatResult['finishReason'] = 'unknown';
    let usage: Usage | undefined;
    let model: string | undefined;

    for await (const data of parseSse(res)) {
      if (data === '[DONE]') break;
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // heartbeat / partial
      }
      const c = chunk as {
        model?: string;
        usage?: Record<string, unknown>;
        choices?: {
          finish_reason?: string | null;
          delta?: {
            content?: string | null;
            tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
      };
      if (typeof c.model === 'string') model = c.model;
      if (c.usage) usage = normalizeUsage(c.usage);
      const choice = c.choices?.[0];
      if (!choice) continue;
      if (typeof choice.finish_reason === 'string') finish = normalizeFinish(choice.finish_reason);
      const delta = choice.delta;
      if (delta?.content) {
        textParts.push(delta.content);
        request.onToken?.(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const acc = toolAcc.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        toolAcc.set(idx, acc);
      }
    }
    const toolCalls: ToolCall[] = [...toolAcc.values()]
      .filter((t) => t.name !== '')
      .map((t, i) => ({ id: t.id || `call_${i}`, name: t.name, arguments: t.args }));
    if (toolCalls.length > 0 && finish === 'unknown') finish = 'tool_calls';
    return { text: textParts.join(''), toolCalls, finishReason: finish, ...(usage ? { usage } : {}), ...(model ? { model } : {}) };
  }

  async listModels(): Promise<ModelInfo[]> {
    const url = await this.endpoint('/models');
    const json = (await httpJson(url, { method: 'GET', headers: this.headers(), ...this.pickDeps() })) as { data?: { id?: string; name?: string }[] };
    return (json.data ?? [])
      .filter((m): m is { id: string; name?: string } => typeof m.id === 'string')
      .map((m) => ({ id: m.id, ...(m.name ? { label: m.name } : {}) }));
  }

  protected pickDeps() {
    return {
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
      ...(this.deps.maxRetries !== undefined ? { maxRetries: this.deps.maxRetries } : {}),
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const models = await this.listModels!();
      return { ok: true, detail: `Connected to ${this.label}; ${models.length} model(s) visible.`, modelsDiscovered: models.length };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, detail: `${err.kind}: ${err.message}` };
      return { ok: false, detail: (err as Error).message };
    }
  }
}

function toWireMessage(m: ChatMessage): WireMessage {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '', ...(m.name ? { name: m.name } : {}) };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content === '' ? null : m.content,
      tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } })),
    };
  }
  return { role: m.role, content: m.content };
}

export function parseWireCompletion(json: Record<string, unknown>): ChatResult {
  const choices = json['choices'] as
    | { finish_reason?: string | null; message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[]
    | undefined;
  const choice = choices?.[0];
  if (!choice?.message) {
    throw new ProviderError('provider', 'Provider response contained no completion.');
  }
  const message = choice.message;
  const toolCalls: ToolCall[] = (message.tool_calls ?? [])
    .filter((tc) => typeof tc.function?.name === 'string')
    .map((tc, i) => ({ id: tc.id ?? `call_${i}`, name: tc.function!.name!, arguments: tc.function?.arguments ?? '{}' }));
  return {
    text: message.content ?? '',
    toolCalls,
    finishReason: normalizeFinish(choice.finish_reason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop')),
    ...(json['usage'] ? { usage: normalizeUsage(json['usage'] as Record<string, unknown>) } : {}),
    ...(typeof json['model'] === 'string' ? { model: json['model'] } : {}),
  };
}

function normalizeUsage(raw: Record<string, unknown>): Usage {
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    ...(num(raw['prompt_tokens']) !== undefined ? { promptTokens: num(raw['prompt_tokens']) } : {}),
    ...(num(raw['completion_tokens']) !== undefined ? { completionTokens: num(raw['completion_tokens']) } : {}),
    ...(num(raw['total_tokens']) !== undefined ? { totalTokens: num(raw['total_tokens']) } : {}),
    ...(num(raw['cost']) !== undefined ? { costUsd: num(raw['cost']) } : {}),
  };
}

function normalizeFinish(reason: string): ChatResult['finishReason'] {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

export function openAiErrorGuard(err: unknown, fallbackKind: ProviderErrorKind = 'provider'): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError(fallbackKind, (err as Error).message, { cause: err });
}
