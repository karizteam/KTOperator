import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { OperatorConfig } from '../config/schema.js';
import { SandboxError } from '../errors/errors.js';
import { isWindows } from '../platform/paths.js';
import type { ManagedProcessResult, ManagedProcessRunner } from '../core/execution/managed-process.js';
import type { BackendStatus, SandboxBackend, SandboxExecSpec } from './types.js';

/**
 * Docker backend — the preferred, genuinely isolated execution environment:
 * rootless/non-root user, read-only root filesystem, no capabilities,
 * no-new-privileges, bound resources, tmpfs /tmp, network disabled by
 * default, workspace as the ONLY mount (read-only unless authorized), and
 * no container-runtime socket anywhere near the agent.
 */
export class DockerBackend implements SandboxBackend {
  readonly id = 'docker';
  readonly label = 'Docker container';

  constructor(
    private readonly config: OperatorConfig,
    private readonly runner: ManagedProcessRunner,
  ) {}

  async status(): Promise<BackendStatus> {
    const caps = [
      'process isolation (namespaces)',
      'read-only root filesystem',
      'dropped Linux capabilities (ALL)',
      'no-new-privileges',
      'network disabled by default',
      'memory/CPU/pids limits',
      'workspace-only mount',
    ];
    const hasBinary = probe('docker', ['--version']);
    if (!hasBinary) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        reason: 'Docker CLI not found on PATH.',
        capabilities: caps,
        limitations: ['Requires Docker Engine / Docker Desktop + the sandbox image.'],
      };
    }
    const daemonOk = probe('docker', ['info', '--format', '{{.ServerVersion}}'], 10_000);
    if (!daemonOk) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        reason: 'Docker daemon is not reachable.',
        capabilities: caps,
        limitations: ['Start Docker, then re-run `operator sandbox status`.'],
      };
    }
    const imagePresent = probe('docker', ['image', 'inspect', this.config.sandbox.image], 10_000);
    return {
      id: this.id,
      label: this.label,
      available: imagePresent,
      ...(imagePresent ? {} : { reason: `Sandbox image "${this.config.sandbox.image}" is not pulled. Run: docker pull ${this.config.sandbox.image}` }),
      capabilities: caps,
      limitations: ['Image tag is user-configurable; keep it minimal and pinned.'],
    };
  }

  containerName(runId: string): string {
    return `operator-${runId}`;
  }

  buildArgs(spec: SandboxExecSpec, runId: string): string[] {
    const c = this.config.sandbox;
    const args = ['run', '--rm', '-i', '--name', this.containerName(runId)];
    args.push('--network', spec.network ? 'bridge' : 'none');
    args.push('--read-only');
    args.push('--cap-drop', 'ALL');
    args.push('--security-opt', 'no-new-privileges');
    args.push('--user', '65534:65534'); // nobody
    args.push('--memory', `${spec.limits.memoryMb}m`);
    args.push('--cpus', String(spec.limits.cpus));
    args.push('--pids-limit', String(spec.limits.pidsLimit));
    args.push('--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m');
    const mountMode = spec.writable ? 'rw' : 'ro';
    args.push('--mount', `type=bind,source=${spec.workspaceRoot},target=/work,${mountMode}`);
    args.push('--workdir', spec.workdir ? `/work/${spec.workdir.replace(/\\/g, '/')}` : '/work');
    for (const [k, v] of Object.entries(spec.env)) {
      args.push('--env', `${k}=${v}`);
    }
    args.push('-e', 'HOME=/tmp', '-e', 'TMPDIR=/tmp', '-e', 'LANG=C.UTF-8');
    args.push(c.image);
    args.push(...spec.argv);
    return args;
  }

  async run(spec: SandboxExecSpec): Promise<ManagedProcessResult> {
    // Guard first: the agent must never see the docker socket, regardless of availability.
    if (spec.argv.some((a) => a.includes('/var/run/docker.sock'))) {
      throw new SandboxError('execution', 'Refusing to expose the container runtime socket to the sandbox.');
    }
    const status = await this.status();
    if (!status.available) {
      throw new SandboxError('unavailable', `Docker sandbox is not available: ${status.reason ?? 'unknown reason'}`, {
        hint: 'Install/start Docker and pull the sandbox image, or explicitly enable the restricted-process fallback after reviewing docs/sandbox.md.',
      });
    }
    const dockerPath = isWindows ? 'docker.exe' : 'docker';
    const runId = randomUUID();
    const name = this.containerName(runId);

    // Watchdog: killing the foreground docker CLI does NOT stop the
    // container, so enforce the time budget at the daemon side too.
    // Best-effort by design; --rm handles normal exits.
    const watchdog = setTimeout(() => {
      spawnSync(dockerPath, ['rm', '-f', name], { shell: false, timeout: 15_000, windowsHide: true, stdio: 'ignore' });
    }, spec.limits.timeoutMs + 2_000);
    const onAbort = () => {
      spawnSync(dockerPath, ['rm', '-f', name], { shell: false, timeout: 15_000, windowsHide: true, stdio: 'ignore' });
    };
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await this.runner.run({
        argv: [dockerPath, ...this.buildArgs(spec, runId)],
        cwd: spec.workspaceRoot,
        env: minimalDockerClientEnv(),
        timeoutMs: spec.limits.timeoutMs + 5_000,
        maxOutputBytes: spec.limits.maxOutputBytes,
        ...(spec.signal ? { signal: spec.signal } : {}),
        label: 'docker-sandbox',
      });
    } finally {
      clearTimeout(watchdog);
      spec.signal?.removeEventListener('abort', onAbort);
      // Paranoid sweep: --rm may be skipped if the client was SIGKILLed.
      spawnSync(dockerPath, ['rm', '-f', name], { shell: false, timeout: 15_000, windowsHide: true, stdio: 'ignore' });
    }
  }
}

function minimalDockerClientEnv(): Record<string, string> {
  const env: Record<string, string> = { LANG: 'C.UTF-8' };
  for (const key of ['PATH', 'DOCKER_HOST', 'HOME', 'USERPROFILE']) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  return env;
}

function probe(command: string, args: string[], timeoutMs = 5000): boolean {
  try {
    const res = spawnSync(command, args, { shell: false, timeout: timeoutMs, windowsHide: true, stdio: 'pipe' });
    return res.status === 0;
  } catch {
    return false;
  }
}
