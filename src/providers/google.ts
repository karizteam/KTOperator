import { ProviderError } from '../errors/errors.js';
import type { ProviderProfile } from '../config/schema.js';
import type { AIProvider, ChatMessage, ChatRequest, ChatResult, ConnectionTestResult, ModelInfo, ProviderCapabilities, ProviderDeps, ToolCall } from './interfaces/types.js';
import { httpJson, httpRequest } from './http.js';
import { parseSse } from './sse.js';
import { validateProviderBaseUrl } from './ssrf.js';

export const GOOGLE_DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { result: string } } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/** Google Gemini (Generative Language API) adapter. */
export class GoogleProvider implements AIProvider {
  readonly type = 'google';
  readonly label = 'Google Gemini';
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly deps: ProviderDeps;
  private readonly trustedLocal: boolean;
  private validatedBase: Promise<URL> | null = null;

  constructor(profile: ProviderProfile, apiKey: string | null, deps: ProviderDeps = {}) {
    this.baseUrl = (profile.baseUrl ?? GOOGLE_DEFAULT_BASE).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.deps = deps;
    this.trustedLocal = profile.trustedLocal;
  }

  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: true, structuredOutputs: true, modelListing: true };
  }

  private async endpoint(path: string): Promise<string> {
    this.validatedBase ??= validateProviderBaseUrl(this.baseUrl, { trustedLocal: this.trustedLocal, allowPrivate: false }, this.deps.lookupImpl);
    const base = await this.validatedBase;
    return `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    // Key travels in a header, never in the URL (keeps logs safe).
    return this.apiKey ? { 'x-goog-api-key': this.apiKey } : {};
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    if (!this.apiKey) {
      throw new ProviderError('auth', 'Google API key is not configured.', { hint: 'Set GOOGLE_API_KEY or add the profile in the console (/provider add).' });
    }
    const { systemInstruction, contents } = toGeminiContents(request.messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body['systemInstruction'] = { parts: [{ text: systemInstruction }] };
    if (request.tools && request.tools.length > 0) {
      body['tools'] = [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    }
    const generationConfig: Record<string, unknown> = {};
    if (request.maxTokens !== undefined) generationConfig['maxOutputTokens'] = request.maxTokens;
    if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature;
    if (request.responseFormat === 'json') generationConfig['responseMimeType'] = 'application/json';
    if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;

    if (request.stream) {
      const url = await this.endpoint(`/v1beta/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`);
      const res = await httpRequest(url, this.reqOptions(body, request.signal));
      return this.consumeStream(res, request);
    }
    const url = await this.endpoint(`/v1beta/models/${encodeURIComponent(request.model)}:generateContent`);
    const json = (await httpJson(url, this.reqOptions(body, request.signal))) as Record<string, unknown>;
    return parseGeminiResponse(json);
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
    const toolCalls: ToolCall[] = [];
    let usage: ChatResult['usage'];
    for await (const data of parseSse(res)) {
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const candidate = (chunk['candidates'] as { content?: { parts?: GeminiPart[] } }[] | undefined)?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if ('text' in part && part.text) {
          textParts.push(part.text);
          request.onToken?.(part.text);
        } else if ('functionCall' in part) {
          toolCalls.push({ id: `gemini_${toolCalls.length}`, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) });
        }
      }
      const meta = chunk['usageMetadata'] as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;
      if (meta) {
        usage = {
          ...(meta.promptTokenCount !== undefined ? { promptTokens: meta.promptTokenCount } : {}),
          ...(meta.candidatesTokenCount !== undefined ? { completionTokens: meta.candidatesTokenCount } : {}),
          ...(meta.totalTokenCount !== undefined ? { totalTokens: meta.totalTokenCount } : {}),
        };
      }
    }
    return { text: textParts.join(''), toolCalls, finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop', ...(usage ? { usage } : {}) };
  }

  async listModels(): Promise<ModelInfo[]> {
    const url = await this.endpoint('/v1beta/models');
    const json = (await httpJson(url, { method: 'GET', headers: this.headers(), ...this.pickDeps() })) as {
      models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[];
    };
    return (json.models ?? [])
      .filter((m) => typeof m.name === 'string' && (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => ({ id: m.name!.replace(/^models\//, ''), ...(m.displayName ? { label: m.displayName } : {}) }));
  }

  private pickDeps() {
    return {
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.maxRetries !== undefined ? { maxRetries: this.deps.maxRetries } : {}),
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const models = await this.listModels();
      return { ok: true, detail: `Connected to Google Gemini; ${models.length} model(s) visible.`, modelsDiscovered: models.length };
    } catch (err) {
      return { ok: false, detail: err instanceof ProviderError ? `${err.kind}: ${err.message}` : (err as Error).message };
    }
  }
}

function toGeminiContents(messages: ChatMessage[]): { systemInstruction: string | undefined; contents: GeminiContent[] } {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.name ?? 'tool', response: { result: m.content } } }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments) as Record<string, unknown>;
        } catch {
          /* empty */
        }
        parts.push({ functionCall: { name: tc.name, args } });
      }
      contents.push({ role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] });
      continue;
    }
    contents.push({ role: 'user', parts: [{ text: m.content }] });
  }
  return { systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, contents };
}

function parseGeminiResponse(json: Record<string, unknown>): ChatResult {
  const candidate = (json['candidates'] as { content?: { parts?: GeminiPart[] }; finishReason?: string }[] | undefined)?.[0];
  if (!candidate) {
    const block = json['promptFeedback'] as { blockReason?: string } | undefined;
    if (block?.blockReason) {
      throw new ProviderError('provider', `Gemini blocked the request: ${block.blockReason}`);
    }
    throw new ProviderError('provider', 'Gemini returned no candidates.');
  }
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const part of candidate.content?.parts ?? []) {
    if ('text' in part && part.text) textParts.push(part.text);
    else if ('functionCall' in part) toolCalls.push({ id: `gemini_${toolCalls.length}`, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) });
  }
  const meta = json['usageMetadata'] as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;
  return {
    text: textParts.join(''),
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
    ...(meta
      ? {
          usage: {
            ...(meta.promptTokenCount !== undefined ? { promptTokens: meta.promptTokenCount } : {}),
            ...(meta.candidatesTokenCount !== undefined ? { completionTokens: meta.candidatesTokenCount } : {}),
            ...(meta.totalTokenCount !== undefined ? { totalTokens: meta.totalTokenCount } : {}),
          },
        }
      : {}),
  };
}
