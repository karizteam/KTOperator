import fs from 'node:fs/promises';
import { ConfigError } from '../errors/errors.js';
import { credentialsFilePath } from '../platform/paths.js';
import type { ProviderProfile, ProviderType } from './schema.js';

/** Default environment variable consulted for each provider type. */
export const DEFAULT_KEY_ENV: Record<ProviderType, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
  ollama: '', // local inference normally needs no key
};

export interface ResolvedKey {
  value: string | null;
  source: 'environment' | 'store' | 'none';
  envName?: string;
}

/**
 * Credential storage. Environment variables always win. The fallback store
 * is a local JSON file created 0600 inside the (0700) config home — the
 * documented "protected local configuration" fallback. Keys are never
 * written to logs, the workspace, or audit entries.
 */
export class CredentialStore {
  readonly path: string;

  constructor(filePath?: string) {
    this.path = filePath ?? credentialsFilePath();
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as { version?: number; keys?: Record<string, string> };
      if (parsed.version !== 1 || typeof parsed.keys !== 'object' || parsed.keys === null) {
        throw new ConfigError(`Credential store is corrupted: ${this.path}`);
      }
      return parsed.keys;
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      return {};
    }
  }

  async resolve(profile: ProviderProfile): Promise<ResolvedKey> {
    const envName = profile.apiKeyEnv ?? DEFAULT_KEY_ENV[profile.type];
    if (envName) {
      const fromEnv = process.env[envName];
      if (fromEnv && fromEnv.trim() !== '') {
        return { value: fromEnv.trim(), source: 'environment', envName };
      }
    }
    const stored = (await this.readAll())[profile.id];
    if (stored && stored.trim() !== '') return { value: stored.trim(), source: 'store' };
    return { value: null, source: 'none', ...(envName ? { envName } : {}) };
  }

  async set(profileId: string, apiKey: string): Promise<void> {
    if (!apiKey || apiKey.trim().length < 4) {
      throw new ConfigError('Refusing to store an empty or implausibly short API key.');
    }
    const keys = await this.readAll();
    keys[profileId] = apiKey.trim();
    await fs.mkdir(this.dirOf(), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.path, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') await fs.chmod(this.path, 0o600).catch(() => undefined);
  }

  async delete(profileId: string): Promise<boolean> {
    const keys = await this.readAll();
    if (!(profileId in keys)) return false;
    delete keys[profileId];
    await fs.writeFile(this.path, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, { mode: 0o600 });
    return true;
  }

  async storedProfileIds(): Promise<string[]> {
    return Object.keys(await this.readAll());
  }

  private dirOf(): string {
    return this.path.slice(0, this.path.length - this.path.split(/[\\/]/).pop()!.length - 1) || '.';
  }
}
