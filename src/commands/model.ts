import { ConfigError } from '../errors/errors.js';
import type { Runtime } from './runtime.js';

/** `operator model list [--provider id]` — discover models + capabilities. */
export async function modelList(rt: Runtime, providerId: string | undefined): Promise<void> {
  const selector = providerId ?? rt.config.defaultProvider;
  if (!selector) {
    throw new ConfigError('No provider specified and none configured as default.', { hint: 'Pass --provider, pick one in the console, or set a default via /provider use.' });
  }
  const profile = rt.config.providers.find((p) => p.id === selector);
  if (!profile) throw new ConfigError(`No provider profile named "${selector}".`);
  const provider = await rt.buildProvider(profile);
  if (!provider.listModels) {
    rt.ui.emit({ provider: selector, models: [], note: 'This provider does not support model listing.' }, (d) => (d as { note: string }).note);
    return;
  }
  rt.ui.step(`Querying ${provider.label} for models…`);
  const models = await provider.listModels();
  const payload = {
    provider: selector,
    type: profile.type,
    count: models.length,
    models: models.slice(0, 500),
  };
  rt.ui.emit(payload, (d) => {
    const p = d as typeof payload;
    if (p.models.length === 0) return 'No models returned by the provider.';
    const lines = p.models.slice(0, 60).map((m) => {
      const caps: string[] = [];
      if (m.capabilities?.toolCalling === false) caps.push('no-tools');
      if (m.capabilities?.structuredOutputs === false) caps.push('no-json');
      const suffix = caps.length > 0 ? ` (${caps.join(', ')})` : '';
      const ctx = m.contextLength ? ` [${m.contextLength} ctx]` : '';
      return `  ${m.id}${m.label && m.label !== m.id ? ` — ${m.label}` : ''}${ctx}${suffix}`;
    });
    if (p.models.length > 60) lines.push(`  … ${p.models.length - 60} more (use --json for the full list)`);
    return [`${p.count} model(s) on ${selector}:`, ...lines].join('\n');
  });
}
