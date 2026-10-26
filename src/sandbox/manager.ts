import type { OperatorConfig } from '../config/schema.js';
import { SandboxError } from '../errors/errors.js';
import type { AuditLog } from '../security/audit.js';
import { ManagedProcessRunner } from '../core/execution/managed-process.js';
import { DockerBackend } from './docker.js';
import { RestrictedProcessBackend } from './restricted-process.js';
import type { BackendStatus, SandboxBackend, SandboxExecSpec } from './types.js';

/**
 * SandboxManager — owned by the Operator runtime, never by the agent.
 * Selects the backend according to explicit configuration, refuses to run
 * when no secure-enough backend is available, and reports honest status.
 */
export class SandboxManager {
  readonly runner = new ManagedProcessRunner();
  private readonly backends: SandboxBackend[];
  private selected: SandboxBackend | null = null;
  private selectedStatus: BackendStatus | null = null;

  constructor(private readonly config: OperatorConfig) {
    const docker = new DockerBackend(config, this.runner);
    const restricted = new RestrictedProcessBackend(config, this.runner);
    switch (config.sandbox.backend) {
      case 'docker':
        this.backends = [docker];
        break;
      case 'restricted':
        this.backends = [restricted];
        break;
      case 'auto':
      default:
        this.backends = [docker, restricted];
        break;
    }
  }

  /** Evaluate all backends; select the first available one. */
  async prepare(audit?: AuditLog): Promise<BackendStatus> {
    const statuses = await this.statuses();
    const chosen = statuses.find((s) => s.available) ?? null;
    this.selected = chosen ? (this.backends.find((b) => b.id === chosen.id) ?? null) : null;
    this.selectedStatus = chosen;
    await audit?.record({
      event: 'sandbox.select',
      detail: { selected: chosen?.id ?? null, statuses: statuses.map((s) => ({ id: s.id, available: s.available, reason: s.reason })) },
    });
    if (chosen) return chosen;
    return statuses[0] ?? {
      id: 'none',
      label: 'No sandbox',
      available: false,
      reason: 'No sandbox backends are configured.',
      capabilities: [],
      limitations: [],
    };
  }

  async statuses(): Promise<BackendStatus[]> {
    return Promise.all(this.backends.map((b) => b.status()));
  }

  isReady(): boolean {
    return this.selected !== null;
  }

  selectedId(): string | null {
    return this.selected?.id ?? null;
  }

  /** Execute inside the selected sandbox, failing closed when none exists. */
  async execute(spec: SandboxExecSpec) {
    if (!this.selected) await this.prepare();
    if (!this.selected) {
      const reasons = (await this.statuses()).map((s) => `${s.label}: ${s.reason ?? 'unavailable'}`).join('; ');
      throw new SandboxError(
        'unavailable',
        `No secure sandbox is available, so command execution is refused. ${reasons}`,
        {
          hint: 'Install Docker (recommended) and pull the sandbox image, or explicitly opt in to the reduced-isolation backend: operator config set security.allowRestrictedProcessFallback true — after reading docs/sandbox.md.',
        },
      );
    }
    return this.selected.run(spec);
  }
}
