import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redactText, compressContext, createBoundary } from './lib.mjs';
import { runLoop, systemPrompt, estTurnFloor } from './loop.mjs';
import { TOOL_DEFS, SYSTEM_PROMPT } from './operator.mjs';

test('token floor is compact', () => {
  assert.ok(TOOL_DEFS.length <= 22, `tools ${TOOL_DEFS.length}`);
  assert.ok(estTurnFloor(TOOL_DEFS, SYSTEM_PROMPT) < 1500, `floor ${estTurnFloor(TOOL_DEFS, SYSTEM_PROMPT)}`);
});

test('redaction hides secrets', () => {
  assert.ok(!redactText('key sk-or-v1-abcdefghijklmnop123456').includes('abcdefghijklmnop'));
  assert.ok(redactText('password=hunter22x').includes('REDACTED'));
});

test('boundary blocks escape and symlink', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ktc-'));
  await fs.writeFile(path.join(tmp, 'a.txt'), 'hi');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ktc-out-'));
  await fs.symlink(outside, path.join(tmp, 'link'));
  const b = await createBoundary(tmp);
  await assert.rejects(() => b.resolve('../etc/passwd'));
  await assert.rejects(() => b.resolve('link/secret.txt'));
  const e = await b.resolve('a.txt'); assert.equal(e.kind, 'file');
  await fs.rm(tmp, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true });
});

test('compressContext shrinks old tool output under budget', () => {
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'task' }];
  for (let i = 0; i < 10; i++) { msgs.push({ role: 'assistant', content: 'x'.repeat(200) }); msgs.push({ role: 'tool', name: 'read', toolCallId: String(i), content: 'y'.repeat(3000) }); }
  const before = msgs.reduce((n, m) => n + m.content.length, 0);
  compressContext(msgs, 500, TOOL_DEFS);
  const after = msgs.reduce((n, m) => n + m.content.length, 0);
  assert.ok(after < before / 2, `${before} -> ${after}`);
});

test('loop runs tools with mock provider and respects approvals', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ktc-loop-'));
  await fs.writeFile(path.join(tmp, 'note.txt'), 'hello');
  const { makeTools } = await import('./tools.mjs');
  const b = await createBoundary(tmp);
  const { tools } = makeTools({ boundary: b, cfg: { limits: { maxOutputChars: 8000, maxFileBytes: 1e6 }, sandbox: {} }, sessionId: 't', grants: [] });
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  let n = 0;
  const chatFn = async () => { n++; return n === 1 ? { text: '', toolCalls: [{ id: '1', name: 'read', arguments: JSON.stringify({ path: 'note.txt' }) }] } : { text: 'done', toolCalls: [] }; };
  const messages = [{ role: 'system', content: systemPrompt({ workspace: tmp, sandboxLabel: 'x', toolNames: tools.map((t) => t.name), limits: { maxIterations: 5, maxToolCalls: 5, tokenBudget: 5000 } }) }, { role: 'user', content: 'read it' }];
  const r = await runLoop({ chatFn, model: 'm', messages, tools, toolMap, approve: async () => true, maxIterations: 5, maxToolCalls: 5, tokenBudget: 5000, sessionId: 't' });
  assert.equal(r.status, 'completed'); assert.equal(r.finalText, 'done');
  await fs.rm(tmp, { recursive: true, force: true });
});

test('loop stops on denials', async () => {
  const { makeTools } = await import('./tools.mjs');
  const { tools } = makeTools({ boundary: null, cfg: { limits: { maxOutputChars: 1000, maxFileBytes: 1000 }, sandbox: {} }, sessionId: 't', grants: [] });
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const chatFn = async () => ({ text: '', toolCalls: [{ id: '1', name: 'write', arguments: JSON.stringify({ path: 'x.txt', content: 'y' }) }] });
  const r = await runLoop({ chatFn, model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], tools, toolMap, approve: async () => false, maxIterations: 5, maxToolCalls: 5, tokenBudget: 5000, sessionId: 't' });
  assert.equal(r.status, 'limit'); assert.ok(r.deniedCount >= 1);
});
