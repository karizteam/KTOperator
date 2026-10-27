import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { spawnSync } from 'node:child_process';
import { platform } from './paths.js';

export interface ProcessSummary {
  pid: number;
  command: string;
  rssBytes: number;
  cpuPercent: number | null;
}

/** One process as the agent may see it before asking to close it. */
export interface HostProcess {
  pid: number;
  /** Executable/process name, e.g. "opera.exe", "chrome", "notepad". */
  name: string;
  /** Full command line and/or window title, when the platform exposes it. */
  command: string;
}

/**
 * Best-effort, read-only process listing. Uses /proc on Linux, `ps` on
 * macOS, and a PowerShell CIM query on Windows. Never kills anything; the
 * agent can only terminate Operator-managed processes (see execution layer).
 */
export async function listProcesses(limit: number): Promise<ProcessSummary[]> {
  const cap = Math.max(1, Math.min(limit, 50));
  try {
    switch (platform()) {
      case 'linux':
        return await linuxProcesses(cap);
      case 'darwin':
        return psProcesses(cap);
      case 'win32':
        return windowsProcesses(cap);
      default:
        return [];
    }
  } catch {
    return [];
  }
}

async function linuxProcesses(limit: number): Promise<ProcessSummary[]> {
  const entries = await fs.readdir('/proc', { withFileTypes: true });
  const out: ProcessSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
    try {
      const [status, comm] = await Promise.all([
        fs.readFile(`/proc/${e.name}/status`, 'utf8'),
        fs.readFile(`/proc/${e.name}/comm`, 'utf8').catch(() => ''),
      ]);
      const rssKb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
      out.push({
        pid: Number.parseInt(e.name, 10),
        command: (comm || /^Name:\s+(.+)$/m.exec(status)?.[1] || '').trim(),
        rssBytes: rssKb ? Number.parseInt(rssKb, 10) * 1024 : 0,
        cpuPercent: null,
      });
    } catch {
      /* process exited between readdir and read */
    }
    if (out.length >= 512) break;
  }
  return out.sort((a, b) => b.rssBytes - a.rssBytes).slice(0, limit);
}

function psProcesses(limit: number): ProcessSummary[] {
  const res = spawnSync('ps', ['-Aceo', 'pid,rss,pcpu,comm'], { timeout: 5000, shell: false });
  if (res.status !== 0) return [];
  const lines = res.stdout.toString().split('\n').slice(1);
  const out: ProcessSummary[] = [];
  for (const line of lines) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
    if (!m || !m[1] || !m[2] || !m[4]) continue;
    out.push({ pid: Number(m[1]), rssBytes: Number(m[2]) * 1024, cpuPercent: Number(m[3]), command: m[4] });
  }
  return out.sort((a, b) => b.rssBytes - a.rssBytes).slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Host processes: find by name, then close                             */
/* ------------------------------------------------------------------ */

/**
 * Processes that must never be touched by the agent: the kernel/idle range,
 * this very process, and every ancestor of it (whatever launched the CLI —
 * a shell, the user's terminal, an IDE task runner).
 */
let cachedAncestors: Set<number> | null = null;

export function protectedPids(): Set<number> {
  if (cachedAncestors !== null) return cachedAncestors;
  const pids = new Set<number>([process.pid]);
  if (typeof process.ppid === 'number' && process.ppid > 0) pids.add(process.ppid);
  try {
    let current = typeof process.ppid === 'number' ? process.ppid : 0;
    for (let hop = 0; hop < 8 && current > 1; hop++) {
      const parent = parentOf(current);
      if (parent === null || parent <= 1 || pids.has(parent)) break;
      pids.add(parent);
      current = parent;
    }
  } catch {
    /* best effort: the direct parent is always protected */
  }
  cachedAncestors = pids;
  return pids;
}

/** Parent pid via /proc on Linux, `ps` elsewhere. Null when unknown. */
function parentOf(pid: number): number | null {
  try {
    if (platform() === 'linux') {
      const stat = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // `pid (comm) state ppid …` — comm may contain spaces and parentheses.
      const rest = stat.slice(stat.lastIndexOf(')') + 2);
      const ppid = Number.parseInt(rest.split(/\s+/)[1] ?? '', 10);
      return Number.isInteger(ppid) ? ppid : null;
    }
    if (platform() === 'win32') return null; // no cheap, reliable parent lookup
    const res = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000, shell: false });
    if (res.status !== 0) return null;
    const ppid = Number.parseInt(res.stdout.toString().trim(), 10);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/** True when the agent must refuse to terminate this pid. */
export function isProtectedPid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 4) return true;
  return protectedPids().has(pid);
}

/** Normalize a process/app name for matching: "Opera GX.exe" → "operagx". */
export function normalizeProcessName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/[^a-z0-9\u0600-\u06ff]/g, '');
}

/**
 * Match processes by name, best matches first. An exact name wins, then a
 * prefix, then a substring — so "opera" finds "opera.exe" and "OperaGX" finds
 * "opera" too. Queries shorter than 3 characters match nothing.
 */
export function matchHostProcesses(processes: readonly HostProcess[], query: string): HostProcess[] {
  const needle = normalizeProcessName(query);
  if (needle.length < 3) return [];
  const scored: { process: HostProcess; score: number }[] = [];
  for (const process of processes) {
    const haystack = normalizeProcessName(process.name);
    const title = normalizeProcessName(process.command);
    let score: number;
    if (haystack === needle) score = 0;
    else if (haystack.startsWith(needle)) score = 1;
    else if (needle.startsWith(haystack) && haystack.length >= 3) score = 2;
    else if (title.includes(needle)) score = 3;
    else if (haystack.includes(needle)) score = 4;
    else continue;
    scored.push({ process, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.process.pid - b.process.pid).map((s) => s.process);
}

/** Every process the current user can see, unsorted. */
export async function listHostProcesses(): Promise<HostProcess[]> {
  try {
    switch (platform()) {
      case 'linux':
        return await linuxHostProcesses();
      case 'darwin':
        return posixHostProcesses();
      case 'win32':
        return windowsHostProcesses();
      default:
        return [];
    }
  } catch {
    return [];
  }
}

async function linuxHostProcesses(): Promise<HostProcess[]> {
  const entries = await fs.readdir('/proc', { withFileTypes: true });
  const out: HostProcess[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
    try {
      const [comm, cmdline] = await Promise.all([
        fs.readFile(`/proc/${e.name}/comm`, 'utf8').catch(() => ''),
        fs.readFile(`/proc/${e.name}/cmdline`, 'utf8').catch(() => ''),
      ]);
      const name = comm.trim();
      const command = cmdline.split('\u0000').join(' ').trim();
      if (name === '' && command === '') continue;
      out.push({ pid: Number.parseInt(e.name, 10), name: name || command.split(' ')[0] || '', command: command || name });
    } catch {
      /* process vanished */
    }
  }
  return out;
}

function posixHostProcesses(): HostProcess[] {
  const res = spawnSync('ps', ['-Aceo', 'pid,comm,args'], { timeout: 5000, shell: false, maxBuffer: 8 * 1024 * 1024 });
  if (res.status !== 0) return [];
  const out: HostProcess[] = [];
  for (const line of res.stdout.toString().split('\n').slice(1)) {
    const m = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m || !m[1] || !m[2]) continue;
    out.push({ pid: Number(m[1]), name: m[2], command: (m[3] ?? m[2]).trim() || m[2] });
  }
  return out;
}

interface WindowsProcessRow {
  Id?: number;
  ProcessName?: string;
  MainWindowTitle?: string;
}

/** Pure parser for the PowerShell JSON payload (also used by the tests). */
export function parseWindowsProcessRows(raw: string): HostProcess[] {
  let parsed: WindowsProcessRow | WindowsProcessRow[];
  try {
    parsed = JSON.parse(raw) as WindowsProcessRow | WindowsProcessRow[];
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: HostProcess[] = [];
  for (const row of rows) {
    if (typeof row?.Id !== 'number' || typeof row.ProcessName !== 'string') continue;
    const title = typeof row.MainWindowTitle === 'string' ? row.MainWindowTitle.trim() : '';
    out.push({ pid: row.Id, name: row.ProcessName, command: title === '' ? row.ProcessName : title });
  }
  return out;
}

function windowsHostProcesses(): HostProcess[] {
  const script = 'Get-Process -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress';
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 20000,
    shell: false,
    windowsHide: true,
    maxBuffer: 12 * 1024 * 1024,
  });
  if (res.status !== 0) return [];
  return parseWindowsProcessRows(res.stdout.toString());
}

/** Pure argv for closing one pid — no shell, no user-controlled flags. */
export function killArgv(pid: number, force: boolean): string[] {
  return ['taskkill', '/pid', String(pid), '/T', ...(force ? ['/F'] : [])];
}

export interface TerminateOutcome {
  ok: boolean;
  detail: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Close one process. A graceful close first; `force` escalates to a kill.
 * Refuses system-critical pids and this CLI's own process tree.
 */
export async function terminateHostProcess(pid: number, options: { force?: boolean } = {}): Promise<TerminateOutcome> {
  const force = options.force ?? false;
  if (isProtectedPid(pid)) {
    return { ok: false, detail: `Refusing to terminate pid ${pid}: it is a system or Operator process.` };
  }
  if (platform() === 'win32') {
    const argv = killArgv(pid, force);
    const res = spawnSync(argv[0]!, argv.slice(1), {
      timeout: 15000,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    const ok = res.status === 0;
    return {
      ok,
      detail: ok
        ? `Closed pid ${pid}${force ? ' (forced)' : ''}.`
        : `Could not close pid ${pid}${force ? '' : ' gracefully'} — it may need force=true.`,
    };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, detail: `Could not close pid ${pid}: ${(err as Error).message}` };
  }
  for (let i = 0; i < 25 && alive(pid); i++) await sleep(100);
  if (alive(pid)) {
    if (!force) return { ok: false, detail: `pid ${pid} ignored the graceful close — retry with force=true.` };
    try {
      process.kill(pid, 'SIGKILL');
      for (let i = 0; i < 10 && alive(pid); i++) await sleep(100);
    } catch (err) {
      return { ok: false, detail: `Could not force-close pid ${pid}: ${(err as Error).message}` };
    }
  }
  if (alive(pid)) return { ok: false, detail: `pid ${pid} did not terminate.` };
  return { ok: true, detail: `Closed pid ${pid}${force ? ' (forced)' : ''}.` };
}

function windowsProcesses(limit: number): ProcessSummary[] {
  const ps = 'powershell.exe';
  const script =
    'Get-Process | Select-Object -First 200 Id,ProcessName,WorkingSet64,CPU | ConvertTo-Json -Compress';
  const res = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 15000,
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.status !== 0) return [];
  try {
    const parsed = JSON.parse(res.stdout.toString()) as
      | { Id: number; ProcessName: string; WorkingSet64: number; CPU: number | null }[]
      | { Id: number; ProcessName: string; WorkingSet64: number; CPU: number | null };
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .map((p) => ({ pid: p.Id, command: p.ProcessName, rssBytes: p.WorkingSet64, cpuPercent: p.CPU }))
      .sort((a, b) => b.rssBytes - a.rssBytes)
      .slice(0, limit);
  } catch {
    return [];
  }
}
