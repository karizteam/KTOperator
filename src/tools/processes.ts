import { ToolExecutionError } from '../errors/errors.js';
import { isShellExecutable } from '../core/execution/managed-process.js';
import {
  isProtectedPid,
  listHostProcesses,
  matchHostProcesses,
  terminateHostProcess,
  type HostProcess,
} from '../platform/processes.js';
import type { Tool, ToolContext, ToolDescription, ToolResult } from './types.js';

export const executeApprovedCommandTool: Tool = {
  name: 'execute_approved_command',
  description:
    'Run a command inside the sandbox after explicit user approval. argv must be a structured array (executable + arguments); shell interpreters are refused; the workspace is the only visible directory; network stays as configured.',
  requiresWorkspace: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['argv'],
    properties: {
      argv: {
        type: 'array',
        description: 'Executable followed by its arguments, e.g. ["ls", "-la"]. Never a shell string; shells are refused.',
        minItems: 1,
        maxItems: 100,
        items: { type: 'string', minLength: 1, maxLength: 4096 },
      },
      writable: { type: 'boolean', description: 'Allow the command to write inside the workspace (default false = read-only mount where supported).' },
      timeoutMs: { type: 'integer', description: 'Max runtime (default 120000).', minimum: 1000, maximum: 900_000 },
    },
  },
  describe(input) {
    const argv = (input['argv'] as string[]).join(' ');
    return {
      summary: `Execute command: ${argv}`,
      targets: [argv],
      preview: `Sandbox: workspace-mount, network ${'per config'}, limits per config. argv: ${argv}`,
    };
  },
  async run(input, ctx): Promise<ToolResult> {
    const argv = input['argv'] as string[];
    const exe = argv[0]!;
    if (/\s/.test(exe) || isShellExecutable(exe)) {
      throw new ToolExecutionError('execute_approved_command', `Refusing to run a shell command string or interpreter: ${exe}.`, {
        hint: 'Provide the real executable as argv[0] and each argument as its own array element.',
      });
    }
    const writable = (input['writable'] as boolean | undefined) ?? ctx.config.sandbox.writableDefault;
    await ctx.audit.record({ event: 'command.execute', tool: 'execute_approved_command', tier: 3, detail: { argv, writable } });
    const result = await ctx.sandbox.execute({
      argv,
      workspaceRoot: ctx.workspace!.root,
      writable,
      network: ctx.config.sandbox.network,
      env: {},
      limits: {
        timeoutMs: (input['timeoutMs'] as number | undefined) ?? 120_000,
        maxOutputBytes: ctx.config.limits.maxOutputBytes,
        memoryMb: ctx.config.sandbox.memoryMb,
        cpus: ctx.config.sandbox.cpus,
        pidsLimit: ctx.config.sandbox.pidsLimit,
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const tail = (s: string) => {
      const lines = s.trim().split('\n').slice(-40).join('\n');
      return lines.length > 16_000 ? `[truncated]\n${lines.slice(-16_000)}` : lines;
    };
    return {
      ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
      summary: `Command exited ${result.exitCode ?? 'with no code'}${result.timedOut ? ' (timed out and was killed)' : ''}${result.aborted ? ' (cancelled)' : ''} in ${(result.durationMs / 1000).toFixed(1)}s. Process id: ${result.id}.`,
      data: {
        id: result.id,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        outputTruncated: result.outputTruncated,
        durationMs: result.durationMs,
        stdout: tail(result.stdout),
        stderr: tail(result.stderr),
      },
      ...(result.exitCode !== 0 ? { error: `Exit code ${result.exitCode}: ${tail(result.stderr) || tail(result.stdout) || '(no output)'}` } : {}),
    };
  },
};

export const inspectCommandResultTool: Tool = {
  name: 'inspect_command_result',
  description: 'Retrieve the recorded result of a previously executed managed process by its id.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', description: 'Process/result id returned by an execution tool.', minLength: 1, maxLength: 128 } },
  },
  async run(input, ctx) {
    const entry = ctx.sandbox.runner.inspect(input['id'] as string);
    if (!entry) {
      return { ok: false, summary: 'No such process id.', error: `Unknown or expired id: ${input['id'] as string} (history keeps the last 50).` };
    }
    return { ok: true, summary: 'Managed process record found.', data: entry };
  },
};

export const terminateManagedProcessTool: Tool = {
  name: 'terminate_managed_process',
  description: 'Terminate a still-running process that Operator itself started (by id). Arbitrary host processes can never be targeted.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', description: 'Id of a running Operator-managed process.', minLength: 1, maxLength: 128 } },
  },
  describe(input) {
    return { summary: `Terminate managed process ${input['id'] as string}`, targets: [input['id'] as string] };
  },
  async run(input, ctx) {
    const ok = await ctx.sandbox.runner.terminate(input['id'] as string);
    if (!ok) {
      return {
        ok: false,
        summary: 'Process not running.',
        error: `No running managed process with id ${input['id'] as string}. Only Operator-managed processes can be terminated.`,
      };
    }
    return { ok: true, summary: `Termination requested for managed process ${input['id'] as string}.` };
  },
};

/**
 * close_app — close a program the user is done with, or a stuck one.
 *
 * The process listing is read-only and always shown to the user in the
 * approval prompt, so "close notepad" cannot quietly kill something else with
 * a similar name. System-critical pids and Operator's own process tree are
 * refused outright, and matching is name-based, never a shell or wildcard.
 */

const MAX_NAME_LENGTH = 128;

interface CloseTargets {
  processes: HostProcess[];
  /** True when a specific pid narrowed the selection. */
  pinned: boolean;
}

async function resolveCloseTargets(input: Record<string, unknown>): Promise<CloseTargets> {
  const name = String(input['name'] ?? '').trim();
  const pinnedPid = typeof input['pid'] === 'number' ? input['pid'] : undefined;
  const all = await listHostProcesses();
  let matches = matchHostProcesses(all, name);
  if (pinnedPid !== undefined) {
    const narrowed = matches.filter((p) => p.pid === pinnedPid);
    if (narrowed.length > 0) return { processes: narrowed, pinned: true };
    const known = all.find((p) => p.pid === pinnedPid);
    return { processes: [known ?? { pid: pinnedPid, name, command: name }], pinned: true };
  }
  // Never propose a pid the agent may not touch, even if it matched.
  matches = matches.filter((p) => !isProtectedPid(p.pid));
  return { processes: matches, pinned: false };
}

function closeSummary(targets: CloseTargets): ToolDescription {
  const { processes, pinned } = targets;
  if (processes.length === 0) {
    return {
      summary: 'Close an application — nothing matched',
      targets: [],
      preview: 'No running process matched that name, so nothing would be closed.',
    };
  }
  const listed = processes.slice(0, 8).map((p) => `${p.pid}  ${p.name}${p.command !== p.name ? `  (${p.command})` : ''}`);
  return {
    summary: `Close ${processes.length} process(es): ${processes.map((p) => p.name).slice(0, 4).join(', ')}`,
    targets: processes.slice(0, 8).map((p) => `${p.name} (pid ${p.pid})`),
    preview: [pinned ? 'Targeted process:' : 'These processes will be asked to close:', ...listed.map((l) => `  ${l}`)].join('\n'),
  };
}

export const closeAppTool: Tool = {
  name: 'close_app',
  description:
    'Close a running application or process on the user\'s machine after they approve it. Use it when the user asks to close an app, quit a program, or kill a stuck/unresponsive one ("close chrome", "kill notepad"). Pass `name` (the program name, e.g. "opera", "chrome", "notepad"); pass `pid` when the user named a specific instance. A graceful close is requested first — if the app ignores it, call again with force=true. System-critical processes and Operator itself can never be closed. For a command that is still running inside the sandbox, use terminate_managed_process with its id instead.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: {
        type: 'string',
        description: 'Application or process name, e.g. "opera", "chrome", "notepad". Matched case-insensitively.',
        minLength: 2,
        maxLength: MAX_NAME_LENGTH,
      },
      pid: { type: 'integer', description: 'Exact process id to close, when a single instance is meant.', minimum: 5 },
      force: { type: 'boolean', description: 'Force-kill when a graceful close did not stop it.' },
    },
  },
  escalateTier(input) {
    // Forcing a kill is a stronger action than asking an app to close.
    return input['force'] === true ? 3 : null;
  },
  async describe(input): Promise<ToolDescription> {
    const targets = await resolveCloseTargets(input);
    return closeSummary(targets);
  },
  async run(input, ctx: ToolContext): Promise<ToolResult> {
    const name = String(input['name'] ?? '').trim();
    const force = input['force'] === true;
    const targets = await resolveCloseTargets(input);
    const { processes } = targets;
    if (processes.length === 0) {
      return {
        ok: false,
        summary: `Nothing matched "${name}"`,
        error: `No running process matches "${name}". Check the exact name with get_process_summary, or ask the user to confirm the application name.`,
      };
    }
    const blocked = processes.filter((p) => isProtectedPid(p.pid));
    if (blocked.length === processes.length) {
      return {
        ok: false,
        summary: `Refusing to close ${name}`,
        error: `Refusing to close ${name}: every match (${blocked.map((p) => `pid ${p.pid}`).join(', ')}) is a system-critical or Operator process and cannot be terminated.`,
      };
    }

    const closed: string[] = [];
    const failed: string[] = [];
    for (const process of processes) {
      if (isProtectedPid(process.pid)) {
        failed.push(`${process.name} (pid ${process.pid}) — protected`);
        continue;
      }
      const outcome = await terminateHostProcess(process.pid, { force });
      if (outcome.ok) closed.push(`${process.name} (pid ${process.pid})`);
      else failed.push(`${process.name} (pid ${process.pid}) — ${outcome.detail}`);
    }

    await ctx.audit.record({
      event: 'process.close',
      tool: 'close_app',
      tier: force ? 3 : 2,
      decision: closed.length > 0 ? 'ok' : 'error',
      detail: { name, force, closed, failed },
    });

    if (closed.length === 0) {
      return {
        ok: false,
        summary: `Could not close ${name}`,
        error: `${failed.join('; ')}. ${force ? 'Explain this to the user instead of retrying.' : 'Retrying with force=true is the next step if the user agrees.'}`,
      };
    }
    return {
      ok: true,
      summary: `Closed ${closed.join(', ')}${failed.length > 0 ? `; failed: ${failed.join(', ')}` : ''}.`,
      data: { closed, failed: failed.length > 0 ? failed : undefined, forced: force },
    };
  },
};

export const processTools: Tool[] = [
  executeApprovedCommandTool,
  inspectCommandResultTool,
  terminateManagedProcessTool,
  closeAppTool,
];
