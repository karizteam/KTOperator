import { ConfigError, OperatorError } from '../errors/errors.js';
import { buildSystemPrompt } from '../core/agent/system-prompt.js';
import { loadApprovedInstructions } from '../core/agent/instructions.js';
import { runAgentLoop } from '../core/agent/loop.js';
import { collectRunChanges, renderChangesBox } from '../core/agent/changes.js';
import { buildPlan, type Plan } from '../core/planner/planner.js';
import { DEFAULT_KEY_ENV } from '../config/credentials.js';
import { VERSION } from '../version.js';
import { formatCost } from '../util/usage.js';
import type { Runtime } from './runtime.js';

export function NotFoundOrEmpty(message: string): OperatorError {
  return new OperatorError('NOT_FOUND', message);
}

export interface AgentCommandFlags {
  provider?: string | undefined;
  model?: string | undefined;
  yes?: string | boolean | undefined;
  dryRun?: boolean | undefined;
  maxSteps?: number | undefined;
}

interface AgentStack {
  providerLabel: string;
  model: string;
  system: string;
  sessionId: string;
  audit: ReturnType<Runtime['makeAudit']>;
  sandbox: ReturnType<Runtime['makeSandbox']>;
  approval: ReturnType<Runtime['makeApproval']>;
  registry: Awaited<ReturnType<Runtime['makeToolContext']>>['registry'];
  toolContext: Awaited<ReturnType<Runtime['makeToolContext']>>['toolContext'];
  provider: Awaited<ReturnType<Runtime['buildProvider']>>;
}

/** Assemble everything plan/run need; performs honest preflight checks. */
export async function assembleAgent(rt: Runtime, task: string, flags: AgentCommandFlags): Promise<AgentStack> {
  const boundary = await rt.workspaceBoundary(); // may be null (read-only tools still work)
  const { profile, model } = rt.resolveProvider({ provider: flags.provider, model: flags.model });
  // Wrapped when `fallback.enabled` is set: a rate limit mid-run continues on
  // another configured profile instead of losing the session.
  const provider = await rt.buildProviderWithFallback(profile, model);
  const providerLabel = `${profile.type} (${profile.id})`;

  const sessionId = await rt.sessions.create({
    task,
    provider: profile.type,
    model,
    ...(rt.config.workspace.current ? { workspace: rt.config.workspace.current.path } : {}),
  });
  const audit = rt.makeAudit(sessionId);
  await audit.record({ event: 'session.start', detail: { task, provider: profile.type, model, workspace: boundary?.root ?? null } });

  const sandbox = rt.makeSandbox();
  await sandbox.prepare(audit);

  const approval = rt.makeApproval({ ...(flags.yes !== undefined ? { yes: flags.yes } : {}), ...(flags.dryRun ? { dryRun: true } : {}) });

  const { registry, toolContext } = await rt.makeToolContext({
    sessionId,
    audit,
    sandbox,
    approval,
    dryRun: flags.dryRun ?? false,
    workspace: boundary,
    agentLabel: `${providerLabel} / ${model}`,
  });

  // A one-shot run never prompts, so only files the user already approved are
  // included. Content that changed since then is simply left out until they
  // see it again in the console.
  const projectInstructions = await loadApprovedInstructions(boundary?.root ?? null);
  rt.projectInstructions = projectInstructions;

  const system = buildSystemPrompt({
    workspaceRoot: boundary?.root ?? null,
    workspaceName: rt.config.workspace.current?.name ?? null,
    config: rt.config,
    platform: process.platform,
    sandboxLabel: sandbox.selectedId() ?? `none (${flags.dryRun ? 'dry-run' : 'execution will be refused'})`,
    toolNames: registry.names(),
    projectInstructions,
  });

  return { providerLabel, model, system, sessionId, audit, sandbox, approval, registry, toolContext, provider };
}

/** `operator run "<task>"` — the full agent loop. */
export async function runTask(rt: Runtime, task: string, flags: AgentCommandFlags): Promise<number> {
  const stack = await assembleAgent(rt, task, flags);
  const limits = rt.config.limits;

  if (!rt.ui.jsonMode) {
    await rt.ui.splashScreen(VERSION);
    rt.ui.step(`Provider: ${rt.ui.brandBold(stack.providerLabel)}, model: ${rt.ui.brandLight(stack.model)}`);
    rt.ui.step(`Sandbox: ${rt.ui.brandLight(stack.sandbox.selectedId() ?? 'NONE (execution tools will fail safely)')}`);
    if (flags.dryRun) rt.ui.warn('Dry-run mode: nothing will be modified.');
  }

  let streamedAny = false;
  const pendingWrites: Promise<void>[] = [rt.sessions.appendMessage(stack.sessionId, { role: 'user', content: task })];
  const report = await runAgentLoop({
    provider: stack.provider,
    model: stack.model,
    system: stack.system,
    userTask: task,
    registry: stack.registry,
    toolContext: stack.toolContext,
    maxIterations: Math.min(flags.maxSteps ?? limits.maxIterations, limits.maxIterations),
    maxToolCalls: limits.maxToolCalls,
    maxDurationMs: limits.maxDurationMs,
    ...(limits.maxTokens !== undefined ? { maxTokens: limits.maxTokens } : {}),
    stream: rt.ui.interactive && stack.provider.capabilities().streaming,
    signal: rt.signal,
    onText: (delta) => {
      streamedAny = true;
      rt.ui.token(delta);
    },
    onTextDone: () => {
      if (streamedAny) {
        rt.ui.endStream();
        streamedAny = false;
      }
    },
    onToolEvent: (ev) => {
      if (rt.ui.jsonMode) return;
      if (ev.type === 'start') rt.ui.step(rt.ui.dim(`tool → ${ev.name}`));
      else rt.ui.step(rt.ui.dim(`${ev.ok ? '✔' : '✖'} ${ev.name}: ${trimTo(ev.summary ?? '', 120)}`));
    },
    onUsage: () => undefined,
    onMessage: (message) => {
      pendingWrites.push(rt.sessions.appendMessage(stack.sessionId, message));
    },
  });

  // One-shot runs must not leave daemons behind: a background server would keep
  // a port open long after the command that started it returned.
  const backgroundStopped = stack.sandbox.runner.stopAllBackground();

  await Promise.allSettled(pendingWrites);
  await rt.sessions.appendReport(stack.sessionId, report);
  await stack.audit.record({
    event: 'session.end',
    detail: {
      status: report.status,
      iterations: report.iterations,
      toolCalls: report.toolCallsTotal,
      denied: report.deniedCount,
      limitReason: report.limitReason ?? null,
      durationMs: report.durationMs,
      usage: report.usage,
    },
  });

  const changes = collectRunChanges(report.steps);
  const summary = {
    sessionId: stack.sessionId,
    status: report.status,
    limitReason: report.limitReason ?? null,
    iterations: report.iterations,
    toolCalls: report.toolCallsTotal,
    deniedActions: report.deniedCount,
    usage: report.usage,
    durationMs: report.durationMs,
    steps: report.steps.map((s) => s.toolCalls),
    changes,
    backgroundStopped,
  };
  rt.ui.emit({ ...summary, finalText: report.finalText }, () => '');

  if (!rt.ui.jsonMode) {
    renderChangesBox(rt.ui, changes);
    rt.ui.info('');
    const statusColor = report.status === 'completed' ? rt.ui.green.bind(rt.ui) : rt.ui.yellow.bind(rt.ui);
    rt.ui.info(rt.ui.bold(`Session ${report.status === 'completed' ? 'completed' : `ended: ${report.status}`}`));
    if (report.limitReason) rt.ui.warn(statusColor(report.limitReason));
    rt.ui.info(`  iterations ${report.iterations} · tool calls ${report.toolCallsTotal} · denied ${report.deniedCount} · ${(report.durationMs / 1000).toFixed(1)}s`);
    if (backgroundStopped > 0) rt.ui.info(rt.ui.dim(`  stopped ${backgroundStopped} background process${backgroundStopped === 1 ? '' : 'es'}`));
    if (report.usage.promptTokens + report.usage.completionTokens > 0) {
      const cost = report.usage.costUsd !== undefined && report.usage.costUsd > 0 ? ` · ${formatCost(report.usage.costUsd)}` : '';
      rt.ui.info(`  tokens: ${report.usage.promptTokens} in / ${report.usage.completionTokens} out${cost}`);
    }
    rt.ui.info(rt.ui.dim(`  session: ${stack.sessionId} (operator history ${stack.sessionId})`));
  }
  return report.status === 'completed' ? 0 : report.status === 'cancelled' ? 130 : 1;
}

/** `operator plan "<task>"` — plan-only; executes nothing. */
export async function planTask(rt: Runtime, task: string, flags: AgentCommandFlags): Promise<number> {
  const stack = await assembleAgent(rt, task, { ...flags, dryRun: true });
  const plan: Plan = await buildPlan({
    provider: stack.provider,
    model: stack.model,
    system: stack.system,
    task,
    signal: rt.signal,
  });
  await stack.audit.record({ event: 'session.end', detail: { status: 'plan-only', steps: plan.steps.length } });
  const payload = { sessionId: stack.sessionId, task, provider: stack.providerLabel, model: stack.model, parsedFromJson: plan.parsedFromJson, steps: plan.steps };
  rt.ui.emit(payload, (d) => {
    const p = d as typeof payload;
    const lines = p.steps.map((s, i) => `  ${i + 1}. ${s.title}${s.detail ? `\n     ${s.detail}` : ''}${s.tools?.length ? `\n     tools: ${s.tools.join(', ')}` : ''}`);
    return [`Plan (${p.steps.length} step(s)) — nothing has been executed:`, ...lines, '', `Run it with: operator run "${task.replace(/"/g, '\\"')}"`].join('\n');
  });
  return 0;
}

export function requireTask(task: string | undefined): string {
  if (!task || task.trim() === '') {
    throw new ConfigError('A task description is required.', { hint: 'operator run "Analyze this project and explain its architecture"' });
  }
  if (task.length > 20_000) throw new ConfigError('Task description is too long (> 20000 characters).');
  return task;
}

function trimTo(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export { DEFAULT_KEY_ENV };
