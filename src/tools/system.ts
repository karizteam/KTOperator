import { formatBytes } from '../security/path-validation.js';
import { getCpuSummary, getDiskUsage, getMemorySummary, getOperatingSystem, getRuntimeVersions } from '../platform/system-info.js';
import { listProcesses } from '../platform/processes.js';
import type { Tool } from './types.js';
import { resolveReadPath } from './filesystem.js';

export const getOperatingSystemTool: Tool = {
  name: 'get_operating_system',
  description: 'Operating system details: platform, type, release, architecture, hostname, uptime. Read-only.',
  schema: { type: 'object', additionalProperties: false, properties: {} },
  async run() {
    const os = getOperatingSystem();
    return { ok: true, summary: `${os.type} ${os.release} (${os.platform}/${os.arch}), host ${os.hostname}.`, data: os };
  },
};

export const getRuntimeVersionsTool: Tool = {
  name: 'get_runtime_versions',
  description: 'Versions of relevant runtimes/tools (node, npm, git, python, docker); null when not installed. Read-only.',
  schema: { type: 'object', additionalProperties: false, properties: {} },
  async run() {
    const versions = getRuntimeVersions();
    return {
      ok: true,
      summary: Object.entries(versions).map(([k, v]) => `${k}: ${v ?? 'not installed'}`).join(', '),
      data: versions,
    };
  },
};

export const getCpuSummaryTool: Tool = {
  name: 'get_cpu_summary',
  description: 'CPU model, core count and load average. Read-only.',
  schema: { type: 'object', additionalProperties: false, properties: {} },
  async run() {
    const cpu = getCpuSummary();
    return { ok: true, summary: `${cpu.cores} cores (${cpu.model}); load ${cpu.loadAverage.map((l) => l.toFixed(2)).join(' / ')}.`, data: cpu };
  },
};

export const getMemorySummaryTool: Tool = {
  name: 'get_memory_summary',
  description: 'Total/free/used memory. Read-only.',
  schema: { type: 'object', additionalProperties: false, properties: {} },
  async run() {
    const mem = getMemorySummary();
    return {
      ok: true,
      summary: `Memory: ${formatBytes(mem.usedBytes)} used of ${formatBytes(mem.totalBytes)} (${mem.usedPercent}%).`,
      data: mem,
    };
  },
};

export const getDiskUsageTool: Tool = {
  name: 'get_disk_usage',
  description: 'Disk usage for the filesystem containing a path (default: the workspace root, or a granted folder). Read-only.',
  requiresWorkspace: true,
  workspaceOptional: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { path: { type: 'string', description: 'Workspace-relative path (default ".").', maxLength: 1024 } },
  },
  async run(input, ctx) {
    const entry = await resolveReadPath(ctx, (input['path'] as string | undefined) ?? '.');
    const usage = getDiskUsage(entry.realPath);
    return {
      ok: true,
      summary: `Disk (${entry.relativePath}): ${formatBytes(usage.freeBytes)} free of ${formatBytes(usage.totalBytes)} (${usage.usedPercent}% used).`,
      data: { ...usage, path: entry.relativePath },
    };
  },
};

export const getProcessSummaryTool: Tool = {
  name: 'get_process_summary',
  description: 'Top processes by memory usage (pid, command, RSS, CPU% where available). Read-only listing; the agent cannot kill arbitrary processes.',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { limit: { type: 'integer', description: 'How many processes to list (default 10, max 50).', minimum: 1, maximum: 50 } },
  },
  async run(input) {
    const limit = (input['limit'] as number | undefined) ?? 10;
    const processes = await listProcesses(limit);
    return {
      ok: true,
      summary: processes.length > 0 ? `Top ${processes.length} process(es) by memory.` : 'Process listing is not available on this platform.',
      data: { processes: processes.map((p) => ({ pid: p.pid, command: p.command, rss: formatBytes(p.rssBytes), cpuPercent: p.cpuPercent })) },
    };
  },
};

export const systemTools: Tool[] = [
  getOperatingSystemTool,
  getRuntimeVersionsTool,
  getCpuSummaryTool,
  getMemorySummaryTool,
  getDiskUsageTool,
  getProcessSummaryTool,
];
