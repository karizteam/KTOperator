import type { ProviderProfile } from '../config/schema.js';
import { OpenAiCompatProvider } from './openai-compat.js';
import { httpJson } from './http.js';
import type { ConnectionTestResult, ModelInfo, ProviderCapabilities, ProviderDeps } from './interfaces/types.js';

export const OPENROUTER_DEFAULT_BASE = 'https://openrouter.ai/api/v1';

/**
 * First-class OpenRouter adapter (https://openrouter.ai/docs):
 *  - Bearer auth with a user-provided key (env or secure store);
 *  - optional HTTP-Referer / X-Title attribution headers;
 *  - model discovery incl. per-model capability detection via
 *    `supported_parameters` (tools / response_format / streaming);
 *  - usage + cost reporting via `usage: { include: true }`.
 */
export class OpenRouterProvider extends OpenAiCompatProvider {
  constructor(profile: ProviderProfile, apiKey: string | null, deps: ProviderDeps = {}) {
    super({
      type: 'openrouter',
      label: 'OpenRouter',
      baseUrl: profile.baseUrl ?? OPENROUTER_DEFAULT_BASE,
      apiKey,
      policy: { trustedLocal: profile.trustedLocal, allowPrivate: false },
      extraHeaders: {
        ...(profile.referer ? { 'http-referer': profile.referer } : {}),
        ...(profile.title ? { 'x-title': profile.title } : {}),
      },
      extraBody: { usage: { include: true } },
      capabilities: { streaming: true, toolCalling: true, structuredOutputs: true, modelListing: true },
      ...deps,
    });
  }

  override async listModels(): Promise<ModelInfo[]> {
    const url = await this.endpoint('/models');
    const json = (await httpJson(url, { method: 'GET', headers: this.headers(), ...this.pickDeps() })) as {
      data?: {
        id?: string;
        name?: string;
        context_length?: number;
        supported_parameters?: string[];
      }[];
    };
    return (json.data ?? [])
      .filter((m): m is { id: string; name?: string; context_length?: number; supported_parameters?: string[] } => typeof m.id === 'string')
      .map((m) => {
        const caps: Partial<ProviderCapabilities> = {};
        if (Array.isArray(m.supported_parameters)) {
          caps.toolCalling = m.supported_parameters.includes('tools');
          caps.structuredOutputs = m.supported_parameters.includes('response_format') || m.supported_parameters.includes('structured_outputs');
        }
        return {
          id: m.id,
          ...(m.name ? { label: m.name } : {}),
          ...(typeof m.context_length === 'number' ? { contextLength: m.context_length } : {}),
          ...(Object.keys(caps).length > 0 ? { capabilities: caps } : {}),
        };
      });
  }

  override async testConnection(): Promise<ConnectionTestResult> {
    // OpenRouter exposes /api/v1/auth/key for key metadata.
    try {
      const url = await this.endpoint('/auth/key');
      const json = (await httpJson(url, { method: 'GET', headers: this.headers(), ...this.pickDeps() })) as { data?: { label?: string; is_free_tier?: boolean } };
      const label = json.data?.label ? ` key “${json.data.label}”` : '';
      return { ok: true, detail: `OpenRouter authentication succeeded${label}.` };
    } catch {
      // Fall back to model listing if the key endpoint is unavailable.
      return super.testConnection();
    }
  }
}
