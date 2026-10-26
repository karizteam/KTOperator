import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, type ProviderErrorKind } from '../../src/errors/errors.js';
import { OpenRouterProvider } from '../../src/providers/openrouter.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { GoogleProvider } from '../../src/providers/google.js';
import { OpenAiCompatProvider } from '../../src/providers/openai-compat.js';
import { createProvider } from '../../src/providers/registry.js';
import { validateProviderBaseUrl } from '../../src/providers/ssrf.js';
import { defaultConfig, type ProviderProfile } from '../../src/config/schema.js';
import type { ChatRequest } from '../../src/providers/interfaces/types.js';

type FetchHandler = (url: string, init: { body?: unknown; headers?: Record<string, string>; method?: string }) => unknown;

/** Build a fetchImpl that never touches the network. */
function mockFetch(handler: FetchHandler): typeof fetch {
  return (async (url: unknown, init?: { body?: string; headers?: HeadersInit; method?: string }) => {
    let parsedBody: unknown;
    try {
      parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    } catch {
      parsedBody = init?.body;
    }
    const headerObj = Object.fromEntries(new Headers(init?.headers).entries());
    const out = handler(String(url), { body: parsedBody, headers: headerObj, method: init?.method ?? (parsedBody ? 'POST' : 'GET') });
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const openrouterProfile: ProviderProfile = {
  id: 'or',
  type: 'openrouter',
  trustedLocal: false,
  referer: 'https://example.app',
  title: 'OperatorTest',
};

function baseReq(partial?: Partial<ChatRequest>): ChatRequest {
  return {
    model: 'test/model',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ],
    ...partial,
  };
}

describe('OpenRouter adapter', () => {
  it('sends attribution headers and parses completions with usage', async () => {
    let seen: { headers?: Record<string, string>; body?: unknown } = {};
    const provider = new OpenRouterProvider(openrouterProfile, 'sk-or-key', {
      fetchImpl: mockFetch((_url, init) => {
        seen = init;
        return {
          model: 'test/model',
          choices: [{ finish_reason: 'stop', message: { content: 'hi there' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.00042 },
        };
      }),
    });
    const result = await provider.chat(baseReq());
    assert.equal(result.text, 'hi there');
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.usage?.totalTokens, 14);
    assert.equal(result.usage?.costUsd, 0.00042);
    assert.equal(seen.headers?.['authorization'], 'Bearer sk-or-key');
    assert.equal(seen.headers?.['http-referer'], 'https://example.app');
    assert.equal(seen.headers?.['x-title'], 'OperatorTest');
  });

  it('parses tool calls from completions', async () => {
    const provider = new OpenRouterProvider(openrouterProfile, 'k', {
      fetchImpl: mockFetch(() => ({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
            },
          },
        ],
      })),
    });
    const result = await provider.chat(
      baseReq({ tools: [{ name: 'read_file', description: 'x', parameters: { type: 'object', properties: {} } }] }),
    );
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }]);
  });

  it('consumes SSE streams with incremental tool-call accumulation', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"list_directory","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\".\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    const provider = new OpenRouterProvider(openrouterProfile, 'k', {
      fetchImpl: (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch,
    });
    const tokens: string[] = [];
    const result = await provider.chat(baseReq({ stream: true, onToken: (d) => tokens.push(d) }));
    assert.equal(result.text, 'Hello');
    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.deepEqual(result.toolCalls, [{ id: 'c1', name: 'list_directory', arguments: '{"path":"."}' }]);
    assert.equal(result.usage?.totalTokens, 5);
    assert.equal(result.finishReason, 'tool_calls');
  });

  it('detects per-model capabilities from /models supported_parameters', async () => {
    const provider = new OpenRouterProvider(openrouterProfile, 'k', {
      fetchImpl: mockFetch(() => ({
        data: [
          { id: 'a/tools', name: 'A', context_length: 1000, supported_parameters: ['tools', 'response_format'] },
          { id: 'b/plain', name: 'B', supported_parameters: [] },
        ],
      })),
    });
    const models = await provider.listModels();
    assert.equal(models[0]!.capabilities?.toolCalling, true);
    assert.equal(models[1]!.capabilities?.toolCalling, false);
  });

  it('normalizes provider errors by status', async () => {
    const cases: [number, string, ProviderErrorKind][] = [
      [401, '{"error":"invalid key"}', 'auth'],
      [402, '{"error":"no credits"}', 'insufficient_credits'],
      [429, '{"error":"slow down"}', 'rate_limit'],
      [404, '{"error":"model not found"}', 'invalid_model'],
      [500, 'boom', 'provider'],
    ];
    for (const [status, body, kind] of cases) {
      const provider = new OpenRouterProvider(openrouterProfile, 'k', {
        maxRetries: 0,
        fetchImpl: (async () => new Response(body, { status })) as unknown as typeof fetch,
      });
      await assert.rejects(
        () => provider.chat(baseReq()),
        (err: unknown) => err instanceof ProviderError && err.kind === kind,
      );
    }
  });

  it('retries on 429 with Retry-After and eventually succeeds', async () => {
    let attempts = 0;
    const provider = new OpenRouterProvider(openrouterProfile, 'k', {
      maxRetries: 2,
      fetchImpl: (async () => {
        attempts += 1;
        if (attempts < 2) return new Response('{"error":"rate"}', { status: 429, headers: { 'retry-after': '0' } });
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const result = await provider.chat(baseReq());
    assert.equal(result.text, 'ok');
    assert.equal(attempts, 2);
  });

  it('refuses to follow redirects (SSRF defense)', async () => {
    const provider = new OpenRouterProvider(openrouterProfile, 'k', {
      fetchImpl: (async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/meta' } })) as unknown as typeof fetch,
      maxRetries: 0,
    });
    await assert.rejects(() => provider.chat(baseReq()), /redirect/);
  });
});

describe('Anthropic adapter', () => {
  const profile: ProviderProfile = { id: 'a', type: 'anthropic', trustedLocal: false };

  it('maps system/tools/tool-results to the Messages format', async () => {
    let body: Record<string, unknown> = {};
    const provider = new AnthropicProvider(profile, 'k', {
      lookupImpl: async () => ['93.184.216.34'],
      fetchImpl: mockFetch((_url, init) => {
        body = (init.body ?? {}) as Record<string, unknown>;
        return {
          content: [{ type: 'text', text: 'answer' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'x' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 7, output_tokens: 3 },
        };
      }),
    });
    const result = await provider.chat(
      baseReq({
        tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
        messages: [
          { role: 'system', content: 'rules' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', toolCalls: [{ id: 't0', name: 'list_directory', arguments: '{}' }] },
          { role: 'tool', toolCallId: 't0', name: 'list_directory', content: 'entries' },
        ],
      }),
    );
    assert.equal(result.text, 'answer');
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.toolCalls, [{ id: 't1', name: 'read_file', arguments: '{"path":"x"}' }]);
    assert.equal(body['system'], 'rules');
    const msgs = body['messages'] as { role: string; content: unknown }[];
    assert.equal(msgs[0]!.role, 'user');
    assert.ok(JSON.stringify(msgs[1]).includes('tool_use'));
    assert.ok(JSON.stringify(msgs[2]).includes('tool_result'));
  });

  it('fails clearly when no key is configured', async () => {
    const provider = new AnthropicProvider(profile, null, {});
    await assert.rejects(() => provider.chat(baseReq()), /API key is not configured/);
  });
});

describe('Google adapter', () => {
  const profile: ProviderProfile = { id: 'g', type: 'google', trustedLocal: false };

  it('keeps the API key out of the URL and parses function calls', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const provider = new GoogleProvider(profile, 'secret-key-value', {
      lookupImpl: async () => ['93.184.216.34'],
      fetchImpl: mockFetch((url, init) => {
        seenUrl = url;
        seenHeaders = init.headers ?? {};
        return {
          candidates: [{ content: { parts: [{ text: 'thinking…' }, { functionCall: { name: 'search_text', args: { query: 'q' } } }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        };
      }),
    });
    const result = await provider.chat(baseReq());
    assert.equal(seenHeaders['x-goog-api-key'], 'secret-key-value');
    assert.ok(!seenUrl.includes('secret-key-value'), 'key must never appear in the URL');
    assert.equal(result.text, 'thinking…');
    assert.deepEqual(result.toolCalls, [{ id: 'gemini_0', name: 'search_text', arguments: '{"query":"q"}' }]);
    assert.equal(result.usage?.totalTokens, 3);
  });
});

describe('SSRF policy', () => {
  const publicLookup = async () => ['93.184.216.34'];

  it('rejects plain HTTP for untrusted providers', async () => {
    await assert.rejects(
      () => validateProviderBaseUrl('http://api.example.com/v1', { trustedLocal: false, allowPrivate: false }, publicLookup),
      /Plain HTTP/,
    );
  });

  it('rejects URLs with embedded credentials', async () => {
    await assert.rejects(
      () => validateProviderBaseUrl('https://user:pass@api.example.com', { trustedLocal: false, allowPrivate: false }, publicLookup),
      /credentials/,
    );
  });

  it('rejects private-resolution hostnames unless trusted', async () => {
    const privateLookup = async () => ['192.168.1.10'];
    await assert.rejects(
      () => validateProviderBaseUrl('https://internal.example.com', { trustedLocal: false, allowPrivate: false }, privateLookup),
      /private address/,
    );
    const ok = await validateProviderBaseUrl('http://127.0.0.1:11434/v1', { trustedLocal: true, allowPrivate: false }, privateLookup);
    assert.equal(ok.hostname, '127.0.0.1');
  });

  it('rejects non-standard ports for untrusted endpoints', async () => {
    await assert.rejects(
      () => validateProviderBaseUrl('https://api.example.com:8443/v1', { trustedLocal: false, allowPrivate: false }, publicLookup),
      /port/,
    );
  });

  it('rejects localhost names even before DNS when untrusted', async () => {
    for (const host of ['https://localhost/v1', 'https://app.localhost/v1', 'https://printer.internal/v1']) {
      await assert.rejects(
        () => validateProviderBaseUrl(host, { trustedLocal: false, allowPrivate: false }, publicLookup),
        /private/,
        host,
      );
    }
  });
});

describe('provider registry', () => {
  it('builds every provider type from config', () => {
    const config = defaultConfig();
    const types: ProviderProfile['type'][] = ['openrouter', 'openai', 'anthropic', 'google', 'openai-compatible', 'ollama'];
    for (const type of types) {
      const profile: ProviderProfile = {
        id: `p-${type}`,
        type,
        trustedLocal: type === 'ollama',
        ...(type === 'openai-compatible' ? { baseUrl: 'https://api.example.com/v1' } : {}),
      };
      const provider = createProvider(profile, type === 'ollama' ? null : 'key', config, {});
      assert.equal(provider.type, type === 'openai-compatible' ? 'openai-compatible' : type);
    }
  });

  it('openai-compatible requires a base URL', () => {
    const config = defaultConfig();
    assert.throws(
      () => createProvider({ id: 'x', type: 'openai-compatible', trustedLocal: false }, 'k', config, {}),
      /requires a baseUrl/,
    );
  });
});

describe('generic OpenAI-compatible adapter', () => {
  it('works against any /chat/completions endpoint', async () => {
    const profile: ProviderProfile = { id: 'c', type: 'openai-compatible', trustedLocal: false, baseUrl: 'https://llm.example.com/v1' };
    const provider = new OpenAiCompatProvider({
      type: 'openai-compatible',
      label: 'custom',
      baseUrl: profile.baseUrl!,
      apiKey: 'k',
      policy: { trustedLocal: false, allowPrivate: false },
      lookupImpl: async () => ['93.184.216.34'],
      fetchImpl: mockFetch(() => ({ choices: [{ finish_reason: 'stop', message: { content: 'hey' } }] })),
    });
    const result = await provider.chat(baseReq());
    assert.equal(result.text, 'hey');
  });
});
