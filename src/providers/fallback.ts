import { ProviderError } from '../errors/errors.js';
import type { AIProvider, ChatRequest, ChatResult, ConnectionTestResult, ModelInfo, ProviderCapabilities } from './interfaces/types.js';

/**
 * Provider fallback chain.
 *
 * A long run should not die because one endpoint hiccuped: when the active
 * profile is rate-limited, out of credits, unreachable, or returns a 5xx, the
 * same request is retried once on the next configured profile and the run keeps
 * its context.
 *
 * Three rules keep this honest:
 *   - only transient failures fall back (never a bad key, an invalid request or
 *     a model that does not exist — those need the user, not another vendor);
 *   - nothing falls back after tokens have already reached the screen, because
 *     a second attempt would print the answer twice;
 *   - the switch is announced, so the user always knows which model answered.
 */

export type FallbackEvent = { from: string; to: string; reason: string };

export interface FallbackEntry {
  /** "profile · model", shown when this entry answers. */
  label: string;
  model: string;
  provider: AIProvider;
}

/** Failures where another provider is a reasonable next attempt. */
const TRANSIENT_KINDS = new Set(['rate_limit', 'insufficient_credits', 'network', 'timeout', 'provider']);

export function isFallbackWorthy(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (err.kind === 'aborted') return false;
  // A 4xx means the request itself is wrong (a bad key, an unknown model, a
  // malformed body): another vendor cannot fix that, whatever kind it was
  // labelled with. 429 is the one 4xx that says "not now, try elsewhere".
  if (err.status !== undefined && err.status >= 400 && err.status < 500 && err.status !== 429) return false;
  if (TRANSIENT_KINDS.has(err.kind)) return true;
  // Any 5xx is worth one retry elsewhere.
  return err.status !== undefined && err.status >= 500 && err.status < 600;
}

export class FallbackProvider implements AIProvider {
  private switched: FallbackEvent | null = null;

  constructor(
    private readonly entries: readonly FallbackEntry[],
    private readonly onSwitch?: ((event: FallbackEvent) => void) | undefined,
  ) {
    if (entries.length === 0) throw new ProviderError('provider', 'Fallback chain is empty.');
  }

  get type(): string {
    return this.entries[0]!.provider.type;
  }

  get label(): string {
    return this.entries.length > 1 ? `${this.entries[0]!.provider.label} (+${this.entries.length - 1} fallback)` : this.entries[0]!.provider.label;
  }

  /** The entry that answered last, when it was not the primary one. */
  get switchedTo(): FallbackEvent | null {
    return this.switched;
  }

  capabilities(): ProviderCapabilities {
    // The primary decides: a fallback that cannot do tools must not silently
    // downgrade a session that was set up for tool calling.
    return this.entries[0]!.provider.capabilities();
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    let streamed = false;
    let lastError: unknown = null;

    for (let index = 0; index < this.entries.length; index++) {
      const entry = this.entries[index]!;
      const guarded: ChatRequest = {
        ...request,
        model: entry.model,
        ...(request.onToken
          ? {
              onToken: (delta: string) => {
                if (delta !== '') streamed = true;
                request.onToken?.(delta);
              },
            }
          : {}),
      };

      try {
        const result = await entry.provider.chat(guarded);
        return index === 0 ? result : { ...result, model: result.model ?? entry.model };
      } catch (err) {
        lastError = err;
        if (!isFallbackWorthy(err) || index === this.entries.length - 1) throw err;
        if (streamed) {
          // Half an answer is already on screen; a second attempt would repeat it.
          throw err;
        }
        const event: FallbackEvent = {
          from: this.entries[index]!.label,
          to: this.entries[index + 1]!.label,
          reason: (err as Error).message,
        };
        this.switched = event;
        this.onSwitch?.(event);
      }
    }

    throw lastError ?? new ProviderError('provider', 'Every provider in the fallback chain failed.');
  }

  async listModels(): Promise<ModelInfo[]> {
    const primary = this.entries[0]!.provider;
    return primary.listModels ? primary.listModels() : [];
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const primary = this.entries[0]!.provider;
    return primary.testConnection ? primary.testConnection() : { ok: true, detail: `${primary.label}: no dedicated connectivity test.` };
  }
}
