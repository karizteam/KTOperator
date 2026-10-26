import { ToolExecutionError } from '../errors/errors.js';
import { isShellExecutable } from '../core/execution/managed-process.js';
import type { Tool, ToolResult } from './types.js';

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

export const processTools: Tool[] = [executeApprovedCommandTool, inspectCommandResultTool, terminateManagedProcessTool];
