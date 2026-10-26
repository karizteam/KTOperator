import { ProviderError } from '../errors/errors.js';
import type { ProviderProfile } from '../config/schema.js';
import type { AIProvider, ChatMessage, ChatRequest, ChatResult, ConnectionTestResult, ModelInfo, ProviderCapabilities, ProviderDeps, ToolCall, Usage } from './interfaces/types.js';
import { httpJson, httpRequest } from './http.js';
import { parseSse } from './sse.js';
import { validateProviderBaseUrl } from './ssrf.js';

export const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/** Model catalogue snapshot (Anthropic has no public model-list endpoint). */
const KNOWN_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
];

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/** Anthropic Messages API adapter. */
export class AnthropicProvider implements AIProvider {
  readonly type = 'anthropic';
  readonly label = 'Anthropic Claude';
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly deps: ProviderDeps;
  private readonly trustedLocal: boolean;
  private validatedBase: Promise<URL> | null = null;

  constructor(profile: ProviderProfile, apiKey: string | null, deps: ProviderDeps = {}) {
    this.baseUrl = (profile.baseUrl ?? ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.deps = deps;
    this.trustedLocal = profile.trustedLocal;
  }

  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: true, structuredOutputs: false, modelListing: false };
  }

  private async endpoint(path: string): Promise<string> {
    this.validatedBase ??= validateProviderBaseUrl(this.baseUrl, { trustedLocal: this.trustedLocal, allowPrivate: false }, this.deps.lookupImpl);
    const base = await this.validatedBase;
    return `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    if (!this.apiKey) {
      throw new ProviderError('auth', 'Anthropic API key is not configured.', { hint: 'Set ANTHROPIC_API_KEY or add the profile in the console (/provider add).' });
    }
    const url = await this.endpoint('/v1/messages');
    const { system, messages } = toAnthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 8192,
      messages,
    };
    if (system) body['system'] = system;
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.stream) {
      body['stream'] = true;
      const res = await httpRequest(url, this.reqOptions(body, request.signal));
      return this.consumeStream(res, request);
    }
    const json = (await httpJson(url, this.reqOptions(body, request.signal))) as {
      content?: AnthropicContentBlock[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return parseAnthropicResponse(json);
  }

  private reqOptions(body: unknown, signal?: AbortSignal) {
    return {
      body,
      headers: this.headers(),
      ...(signal ? { signal } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.maxRetries !== undefined ? { maxRetries: this.deps.maxRetries } : {}),
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
    };
  }

  private async consumeStream(res: Response, request: ChatRequest): Promise<ChatResult> {
    const textParts: string[] = [];
    const toolAcc = new Map<number, { id: string; name: string; json: string }>();
    let stop: string | undefined;
    const usage: Usage = {};

    for await (const data of parseSse(res)) {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      switch (ev['type']) {
        case 'message_start': {
          const u = (ev['message'] as { usage?: { input_tokens?: number } })?.usage;
          if (u?.input_tokens !== undefined) usage.promptTokens = u.input_tokens;
          break;
        }
        case 'content_block_start': {
          const block = ev['content_block'] as { type?: string; id?: string; name?: string };
          if (block?.type === 'tool_use') {
            toolAcc.set(Number(ev['index'] ?? 0), { id: block.id ?? '', name: block.name ?? '', json: '' });
          }
          break;
        }
        case 'content_block_delta': {
          const delta = ev['delta'] as { type?: string; text?: string; partial_json?: string };
          if (delta?.type === 'text_delta' && delta.text) {
            textParts.push(delta.text);
            request.onToken?.(delta.text);
          } else if (delta?.type === 'input_json_delta') {
            const acc = toolAcc.get(Number(ev['index'] ?? 0));
            if (acc) acc.json += delta.partial_json ?? '';
          }
          break;
        }
        case 'message_delta': {
          const d = ev['delta'] as { stop_reason?: string };
          if (d?.stop_reason) stop = d.stop_reason;
          const u = ev['usage'] as { output_tokens?: number } | undefined;
          if (u?.output_tokens !== undefined) usage.completionTokens = u.output_tokens;
          break;
        }
      }
    }
    const toolCalls: ToolCall[] = [...toolAcc.values()]
      .filter((t) => t.name !== '')
      .map((t, i) => ({ id: t.id || `toolu_${i}`, name: t.name, arguments: t.json === '' ? '{}' : t.json }));
    return {
      text: textParts.join(''),
      toolCalls,
      finishReason: stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length' : 'stop',
      ...(usage.promptTokens !== undefined || usage.completionTokens !== undefined ? { usage } : {}),
    };
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(KNOWN_MODELS);
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const url = await this.endpoint('/v1/messages');
      await httpJson(url, this.reqOptions({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }));
      return { ok: true, detail: 'Anthropic authentication succeeded.' };
    } catch (err) {
      if (err instanceof ProviderError) {
        // A 400 here still proves reachability+auth debate; auth errors mean failure.
        if (err.kind === 'auth') return { ok: false, detail: err.message };
        return { ok: true, detail: `Anthropic endpoint reachable (${err.kind}).` };
      }
      return { ok: false, detail: (err as Error).message };
    }
  }
}

function toAnthropicMessages(messages: ChatMessage[]): { system: string | undefined; messages: { role: 'user' | 'assistant'; content: AnthropicContentBlock[] | string }[] } {
  const systemParts: string[] = [];
  const out: { role: 'user' | 'assistant'; content: AnthropicContentBlock[] | string }[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      // Consecutive tool results must merge into one user turn.
      const block: AnthropicContentBlock = { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.arguments);
        } catch {
          /* pass through empty object */
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: out };
}

function parseAnthropicResponse(json: { content?: AnthropicContentBlock[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } }): ChatResult {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of json.content ?? []) {
    if (block.type === 'text') textParts.push(block.text);
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
  }
  return {
    text: textParts.join(''),
    toolCalls,
    finishReason: json.stop_reason === 'tool_use' ? 'tool_calls' : json.stop_reason === 'max_tokens' ? 'length' : 'stop',
    ...(json.usage
      ? {
          usage: {
            ...(json.usage.input_tokens !== undefined ? { promptTokens: json.usage.input_tokens } : {}),
            ...(json.usage.output_tokens !== undefined ? { completionTokens: json.usage.output_tokens } : {}),
          },
        }
      : {}),
  };
}
