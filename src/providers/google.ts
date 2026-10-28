import { ProviderError } from '../errors/errors.js';
import type { ProviderProfile } from '../config/schema.js';
import type { AIProvider, ChatMessage, ChatRequest, ChatResult, ConnectionTestResult, ModelInfo, ProviderCapabilities, ProviderDeps, ToolCall } from './interfaces/types.js';
import { httpJson, httpRequest } from './http.js';
import { parseSse } from './sse.js';
import { validateProviderBaseUrl } from './ssrf.js';

export const GOOGLE_DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

/**
 * The Generative Language API exposes two very different surfaces on the same
 * host: the native one (`/v1beta/models/{model}:generateContent`) and an
 * OpenAI-compatible shim (`/v1beta/openai/chat/completions`). A profile pointed
 * at the shim would send an OpenAI request and get OpenAI-shaped errors, so the
 * base is normalized to the host root and this adapter always speaks the
 * native protocol.
 */
export function normalizeGoogleBase(raw: string | undefined): string {
  const value = (raw ?? GOOGLE_DEFAULT_BASE).trim() || GOOGLE_DEFAULT_BASE;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value.replace(/\/+$/, '');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(v1beta|v1)(\/openai)?$/i, '').replace(/\/openai$/i, '');
  return `${url.origin}${path}`;
}

/**
 * Gemini model ids travel in the URL path, so a slash breaks the request. Model
 * pickers and other providers hand out ids like `models/gemini-2.5-pro` or
 * `google/gemini-2.5-pro`; both mean the same model here.
 */
export function normalizeGeminiModel(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new ProviderError('invalid_model', 'No Gemini model was selected.', {
      hint: 'Pick one with `/model reload` in the console, or pass --model.',
    });
  }
  let id = trimmed.replace(/^models\//i, '');
  if (id.includes('/')) id = id.slice(id.lastIndexOf('/') + 1);
  if (id === '') throw new ProviderError('invalid_model', `Not a Gemini model id: ${trimmed}`);
  return id;
}

/**
 * Gemini's `functionDeclarations[].parameters` accepts only the OpenAPI 3.0
 * Schema subset and rejects unknown keys outright (HTTP 400 INVALID_ARGUMENT).
 * Our tool schemas carry `additionalProperties: false` for local validation,
 * so the wire copy is filtered down to the keys Gemini understands while the
 * original schema keeps validating model arguments locally.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
]);

const MAX_SCHEMA_DEPTH = 12;

export function toGeminiSchema(schema: unknown, depth = 0): Record<string, unknown> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema) || depth > MAX_SCHEMA_DEPTH) {
    return { type: 'object', properties: {} };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue; // additionalProperties, $schema, oneOf, … are refused by the API
    if (key === 'properties') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const properties: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) properties[name] = toGeminiSchema(sub, depth + 1);
      out[key] = properties;
      continue;
    }
    if (key === 'items') {
      out[key] = toGeminiSchema(value, depth + 1);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Gemini 3 signs every function call with an opaque `thoughtSignature` and
 * rejects the next turn — HTTP 400 "Function call is missing a
 * thought_signature in functionCall parts" — unless each part travels back
 * exactly as it arrived. Google documents one placeholder for parts the API
 * did not generate (a call rebuilt from another provider's history, or one
 * loaded from an older session): the first function-call part of such a turn
 * can carry this sentinel instead.
 */
const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: { result: string } } };

/**
 * Tool calls from one candidate's parts, keeping the signature of each call.
 * Thinking text (`thought: true`) is deliberately not included: it is the
 * model's internal reasoning, not an answer for the user.
 */
function toolCallsFromParts(parts: GeminiPart[] | undefined): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const part of parts ?? []) {
    if (!('functionCall' in part)) continue;
    calls.push({
      id: `gemini_${calls.length}`,
      name: part.functionCall.name,
      arguments: JSON.stringify(part.functionCall.args ?? {}),
      ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
    });
  }
  return calls;
}

/** Visible text of a candidate, skipping internal thinking parts. */
function visibleText(parts: GeminiPart[] | undefined): string {
  return (parts ?? [])
    .filter((part): part is { text: string; thought?: boolean } => 'text' in part && part.thought !== true && part.text !== '')
    .map((part) => part.text)
    .join('');
}

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
    this.baseUrl = normalizeGoogleBase(profile.baseUrl);
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
    const model = normalizeGeminiModel(request.model);
    const { systemInstruction, contents } = toGeminiContents(request.messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body['systemInstruction'] = { parts: [{ text: systemInstruction }] };
    if (request.tools && request.tools.length > 0) {
      body['tools'] = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: toGeminiSchema(t.parameters),
          })),
        },
      ];
    }
    const generationConfig: Record<string, unknown> = {};
    if (request.maxTokens !== undefined) generationConfig['maxOutputTokens'] = request.maxTokens;
    if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature;
    if (request.responseFormat === 'json') generationConfig['responseMimeType'] = 'application/json';
    if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;

    if (request.stream) {
      const url = await this.endpoint(`/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`);
      const res = await httpRequest(url, this.reqOptions(body, request.signal));
      return this.consumeStream(res, request);
    }
    const url = await this.endpoint(`/v1beta/models/${encodeURIComponent(model)}:generateContent`);
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
        if ('text' in part) {
          if (part.thought === true || part.text === '') continue; // reasoning, not output
          textParts.push(part.text);
          request.onToken?.(part.text);
        }
      }
      toolCalls.push(...toolCallsFromParts(candidate?.content?.parts));
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

export function toGeminiContents(messages: ChatMessage[]): { systemInstruction: string | undefined; contents: GeminiContent[] } {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];
  /** Gemini expects alternating turns: merge neighbours instead of repeating a role. */
  const append = (role: GeminiContent['role'], parts: GeminiPart[]): void => {
    const last = contents[contents.length - 1];
    if (last !== undefined && last.role === role) {
      last.parts.push(...parts);
      return;
    }
    contents.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      // Parallel tool calls all answer into ONE user turn, in call order.
      append('user', [{ functionResponse: { name: m.name ?? 'tool', response: { result: m.content } } }]);
      continue;
    }
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      (m.toolCalls ?? []).forEach((tc, index) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments) as Record<string, unknown>;
        } catch {
          /* empty */
        }
        // The signature Gemini returned must be replayed verbatim; an unsigned
        // call (rebuilt from history, or from another provider) gets the
        // documented sentinel on the first part of the turn.
        const signature = tc.signature ?? (index === 0 ? SKIP_THOUGHT_SIGNATURE : undefined);
        parts.push({ functionCall: { name: tc.name, args }, ...(signature !== undefined ? { thoughtSignature: signature } : {}) });
      });
      append('model', parts.length > 0 ? parts : [{ text: '' }]);
      continue;
    }
    append('user', [{ text: m.content }]);
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
  const text = visibleText(candidate.content?.parts);
  const toolCalls: ToolCall[] = toolCallsFromParts(candidate.content?.parts);
  const meta = json['usageMetadata'] as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;
  return {
    text,
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
