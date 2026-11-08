#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { VERSION, loadConfig, saveConfig, cfgPath, createBoundary, newSessionId, saveSession, listSessions, readSession, audit, redactText, homeDir } from './lib.mjs';
import { makeTools } from './tools.mjs';
import { chat, listModels, testConnection } from './providers.mjs';
import { runLoop, systemPrompt, estTurnFloor } from './loop.mjs';

export { makeTools } from './tools.mjs';
export { systemPrompt, estTurnFloor } from './loop.mjs';
export { estTokens, redactText, compressContext, createBoundary } from './lib.mjs';
import { compressContext } from './lib.mjs';
export const TOOL_DEFS = makeTools({ boundary: null, cfg: { limits: { maxOutputChars: 32000, maxFileBytes: 2097152 }, sandbox: { network: false, memoryMb: 512, image: 'x' } }, sessionId: 'measure', grants: [] }).tools;
export const SYSTEM_PROMPT = systemPrompt({ workspace: '/ws', sandboxLabel: 'docker', toolNames: ['ls', 'read', 'search', 'stat', 'diff', 'write', 'move', 'delete', 'inspect', 'run_script', 'sysinfo', 'exec', 'shell', 'bg', 'launch_app', 'open_url', 'close_app', 'request_access', 'web_fetch', 'web_search'], limits: { maxIterations: 12, maxToolCalls: 30, tokenBudget: 20000 } });

const out = (s) => process.stdout.write(String(s) + '\n');
const jout = (o) => out(JSON.stringify(o, null, 2));
function parseArgs(argv) { const [cmd, ...rest] = argv; const flags = {}; const pos = []; for (let i = 0; i < rest.length; i++) { const a = rest[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; flags[k] = v; } else pos.push(a); } return { cmd: cmd ?? 'chat', pos, flags }; }
const isJson = (f) => !!f.json;

async function getBoundary(cfg) { return cfg.workspace?.path ? await createBoundary(cfg.workspace.path) : null; }
async function dockerAvailable() { try { const { execSync } = await import('node:child_process'); execSync('docker version', { stdio: 'ignore' }); return true; } catch { return false; } }

async function assemble(cfg, flags, task) {
  const profile = cfg.providers.find((p) => p.id === (flags.provider || cfg.defaultProvider)) || cfg.providers[0];
  if (!profile) throw new Error('no provider configured — run: operator provider add --id x --type openrouter --model ...');
  const model = flags.model || profile.model || cfg.defaultModel;
  if (!model) throw new Error('no model — pass --model or set profile model');
  const boundary = await getBoundary(cfg);
  const sessionId = newSessionId();
  const grants = [];
  const { tools } = makeTools({ boundary, cfg, sessionId, grants });
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const sys = systemPrompt({ workspace: boundary?.root ?? null, sandboxLabel: (await dockerAvailable()) ? 'docker' : 'none (exec refused)', toolNames: tools.map((t) => t.name), limits: cfg.limits });
  const yesLevel = flags.yes === true ? 'read' : flags.yes;
  const approve = async ({ tool, tier, args }) => {
    if (flags['dry-run']) return false;
    if (yesLevel === 'all' || (yesLevel === 'write' && tier <= 2) || (yesLevel === 'read' && tier === 0)) return true;
    if (!process.stdin.isTTY) return false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const ans = await new Promise((r) => rl.question(`Allow ${tool} (tier ${tier}) ${String(args).slice(0, 120)}? [y/N] `, r)); rl.close();
    return /^y(es)?$/i.test(ans.trim());
  };
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: task }];
  return { profile, model, boundary, sessionId, tools, toolMap, messages, approve, dryRun: !!flags['dry-run'] };
}

async function runTask(cfg, flags, task, planOnly = false) {
  const s = await assemble(cfg, flags, task);
  if (!isJson(flags)) { out(`ktOperator-compact ${VERSION} · ${s.profile.type}/${s.model}`); out(`workspace: ${s.boundary?.root ?? 'none'} · tools: ${s.tools.length} · per-turn floor ~${estTurnFloor(s.tools, s.messages[0].content)} tok`); }
  const report = planOnly
    ? await (async () => { const r = await chat(s.profile, s.model, [...s.messages, { role: 'user', content: 'Produce numbered plan JSON only: {"steps":[{"title":..}]}' }], [], {}); return { status: 'plan', finalText: r.text, iterations: 1, toolCallsTotal: 0, deniedCount: 0, steps: [], usage: r.usage ?? {}, durationMs: 0 }; })()
    : await runLoop({ chatFn: (c) => chat(s.profile, c.model, c.messages, c.tools, { onToken: (t) => process.stdout.write(t), signal: undefined }), model: s.model, messages: s.messages, tools: s.tools, toolMap: s.toolMap, approve: s.approve, dryRun: s.dryRun, onTool: (e) => { if (!isJson(flags)) out(`${e.type === 'start' ? '→' : e.ok ? '✔' : '✖'} ${e.name} ${e.summary ?? ''}`); }, maxIterations: Number(flags['max-steps'] ?? cfg.limits.maxIterations), maxToolCalls: cfg.limits.maxToolCalls, maxDurationMs: cfg.limits.maxDurationMs, tokenBudget: Number(flags['token-budget'] ?? cfg.limits.tokenBudget), sessionId: s.sessionId });
  await saveSession(s.sessionId, { id: s.sessionId, task, created: new Date().toISOString(), provider: s.profile.type, model: s.model, report });
  await audit(s.sessionId, 'session.end', { status: report.status });
  if (isJson(flags)) jout({ sessionId: s.sessionId, ...report }); else { out(`\n— ${report.status} · ${report.iterations} iter · ${report.toolCallsTotal} calls · denied ${report.deniedCount} · ${(report.durationMs / 1000).toFixed(1)}s`); if (report.usage?.promptTokens) out(`tokens: ${report.usage.promptTokens} in / ${report.usage.completionTokens} out${report.usage.costUsd ? ` · $${report.usage.costUsd}` : ''} · est prompt total ${report.usage.estPrompt ?? '?'}`); if (report.limitReason) out(`! ${report.limitReason}`); }
  return report.status === 'completed' || planOnly ? 0 : 1;
}

async function chatRepl(cfg, flags) {
  out(`ktOperator-compact ${VERSION} — type /help, /exit. Ctrl+C exits.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  let history = [];
  rl.on('line', async (line) => {
    const t = line.trim(); if (!t) return rl.prompt();
    if (t === '/exit' || t === '/quit') return rl.close();
    if (t === '/help') { out('commands: /help /status /workspace [path] /provider /model /clear /exit'); return rl.prompt(); }
    if (t === '/status') { const p = cfg.providers.find((x) => x.id === cfg.defaultProvider); out(`provider ${p?.id ?? 'none'} · workspace ${cfg.workspace?.path ?? 'none'} · sessions ${history.length}`); return rl.prompt(); }
    if (t === '/clear') { history = []; return rl.prompt(); }
    if (t.startsWith('/workspace')) { const p = t.split(/\s+/)[1] || process.cwd(); try { const b = await createBoundary(p); cfg.workspace = { path: b.root, name: path.basename(b.root) }; await saveConfig(cfg); out(`workspace: ${b.root}`); } catch (e) { out(`✖ ${e.message}`); } return rl.prompt(); }
    try { const s = await assemble(cfg, flags, t); const messages = [...history, ...s.messages]; const r = await runLoop({ chatFn: (c) => chat(s.profile, c.model, c.messages, c.tools, { onToken: (x) => process.stdout.write(x) }), model: s.model, messages, tools: s.tools, toolMap: s.toolMap, approve: s.approve, onMessage: (m) => history.push(m), maxIterations: cfg.limits.maxIterations, maxToolCalls: cfg.limits.maxToolCalls, tokenBudget: cfg.limits.tokenBudget, sessionId: s.sessionId }); history.push({ role: 'assistant', content: r.finalText }); compressContext(history, cfg.limits.tokenBudget, s.tools); out(''); } catch (e) { out(`✖ ${e.message}`); }
    rl.prompt();
  });
  rl.prompt();
  await new Promise((r) => rl.on('close', r));
}

export async function main(argv = process.argv.slice(2)) {
  const { cmd, pos, flags } = parseArgs(argv);
  const cfg = await loadConfig();
  try {
    switch (cmd) {
      case 'chat': case undefined: return await chatRepl(cfg, flags), 0;
      case 'run': { const task = pos.join(' '); if (!task) throw new Error('task required'); return runTask(cfg, flags, task); }
      case 'plan': { const task = pos.join(' '); if (!task) throw new Error('task required'); return runTask(cfg, flags, task, true); }
      case 'init': await fs.mkdir(homeDir(), { recursive: true }); await saveConfig(cfg); return out(`config: ${cfgPath()}`), 0;
      case 'doctor': { out(`node ${process.version} · config ${cfgPath()} · providers ${cfg.providers.length} · workspace ${cfg.workspace?.path ?? 'none'} · docker ${await dockerAvailable()}`); return 0; }
      case 'workspace': { if (pos[0] === 'select') { const b = await createBoundary(pos[1] || process.cwd()); cfg.workspace = { path: b.root, name: path.basename(b.root) }; await saveConfig(cfg); jout({ workspace: cfg.workspace }); return 0; } jout({ workspace: cfg.workspace ?? null }); return 0; }
      case 'provider': {
        const sub = pos[0];
        if (sub === 'add') { const p = { id: flags.id, type: flags.type || 'openrouter', ...(flags['base-url'] ? { baseUrl: flags['base-url'] } : {}), ...(flags.model ? { model: flags.model } : {}), ...(flags['api-key-env'] ? { apiKeyEnv: flags['api-key-env'] } : {}), ...(flags.key ? { key: flags.key } : {}) }; cfg.providers = cfg.providers.filter((x) => x.id !== p.id); cfg.providers.push(p); if (flags.default) cfg.defaultProvider = p.id; await saveConfig(cfg); out(`added ${p.id} (keys never printed)`); return 0; }
        if (sub === 'list') { jout({ providers: cfg.providers.map(({ key, ...r }) => ({ ...r, hasKey: !!key })) }); return 0; }
        if (sub === 'remove') { cfg.providers = cfg.providers.filter((x) => x.id !== pos[1]); await saveConfig(cfg); return 0; }
        if (sub === 'test') { const p = cfg.providers.find((x) => x.id === (pos[1] || cfg.defaultProvider)); jout(await testConnection(p)); return 0; }
        throw new Error('provider subcommand: add|list|test|remove');
      }
      case 'model': { const p = cfg.providers.find((x) => x.id === (flags.provider || cfg.defaultProvider)); jout({ models: await listModels(p) }); return 0; }
      case 'config': { if (pos[0] === 'show') { jout(JSON.parse(redactText(JSON.stringify(cfg)))); return 0; } if (pos[0] === 'path') { out(cfgPath()); return 0; } if (pos[0] === 'set') { const [k, v] = [pos[1], pos[2]]; const parts = k.split('.'); let o = cfg; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ??= {}; o[parts.at(-1)] = isNaN(Number(v)) ? v === 'true' ? true : v === 'false' ? false : v : Number(v); await saveConfig(cfg); return 0; } throw new Error('config show|set|path'); }
      case 'session': { const ids = await listSessions(); if (pos[0] === 'list') { jout({ sessions: ids }); return 0; } throw new Error('session list'); }
      case 'history': { if (pos[0]) { jout(await readSession(pos[0])); return 0; } const a = await fs.readFile(path.join(homeDir(), 'audit.jsonl'), 'utf8').catch(() => ''); out(a.split('\n').filter(Boolean).slice(-100).join('\n') || '(no audit entries)'); return 0; }
      case 'sandbox': out(`docker: ${await dockerAvailable()} · backend: ${cfg.sandbox.backend}`); return 0;
      case 'backups': { const d = path.join(homeDir(), 'backups'); out(existsSyncSafe(d) ? (await fs.readdir(d)).join('\n') : '(none)'); return 0; }
      case 'rollback': { const src = path.join(homeDir(), 'backups', pos[0]); const dst = cfg.workspace?.path; if (!dst) throw new Error('no workspace for rollback'); await fs.cp(src, dst, { recursive: true, force: true }); out(`restored ${pos[0]} -> ${dst}`); return 0; }
      default: throw new Error(`unknown command: ${cmd}`);
    }
  } catch (e) {
    if (isJson(flags)) jout({ error: e.message }); else process.stderr.write(`✖ ${e.message}\n`);
    return 1;
  }
}
const existsSyncSafe = (p) => { try { return !!p; } catch { return false; } };

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { process.exitCode = await main(); }
