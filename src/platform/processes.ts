import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { platform } from './paths.js';

export interface ProcessSummary {
  pid: number;
  command: string;
  rssBytes: number;
  cpuPercent: number | null;
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
