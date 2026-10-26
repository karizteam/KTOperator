import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OperatorConfig } from '../config/schema.js';
import { SandboxError, WorkspaceError } from '../errors/errors.js';
import type { ManagedProcessRunner } from '../core/execution/managed-process.js';
import { isShellExecutable, resolveExecutable, resolveWindowsScriptInvocation } from '../core/execution/managed-process.js';
import { isLinux, isMacOS, isWindows, platform, sandboxTempRoot } from '../platform/paths.js';
import type { BackendStatus, SandboxBackend, SandboxExecSpec } from './types.js';

const MINIMAL_POSIX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Restricted-process backend — the documented, explicitly OPT-IN fallback
 * for hosts without containers. It is NOT equivalent to a container:
 *
 *   applies:  no shell, minimal env, isolated HOME/TMP, workspace-bound cwd,
 *             timeout, bounded output, prlimits (Linux; via `prlimit` where
 *             available), non-root uid when possible, process-tree cleanup.
 *   cannot:   isolate the filesystem, restrict syscalls, or disable the
 *             network. Those guarantees need the Docker backend.
 *
 * It exists so read-only diagnostics (e.g. `git status`) and carefully
 * approved commands still work on container-less machines, after the user
 * has read docs/sandbox.md and set security.allowRestrictedProcessFallback.
 */
export class RestrictedProcessBackend implements SandboxBackend {
  readonly id = 'restricted-process';
  readonly label = 'Restricted process (fallback)';

  constructor(
    private readonly config: OperatorConfig,
    private readonly runner: ManagedProcessRunner,
  ) {}

  async status(): Promise<BackendStatus> {
    const caps: string[] = [
      'no shell interpretation (argv only)',
      'minimal environment',
      'isolated HOME/TMP directories',
      'timeout + bounded output',
      'process-tree cleanup on cancel',
    ];
    const limitations: string[] = [
      'NOT a container: filesystem and network are not isolated',
      'requires security.allowRestrictedProcessFallback=true (opt-in)',
    ];
    if (isLinux) {
      if (has('prlimit')) caps.push('partial resource limits via prlimit (nofile/fsize)');
      else limitations.push('prlimit not found: resource limits limited to timeout/output');
    }
    limitations.push('NO memory or process-count enforcement (needs the Docker backend cgroup limits)');
    if (isMacOS) limitations.push('no resource-limit helper on macOS: timeout/output only');
    if (isWindows) limitations.push('reduced isolation on Windows: no uid drop, no rlimits');
    if (!this.config.security.allowRestrictedProcessFallback) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        reason: 'Fallback is disabled. Set security.allowRestrictedProcessFallback=true after reading docs/sandbox.md, or install Docker for full isolation.',
        capabilities: caps,
        limitations,
      };
    }
    return { id: this.id, label: this.label, available: true, capabilities: caps, limitations };
  }

  async run(spec: SandboxExecSpec) {
    const status = await this.status();
    if (!status.available) {
      throw new SandboxError('unavailable', `Restricted-process backend is disabled: ${status.reason}`, {
        hint: 'Install Docker for a real sandbox, or opt in via `operator config set security.allowRestrictedProcessFallback true`.',
      });
    }
    const exeName = spec.argv[0];
    if (!exeName) throw new SandboxError('execution', 'Empty command.');
    if (isShellExecutable(exeName)) {
      throw new SandboxError('execution', `Refusing to run a shell interpreter (${exeName}) inside the sandbox.`, {
        hint: 'Run the real executable with structured arguments instead of a shell command string.',
      });
    }

    // Minimal environment: PATH + isolated HOME/TMP + caller's allowlist.
    const runId = randomUUID();
    const tmpBase = path.join(sandboxTempRoot(), runId);
    await fs.mkdir(tmpBase, { recursive: true, mode: 0o700 });
    const nodeBinDir = path.dirname(process.execPath);
    const env: Record<string, string> = {
      PATH: isWindows
        ? [process.env['SystemRoot'] != null ? `${process.env['SystemRoot']}\\System32` : '', process.env['SystemRoot'] ?? '', nodeBinDir].filter(Boolean).join(';')
        : `${nodeBinDir}:${MINIMAL_POSIX_PATH}`,
      HOME: tmpBase,
      TMPDIR: tmpBase,
      TEMP: tmpBase,
      TMP: tmpBase,
      LANG: 'C.UTF-8',
      ...spec.env,
    };

    if (!spec.workspaceRoot.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(spec.workspaceRoot)) {
      throw new WorkspaceError(`Sandbox workspace root must be absolute: ${spec.workspaceRoot}`);
    }
    const rootResolved = path.resolve(spec.workspaceRoot);
    const cwd = spec.workdir ? path.resolve(rootResolved, spec.workdir) : rootResolved;
    const rel = path.relative(rootResolved, cwd);
    if (rel !== '' && (rel.split(path.sep)[0] === '..' || path.isAbsolute(rel))) {
      throw new SandboxError('execution', 'Sandbox working directory escapes the workspace.');
    }
    if (!spec.writable) {
      // We cannot make the tree read-only without containers; record it.
      env['OPERATOR_READ_ONLY_WORKSPACE'] = '1';
    }

    let argv: string[];
    if (isWindows) {
      const resolved = await resolveExecutable(exeName, env['PATH']!);
      // `.cmd`/`.bat` shims (npm, npx, corepack …) cannot be spawned directly
      // without a shell — run their JavaScript entry point through node instead.
      argv = [...(await resolveWindowsScriptInvocation(resolved)), ...spec.argv.slice(1)];
    } else {
      const resolved = await resolveExecutable(exeName, env['PATH']!);
      argv = [resolved, ...spec.argv.slice(1)];
      if (platform() === 'linux' && has('prlimit')) {
        // NOTE: memory and process counts are intentionally NOT capped here.
        // RLIMIT_AS measures virtual address space (kill-node-on-startup
        // territory) and RLIMIT_NPROC counts every process of the UID — both
        // produce false kills on busy hosts. Real memory/pid enforcement
        // comes from the Docker backend's cgroup limits. nofile and fsize
        // are per-process and safe.
        const fileBytes = spec.limits.memoryMb * 1024 * 1024;
        argv = ['prlimit', '--nofile=256', `--fsize=${fileBytes}`, '--', ...argv];
      }
    }

    const demote = posixDemoteIds();
    try {
      return await this.runner.run({
        argv,
        cwd,
        env,
        timeoutMs: spec.limits.timeoutMs,
        maxOutputBytes: spec.limits.maxOutputBytes,
        ...(demote ? demote : {}),
        ...(spec.signal ? { signal: spec.signal } : {}),
        label: 'restricted-process-sandbox',
      });
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** If we ever run as root (never recommended), drop to `nobody`. */
function posixDemoteIds(): { uid: number; gid: number } | null {
  if (isWindows || typeof process.getuid !== 'function') return null;
  try {
    if (process.getuid() !== 0) return null;
    return { uid: 65534, gid: 65534 };
  } catch {
    return null;
  }
}

function has(command: string): boolean {
  try {
    const res = spawnSync(command, ['--version'], { shell: false, timeout: 3000, stdio: 'pipe' });
    return res.status === 0 || res.status === 1; // prlimit --version exits 0
  } catch {
    return false;
  }
}
