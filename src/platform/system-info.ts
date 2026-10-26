import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isWindows } from './paths.js';

export interface OperatingSystemInfo {
  platform: string;
  type: string;
  release: string;
  arch: string;
  hostname: string;
  uptimeSeconds: number;
}

export function getOperatingSystem(): OperatingSystemInfo {
  return {
    platform: process.platform,
    type: os.type(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    uptimeSeconds: Math.round(os.uptime()),
  };
}

function probeVersion(command: string, args: string[]): string | null {
  try {
    const res = spawnSync(command, args, { timeout: 5000, shell: false, windowsHide: true });
    if (res.status === 0) {
      const out = (res.stdout ?? '').toString().trim().split('\n')[0];
      return out ?? null;
    }
  } catch {
    /* tool not installed */
  }
  return null;
}

export function getRuntimeVersions(): Record<string, string | null> {
  const npmCommand = isWindows ? 'npm.cmd' : 'npm';
  return {
    node: process.version,
    npm: probeVersion(npmCommand, ['--version']),
    git: probeVersion('git', ['--version']),
    python: probeVersion(isWindows ? 'py' : 'python3', ['--version']),
    docker: probeVersion('docker', ['--version']),
  };
}

export function getCpuSummary() {
  const cpus = os.cpus();
  const perModel = new Map<string, number>();
  for (const c of cpus) perModel.set(c.model, (perModel.get(c.model) ?? 0) + 1);
  return {
    model: [...perModel.entries()].map(([model, count]) => `${count} × ${model}`).join(', ') || 'unknown',
    cores: cpus.length,
    loadAverage: os.loadavg(),
  };
}

export function getMemorySummary() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    totalBytes: total,
    freeBytes: free,
    usedBytes: total - free,
    usedPercent: Math.round(((total - free) / Math.max(1, total)) * 100),
  };
}

/** Disk usage for the filesystem containing `targetPath`. Node ≥ 18.15. */
export function getDiskUsage(targetPath: string) {
  const s = fs.statfsSync(targetPath);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize; // available to unprivileged users
  return {
    path: targetPath,
    totalBytes: total,
    freeBytes: free,
    usedBytes: total - free,
    usedPercent: Math.round(((total - free) / Math.max(1, total)) * 100),
  };
}
