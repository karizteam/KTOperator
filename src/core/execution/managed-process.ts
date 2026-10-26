import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SandboxError } from '../../errors/errors.js';
import { isWindows } from '../../platform/paths.js';

/**
 * Managed process execution: structured argv (no shell by default), minimal
 * environment, timeout, bounded output capture, and guaranteed process-tree
 * cleanup on cancellation. This is the last stop before the OS — sandbox
 * backends build on top of it.
 */

export interface ManagedExecSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Drop to this uid/gid (POSIX, only when we are allowed to). */
  uid?: number;
  gid?: number;
  /** Prefix wrapper already resolved to argv (e.g. prlimit / docker run). */
  label?: string;
}

export interface ManagedProcessResult {
  id: string;
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  outputTruncated: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ManagedProcessInfo {
  id: string;
  argv: string[];
  startedAt: string;
  running: boolean;
  label?: string;
}

/** How long a cancelled/exhausted process gets before SIGKILL. */
const KILL_ESCALATION_MS = 3_000;
/**
 * Absolute backstop: if a killed process never reports its exit (a stuck
 * tree-kill, a wedged child), the call still settles. Without this a single
 * Ctrl+C could leave an interactive session waiting forever.
 */
const KILL_WATCHDOG_MS = 6_000;

const SHELL_NAMES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'command.com', 'wsl', 'wsl.exe',
]);

export function isShellExecutable(name: string): boolean {
  // Sneak attempt like "/bin/sh -c 'id'" as a single argv token: check the first word's basename.
  const firstToken = name.trim().split(/\s+/)[0] ?? name;
  return SHELL_NAMES.has(path.basename(firstToken).toLowerCase());
}

/** Resolve an executable name against a PATH-like string; no shell involved. */
export async function resolveExecutable(name: string, envPath: string): Promise<string> {
  if (name.includes('/') || name.includes('\\')) {
    await assertExecutable(name);
    return name;
  }
  const exts = isWindows ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        await assertExecutable(candidate);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  throw new SandboxError('execution', `Executable not found on the allowed PATH: ${name}`, {
    hint: 'Use an absolute path or check the command name.',
  });
}

/**
 * Windows `.cmd`/`.bat` shims cannot be spawned directly: Node refuses to
 * execute them without a shell (CVE-2024-27980), and handing them to `cmd.exe`
 * would break the sandbox's no-shell rule. JavaScript CLI shims (npm, npx,
 * corepack, pnpm, yarn …) all boil down to `"<node>" "<entry>.js" %*`, so read
 * the shim, resolve `%~dp0`/`%VAR%` and return a plain `[node, entry.js]`
 * invocation that runs with no shell at all.
 *
 * Returns `[script]` unchanged when it is not a batch file, and throws an
 * actionable SandboxError when the shim cannot be expressed that way —
 * never a bare `spawn EINVAL`.
 */
export async function resolveWindowsScriptInvocation(script: string): Promise<string[]> {
  if (!/\.(cmd|bat)$/i.test(script)) return [script];

  const text = (await fs.readFile(script, 'utf8').catch(() => '')).replace(/\r/g, '');
  const dir = path.dirname(script);

  // Every `SET NAME=value`, in file order — later assignments win.
  const assignments = new Map<string, string[]>();
  for (const m of text.matchAll(/^\s*@?SET\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$/gim)) {
    const name = m[1]!.toUpperCase();
    const list = assignments.get(name) ?? [];
    list.push(m[2]!.trim());
    assignments.set(name, list);
  }

  const expand = (value: string): string => {
    let out = value.replace(/%~dp0/gi, dir);
    for (let i = 0; i < 5; i++) {
      const next = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => {
        const list = assignments.get(name.toUpperCase()) ?? [];
        return list[list.length - 1] ?? whole;
      });
      if (next === out) break;
      out = next;
    }
    return out;
  };

  // A variable is only usable when its value resolves to a real file: shims
  // re-point their CLI variable at a global prefix that may not be installed.
  const valueOf = async (name: string): Promise<string> => {
    const list = assignments.get(name) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const expanded = expand(list[i]!);
      if (!/%/.test(expanded) && (await isFile(expanded))) return expanded;
    }
    return list.length > 0 ? expand(list[list.length - 1]!) : '';
  };

  // Candidate entry points: `.js` paths from the assignments and from the
  // invocation lines themselves (corepack inlines it instead of using a var).
  const candidates: { name: string; file: string }[] = [];
  for (const [name, list] of assignments) {
    for (const raw of list) if (/\.js$/i.test(raw)) candidates.push({ name, file: expand(raw) });
  }
  for (const m of text.matchAll(/"([^"]+\.js)"/gi)) candidates.push({ name: m[1]!, file: expand(m[1]!) });

  const existing: { name: string; file: string }[] = [];
  for (const c of candidates) {
    if (!/\.js$/i.test(c.file) || /%/.test(c.file)) continue;
    if (await isFile(c.file)) existing.push(c);
  }
  const entry = existing.find((c) => /cli/i.test(path.basename(c.file)) || /cli/i.test(c.name)) ?? existing[existing.length - 1];

  if (!entry) {
    throw new SandboxError('execution', `Cannot run ${path.basename(script)} without a shell: it is a batch script that does not invoke a JavaScript entry point.`, {
      hint: 'Run the underlying executable directly (for npm: <node> <npm-cli.js>), or install a native executable version of the tool.',
    });
  }

  const nodeExe = [await valueOf('NODE_EXE'), path.join(dir, 'node.exe')].find((c) => c !== '' && isFileSync(c)) ?? process.execPath;
  return [nodeExe, entry.file];
}

function isFileSync(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function assertExecutable(p: string): Promise<void> {
  const stat = await fs.stat(p);
  if (!stat.isFile()) throw new SandboxError('execution', `Not a file: ${p}`);
  if (!isWindows && (stat.mode & 0o111) === 0) {
    throw new SandboxError('execution', `File is not executable: ${p}`);
  }
}

class BoundedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    if (this.size >= this.max) {
      this.truncated = true;
      return;
    }
    const remaining = this.max - this.size;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size += remaining;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

interface ActiveHandle {
  info: ManagedProcessInfo;
  child: ChildProcess;
  kill: (reason: string) => void;
}

const HISTORY_LIMIT = 50;

export class ManagedProcessRunner {
  private readonly active = new Map<string, ActiveHandle>();
  private readonly history: ManagedProcessResult[] = [];

  list(): ManagedProcessInfo[] {
    return [...this.active.values()].map((h) => h.info);
  }

  inspect(id: string): ManagedProcessInfo | ManagedProcessResult | undefined {
    const live = this.active.get(id);
    if (live) return live.info;
    return this.history.find((r) => r.id === id);
  }

  async terminate(id: string, reason = 'terminated by user'): Promise<boolean> {
    const handle = this.active.get(id);
    if (!handle) return false;
    handle.kill(reason);
    return true;
  }

  async run(spec: ManagedExecSpec): Promise<ManagedProcessResult> {
    if (spec.argv.length === 0) throw new SandboxError('execution', 'Empty command argv.');
    const id = randomUUID();
    const startedAt = new Date();
    const stdout = new BoundedBuffer(spec.maxOutputBytes);
    const stderr = new BoundedBuffer(spec.maxOutputBytes);

    const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      windowsHide: true,
      detached: !isWindows, // own process group so we can kill the tree
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(spec.uid !== undefined ? { uid: spec.uid } : {}),
      ...(spec.gid !== undefined ? { gid: spec.gid } : {}),
    });
    child.stdout?.on('data', (c: Buffer) => stdout.push(c));
    child.stderr?.on('data', (c: Buffer) => stderr.push(c));

    const info: ManagedProcessInfo = { id, argv: spec.argv, startedAt: startedAt.toISOString(), running: true, ...(spec.label ? { label: spec.label } : {}) };

    return new Promise<ManagedProcessResult>((resolve) => {
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const finish = (exitCode: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (watchdog) clearTimeout(watchdog);
        spec.signal?.removeEventListener('abort', onAbort);
        this.active.delete(id);
        // A process we killed never chose its own exit code: POSIX reports
        // (null, signal) while Windows taskkill /F reports 1. Report "killed"
        // on both so callers see one meaning instead of a platform artifact.
        const reportedExitCode = timedOut || aborted ? null : exitCode;
        const result: ManagedProcessResult = {
          id,
          argv: spec.argv,
          exitCode: reportedExitCode,
          signal,
          timedOut,
          aborted,
          outputTruncated: stdout.truncated || stderr.truncated,
          stdout: stdout.text(),
          stderr: stderr.text(),
          durationMs: Date.now() - startedAt.getTime(),
        };
        this.history.push(result);
        if (this.history.length > HISTORY_LIMIT) this.history.shift();
        resolve(result);
      };

      let killTimer: NodeJS.Timeout | null = null;
      let watchdog: NodeJS.Timeout | null = null;

      /**
       * Settle no matter what: a cancelled task must always hand control back
       * to the caller (the console prompt), even if the OS never tells us the
       * process died. Firing this after `finish()` already ran is a no-op.
       */
      const armWatchdog = () => {
        if (watchdog) return;
        watchdog = setTimeout(() => {
          watchdog = null;
          try {
            if (child.pid) child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          try {
            child.stdout?.destroy();
            child.stderr?.destroy();
          } catch {
            /* streams already closed */
          }
          finish(null, 'SIGKILL');
        }, KILL_WATCHDOG_MS);
        // Deliberately kept referenced: the promise must settle even if this is
        // the only thing left on the event loop.
      };

      const killTree = (_reason: string) => {
        armWatchdog();
        if (!child.pid) return;
        try {
          if (isWindows) {
            // /T kills the process tree. Never let a failed killer hang us: the
            // watchdog above settles the call, this just makes child.kill a
            // best-effort fallback when taskkill is unavailable.
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => {
              try {
                child.kill('SIGKILL');
              } catch {
                /* gone */
              }
            });
            if (typeof killer.unref === 'function') killer.unref();
          } else {
            process.kill(-child.pid, 'SIGTERM'); // the whole group
            killTimer = setTimeout(() => {
              try {
                if (child.pid) process.kill(-child.pid, 'SIGKILL');
              } catch {
                /* already gone */
              }
            }, KILL_ESCALATION_MS);
          }
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree('timeout');
      }, spec.timeoutMs);

      const onAbort = () => {
        aborted = true;
        killTree('cancelled');
      };
      if (spec.signal) {
        if (spec.signal.aborted) onAbort();
        else spec.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.active.set(id, { info, child, kill: killTree });

      child.on('error', (err) => {
        stderr.push(Buffer.from(`spawn error: ${err.message}`));
        finish(null, null);
      });
      child.on('close', (code, sig) => {
        if (killTimer) clearTimeout(killTimer);
        finish(code, sig);
      });
    });
  }
}
