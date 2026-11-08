import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSlashMenu, MAX_MENU_ITEMS } from '../../src/cli/ui.js';
import { filterSlashCommands, SLASH_COMMANDS } from '../../src/commands/console.js';
import { addUsage, cacheHitRate, emptyTotals, usageSummaryLines } from '../../src/util/usage.js';
import { SessionStore } from '../../src/sessions/store.js';
import { MockProvider, textResult, makeHarness } from '../helpers.js';
import { runAgentLoop } from '../../src/core/agent/loop.js';
import { providerRemove } from '../../src/commands/provider.js';
import { manageSessions } from '../../src/commands/console.js';
import type { Runtime } from '../../src/commands/runtime.js';

describe('slash menu: fuzzy matching', () => {
  it('finds /status from a substring typo', () => {
    assert.ok(filterSlashCommands('/tatus').some((i) => i.command === '/status'));
    assert.ok(filterSlashCommands('/stat').some((i) => i.command === '/status'));
  });
  it('prefix matches rank before substring matches', () => {
    const items = filterSlashCommands('/s');
    assert.equal(items[0]!.command, '/status');
    assert.ok(items.some((i) => i.command === '/sandbox'));
  });
  it('every command has a group and icon for the grouped /help', () => {
    for (const c of SLASH_COMMANDS) {
      assert.ok(['Session', 'Setup', 'System'].includes(c.group), c.name);
      assert.ok(c.icon.length > 0, c.name);
    }
  });
  it('/usage and /provider delete are listed', () => {
    assert.ok(SLASH_COMMANDS.some((c) => c.name === 'usage'));
    const provider = SLASH_COMMANDS.find((c) => c.name === 'provider')!;
    assert.match(provider.usage ?? '', /delete/);
  });
  it('/sessions is listed as a session command', () => {
    const s = SLASH_COMMANDS.find((c) => c.name === 'sessions')!;
    assert.equal(s.group, 'Session');
    assert.match(s.usage ?? '', /delete/);
  });
  it('offers /provider subcommands after the space (delete included)', () => {
    const all = filterSlashCommands('/provider ');
    assert.ok(all.some((i) => i.command === '/provider delete'));
    assert.ok(all.some((i) => i.command === '/provider add'));
    assert.ok(all.some((i) => i.command === '/provider use'));
  });
  it('narrows /provider subcommands by prefix and fuzzy match', () => {
    assert.deepEqual(filterSlashCommands('/provider d').map((i) => i.command), ['/provider delete']);
    assert.deepEqual(filterSlashCommands('/provider del').map((i) => i.command), ['/provider delete']);
    assert.ok(filterSlashCommands('/provider ete').some((i) => i.command === '/provider delete'));
    assert.deepEqual(filterSlashCommands('/provider delete x'), []);
    assert.deepEqual(filterSlashCommands('/model u').map((i) => i.command), ['/model use']);
  });
});

describe('slash menu: capped rendering with wrap-around selection', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ command: `/c${i}`, help: `help ${i}` }));
  it('never shows more than MAX_MENU_ITEMS rows', () => {
    const menu = buildSlashMenu(items, 0);
    assert.equal(menu.visible.length, MAX_MENU_ITEMS);
    assert.equal(menu.hidden, 20 - MAX_MENU_ITEMS);
  });
  it('keeps the selected row visible when navigating far down', () => {
    const menu = buildSlashMenu(items, 17);
    assert.equal(menu.selectedIndex, 17);
    assert.ok(menu.visible.some((v) => v.command === '/c17'));
  });
  it('wraps negative selection to the end', () => {
    assert.equal(buildSlashMenu(items, -1).selectedIndex, 19);
    assert.equal(buildSlashMenu(items, 25).selectedIndex, 5);
  });
  it('returns everything when the list fits', () => {
    assert.equal(buildSlashMenu(items.slice(0, 3), 1).hidden, 0);
    assert.equal(buildSlashMenu([], 0).visible.length, 0);
  });
  it('stops capping as soon as narrowing fits the list', () => {
    const narrowed = buildSlashMenu(items.slice(0, 4), 2);
    assert.equal(narrowed.visible.length, 4);
    assert.equal(narrowed.hidden, 0);
  });
});

describe('usage accounting', () => {
  it('accumulates cached tokens and counts requests', () => {
    const t = emptyTotals();
    addUsage(t, { promptTokens: 1000, completionTokens: 100, cachedTokens: 800, costUsd: 0.01 });
    addUsage(t, { promptTokens: 500, completionTokens: 50, cachedTokens: 0 });
    assert.equal(t.cachedTokens, 800);
    assert.equal(t.requests, 2);
    assert.equal(cacheHitRate(t), (800 / 1500) * 100);
  });
  it('summarizes cached + context + cap', () => {
    const t = emptyTotals();
    addUsage(t, { promptTokens: 2000, completionTokens: 200, cachedTokens: 1500, costUsd: 0.05 });
    const lines = usageSummaryLines(t, { tokenBudget: 30_000, contextTokens: 15_000, costCapUsd: 1 });
    assert.ok(lines.some((l) => l.includes('cached')));
    assert.ok(lines.some((l) => l.includes('50% used')));
    assert.ok(lines.some((l) => l.includes('remaining')));
  });
  it('loop report carries cached tokens and context callback fires', async () => {
    const h = await makeHarness({ workspaceFiles: { 'a.txt': 'hello' } });
    const provider = new MockProvider();
    provider.queue(() => textResult('done'));
    const seen: { estimatedTokens: number; percent: number }[] = [];
    const report = await runAgentLoop({
      provider,
      model: 'mock',
      system: 'sys',
      userTask: 'hi',
      registry: h.registry,
      toolContext: h.toolContext,
      maxIterations: 5,
      maxToolCalls: 5,
      maxDurationMs: 10_000,
      tokenBudget: 30_000,
      onContextUsage: (info) => seen.push(info),
    });
    assert.equal(report.status, 'completed');
    assert.ok(seen.length >= 1);
    assert.ok(seen[0]!.percent >= 0 && seen[0]!.percent <= 100);
  });
});

describe('provider delete', () => {
  async function fakeRuntime() {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-del-'));
    const store = new SessionStore(tmp);
    const { defaultConfig } = await import('../../src/config/schema.js');
    const config = defaultConfig();
    config.providers = [
      { id: 'a', type: 'openai', trustedLocal: false, model: 'm-a' },
      { id: 'b', type: 'openai', trustedLocal: false, model: 'm-b' },
    ];
    config.defaultProvider = 'a';
    config.defaultModel = 'm-a';
    const saved = config;
    const rt = {
      config,
      store: { update: async (fn: (c: typeof config) => void) => { fn(saved); return saved; } },
      credentials: { delete: async () => true },
      ui: { emit: () => undefined, jsonMode: false, success: () => undefined },
      sessions: store,
    } as unknown as Runtime;
    return { rt, tmp, get saved() { return saved; } };
  }

  it('deleting the default re-points defaultProvider/model at the remaining profile', async () => {
    const { rt, tmp } = await fakeRuntime();
    await providerRemove(rt, 'a');
    assert.equal(rt.config.providers.length, 1);
    assert.equal(rt.config.defaultProvider, 'b');
    assert.equal(rt.config.defaultModel, 'm-b');
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('session store deletes a session and reports misses', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-sess-'));
    const store = new SessionStore(tmp);
    const a = await store.create({ task: 'a' });
    const b = await store.create({ task: 'b' });
    assert.equal(await store.delete(a), true);
    assert.equal(await store.delete(a), false);
    assert.equal(await store.delete(''), false);
    assert.equal(await store.delete('../evil'), false);
    const remaining = await store.list();
    assert.deepEqual(remaining.map((m) => m.id), [b]);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('session manager refuses to delete the open session', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-sess-'));
    const store = new SessionStore(tmp);
    const open = await store.create({ task: 'open' });
    const messages: string[] = [];
    const rt = {
      sessions: store,
      ui: {
        info: (s: string) => messages.push(s),
        error: (s: string) => messages.push(s),
        success: (s: string) => messages.push(s),
        confirm: async () => true,
        promptSelect: async () => 0,
        dim: (s: string) => s,
        brand: (s: string) => s,
        brandLight: (s: string) => s,
      },
    } as unknown as Runtime;
    await manageSessions(rt, `delete ${open}`, { replaceStack: () => undefined, clearHistory: () => undefined, replaceHistory: () => undefined, sessionId: open });
    assert.ok(messages.some((m) => m.includes('open right now')));
    assert.equal((await store.list()).length, 1);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('deleting the last profile clears defaults', async () => {
    const { rt, tmp } = await fakeRuntime();
    await providerRemove(rt, 'a');
    await providerRemove(rt, 'b');
    assert.equal(rt.config.providers.length, 0);
    assert.equal(rt.config.defaultProvider, undefined);
    assert.equal(rt.config.defaultModel, undefined);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
