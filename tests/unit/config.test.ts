import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigError } from '../../src/errors/errors.js';
import { ConfigStore } from '../../src/config/store.js';
import { CredentialStore } from '../../src/config/credentials.js';
import { CONFIG_VERSION, defaultConfig } from '../../src/config/schema.js';
import type { ProviderProfile } from '../../src/config/schema.js';

let tmp: string;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-config-'));
  process.env['OPERATOR_HOME'] = tmp;
});

after(async () => {
  delete process.env['OPERATOR_HOME'];
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('config store', () => {
  it('returns defaults when no file exists', async () => {
    const store = new ConfigStore(path.join(tmp, 'config.json'));
    const cfg = await store.load();
    assert.equal(cfg.version, CONFIG_VERSION);
    assert.equal(cfg.security.allowRestrictedProcessFallback, false, 'fallback must default to OFF');
    assert.equal(cfg.sandbox.network, false, 'sandbox network must default to OFF');
  });

  it('saves and reloads a valid config atomically', async () => {
    const store = new ConfigStore(path.join(tmp, 'config.json'));
    const cfg = defaultConfig();
    cfg.defaultModel = 'test-model';
    await store.save(cfg);
    const reloaded = await store.load();
    assert.equal(reloaded.defaultModel, 'test-model');
  });

  it('migrates a versionless legacy config without weakening security', async () => {
    const file = path.join(tmp, 'legacy.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        defaultModel: 'old-model',
        providers: [{ id: 'x', type: 'openai', trustedLocal: false }],
        madeUpField: 'dropped',
      }),
    );
    const store = new ConfigStore(file);
    const cfg = await store.load();
    assert.equal(cfg.version, CONFIG_VERSION);
    assert.equal(cfg.defaultModel, 'old-model');
    assert.equal(cfg.providers[0]!.id, 'x');
    assert.equal(cfg.security.allowRestrictedProcessFallback, false);
    assert.ok(!('madeUpField' in cfg));
  });

  it('rejects configs with invalid security values', async () => {
    const file = path.join(tmp, 'bad.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, security: { allowRestrictedProcessFallback: 'yes please' } }));
    const store = new ConfigStore(file);
    await assert.rejects(() => store.load(), ConfigError);
  });

  it('rejects invalid JSON', async () => {
    const file = path.join(tmp, 'broken.json');
    await fs.writeFile(file, '{oops');
    const store = new ConfigStore(file);
    await assert.rejects(() => store.load(), /not valid JSON/);
  });
});

describe('credential store', () => {
  const profile: ProviderProfile = { id: 'p1', type: 'openrouter', trustedLocal: false };

  it('stores keys chmod 600 and resolves them back', async () => {
    const creds = new CredentialStore(path.join(tmp, 'credentials.json'));
    await creds.set('p1', 'sk-or-test-key-1234567890');
    const resolved = await creds.resolve(profile);
    assert.equal(resolved.value, 'sk-or-test-key-1234567890');
    assert.equal(resolved.source, 'store');
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(path.join(tmp, 'credentials.json'))).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  });

  it('environment variables take precedence and are the documented path', async () => {
    process.env['OPENROUTER_API_KEY'] = 'env-key-111';
    try {
      const creds = new CredentialStore(path.join(tmp, 'credentials.json'));
      const resolved = await creds.resolve(profile);
      assert.equal(resolved.value, 'env-key-111');
      assert.equal(resolved.source, 'environment');
      assert.equal(resolved.envName, 'OPENROUTER_API_KEY');
    } finally {
      delete process.env['OPENROUTER_API_KEY'];
    }
  });

  it('refuses implausibly short keys and reports none', async () => {
    const creds = new CredentialStore(path.join(tmp, 'credentials.json'));
    await assert.rejects(() => creds.set('p2', 'x'));
    const noProfile: ProviderProfile = { id: 'nope', type: 'anthropic', trustedLocal: false };
    const resolved = await creds.resolve(noProfile);
    assert.equal(resolved.source, 'none');
  });

  it('deletes stored keys', async () => {
    const creds = new CredentialStore(path.join(tmp, 'credentials.json'));
    await creds.set('delme', 'some-long-enough-key');
    assert.equal(await creds.delete('delme'), true);
    assert.equal(await creds.delete('delme'), false);
  });
});
