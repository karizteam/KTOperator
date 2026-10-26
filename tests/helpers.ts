import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, type OperatorConfig } from '../src/config/schema.js';
import { ApprovalEngine, type ApprovalMode } from '../src/security/approval.js';
import { AuditLog } from '../src/security/audit.js';
import { Ui } from '../src/cli/ui.js';
import { WorkspaceBoundary } from '../src/security/path-validation.js';
import { PathAccess } from '../src/security/access.js';
import { BackupManager } from '../src/recovery/backups.js';
import { SandboxManager } from '../src/sandbox/manager.js';
import { createToolRegistry, type ToolContext } from '../src/tools/index.js';
import type { ChatRequest, ChatResult, AIProvider, ProviderCapabilities } from '../src/providers/interfaces/types.js';

export interface TestHarness {
  tmp: string;
  workspaceDir: string;
  config: OperatorConfig;
  boundary: WorkspaceBoundary;
  sandbox: SandboxManager;
  approval: ApprovalEngine;
  backups: BackupManager;
  audit: AuditLog;
  /** Read-only grants for paths outside the workspace (session scope). */
  access: PathAccess;
  toolContext: ToolContext;
  registry: ReturnType<typeof createToolRegistry>;
  cleanup: () => Promise<void>;
}

export interface HarnessOptions {
  approvalMode?: ApprovalMode;
  restrictedFallback?: boolean;
  dryRun?: boolean;
  workspaceFiles?: Record<string, string>;
}

/** Hermetic harness: tmp workspace + config + all security services. */
export async function makeHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-harness-'));
  const workspaceDir = path.join(tmp, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });
  for (const [rel, content] of Object.entries(options.workspaceFiles ?? {})) {
    const abs = path.join(workspaceDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  const config = defaultConfig();
  if (options.restrictedFallback ?? true) config.security.allowRestrictedProcessFallback = true;

  const boundary = await WorkspaceBoundary.create(workspaceDir);
  const sandbox = new SandboxManager(config);
  const ui = new Ui({ json: true, noColor: true, forceNonInteractive: true });
  const approval = new ApprovalEngine(options.approvalMode ?? { kind: 'auto', maxTier: 3 }, config, ui);
  const backups = new BackupManager(config, path.join(tmp, 'backups'));
  const audit = new AuditLog('test-session', path.join(tmp, 'audit'));
  const registry = createToolRegistry();
  const access = new PathAccess();
  const toolContext: ToolContext = {
    config,
    workspace: boundary,
    access,
    approval,
    audit,
    backups,
    sandbox,
    sessionId: 'test-session',
    dryRun: options.dryRun ?? false,
    signal: undefined,
  };
  return {
    tmp,
    workspaceDir,
    config,
    boundary,
    access,
    sandbox,
    approval,
    backups,
    audit,
    registry,
    toolContext,
    cleanup: async () => fs.rm(tmp, { recursive: true, force: true }),
  };
}

/** Scriptable mock provider for agent-loop tests. */
export class MockProvider implements AIProvider {
  readonly type = 'mock';
  readonly label = 'Mock';
  readonly responses: ((req: ChatRequest, call: number) => ChatResult | Promise<ChatResult>)[] = [];
  calls = 0;

  queue(handler: (req: ChatRequest, call: number) => ChatResult | Promise<ChatResult>): this {
    this.responses.push(handler);
    return this;
  }

  capabilities(): ProviderCapabilities {
    return { streaming: false, toolCalling: true, structuredOutputs: true, modelListing: false };
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    // Replay the last handler when the script runs out: real models do keep
    // responding, and loop tests rely on that to exercise limits.
    const handler = this.responses[Math.min(this.calls - 1, this.responses.length - 1)];
    if (!handler) return { text: 'no scripted responses', toolCalls: [], finishReason: 'stop' };
    return handler(request, this.calls);
  }
}

export function textResult(text: string): ChatResult {
  return { text, toolCalls: [], finishReason: 'stop' };
}

export function toolCallResult(name: string, args: Record<string, unknown>, id = `tc-${Math.random().toString(36).slice(2, 8)}`): ChatResult {
  return { text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }], finishReason: 'tool_calls' };
}
