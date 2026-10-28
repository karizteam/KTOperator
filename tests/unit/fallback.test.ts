import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../../src/errors/errors.js';
import { FallbackProvider, isFallbackWorthy, type FallbackEntry } from '../../src/providers/fallback.js';
import type { AIProvider, ChatRequest, ChatResult } from '../../src/providers/interfaces/types.js';

function stub(label: string, handler: (request: ChatRequest) => ChatResult | Promise<ChatResult>): AIProvider {
  return {
    type: 'stub',
    label,
    capabilities: () => ({ streaming: true, toolCalling: true, structuredOutputs: false, modelListing: false }),
    chat: handler,
  };
}

const entries = (first: AIProvider, second: AIProvider): FallbackEntry[] => [
  { label: 'primary · m1', model: 'm1', provider: first },
  { label: 'backup · m2', model: 'm2', provider: second },
];

const request: ChatRequest = { messages: [{ role: 'user', content: 'hi' }] };

describe('provider fallback chain', () => {
  it('moves to the next profile on a transient failure and announces it', async () => {
    const seen: string[] = [];
    const provider = new FallbackProvider(
      entries(
        stub('primary', () => {
          throw new ProviderError('rate_limit', '429 too many requests', { status: 429 });
        }),
        stub('backup', () => ({ text: 'from backup', toolCalls: [], finishReason: 'stop', model: 'm2' })),
      ),
      (event) => seen.push(`${event.from} -> ${event.to}`),
    );

    const result = await provider.chat(request);
    assert.equal(result.text, 'from backup');
    assert.deepEqual(seen, ['primary · m1 -> backup · m2']);
    assert.equal(provider.switchedTo?.to, 'backup · m2');
  });

  it('the fallback answers with its own model, not the primary one', async () => {
    const requested: string[] = [];
    const provider = new FallbackProvider(
      entries(
        stub('primary', (req) => {
          requested.push(String(req.model));
          throw new ProviderError('network', 'ECONNRESET');
        }),
        stub('backup', (req) => {
          requested.push(String(req.model));
          return { text: 'ok', toolCalls: [], finishReason: 'stop' };
        }),
      ),
    );

    const result = await provider.chat({ ...request, model: 'm1' });
    assert.deepEqual(requested, ['m1', 'm2']);
    assert.equal(result.model, 'm2');
  });

  it('never retries a bad key, a bad request, or a missing model', async () => {
    for (const kind of ['auth', 'invalid_request', 'invalid_model', 'aborted'] as const) {
      let backupCalls = 0;
      const provider = new FallbackProvider(
        entries(
          stub('primary', () => {
            throw new ProviderError(kind, kind);
          }),
          stub('backup', () => {
            backupCalls += 1;
            return { text: 'unexpected', toolCalls: [], finishReason: 'stop' };
          }),
        ),
      );
      await assert.rejects(() => provider.chat(request), new RegExp(kind));
      assert.equal(backupCalls, 0, `${kind} must not fall back`);
    }
  });

  it('treats a 5xx as transient and a 400 as final', () => {
    assert.equal(isFallbackWorthy(new ProviderError('provider', 'boom', { status: 503 })), true);
    assert.equal(isFallbackWorthy(new ProviderError('provider', 'bad', { status: 400 })), false);
    assert.equal(isFallbackWorthy(new Error('not a provider error')), false);
  });

  it('does not fall back once answer text has been streamed', async () => {
    let backupCalls = 0;
    const provider = new FallbackProvider(
      entries(
        stub('primary', (req) => {
          req.onToken?.('half an ans');
          throw new ProviderError('timeout', 'stream stalled');
        }),
        stub('backup', () => {
          backupCalls += 1;
          return { text: 'second answer', toolCalls: [], finishReason: 'stop' };
        }),
      ),
    );

    const received: string[] = [];
    await assert.rejects(
      () => provider.chat({ ...request, onToken: (delta) => received.push(delta) }),
      /stream stalled/,
    );
    assert.deepEqual(received, ['half an ans']);
    assert.equal(backupCalls, 0);
  });
});
