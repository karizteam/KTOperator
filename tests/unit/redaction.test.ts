import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactValue } from '../../src/security/redaction.js';

describe('redaction', () => {
  it('redacts provider API keys', () => {
    const { text, redactedCount } = redactText('key is sk-or-v1-abcdef1234567890abcdef and sk-proj-XYZ1234567890abcdefgh');
    assert.ok(redactedCount >= 2);
    assert.ok(!text.includes('abcdef1234567890'));
    assert.match(text, /\[REDACTED:/);
  });

  it('redacts JWTs and bearer tokens', () => {
    const { text } = redactText('Authorization: Bearer abcdefghijklmnopqrstuvwx.yz0123456789');
    assert.ok(!text.includes('abcdefghijklmnopqrstuvwx'));
    const jwt = redactText('token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c');
    assert.ok(!jwt.text.includes('SflKxwRJSMeKKF2QT4'));
  });

  it('redacts private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\nmultiline\n-----END RSA PRIVATE KEY-----';
    const { text } = redactText(pem);
    assert.ok(!text.includes('MIIEpAIBAAKCAQEA7'));
  });

  it('redacts generic secret fields', () => {
    const { text } = redactText('{"api_key": "supersecretvalue123"}');
    assert.ok(!text.includes('supersecretvalue123'));
  });

  it('redacts credentials embedded in URLs', () => {
    const { text } = redactText('mongo: mongodb://admin:hunter2pass@db.internal:27017/app');
    assert.ok(!text.includes('hunter2pass'));
  });

  it('leaves ordinary text intact', () => {
    const sample = 'const greeting = "hello world"; // nothing sensitive';
    const { text, redactedCount } = redactText(sample);
    assert.equal(text, sample);
    assert.equal(redactedCount, 0);
  });

  it('redactValue deep-masks sensitive keys', () => {
    const out = redactValue({ providers: [{ apiKey: 'secret', model: 'x' }], nested: { token: 'tok123456789' } }) as {
      providers: { apiKey: string; model: string }[];
      nested: { token: string };
    };
    assert.equal(out.providers[0]!.apiKey, '[REDACTED]');
    assert.equal(out.providers[0]!.model, 'x');
    assert.equal(out.nested.token, '[REDACTED]');
  });
});
