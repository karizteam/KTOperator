import { ConfigError } from '../errors/errors.js';
import type { OperatorConfig, ProviderProfile } from '../config/schema.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import type { AIProvider, ConnectionTestResult, ProviderDeps } from './interfaces/types.js';
import { OpenAiCompatProvider } from './openai-compat.js';
import { OpenRouterProvider } from './openrouter.js';

export const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
export const OLLAMA_DEFAULT_BASE = 'http://127.0.0.1:11434/v1';

/** Build a concrete provider adapter from a configured profile. */
export function createProvider(
  profile: ProviderProfile,
  apiKey: string | null,
  config: OperatorConfig,
  deps: ProviderDeps = {},
): AIProvider {
  const allowPrivate = config.network.allowPrivateProviderEndpoints;
  switch (profile.type) {
    case 'openrouter':
      return new OpenRouterProvider(profile, apiKey, deps);
    case 'openai':
      return new OpenAiCompatProvider({
        type: 'openai',
        label: 'OpenAI',
        baseUrl: profile.baseUrl ?? OPENAI_DEFAULT_BASE,
        apiKey,
        policy: { trustedLocal: profile.trustedLocal, allowPrivate },
        capabilities: { streaming: true, toolCalling: true, structuredOutputs: true, modelListing: true },
        ...deps,
      });
    case 'anthropic':
      return new AnthropicProvider(profile, apiKey, deps);
    case 'google':
      return new GoogleProvider(profile, apiKey, deps);
    case 'openai-compatible': {
      if (!profile.baseUrl) {
        throw new ConfigError(`Provider profile "${profile.id}" (openai-compatible) requires a baseUrl.`, {
          hint: 'Run `operator provider add` to configure it.',
        });
      }
      return new OpenAiCompatProvider({
        type: 'openai-compatible',
        label: `OpenAI-compatible (${profile.id})`,
        baseUrl: profile.baseUrl,
        apiKey,
        policy: { trustedLocal: profile.trustedLocal, allowPrivate },
        ...deps,
      });
    }
    case 'ollama': {
      // Ollama exposes an OpenAI-compatible API under /v1.
      return new OpenAiCompatProvider({
        type: 'ollama',
        label: 'Ollama (local)',
        baseUrl: profile.baseUrl ?? OLLAMA_DEFAULT_BASE,
        apiKey,
        policy: { trustedLocal: true, allowPrivate: true },
        capabilities: { streaming: true, toolCalling: true, structuredOutputs: false, modelListing: true },
        ...deps,
      });
    }
  }
}

export function findProfile(config: OperatorConfig, selector?: string): ProviderProfile {
  const id = selector ?? config.defaultProvider;
  if (!id) {
    throw new ConfigError('No AI provider is configured.', {
      hint: 'Just run `ktoperator` to open the console and pick a provider, or use `operator provider add` for scripts.',
    });
  }
  const profile = config.providers.find((p) => p.id === id);
  if (!profile) {
    throw new ConfigError(`Provider profile "${id}" does not exist.`, {
      hint: `Configured profiles: ${config.providers.map((p) => p.id).join(', ') || '(none)'}. Run \`ktoperator\` and pick a provider in the console.`,
    });
  }
  return profile;
}

export function resolveModel(profile: ProviderProfile, config: OperatorConfig, explicit?: string): string {
  const model = explicit ?? config.defaultModel ?? profile.model;
  if (!model) {
    throw new ConfigError('No model selected.', {
      hint: 'Pass --model, set a default with `operator config set defaultModel <id>`, or choose one with `operator model list`.',
    });
  }
  return model;
}

export async function testProviderConnection(provider: AIProvider): Promise<ConnectionTestResult> {
  if (provider.testConnection) return provider.testConnection();
  return { ok: true, detail: `${provider.label}: no dedicated connectivity test; assumed reachable.` };
}
