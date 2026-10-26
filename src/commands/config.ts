import { ConfigError } from '../errors/errors.js';
import { configFilePath } from '../platform/paths.js';
import { redactValue } from '../security/redaction.js';
import type { Runtime } from './runtime.js';

/** `operator config show` — validated, redacted view of the live config. */
export async function configShow(rt: Runtime): Promise<void> {
  const view = redactValue(rt.config);
  rt.ui.emit(view, () => JSON.stringify(view, null, 2));
}

/** Allowlist of `operator config set` targets with per-key coercion. */
const SETTABLE: Record<string, (raw: string) => unknown> = {
  defaultProvider: (v) => v,
  defaultModel: (v) => v,
  'security.allowRestrictedProcessFallback': bool,
  'security.maxAutoApproveTier': intRange(0, 2),
  'sandbox.backend': oneOf(['auto', 'docker', 'restricted']),
  'sandbox.image': (v) => v,
  'sandbox.network': bool,
  'sandbox.memoryMb': intRange(64, 65536),
  'sandbox.cpus': numRange(0.25, 32),
  'sandbox.pidsLimit': intRange(16, 4096),
  'sandbox.writableDefault': bool,
  'network.allowPrivateProviderEndpoints': bool,
  'limits.maxIterations': intRange(1, 100),
  'limits.maxToolCalls': intRange(1, 500),
  'limits.maxDurationMs': intRange(10_000, 3_600_000),
  'limits.maxOutputBytes': intRange(1024, 4_000_000),
  'limits.maxFileBytes': intRange(1024, 512 * 1024 * 1024),
  'limits.maxProviderRetries': intRange(0, 10),
  'backups.enabled': bool,
  'backups.maxMb': intRange(1, 50_000),
  'ui.color': bool,
};

function bool(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new ConfigError(`Expected true or false, got "${v}".`);
}
function intRange(min: number, max: number) {
  return (v: string): unknown => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`Expected an integer in [${min}, ${max}], got "${v}".`);
    return n;
  };
}
function numRange(min: number, max: number) {
  return (v: string): unknown => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`Expected a number in [${min}, ${max}], got "${v}".`);
    return n;
  };
}
function oneOf(values: string[]) {
  return (v: string): unknown => {
    if (!values.includes(v)) throw new ConfigError(`Expected one of ${values.join(', ')}, got "${v}".`);
    return v;
  };
}

/** `operator config set <key> <value>` — validated, then schema re-checked. */
export async function configSet(rt: Runtime, key: string, value: string): Promise<void> {
  const coerce = SETTABLE[key];
  if (!coerce) {
    throw new ConfigError(`"${key}" is not a settable configuration key.`, {
      hint: `Settable keys: ${Object.keys(SETTABLE).join(', ')}`,
    });
  }
  const coerced = coerce(value);
  rt.config = await rt.store.update((config) => {
    const parts = key.split('.');
    let cursor: Record<string, unknown> = config as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor = cursor[parts[i]!] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]!] = coerced;
  });
  rt.ui.emit({ updated: true, key, value: '[set]' }, () => '');
  if (!rt.ui.jsonMode) rt.ui.success(`${key} updated. (Secrets are never accepted here — API keys go through \`operator provider add\`.)`);
}

export function configPath(rt: Runtime): void {
  rt.ui.emit({ configFile: configFilePath(), securityNote: 'API keys are stored separately (chmod 600) or via environment variables.' }, (d) => {
    const p = d as { configFile: string; securityNote: string };
    return `${p.configFile}\n${p.securityNote}`;
  });
}
