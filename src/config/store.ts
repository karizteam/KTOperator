import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../errors/errors.js';
import { configFilePath, configHome } from '../platform/paths.js';
import { redactValue } from '../security/redaction.js';
import { CONFIG_VERSION, configSchema, defaultConfig, type OperatorConfig } from './schema.js';

/**
 * Loads, validates, migrates and saves the Operator configuration.
 * Writes are atomic (tmp + rename) and the config home is created 0700.
 */
export class ConfigStore {
  readonly path: string;

  constructor(filePath?: string) {
    this.path = filePath ?? configFilePath();
  }

  async ensureHome(): Promise<void> {
    await fs.mkdir(configHome(), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await fs.chmod(configHome(), 0o700).catch(() => undefined);
    }
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.path);
      return true;
    } catch {
      return false;
    }
  }

  /** Load config; missing file yields defaults. Invalid files are hard errors. */
  async load(): Promise<OperatorConfig> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch {
      return defaultConfig();
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new ConfigError(`Configuration file is not valid JSON: ${this.path}`, {
        hint: 'Fix or remove the file; a fresh default will be written on next save.',
      });
    }
    return this.migrate(parsedJson);
  }

  /** Migrate older/partial configs. Never silently weakens security:
   *  unknown or invalid security fields fall back to secure defaults. */
  migrate(raw: unknown): OperatorConfig {
    if (typeof raw !== 'object' || raw === null) {
      throw new ConfigError('Configuration has an unexpected shape.');
    }
    const obj = raw as Record<string, unknown>;
    if (obj['version'] !== CONFIG_VERSION) {
      // v0 → v1: re-parse through the schema; defaults fill missing fields,
      // unknown keys are stripped, invalid values are rejected.
      const migrated = { ...obj, version: CONFIG_VERSION };
      const res = configSchema.safeParse(migrated);
      if (!res.success) {
        throw new ConfigError('Configuration migration failed; invalid values were found.', {
          hint: `Validate ${this.path}: ${summarizeIssues(res.error.issues)}`,
        });
      }
      return res.data;
    }
    const res = configSchema.safeParse(obj);
    if (!res.success) {
      throw new ConfigError(`Configuration file failed validation: ${this.path}`, {
        hint: summarizeIssues(res.error.issues),
      });
    }
    return res.data;
  }

  async save(config: OperatorConfig): Promise<void> {
    await this.ensureHome();
    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    const tmp = path.join(path.dirname(this.path), `.config-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(tmp, serialized, { mode: 0o600 });
    await fs.rename(tmp, this.path);
  }

  /** View with credentials and anything resembling a secret masked. */
  async redactedView(): Promise<OperatorConfig> {
    return redactValue(await this.load());
  }

  async update(mutator: (config: OperatorConfig) => void): Promise<OperatorConfig> {
    const config = await this.load();
    mutator(config);
    const res = configSchema.safeParse(config);
    if (!res.success) {
      throw new ConfigError(`Refusing to save invalid configuration: ${summarizeIssues(res.error.issues)}`);
    }
    await this.save(res.data);
    return res.data;
  }
}

function summarizeIssues(issues: readonly { path?: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
