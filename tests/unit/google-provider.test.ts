import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_DEFAULT_BASE,
  GoogleProvider,
  normalizeGeminiModel,
  normalizeGoogleBase,
  toGeminiSchema,
} from '../../src/providers/google.js';
import { createProvider } from '../../src/providers/registry.js';
import { defaultConfig, type ProviderProfile } from '../../src/config/schema.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import type { ChatRequest } from '../../src/providers/interfaces/types.js';

/**
 * Gemini's functionDeclarations accept only the OpenAPI 3.0 subset and reject
 * unknown keys with HTTP 400. Every tool schema in this project carries
 * `additionalProperties: false` for local validation, so without the sanitizer
 * *every* request that includes tools failed — which is what "Gemini doesn't
 * work" looked like from the outside.
 */

const PUBLIC_LOOKUP = async (): Promise<string[]> => ['93.184.216.34'];

const profile: ProviderProfile = { id: 'gemini', type: 'google', trustedLocal: false };

function hasAdditionalProperties(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasAdditionalProperties);
  return Object.entries(value as Record<string, unknown>).some(([k, v]) => k === 'additionalProperties' || hasAdditionalProperties(v));
}

/** A fetch stub that records the request and answers with a Gemini payload. */
function mockGemini(respond: (url: string, init: { body?: unknown; headers: Record<string, string> }) => unknown) {
  const seen: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: unknown, init?: { body?: string; headers?: HeadersInit }) => {
    let body: unknown;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    } catch {
      body = init?.body;
    }
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    seen.push({ url: String(url), body, headers });
    const out = respond(String(url), { body, headers });
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function baseReq(partial?: Partial<ChatRequest>): ChatRequest {
  return { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], ...partial };
}

describe('Gemini schema compatibility', () => {
  it('drops keys the Generative Language API refuses, recursively', () => {
    const cleaned = toGeminiSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', maxLength: 10, additionalProperties: false, description: 'p' },
        edits: {
          type: 'array',
          minItems: 1,
          items: { type: 'object', additionalProperties: false, properties: { find: { type: 'string' } }, required: ['find'] },
        },
      },
      required: ['path'],
    });
    assert.equal(hasAdditionalProperties(cleaned), false);
    assert.deepEqual(cleaned['required'], ['path']);
    const props = cleaned['properties'] as Record<string, Record<string, unknown>>;
    assert.equal(props['path']!['maxLength'], 10);
    assert.equal(props['path']!['description'], 'p');
    assert.deepEqual((props['edits']!['items'] as Record<string, unknown>)['required'], ['find']);
  });

  it('produces a Gemini-safe schema for every tool in the registry', () => {
    for (const tool of ALL_TOOLS) {
      const cleaned = toGeminiSchema(tool.schema);
      assert.equal(hasAdditionalProperties(cleaned), false, tool.name);
      assert.equal(cleaned['type'], 'object', tool.name);
    }
  });

  it('sends Gemini-shaped tool declarations and never an OpenAI payload', async () => {
    const { fetchImpl, seen } = mockGemini(() => ({
      candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }] }, finishReason: 'STOP' }],
    }));
    const provider = new GoogleProvider(profile, 'k', { fetchImpl, lookupImpl: PUBLIC_LOOKUP });
    const result = await provider.chat(
      baseReq({ tools: ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.schema })), stream: false }),
    );

    assert.equal(seen.length, 1);
    const request = seen[0]!;
    assert.equal(request.url, `${GOOGLE_DEFAULT_BASE}/v1beta/models/gemini-2.5-pro:generateContent`);
    assert.ok(!request.url.includes('/chat/completions'), 'must not use the OpenAI-compatible surface');
    assert.equal(request.headers['x-goog-api-key'], 'k');
    assert.equal(request.headers['authorization'], undefined, 'no OpenAI-style bearer auth');

    const body = request.body as Record<string, unknown>;
    assert.ok(Array.isArray(body['contents']), 'Gemini uses `contents`');
    assert.equal(body['messages'], undefined, 'the OpenAI `messages` field must not be sent');
    const tools = body['tools'] as { functionDeclarations: { name: string; parameters: Record<string, unknown> }[] }[];
    assert.ok(Array.isArray(tools[0]!.functionDeclarations));
    assert.equal(hasAdditionalProperties(tools[0]!.functionDeclarations), false, 'tool declarations must be Gemini-safe');
    assert.deepEqual(result.toolCalls, [{ id: 'gemini_0', name: 'read_file', arguments: '{"path":"a.txt"}' }]);
    assert.equal(result.finishReason, 'tool_calls');
  });
});

describe('Gemini model and base normalization', () => {
  it('accepts the model ids other tools hand out', () => {
    assert.equal(normalizeGeminiModel('gemini-2.5-pro'), 'gemini-2.5-pro');
    assert.equal(normalizeGeminiModel('models/gemini-2.5-flash'), 'gemini-2.5-flash');
    assert.equal(normalizeGeminiModel('google/gemini-2.5-pro'), 'gemini-2.5-pro');
    assert.equal(normalizeGeminiModel(' models/gemini-2.5-pro '), 'gemini-2.5-pro');
    assert.throws(() => normalizeGeminiModel('   '), /No Gemini model/);
  });

  it('never lets a slash reach the request path', async () => {
    const { fetchImpl, seen } = mockGemini(() => ({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }));
    const provider = new GoogleProvider(profile, 'k', { fetchImpl, lookupImpl: PUBLIC_LOOKUP });
    await provider.chat(baseReq({ model: 'models/gemini-2.5-flash' }));
    assert.equal(seen[0]!.url, `${GOOGLE_DEFAULT_BASE}/v1beta/models/gemini-2.5-flash:generateContent`);
  });

  it('points an OpenAI-compatible Gemini base URL back at the native API', () => {
    assert.equal(normalizeGoogleBase(undefined), GOOGLE_DEFAULT_BASE);
    assert.equal(normalizeGoogleBase('https://generativelanguage.googleapis.com/'), GOOGLE_DEFAULT_BASE);
    assert.equal(normalizeGoogleBase('https://generativelanguage.googleapis.com/v1beta/openai'), GOOGLE_DEFAULT_BASE);
    assert.equal(normalizeGoogleBase('https://generativelanguage.googleapis.com/v1beta'), GOOGLE_DEFAULT_BASE);
    assert.equal(normalizeGoogleBase('https://generativelanguage.googleapis.com/v1'), GOOGLE_DEFAULT_BASE);
    assert.equal(normalizeGoogleBase('https://proxy.example.com/gemini'), 'https://proxy.example.com/gemini');
  });

  it('is the adapter the registry builds for the "Google Gemini" choice', () => {
    const provider = createProvider(profile, 'k', defaultConfig(), {});
    assert.ok(provider instanceof GoogleProvider);
    assert.equal(provider.type, 'google');
  });

  it('streams Gemini SSE events into text', async () => {
    const chunks = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":3}}\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    const provider = new GoogleProvider(profile, 'k', {
      lookupImpl: PUBLIC_LOOKUP,
      fetchImpl: (async (url: unknown) => {
        assert.match(String(url), /:streamGenerateContent\?alt=sse$/);
        return new Response(stream, { status: 200 });
      }) as unknown as typeof fetch,
    });
    const tokens: string[] = [];
    const result = await provider.chat(baseReq({ stream: true, onToken: (d) => tokens.push(d) }));
    assert.equal(result.text, 'Hello');
    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.equal(result.usage?.totalTokens, 3);
  });

  it('reports a missing key instead of sending an anonymous request', async () => {
    const provider = new GoogleProvider(profile, null, { lookupImpl: PUBLIC_LOOKUP });
    await assert.rejects(() => provider.chat(baseReq()), /API key is not configured/);
  });
});
