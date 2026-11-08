import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { backupFile, redactText } from './lib.mjs';

const cap = (s, n) => (s.length > n ? s.slice(0, n) + `\n[truncated ${s.length - n} chars]` : s);
async function walk(dir, base, out, depth) {
  if (depth > 6 || out.length > 500) return;
  let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const rel = path.relative(base, path.join(dir, e.name)).split(path.sep).join('/');
    out.push(rel + (e.isDirectory() ? '/' : ''));
    if (e.isDirectory()) await walk(path.join(dir, e.name), base, out, depth + 1);
  }
}
const execHost = (cmd, opts = {}) => new Promise((res) => {
  const p = spawn(cmd, opts.args ?? [], { cwd: opts.cwd, shell: opts.shell ?? false, env: { ...process.env, ...(opts.env ?? {}) } });
  let out = '', err = '';
  p.stdout?.on('data', (d) => { out += d; });
  p.stderr?.on('data', (d) => { err += d; });
  p.on('error', (e) => res({ code: -1, out, err: String(e) }));
  p.on('close', (code) => res({ code, out, err }));
  if (opts.input) p.stdin?.end(opts.input);
});
export const TIER = { ls:0, read:0, search:0, stat:0, diff:0, inspect:0, sysinfo:0, web_fetch:0, web_search:0, write:1, move:1, delete:2, close_app:2, run_script:3, exec:3, shell:3, bg:3, launch_app:3, open_url:3, request_access:3 };

export function makeTools(ctx) {
  const { boundary, cfg, sessionId, grants } = ctx;
  const R = async (p, o) => boundary ? await boundary.resolve(p, o) : (() => { throw new Error('no workspace selected'); })();
  const tools = [
    { name: 'ls', desc: 'List directory (workspace-relative).', schema: { type: 'object', properties: { path: { type: 'string' } } }, run: async (a) => { const e = await R(a.path ?? '.'); const names = await fs.readdir(e.realPath); return { ok: true, summary: `${names.length} entries`, data: names.slice(0, 200) }; } },
    { name: 'read', desc: 'Read file lines [start,end].', schema: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['path'] }, run: async (a) => { const e = await R(a.path, { maxBytes: cfg.limits.maxFileBytes }); let t = await fs.readFile(e.realPath, 'utf8'); const lines = t.split('\n'); const s = Math.max(0, (a.start ?? 1) - 1), en = a.end ?? lines.length; return { ok: true, summary: `${lines.length} lines`, data: cap(lines.slice(s, en).join('\n'), cfg.limits.maxOutputChars) }; } },
    { name: 'search', desc: 'Search filenames (glob/pattern) or content.', schema: { type: 'object', properties: { q: { type: 'string' }, mode: { type: 'string', enum: ['files', 'text'] }, path: { type: 'string' } }, required: ['q'] }, run: async (a) => { const base = a.path ? (await R(a.path)).realPath : boundary.root; const all = []; await walk(base, boundary.root, all, 0); let hits = []; if (a.mode === 'text') { const re = new RegExp(a.q, 'i'); for (const f of all.filter((x) => !x.endsWith('/')).slice(0, 300)) { try { const t = await fs.readFile(path.join(boundary.root, f), 'utf8'); t.split('\n').forEach((ln, i) => { if (re.test(ln) && hits.length < 50) hits.push(`${f}:${i + 1}:${ln.trim().slice(0, 120)}`); }); } catch {} } } else { const re = new RegExp(a.q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i'); hits = all.filter((f) => re.test(f)).slice(0, 100); } return { ok: true, summary: `${hits.length} hits`, data: hits }; } },
    { name: 'stat', desc: 'File metadata + sha256.', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, run: async (a) => { const e = await R(a.path); const s = await fs.stat(e.realPath); const { createHash } = await import('node:crypto'); const hash = e.kind === 'file' ? createHash('sha256').update(await fs.readFile(e.realPath)).digest('hex').slice(0, 16) : null; return { ok: true, summary: e.kind, data: { kind: e.kind, size: s.size, mtime: s.mtime.toISOString(), sha16: hash } }; } },
    { name: 'diff', desc: 'Preview diff of proposed content. No changes.', schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, run: async (a) => { let old = ''; try { old = await fs.readFile((await R(a.path)).realPath, 'utf8'); } catch {} const o = old.split('\n'), n = a.content.split('\n'); const lines = []; for (let i = 0; i < Math.max(o.length, n.length); i++) { if (o[i] === n[i]) continue; if (o[i] !== undefined) lines.push('- ' + o[i]); if (n[i] !== undefined) lines.push('+ ' + n[i]); } return { ok: true, summary: `${lines.length} changed lines`, data: cap(lines.join('\n'), 4000) }; } },
    { name: 'write', desc: 'Create/overwrite file, or edit with find/replace. Backed up.', schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, all: { type: 'boolean' } }, required: ['path'] }, run: async (a) => { const e = await R(a.path, { allowMissing: true }); await backupFile(sessionId, boundary, a.path); let content = a.content; if (a.find !== undefined) { const old = await fs.readFile(e.realPath, 'utf8'); if (!old.includes(a.find)) return { ok: false, summary: 'find text not present', error: 'find text not present' }; content = a.all ? old.split(a.find).join(a.replace ?? '') : old.replace(a.find, a.replace ?? ''); } if (content === undefined) return { ok: false, summary: 'content or find required', error: 'missing content' }; await fs.mkdir(path.dirname(e.realPath), { recursive: true }); await fs.writeFile(e.realPath, content); return { ok: true, summary: `wrote ${a.path} (${content.length} chars)` }; } },
    { name: 'move', desc: 'Move/rename within workspace.', schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }, run: async (a) => { const s = await R(a.from), d = await R(a.to, { allowMissing: true }); await backupFile(sessionId, boundary, a.from); await fs.mkdir(path.dirname(d.realPath), { recursive: true }); await fs.rename(s.realPath, d.realPath); return { ok: true, summary: `${a.from} -> ${a.to}` }; } },
    { name: 'delete', desc: 'Delete a file (backed up first).', schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, run: async (a) => { const e = await R(a.path); if (e.kind !== 'file') return { ok: false, summary: 'only files can be deleted', error: 'not a file' }; await backupFile(sessionId, boundary, a.path); await fs.unlink(e.realPath); return { ok: true, summary: `deleted ${a.path}` }; } },
    { name: 'inspect', desc: 'Project summary: tree, manifests, git status.', schema: { type: 'object', properties: {} }, run: async () => { const all = []; await walk(boundary.root, boundary.root, all, 0); let pkg = null; try { pkg = JSON.parse(await fs.readFile(path.join(boundary.root, 'package.json'), 'utf8')); } catch {} const git = await execHost('git', { args: ['status', '--porcelain=v1', '-b'], cwd: boundary.root }); return { ok: true, summary: `${all.length} paths`, data: { files: all.slice(0, 80), package: pkg ? { name: pkg.name, scripts: Object.keys(pkg.scripts ?? {}) } : null, git: cap(git.out, 2000) } }; } },
    { name: 'run_script', desc: 'Run an existing npm script (test/typecheck/lint/build).', schema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] }, run: async (a) => { const r = await execHost(process.platform === 'win32' ? 'npm.cmd' : 'npm', { args: ['run', a.script], cwd: boundary.root }); return { ok: r.code === 0, summary: `npm run ${a.script} exit ${r.code}`, data: cap(r.out + r.err, cfg.limits.maxOutputChars), ...(r.code ? { error: `exit ${r.code}` } : {}) }; } },
    { name: 'sysinfo', desc: 'OS, CPU, memory, disk, node versions.', schema: { type: 'object', properties: {} }, run: async () => ({ ok: true, summary: process.platform, data: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length, memGB: +(os.totalmem() / 1e9).toFixed(1), uptimeMin: Math.round(os.uptime() / 60) } }) },
    { name: 'exec', desc: 'Run argv in Docker sandbox (refused without Docker).', schema: { type: 'object', properties: { argv: { type: 'array', items: { type: 'string' } } }, required: ['argv'] }, run: async (a) => { const has = await execHost('docker', { args: ['version'] }); if (has.code !== 0) return { ok: false, summary: 'no sandbox available', error: 'Docker unavailable; execution refused. Enable Docker or use shell (host, tier-3 approval).' }; const r = await execHost('docker', { args: ['run', '--rm', '--network', cfg.sandbox.network ? 'host' : 'none', '--memory', `${cfg.sandbox.memoryMb}m`, '-v', `${boundary.root}:/ws`, '-w', '/ws', cfg.sandbox.image, ...a.argv] }); return { ok: r.code === 0, summary: `docker exit ${r.code}`, data: cap(r.out + r.err, cfg.limits.maxOutputChars) }; } },
    { name: 'shell', desc: 'Run a host shell command (tier-3, approved).', schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, run: async (a) => { const r = await execHost(a.command, { shell: true, cwd: boundary?.root }); return { ok: r.code === 0, summary: `exit ${r.code}`, data: cap(r.out + r.err, cfg.limits.maxOutputChars) }; } },
    { name: 'bg', desc: 'Background process: op start|read|kill.', schema: { type: 'object', properties: { op: { type: 'string', enum: ['start', 'read', 'kill'] }, command: { type: 'string' }, id: { type: 'string' } }, required: ['op'] }, run: async (a) => bgTool(a, boundary) },
    { name: 'launch_app', desc: 'Launch an installed app by name.', schema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] }, run: async (a) => launchApp(a.app) },
    { name: 'open_url', desc: 'Open https URL in default browser.', schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, run: async (a) => { if (!a.url.startsWith('https://')) return { ok: false, summary: 'https only', error: 'https only' }; return launchApp(a.url); } },
    { name: 'close_app', desc: 'Close/kill app by name or pid.', schema: { type: 'object', properties: { app: { type: 'string' }, pid: { type: 'integer' }, force: { type: 'boolean' } } }, run: async (a) => closeApp(a) },
    { name: 'request_access', desc: 'Ask user for folder access outside workspace.', schema: { type: 'object', properties: { path: { type: 'string' }, write: { type: 'boolean' } }, required: ['path'] }, run: async (a) => { grants.push({ path: a.path, write: !!a.write }); return { ok: true, summary: `access requested: ${a.path} (${a.write ? 'write' : 'read'}) — user approval handled by host`, data: { pending: true, path: a.path, write: !!a.write } }; } },
    { name: 'web_fetch', desc: 'Fetch https URL as text (capped).', schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, run: async (a) => { if (!a.url.startsWith('https://')) return { ok: false, summary: 'https only', error: 'https only' }; const r = await fetch(a.url, { redirect: 'error' }); const t = await r.text(); return { ok: r.ok, summary: `HTTP ${r.status}`, data: cap(redactText(t.replace(/<[^>]+>/g, ' ')).slice(0, 8000), cfg.limits.maxOutputChars) }; } },
    { name: 'web_search', desc: 'Web search (DDG html).', schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, run: async (a) => { const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(a.q)}`); const t = await r.text(); const hits = [...t.matchAll(/result__a"[^>]*>([^<]+)</g)].map((m) => m[1]).slice(0, 8); return { ok: true, summary: `${hits.length} results`, data: hits }; } },
  ];
  return { tools, names: tools.map((t) => t.name) };
}

const bgJobs = new Map();
let bgSeq = 0;
export async function bgTool(a, boundary) {
  if (a.op === 'start') {
    const id = `bg${++bgSeq}`;
    const p = spawn(a.command, { shell: true, cwd: boundary?.root });
    const job = { p, buf: '', pos: 0, code: null };
    p.stdout?.on('data', (d) => { job.buf += d; });
    p.stderr?.on('data', (d) => { job.buf += d; });
    p.on('close', (c) => { job.code = c; });
    bgJobs.set(id, job);
    return { ok: true, summary: `started ${id}`, data: { id } };
  }
  const job = bgJobs.get(a.id);
  if (!job) return { ok: false, summary: 'unknown job', error: 'unknown job id' };
  if (a.op === 'read') { const out = job.buf.slice(job.pos); job.pos = job.buf.length; return { ok: true, summary: `job ${a.id} ${job.code === null ? 'running' : 'exit ' + job.code}`, data: out.slice(-4000) }; }
  try { if (process.platform === 'win32') spawn('taskkill', ['/PID', String(job.p.pid), '/T', '/F']); else { job.p.kill('SIGTERM'); } } catch {}
  bgJobs.delete(a.id);
  return { ok: true, summary: `killed ${a.id}` };
}
const CATALOG = { chrome: 'chrome', edge: 'msedge', firefox: 'firefox', notepad: 'notepad', explorer: 'explorer', calculator: 'calc', paint: 'mspaint', vscode: 'code', spotify: 'spotify', opera: 'opera' };
export async function launchApp(app) {
  const exe = CATALOG[app.toLowerCase()] || app;
  const r = await execHost(process.platform === 'win32' ? 'where' : 'which', { args: [exe] });
  if (r.code !== 0 && !app.startsWith('http')) return { ok: false, summary: `app not found: ${app}`, error: `No installed app matches '${app}'.` };
  const target = r.code === 0 ? r.out.trim().split('\n')[0] : app;
  const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const s = await execHost(opener, { args: [target], shell: process.platform === 'win32' });
  return { ok: s.code === 0, summary: `launched ${app}`, error: s.code ? s.err.slice(0, 300) : undefined };
}
export async function closeApp(a) {
  const crit = ['system', 'registry', 'csrss', 'lsass', 'winlogon', 'services'];
  const name = (a.app || '').toLowerCase();
  if (crit.some((c) => name.includes(c))) return { ok: false, summary: 'refused: system process', error: 'system-critical processes are never touched' };
  const r = a.pid ? await execHost(process.platform === 'win32' ? 'taskkill' : 'kill', { args: process.platform === 'win32' ? ['/PID', String(a.pid), ...(a.force ? ['/F'] : [])] : [a.force ? '-9' : '-TERM', String(a.pid)] })
    : await execHost(process.platform === 'win32' ? 'taskkill' : 'pkill', { args: process.platform === 'win32' ? ['/IM', `${a.app}.exe`, ...(a.force ? ['/F'] : [])] : [`-${a.force ? '9' : 'TERM'}`, a.app] });
  return { ok: r.code === 0, summary: `close ${a.app ?? a.pid} exit ${r.code}`, error: r.code ? (r.err || r.out).slice(0, 300) : undefined };
}
