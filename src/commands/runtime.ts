import { Ui } from '../cli/ui.js';
import { ConfigStore } from '../config/store.js';
import { CredentialStore } from '../config/credentials.js';
import type { OperatorConfig } from '../config/schema.js';
import { ApprovalEngine, type ApprovalMode } from '../security/approval.js';
import { AuditLog } from '../security/audit.js';
import { BackupManager } from '../recovery/backups.js';
import { SandboxManager } from '../sandbox/manager.js';
import { SessionStore } from '../sessions/store.js';
import { createToolRegistry, type ToolContext, type ToolRegistry } from '../tools/index.js';
import { WorkspaceBoundary } from '../security/path-validation.js';
import { PathAccess } from '../security/access.js';
import { ConfigError, WorkspaceError } from '../errors/errors.js';
import { createProvider, findProfile, resolveModel } from '../providers/registry.js';
import type { AIProvider } from '../providers/interfaces/types.js';
import type { ProviderProfile } from '../config/schema.js';

export interface CliGlobals {
  json: boolean;
  noColor: boolean;
}

/** Shared runtime services assembled once per CLI invocation. */
export class Runtime {
  readonly ui: Ui;
  readonly store = new ConfigStore();
  readonly credentials = new CredentialStore();
  readonly sessions = new SessionStore();
  readonly access = new PathAccess();
  private controller = new AbortController();
  config!: OperatorConfig;
  backups!: BackupManager;
  private boundary: WorkspaceBoundary | null | undefined; // undefined = not tried
  /** Long-lived command that wants to own Ctrl+C (the interactive console). */
  private interruptListener: (() => void) | null = null;

  private constructor(globals: CliGlobals) {
    this.ui = new Ui({ json: globals.json, noColor: globals.noColor });
  }

  static async create(globals: CliGlobals): Promise<Runtime> {
    const config = await new ConfigStore().load();
    const rt = new Runtime({
      json: globals.json,
      noColor: globals.noColor || !config.ui.color,
    });
    rt.config = config;
    rt.backups = new BackupManager(rt.config);
    return rt;
  }

  /** Cancellation for one-shot runs. Re-armed between interactive phases. */
  get abort(): AbortController {
    return this.controller;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** A stale abort must never disable the next phase of an interactive session. */
  resetInterrupt(): void {
    if (this.controller.signal.aborted) this.controller = new AbortController();
  }

  /**
   * One Ctrl+C owner at a time. The console takes over so a single press stops
   * the running task (instead of poisoning the whole run's abort signal and
   * leaving the chat unusable). One-shot commands keep the default behaviour.
   */
  setInterruptHandler(listener: (() => void) | null): () => void {
    this.interruptListener = listener;
    return () => {
      if (this.interruptListener === listener) this.interruptListener = null;
    };
  }

  /** Route one Ctrl+C to the active owner, or abort this one-shot run. */
  handleInterrupt(): void {
    if (this.interruptListener) this.interruptListener();
    else this.abort.abort('SIGINT');
  }

  makeAudit(sessionId: string): AuditLog {
    return new AuditLog(sessionId);
  }

  makeSandbox(): SandboxManager {
    return new SandboxManager(this.config);
  }

  makeApproval(options: { yes?: string | boolean; dryRun?: boolean }): ApprovalEngine {
    const mode: ApprovalMode = ApprovalEngine.modeFromFlags(
      {
        interactive: this.ui.interactive,
        ...(options.yes !== undefined && options.yes !== false
          ? { yesLevel: options.yes === true ? '' : String(options.yes) }
          : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
      },
      this.config,
    );
    return new ApprovalEngine(mode, this.config, this.ui);
  }

  /** Drop the cached boundary after the workspace grant changes. */
  invalidateWorkspace(): void {
    this.boundary = undefined;
  }

  async workspaceBoundary(): Promise<WorkspaceBoundary | null> {
    if (this.boundary !== undefined) return this.boundary;
    const current = this.config.workspace.current;
    if (!current) {
      this.boundary = null;
      return null;
    }
    try {
      this.boundary = await WorkspaceBoundary.create(current.path);
    } catch {
      this.boundary = null; // selected path vanished or moved
    }
    return this.boundary;
  }

  async requireWorkspace(): Promise<WorkspaceBoundary> {
    const boundary = await this.workspaceBoundary();
    if (!boundary) {
      const current = this.config.workspace.current;
      throw new WorkspaceError(
        current ? `The selected workspace is no longer valid: ${current.path}` : 'No workspace selected.',
        { hint: 'Run `operator workspace select` (or `operator workspace select .` for the current directory).' },
      );
    }
    return boundary;
  }

  resolveProvider(options: { provider?: string | undefined; model?: string | undefined }): {
    profile: ProviderProfile;
    provider: AIProvider;
    model: string;
  } {
    const profile = findProfile(this.config, options.provider);
    const model = resolveModel(profile, this.config, options.model);
    return { profile, provider: null as unknown as AIProvider, model };
  }

  async buildProvider(profile: ProviderProfile): Promise<AIProvider> {
    const key = await this.credentials.resolve(profile);
    if (!key.value && profile.type !== 'ollama') {
      throw new ConfigError(`No API key available for provider "${profile.id}" (${profile.type}).`, {
        hint: `Set ${key.envName ?? 'the provider key env var'} or store it via \`operator provider add\`. Keys are never printed.`,
      });
    }
    return createProvider(profile, key.value, this.config, { maxRetries: this.config.limits.maxProviderRetries });
  }

  /** Full agent stack for plan/run commands. */
  async makeToolContext(options: {
    sessionId: string;
    audit: AuditLog;
    sandbox: SandboxManager;
    approval: ApprovalEngine;
    dryRun: boolean;
    workspace: WorkspaceBoundary | null;
    agentLabel?: string;
  }): Promise<{ registry: ToolRegistry; toolContext: ToolContext }> {
    const registry = createToolRegistry();
    const toolContext: ToolContext = {
      config: this.config,
      workspace: options.workspace,
      access: this.access,
      approval: options.approval,
      audit: options.audit,
      backups: this.backups,
      sandbox: options.sandbox,
      sessionId: options.sessionId,
      dryRun: options.dryRun,
      signal: this.signal,
      ...(options.agentLabel ? { agentLabel: options.agentLabel } : {}),
    };
    return { registry, toolContext };
  }
}
