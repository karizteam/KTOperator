import { planHostShell, shellEnvironment, SHELL_KINDS, type HostShellPlan } from '../platform/shell.js';
import type { Tool, ToolDescription, ToolResult } from './types.js';

/**
 * Long-running processes — the missing half of "run my dev server and check
 * it". `run_shell_command` blocks until the command is done, which is exactly
 * wrong for a server, a watcher, or a build that takes minutes.
 *
 * The trade is the same one the shell tool already makes, and it is explicit:
 * the job runs on the user's OWN machine (a container would not keep a server
 * reachable from their browser), it starts only after the user approves the
 * exact text, its output is captured in a bounded tail, and it can always be
 * stopped — `terminate_managed_process` kills the whole process tree.
 *
 * Two tools, not five:
 *   - start_background_process: one command line, one approval, one id;
 *   - read_process_output: what happened since the last read.
 */

const MAX_LABEL_LENGTH = 48;

function labelFor(command: string, explicit: unknown): string {
  const given = typeof explicit === 'string' ? explicit.trim() : '';
  if (given !== '') return given.slice(0, MAX_LABEL_LENGTH);
  const first = command.split('\n')[0]!.trim().replace(/\s+/g, ' ');
  return first.length > MAX_LABEL_LENGTH ? `${first.slice(0, MAX_LABEL_LENGTH - 1)}…` : first;
}

function startPreview(plan: HostShellPlan, cwd: string, label: string): string {
  return [
    'Starts NOW on YOUR machine, outside the sandbox, and keeps running.',
    `Job       : ${label}`,
    `Shell     : ${plan.label}`,
    `Directory : ${cwd}`,
    '',
    plan.command,
    ...(plan.warnings.length > 0 ? ['', ...plan.warnings.map((w) => `⚠ ${w}`)] : []),
  ].join('\n');
}

export const startBackgroundProcessTool: Tool = {
  name: 'start_background_process',
  description:
    'Start a command that must keep running — a dev server, a watcher, a long build — and return immediately with a process id. Use it instead of run_shell_command whenever the command does not finish on its own ("start the dev server", "run the tests in watch mode", "start the API on port 3000"); then read its output with read_process_output, and stop it with terminate_managed_process. It runs on the user\'s own machine (a container cannot serve their browser), so it is tier 3: the exact command, shell and directory are shown and must be approved before anything starts. Output is a bounded tail: each line is returned once, so repeated reads show only what is new. Background jobs stop when the session ends.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['command'],
    properties: {
      command: {
        type: 'string',
        description: 'The exact command line to start, e.g. "npm run dev", "node server.js", "vite --port 3000".',
        minLength: 1,
        maxLength: 8_000,
      },
      shell: {
        type: 'string',
        enum: ['auto', ...SHELL_KINDS],
        description: 'Which shell to use. "auto" (default) = cmd on Windows, bash elsewhere.',
      },
      label: {
        type: 'string',
        description: 'Short name shown with the output, e.g. "dev server". Defaults to the command itself.',
        maxLength: MAX_LABEL_LENGTH,
      },
    },
  },
  async describe(input, ctx): Promise<ToolDescription> {
    const cwd = ctx.workspace?.root ?? process.cwd();
    const command = String(input['command'] ?? '').trim();
    const requested = typeof input['shell'] === 'string' && input['shell'] !== '' ? input['shell'] : 'auto';
    try {
      const plan = planHostShell(requested, command);
      const label = labelFor(command, input['label']);
      return {
        summary: `Start in the background: ${label}`,
        targets: [label],
        preview: startPreview(plan, cwd, label),
      };
    } catch (err) {
      return { summary: `Start command (invalid): ${command.slice(0, 80)}`, targets: [], preview: (err as Error).message };
    }
  },
  async run(input, ctx): Promise<ToolResult> {
    const cwd = ctx.workspace?.root ?? process.cwd();
    const requested = typeof input['shell'] === 'string' && input['shell'] !== '' ? input['shell'] : 'auto';
    const plan = planHostShell(requested, String(input['command'] ?? ''));
    const label = labelFor(plan.command, input['label']);

    await ctx.audit.record({
      event: 'command.start',
      tool: 'start_background_process',
      tier: 3,
      detail: { host: true, background: true, shell: plan.kind, cwd, command: plan.command.slice(0, 500), label, warnings: plan.warnings },
    });

    const started = ctx.sandbox.runner.startBackground({
      argv: plan.argv,
      cwd,
      env: shellEnvironment(process.env),
      maxOutputBytes: ctx.config.limits.maxOutputBytes,
      maxProcesses: ctx.config.limits.maxProcesses,
      label,
      ...(plan.verbatim ? { windowsVerbatim: true } : {}),
    });

    return {
      ok: true,
      summary: `Started "${label}" in the background (${plan.kind}). Process id: ${started.id}. It keeps running — read its output with read_process_output.`,
      data: {
        id: started.id,
        pid: started.pid,
        shell: plan.kind,
        label,
        command: plan.command,
        cwd,
      },
    };
  },
};

const MAX_STREAM_CHARS = 12_000;

function tailText(text: string, limit = MAX_STREAM_CHARS): string {
  if (text.length <= limit) return text;
  return `[earlier lines omitted]\n${text.slice(-limit)}`;
}

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').filter((l) => l !== '').length;
}

export const readProcessOutputTool: Tool = {
  name: 'read_process_output',
  description:
    'Read what a background process printed since the previous read. Use it after start_background_process, and again after waiting or after probing the server: output is returned line by line exactly once, so each call shows only new lines (pass reset=true to re-read from the start of the buffer). The result reports whether the job is still running, its exit code once it finished, and any trailing line that has no newline yet. For a command that already finished and returned, use inspect_command_result instead.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', description: 'Process id returned by start_background_process.', minLength: 1, maxLength: 128 },
      reset: { type: 'boolean', description: 'Re-read the whole retained buffer instead of only new lines.' },
    },
  },
  async run(input, ctx): Promise<ToolResult> {
    const id = String(input['id'] ?? '');
    const snapshot = ctx.sandbox.runner.readBackground(id, { reset: input['reset'] === true });
    if (snapshot === null) {
      return {
        ok: false,
        summary: 'No such background process.',
        error: `No background process with id ${id}. Only processes started with start_background_process can be read this way; finished one-shot commands are available through inspect_command_result.`,
      };
    }

    const newLines = lineCount(snapshot.stdout) + lineCount(snapshot.stderr);
    const label = snapshot.label ?? snapshot.argv.join(' ');
    const state = snapshot.running ? 'still running' : `exited ${snapshot.exitCode ?? 'without a code'}`;
    const seconds = (snapshot.durationMs / 1000).toFixed(1);
    const detail = newLines === 0 ? 'no new output' : `${newLines} new line${newLines === 1 ? '' : 's'}`;
    const partial = snapshot.partialOut !== '' || snapshot.partialErr !== '' ? ' · one line still open' : '';
    const crashed = !snapshot.running && snapshot.exitCode !== null && snapshot.exitCode !== 0;

    const data = {
      id: snapshot.id,
      label,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      durationMs: snapshot.durationMs,
      stdout: tailText(snapshot.stdout),
      stderr: tailText(snapshot.stderr),
      partialOut: snapshot.partialOut,
      partialErr: snapshot.partialErr,
      truncated: snapshot.truncated,
      totalLines: { stdout: snapshot.totalOut, stderr: snapshot.totalErr },
    };

    const summary = `${label}: ${detail}, ${state} after ${seconds}s${partial}.`;
    if (crashed) {
      return {
        ok: false,
        summary,
        error: `${label} exited with code ${snapshot.exitCode}. ${snapshot.stderr !== '' ? tailText(snapshot.stderr, 2_000) : tailText(snapshot.stdout, 2_000) || '(no output)'}`,
        data,
      };
    }
    return { ok: true, summary, data };
  },
};

export const backgroundTools: Tool[] = [startBackgroundProcessTool, readProcessOutputTool];
