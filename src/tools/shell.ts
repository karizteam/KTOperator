import { stdout } from 'node:process';
import {
  commandWarnings,
  resolveShell,
  shellEnv,
  shellEnvironment,
  validateShellCommand,
  SHELL_KINDS,
} from '../platform/shell.js';
import type { Tool, ToolDescription, ToolResult } from './types.js';

/**
 * run_shell_command — the escape hatch for "do it in cmd/bash".
 *
 * Everything else in Operator runs structured argv inside the sandbox. This is
 * the only tool that runs a real command line, and it runs it on the user's own
 * machine (that is the whole point: `ipconfig`, `dir`, `netstat`, `git status`
 * have no meaning inside a Linux container). The trade is explicit:
 *
 *   - tier 3: every single command needs the user's approval, in a prompt that
 *     shows the exact text, the shell, the working directory and any warning;
 *   - non-interactive runs (`--json`, no `--yes`) can never use it;
 *   - the child gets a minimal environment (no API keys), a timeout, and a
 *     bounded, redacted output; the process tree is killed on cancel;
 *   - the command id is returned, so a still-running one can be stopped with
 *     terminate_managed_process and inspected with inspect_command_result.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 900_000;

interface ShellPlan {
  kind: string;
  label: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  warnings: string[];
}

function planCommand(input: Record<string, unknown>, cwd: string): ShellPlan {
  const command = validateShellCommand(String(input['command'] ?? ''));
  const requested = typeof input['shell'] === 'string' && input['shell'] !== '' ? input['shell'] : 'auto';
  const shell = resolveShell(requested, command, shellEnv());
  const rawTimeout = typeof input['timeoutMs'] === 'number' ? input['timeoutMs'] : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(rawTimeout, MAX_TIMEOUT_MS));
  return { kind: shell.kind, label: shell.label, argv: shell.argv, cwd, timeoutMs, warnings: commandWarnings(command) };
}

function preview(plan: ShellPlan, command: string): string {
  return [
    `Runs on YOUR machine, outside the sandbox.`,
    `Shell     : ${plan.label}`,
    `Directory : ${plan.cwd}`,
    `Timeout   : ${(plan.timeoutMs / 1000).toFixed(0)}s`,
    '',
    command,
    ...(plan.warnings.length > 0 ? ['', ...plan.warnings.map((w) => `⚠ ${w}`)] : []),
  ].join('\n');
}

export const runShellCommandTool: Tool = {
  name: 'run_shell_command',
  description:
    'Run a real command line on the user\'s OWN machine after they approve the exact text — the tool for "in cmd", "in bash", "run this command", or any request that maps to a shell one-liner ("show my IP", "how much free space is left", "list the 10 biggest files here", "which version of node is installed"). Write the command that does what the user asked, then call this tool: the user sees the command, the shell, the directory and any warning, and approves or rejects it before anything runs. `shell` defaults to cmd on Windows and bash elsewhere; pass "powershell" for cmdlets. Use this for operating-system tasks; for project work inside the sandbox (tests, builds, scripts) prefer run_tests / run_build / execute_approved_command. The command runs with the workspace as its working directory, a timeout, no inherited API keys, and its output is capped and redacted. Never claim a command ran unless this tool returned success.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['command'],
    properties: {
      command: {
        type: 'string',
        description: 'The exact command line to run, e.g. "ipconfig /all", "ls -lh | head", "git status --short". One command (multiple lines are allowed but stay short).',
        minLength: 1,
        maxLength: 8_000,
      },
      shell: {
        type: 'string',
        enum: ['auto', ...SHELL_KINDS],
        description: 'Which shell to use. "auto" (default) = cmd on Windows, bash elsewhere.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Maximum runtime in milliseconds (default 120000, max 900000).',
        minimum: MIN_TIMEOUT_MS,
        maximum: MAX_TIMEOUT_MS,
      },
    },
  },
  async describe(input, ctx): Promise<ToolDescription> {
    const cwd = ctx.workspace?.root ?? process.cwd();
    let plan: ShellPlan;
    try {
      plan = planCommand(input, cwd);
    } catch (err) {
      return {
        summary: `Run command (invalid): ${String(input['command'] ?? '').slice(0, 80)}`,
        targets: [],
        preview: (err as Error).message,
      };
    }
    const command = String(input['command'] ?? '').trim();
    return {
      summary: `Run on your machine (${plan.kind}): ${firstLine(command)}`,
      targets: [firstLine(command)],
      preview: preview(plan, command),
    };
  },
  async run(input, ctx): Promise<ToolResult> {
    const cwd = ctx.workspace?.root ?? process.cwd();
    const plan = planCommand(input, cwd);
    const command = String(input['command'] ?? '').trim();

    await ctx.audit.record({
      event: 'command.execute',
      tool: 'run_shell_command',
      tier: 3,
      detail: { host: true, shell: plan.kind, cwd, command: command.slice(0, 500), warnings: plan.warnings },
    });

    const result = await ctx.sandbox.runner.run({
      argv: plan.argv,
      cwd,
      env: shellEnvironment(process.env),
      timeoutMs: plan.timeoutMs,
      maxOutputBytes: ctx.config.limits.maxOutputBytes,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    const tail = (s: string): string => {
      const lines = s.trim().split('\n').slice(-40).join('\n');
      return lines.length > 16_000 ? `[truncated]\n${lines.slice(-16_000)}` : lines;
    };
    const status = [
      `exit ${result.exitCode ?? 'no code'}`,
      result.timedOut ? 'timed out and was killed' : '',
      result.aborted ? 'cancelled' : '',
    ]
      .filter((s) => s !== '')
      .join(', ');
    const summary = `Command ${status} in ${(result.durationMs / 1000).toFixed(1)}s (${plan.kind}). Process id: ${result.id}.`;
    const data = {
      id: result.id,
      shell: plan.kind,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
      outputTruncated: result.outputTruncated,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
    };
    const succeeded = result.exitCode === 0 && !result.timedOut && !result.aborted;
    if (!succeeded) {
      return {
        ok: false,
        summary,
        error: `${tail(result.stderr) || tail(result.stdout) || '(no output)'}`.slice(0, 4_000),
        data,
      };
    }
    return { ok: true, summary, data };
  },
};

/** One short line for the approval prompt title. */
function firstLine(command: string): string {
  const line = command.split('\n')[0]!.trim();
  const width = Math.max(20, (stdout.columns ?? 80) - 24);
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

export const shellTools: Tool[] = [runShellCommandTool];
