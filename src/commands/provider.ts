import { ConfigError } from '../errors/errors.js';
import { DEFAULT_KEY_ENV } from '../config/credentials.js';
import { providerTypeSchema, type ProviderProfile, type ProviderType } from '../config/schema.js';
import { createProvider, testProviderConnection } from '../providers/registry.js';
import type { Runtime } from './runtime.js';

/** `operator provider list` — profiles without ever printing secrets. */
export async function providerList(rt: Runtime): Promise<void> {
  const rows = await Promise.all(
    rt.config.providers.map(async (p) => {
      const key = await rt.credentials.resolve(p);
      return {
        id: p.id,
        type: p.type,
        model: p.model ?? null,
        baseUrl: p.baseUrl ?? null,
        default: rt.config.defaultProvider === p.id,
        key: key.source === 'environment' ? `env:${key.envName}` : key.source === 'store' ? 'stored' : p.type === 'ollama' ? 'not required' : 'MISSING',
      };
    }),
  );
  rt.ui.emit({ providers: rows }, (d) => {
    const r = (d as { providers: typeof rows }).providers;
    if (r.length === 0) return 'No providers configured. Run `ktoperator` (console onboarding) or `operator provider add`.';
    return r
      .map((p) => `${p.default ? '*' : ' '} ${p.id}  ${p.type}  model=${p.model ?? '(none)'}  key=${p.key}${p.baseUrl ? `  url=${p.baseUrl}` : ''}`)
      .join('\n');
  });
}

export interface ProviderAddOptions {
  id: string;
  type: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  apiKeyEnv?: string | undefined;
  key?: string | undefined; // store securely; never echoed
  referer?: string | undefined;
  title?: string | undefined;
  trustedLocal?: boolean | undefined;
  makeDefault?: boolean | undefined;
  skipTest?: boolean | undefined;
}

/** `operator provider add` — non-wizard profile creation (flag driven). */
export async function providerAdd(rt: Runtime, opts: ProviderAddOptions): Promise<void> {
  const parsedType = providerTypeSchema.safeParse(opts.type);
  if (!parsedType.success) {
    throw new ConfigError(`Unknown provider type "${opts.type}".`, {
      hint: `Valid types: ${providerTypeSchema.options.join(', ')}.`,
    });
  }
  const type: ProviderType = parsedType.data;
  if (type === 'openai-compatible' && !opts.baseUrl) {
    throw new ConfigError('provider type openai-compatible requires --base-url.', { hint: 'This URL is validated against SSRF rules before use.' });
  }
  if (rt.config.providers.some((p) => p.id === opts.id)) {
    throw new ConfigError(`A provider profile named "${opts.id}" already exists.`, { hint: 'Choose another --id or remove it first.' });
  }

  const trustedLocal = opts.trustedLocal ?? (type === 'ollama');
  const profile: ProviderProfile = {
    id: opts.id,
    type,
    trustedLocal,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.apiKeyEnv ? { apiKeyEnv: opts.apiKeyEnv } : {}),
    ...(opts.referer ? { referer: opts.referer } : {}),
    ...(opts.title ? { title: opts.title } : {}),
  };

  // Validate base URL SSRF posture eagerly (fail fast, before saving).
  if (opts.baseUrl) {
    const { validateProviderBaseUrl } = await import('../providers/ssrf.js');
    await validateProviderBaseUrl(opts.baseUrl, {
      trustedLocal,
      allowPrivate: rt.config.network.allowPrivateProviderEndpoints,
    });
  }

  const envKey = opts.apiKeyEnv ?? DEFAULT_KEY_ENV[type];
  const apiKey = opts.key ?? (envKey ? (process.env[envKey] ?? null) : null);
  const provider = createProvider(profile, apiKey, rt.config, { maxRetries: 0, timeoutMs: 15_000 });
  let test: { ok: boolean; detail: string } | null = null;
  if (!opts.skipTest) {
    rt.ui.step('Testing connection…');
    test = await testProviderConnection(provider);
  }

  if (opts.key) {
    await rt.credentials.set(opts.id, opts.key);
  }

  rt.config = await rt.store.update((config) => {
    config.providers.push(profile);
    if (opts.makeDefault || config.providers.length === 1) {
      config.defaultProvider = opts.id;
      if (opts.model) config.defaultModel = opts.model;
    }
  });

  const payload = { added: true, id: opts.id, type, test: test ?? undefined };
  rt.ui.emit(payload, () => '');
  if (!rt.ui.jsonMode) {
    rt.ui.success(`Provider "${opts.id}" (${type}) added${rt.config.defaultProvider === opts.id ? ' and made default' : ''}.`);
    if (test) {
      if (test.ok) rt.ui.success(test.detail);
      else rt.ui.warn(`Connection test: ${test.detail}`);
    }
    if (!apiKey && type !== 'ollama') {
      rt.ui.warn(`No API key found yet — set ${envKey} or re-run with --key.`);
    }
  }
}

/** `operator provider test [id]` — live connectivity + auth check. */
export async function providerTest(rt: Runtime, id: string | undefined): Promise<number> {
  const { profile, provider } = await resolveForTest(rt, id);
  const result = await testProviderConnection(provider);
  rt.ui.emit({ id: profile.id, type: profile.type, ...result }, () => '');
  if (!rt.ui.jsonMode) {
    if (result.ok) rt.ui.success(`[${profile.id}] ${result.detail}`);
    else rt.ui.error(`[${profile.id}] ${result.detail}`);
  }
  return result.ok ? 0 : 1;
}

/** `operator provider remove <id>` — also deletes any stored key. */
export async function providerRemove(rt: Runtime, id: string): Promise<void> {
  const exists = rt.config.providers.some((p) => p.id === id);
  if (!exists) throw new ConfigError(`No provider profile named "${id}".`);
  await rt.credentials.delete(id);
  rt.config = await rt.store.update((config) => {
    config.providers = config.providers.filter((p) => p.id !== id);
    if (config.defaultProvider === id) {
      config.defaultProvider = config.providers[0]?.id;
      if (config.defaultProvider === undefined) delete config.defaultProvider;
    }
  });
  rt.ui.emit({ removed: id }, () => '');
  if (!rt.ui.jsonMode) rt.ui.success(`Removed provider "${id}" (stored credentials deleted if any).`);
}

async function resolveForTest(rt: Runtime, id: string | undefined) {
  const selector = id ?? rt.config.defaultProvider;
  if (!selector) throw new ConfigError('No provider specified and no default configured.', { hint: 'operator provider list' });
  const profile = rt.config.providers.find((p) => p.id === selector);
  if (!profile) throw new ConfigError(`No provider profile named "${selector}".`);
  const provider = await rt.buildProvider(profile);
  return { profile, provider };
}
