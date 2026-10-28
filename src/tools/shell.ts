import { stdout } from 'node:process';
import { planHostShell, shellEnvironment, SHELL_KINDS, type HostShellPlan } from '../platform/shell.js';
import type { Tool, ToolContext, ToolDescription, ToolResult } from './types.js';

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
 *
 * `executeHostShell` is shared with execute_approved_command, which receives
 * the same request as structured argv (`["cmd", "/c", "ipconfig"]`) and must
 * behave identically instead of refusing.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 900_000;

/** Clamp a requested timeout to the supported window. */
export function shellTimeout(raw: unknown, fallback = DEFAULT_TIMEOUT_MS): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.max(MIN_TIMEOUT_MS, Math.min(value, MAX_TIMEOUT_MS));
}

/** The approval prompt body: exact text, where it runs, and any warning. */
export function shellPreview(plan: HostShellPlan, cwd: string, timeoutMs: number): string {
  return [
    'Runs on YOUR machine, outside the sandbox.',
    `Shell     : ${plan.label}`,
    `Directory : ${cwd}`,
    `Timeout   : ${(timeoutMs / 1000).toFixed(0)}s`,
    '',
    plan.command,
    ...(plan.warnings.length > 0 ? ['', ...plan.warnings.map((w) => `⚠ ${w}`)] : []),
  ].join('\n');
}

/**
 * Run one host-shell plan and normalise the outcome for the model. Used by
 * both shell-facing tools so a command behaves the same whichever name the
 * model happened to call.
 */
export async function executeHostShell(
  plan: HostShellPlan,
  ctx: ToolContext,
  cwd: string,
  timeoutMs: number,
  tool: string,
  extra: Record<string, unknown> = {},
): Promise<ToolResult> {
  await ctx.audit.record({
    event: 'command.execute',
    tool,
    tier: 3,
    detail: { host: true, shell: plan.kind, cwd, command: plan.command.slice(0, 500), warnings: plan.warnings, ...extra },
  });

  const result = await ctx.sandbox.runner.run({
    argv: plan.argv,
    cwd,
    env: shellEnvironment(process.env),
    timeoutMs,
    maxOutputBytes: ctx.config.limits.maxOutputBytes,
    ...(plan.verbatim ? { windowsVerbatim: true } : {}),
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
    const command = String(input['command'] ?? '').trim();
    const requested = typeof input['shell'] === 'string' && input['shell'] !== '' ? input['shell'] : 'auto';
    let plan: HostShellPlan;
    try {
      plan = planHostShell(requested, command);
    } catch (err) {
      return {
        summary: `Run command (invalid): ${command.slice(0, 80)}`,
        targets: [],
        preview: (err as Error).message,
      };
    }
    return {
      summary: `Run on your machine (${plan.kind}): ${firstLine(command)}`,
      targets: [firstLine(command)],
      preview: shellPreview(plan, cwd, shellTimeout(input['timeoutMs'])),
    };
  },
  async run(input, ctx): Promise<ToolResult> {
    const cwd = ctx.workspace?.root ?? process.cwd();
    const requested = typeof input['shell'] === 'string' && input['shell'] !== '' ? input['shell'] : 'auto';
    const plan = planHostShell(requested, String(input['command'] ?? ''));
    return executeHostShell(plan, ctx, cwd, shellTimeout(input['timeoutMs']), 'run_shell_command');
  },
};

/** One short line for the approval prompt title. */
function firstLine(command: string): string {
  const line = command.split('\n')[0]!.trim();
  const width = Math.max(20, (stdout.columns ?? 80) - 24);
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

export const shellTools: Tool[] = [runShellCommandTool];
