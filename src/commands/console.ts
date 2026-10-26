import { stdout } from 'node:process';
import path from 'node:path';
import { ConfigError, OperatorError, UserCancelledError, errorMessage } from '../errors/errors.js';
import { DEFAULT_KEY_ENV } from '../config/credentials.js';
import type { ProviderProfile, ProviderType } from '../config/schema.js';
import type { AIProvider, ChatMessage } from '../providers/interfaces/types.js';
import { createProvider } from '../providers/registry.js';
import { createToolRegistry } from '../tools/index.js';
import type { ToolContext } from '../tools/types.js';
import { buildSystemPrompt } from '../core/agent/system-prompt.js';
import { runAgentLoop } from '../core/agent/loop.js';
import { collectRunChanges, renderChangesBox } from '../core/agent/changes.js';
import { VERSION } from '../version.js';
import { BRAND_HEX, displayWidth, truncateToWidth } from '../cli/ui.js';
import type { SandboxManager } from '../sandbox/manager.js';
import { workspaceSelect, workspaceShow } from './workspace.js';
import { sandboxStatus } from './sandbox.js';
import { doctor } from './doctor.js';
import type { Runtime } from './runtime.js';
import type { SessionMeta } from '../sessions/store.js';

/**
 * The interactive ktOperator console — the default landing environment.
 * Themed in #8B9A6E with an animated KT Operator splash screen ("MadeByKariz"),
 * full Persian/RTL text shaping, and an interactive status dashboard.
 */

const PROVIDER_CHOICES: readonly { type: ProviderType; label: string; needsKey: boolean }[] = [
  { type: 'openrouter', label: 'OpenRouter — openrouter.ai (many models, one key)', needsKey: true },
  { type: 'openai', label: 'OpenAI', needsKey: true },
  { type: 'anthropic', label: 'Anthropic Claude', needsKey: true },
  { type: 'google', label: 'Google Gemini', needsKey: true },
  { type: 'openai-compatible', label: 'OpenAI-compatible endpoint (custom URL)', needsKey: true },
  { type: 'ollama', label: 'Ollama — local inference, no key', needsKey: false },
];

const HISTORY_CAP = 60;

/** How long the "press Ctrl+C again" confirmation stays armed. */
export const EXIT_CONFIRM_WINDOW_MS = 2_000;

/**
 * Classify a Ctrl+C that arrived while the prompt was waiting for input:
 * the first press (or one after the window expired) only warns, an immediate
 * repeat leaves the console. A stale earlier press must never make a single
 * keystroke kill the session later on.
 */
export function interruptDecision(lastAt: number, now: number, windowMs = EXIT_CONFIRM_WINDOW_MS): 'clear' | 'confirm-exit' {
  if (lastAt <= 0) return 'clear';
  return now - lastAt <= windowMs ? 'confirm-exit' : 'clear';
}

export interface SlashCommandSpec {
  name: string;
  usage?: string;
  help: string;
}

/** Every console command, also used by the "type /" menu in the input box. */
export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { name: 'help', help: 'list every console command' },
  { name: 'status', help: 'session, provider, workspace and sandbox dashboard' },
  { name: 'provider', usage: '[list|use <id>|add]', help: 'list, switch, or add provider profiles' },
  { name: 'model', usage: '[use <id>|reload]', help: 'show or switch the model' },
  { name: 'workspace', usage: '[path]', help: 'show or re-authorize the workspace' },
  { name: 'access', usage: '[list|clear]', help: 'folders you granted read-only access outside the workspace' },
  { name: 'sandbox', help: 'sandbox backends and availability' },
  { name: 'resume', usage: '[id]', help: 'continue a previous session with its context' },
  { name: 'doctor', help: 'full environment diagnostics' },
  { name: 'clear', help: 'clear the conversation view and context' },
  { name: 'exit', help: 'leave the console (alias: /quit)' },
];

/** Commands offered for a bare "/prefix" — feeds the chat input menu. */
export function filterSlashCommands(input: string): { command: string; help: string }[] {
  const value = input.trimStart();
  if (!value.startsWith('/') || value.includes(' ') || value.includes('\n')) return [];
  const prefix = value.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix)).map((c) => ({
    command: `/${c.name}`,
    help: c.help,
  }));
}

interface ConsoleStack {
  profile: ProviderProfile;
  provider: AIProvider;
  model: string;
  system: string;
}

export interface SlashCommand {
  name: string;
  args: string;
}

/** Parse "/name args…" → { name, args }, or null when not a slash command. */
export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const space = trimmed.indexOf(' ');
  const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  if (name === '') return null; // a lone '/' is not a command
  const args = space === -1 ? '' : trimmed.slice(space + 1).trim();
  return { name, args };
}

export async function consoleMain(rt: Runtime): Promise<number> {
  // A Ctrl+C from an earlier phase must not cancel this session.
  rt.resetInterrupt();

  if (!rt.ui.interactive) {
    throw new ConfigError('The console needs an interactive terminal (TTY).', {
      hint: 'Use subcommands like `ktoperator run "<task>"` for non-interactive/JSON usage.',
    });
  }

  await banner(rt);

  // ── Phase 1: provider + model (selection → key → models → pick) ──────────
  let stack = await ensureProviderAndModel(rt);

  // ── Phase 2: workspace authorization ──────────────────────────────────────
  await ensureWorkspace(rt);

  // ── Phase 3: sandbox (report only; read-only tools work regardless) ───────
  const sandbox = await ensureSandbox(rt);

  // The boundary and the sandbox were resolved after onboarding — rebuild the
  // stack so the model sees the workspace and can read its files/folders.
  stack = await buildConsoleStack(rt, stack.profile, stack.model);
  printHeader(rt, stack, sandbox.selectedId());

  // ── Phase 4: chatbox ───────────────────────────────────────────────────────
  // A Ctrl+C during onboarding aborted that phase, not the chat: re-arm it.
  rt.resetInterrupt();
  const registry = createToolRegistry();
  const approval = rt.makeApproval({});
  const sessionId = await rt.sessions.create({
    task: '(interactive console session)',
    provider: stack.profile.type,
    model: stack.model,
    ...(rt.config.workspace.current ? { workspace: rt.config.workspace.current.path } : {}),
  });
  const audit = rt.makeAudit(sessionId);
  await audit.record({ event: 'session.start', detail: { console: true, provider: stack.profile.type, model: stack.model } });

  const history: ChatMessage[] = [];
  /** Earlier prompts, newest last — recalled with ↑/↓ in the input box. */
  const promptHistory: string[] = [];
  let taskController: AbortController | null = null;
  let taskRunning = false;
  let exitRequested = false;
  let lastInterruptAt = 0;

  /**
   * Ctrl+C has two meanings, never three:
   *  - while a task runs it stops that task — it never ends the session;
   *  - at the prompt it clears the line, and a second press within
   *    EXIT_CONFIRM_WINDOW_MS leaves the console.
   * The key arrives through the UI in raw mode (prompt) and as SIGINT while a
   * task owns the terminal — both funnel into this one handler.
   */
  const onInterrupt = () => {
    if (taskRunning) {
      if (taskController && !taskController.signal.aborted) {
        taskController.abort();
        rt.ui.warn(`${rt.ui.brandBold('Cancelling')} the running task — stopping it now…`);
      }
      return;
    }
    const now = Date.now();
    const verdict = interruptDecision(lastInterruptAt, now);
    lastInterruptAt = now;
    if (verdict === 'confirm-exit') {
      exitRequested = true;
      stdout.write(`\n  ${rt.ui.brandDark('Leaving the console…')}\n`);
      return;
    }
    stdout.write(`\n  ${rt.ui.brandDark('Ctrl+C again within 2s to exit')} ${rt.ui.brandDark('·')} ${rt.ui.dim('/exit works too')}\n`);
  };

  // Raw-mode prompts report the key through the UI; the process signal covers
  // the phase where a task owns the terminal.
  const offUiInterrupt = rt.ui.onInterrupt(onInterrupt);
  const offSigint = rt.setInterruptHandler(onInterrupt);

  try {
    while (!exitRequested) {
      let input: string;
      try {
        input = (await ask(rt, stack, promptHistory)).trim();
      } catch (err) {
        if (err instanceof UserCancelledError) {
          if (exitRequested) break;
          continue;
        }
        throw err;
      }
      rt.ui.info('');
      lastInterruptAt = 0;
      if (exitRequested) break;
      if (input === '') continue;
      if (promptHistory[promptHistory.length - 1] !== input) promptHistory.push(input);
      if (promptHistory.length > 100) promptHistory.splice(0, promptHistory.length - 100);

      const slash = parseSlashCommand(input);
      if (slash) {
        const result = await handleSlash(rt, slash, stack, {
          replaceStack: (next) => {
            stack = next;
          },
          clearHistory: () => {
            history.length = 0;
          },
          replaceHistory: (messages) => {
            history.length = 0;
            history.push(...messages);
          },
          sandboxId: sandbox.selectedId(),
          sessionId,
          historyCount: history.length,
        });
        if (result === 'exit') break;
        continue;
      }

      try {
        taskRunning = true;
        await runConsoleTask(rt, {
          stack,
          sandbox,
          approval,
          registry,
          sessionId,
          audit,
          history,
          input,
          setController: (c) => (taskController = c),
        });
      } catch (err) {
        if (err instanceof UserCancelledError) {
          rt.ui.warn('Cancelled.');
        } else if (err instanceof OperatorError) {
          rt.ui.error(err.message);
          if (err.hint) rt.ui.info(rt.ui.dim(`hint: ${err.hint}`));
        } else {
          rt.ui.error(`Unexpected error: ${errorMessage(err)}`);
        }
      } finally {
        taskRunning = false;
        taskController = null;
        lastInterruptAt = 0;
        // A cancelled task must hand back a clean terminal, not a half-drawn one.
        rt.ui.resetTerminal();
      }
    }
  } finally {
    offUiInterrupt();
    offSigint();
  }

  rt.ui.info(`  ${rt.ui.brandLight('✦')} ${rt.ui.dim('Goodbye')}`);
  rt.ui.close();
  return 0;
}

/* ------------------------------------------------------------------ */
/* Provider + model onboarding                                         */
/* ------------------------------------------------------------------ */

export async function ensureProviderAndModel(rt: Runtime): Promise<ConsoleStack> {
  let profile: ProviderProfile | null = null;

  if (rt.config.providers.length > 0) {
    const options = rt.config.providers.map((p) => `${p.id} (${p.type}${p.model ? `, ${p.model}` : ''})${rt.config.defaultProvider === p.id ? ' — current default' : ''}`);
    const idx = await rt.ui.promptSelect('Provider', [...options, '＋ Add a new provider…']);
    if (idx < rt.config.providers.length) {
      profile = rt.config.providers[idx]!;
    }
  }

  profile ??= await addProviderFlow(rt);

  // Ensure a credential exists before model loading.
  const key = await rt.credentials.resolve(profile);
  const needsKey = profile.type !== 'ollama';
  if (needsKey && !key.value) {
    rt.ui.warn(`No API key found for "${profile.id}".`);
    const entered = await rt.ui.promptInput(`API key for ${profile.type}`, { mask: true, required: true });
    await rt.credentials.set(profile.id, entered);
    rt.ui.success('Key stored securely (chmod 600).');
  }

  const model = await ensureModel(rt, profile, { keepCurrent: true });
  return finishStack(rt, profile, model);
}

async function addProviderFlow(rt: Runtime): Promise<ProviderProfile> {
  const idx = await rt.ui.promptSelect('Provider type', PROVIDER_CHOICES.map((c) => c.label));
  const choice = PROVIDER_CHOICES[idx]!;

  const id = await rt.ui.promptInput('Profile name', { defaultValue: choice.type, required: true });
  if (rt.config.providers.some((p) => p.id === id)) {
    throw new ConfigError(`A profile named "${id}" already exists — choose another name.`);
  }

  let baseUrl: string | undefined;
  if (choice.type === 'openai-compatible') {
    baseUrl = await rt.ui.promptInput('Base URL (e.g. https://llm.example.com/v1)', { required: true });
  } else if (choice.type === 'ollama') {
    baseUrl = await rt.ui.promptInput('Ollama base URL', { defaultValue: 'http://127.0.0.1:11434/v1' });
  }

  const trustedLocal = choice.type === 'ollama' || (baseUrl !== undefined && /^https?:\/\/(127\.|localhost|\[::1\])/.test(baseUrl));

  let apiKeyEnv: string | undefined;
  let key: string | null = null;
  if (choice.needsKey) {
    const envName = DEFAULT_KEY_ENV[choice.type];
    const fromEnv = envName ? process.env[envName] : undefined;
    if (fromEnv) {
      rt.ui.success(`Using ${envName} from the environment.`);
      key = fromEnv;
    } else {
      key = await rt.ui.promptInput(`API key for ${choice.type}`, { mask: true, required: true });
      if (choice.type === 'openai-compatible') {
        apiKeyEnv = await rt.ui.promptInput('Preferred env var name (optional)', { defaultValue: 'OPENAI_COMPATIBLE_API_KEY' });
        if (apiKeyEnv.trim() === '') apiKeyEnv = undefined;
      }
    }
  }

  let referer: string | undefined;
  let title: string | undefined;
  if (choice.type === 'openrouter') {
    const r = await rt.ui.promptInput('HTTP-Referer attribution (optional)');
    const t = await rt.ui.promptInput('X-Title attribution (optional)');
    if (r.trim() !== '') referer = r;
    if (t.trim() !== '') title = t;
  }

  const profile: ProviderProfile = {
    id,
    type: choice.type,
    trustedLocal,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(referer ? { referer } : {}),
    ...(title ? { title } : {}),
  };

  // Test + persist. Key goes to the protected store when it wasn't from env.
  const provider = createProvider(profile, key, rt.config, { maxRetries: 0, timeoutMs: 25_000 });
  const test = await rt.ui.withSpinner('Testing connection…', async () => provider.testConnection?.());
  if (test?.ok) rt.ui.success(test.detail);
  else if (test) rt.ui.warn(`Connection test failed: ${test.detail} (profile saved; fix later with /provider)`);

  const envHadKey = choice.needsKey && DEFAULT_KEY_ENV[choice.type] && process.env[DEFAULT_KEY_ENV[choice.type]] === key;
  if (key && !envHadKey) await rt.credentials.set(id, key);

  rt.config = await rt.store.update((config) => {
    config.providers.push(profile);
    if (config.providers.length === 1) config.defaultProvider = profile.id;
  });

  return rt.config.providers.find((p) => p.id === id)!;
}

/** Load models and let the user pick; returns the chosen model id. */
async function ensureModel(rt: Runtime, profile: ProviderProfile, options: { keepCurrent?: boolean } = {}): Promise<string> {
  if (options.keepCurrent && profile.model) return profile.model;

  const provider = await rt.buildProvider(profile);
  let models: { id: string; label?: string; capabilities?: { toolCalling?: boolean } }[] = [];
  if (provider.listModels && provider.capabilities().modelListing) {
    try {
      models = await rt.ui.withSpinner('Loading models…', () => provider.listModels!());
    } catch (err) {
      rt.ui.warn(`Could not load models: ${errorMessage(err)}`);
    }
  }

  let model: string;
  if (models.length > 0) {
    const top = models.slice(0, 20);
    const labels = top.map((m) => `${m.id}${m.capabilities?.toolCalling === false ? ' (no tool calling)' : ''}`);
    const idx = await rt.ui.promptSelect(
      `Select a model (${models.length} available):`,
      [...labels, models.length > 20 ? `… ${models.length - 20} more not shown — enter a model id manually` : 'Enter a model id manually…'],
    );
    model = idx < top.length ? top[idx]!.id : await rt.ui.promptInput('Model id', { required: true });
    if (top[idx]?.capabilities?.toolCalling === false) {
      rt.ui.warn('This model does not declare tool-calling support; the agent may not be able to act.');
    }
  } else {
    model = await rt.ui.promptInput('Model id', { ...(profile.model ? { defaultValue: profile.model } : {}), required: true });
  }

  rt.config = await rt.store.update((config) => {
    config.providers = config.providers.map((p) => (p.id === profile.id ? { ...p, model } : p));
    if (config.defaultProvider === profile.id || config.providers.length === 1) {
      config.defaultProvider = profile.id;
      config.defaultModel = model;
    }
  });

  return model;
}

function finishStack(rt: Runtime, profile: ProviderProfile, model: string): Promise<ConsoleStack> {
  return buildConsoleStack(rt, profile, model);
}

async function buildConsoleStack(rt: Runtime, profile: ProviderProfile, model: string): Promise<ConsoleStack> {
  const provider = await rt.buildProvider(profile);
  const boundary = await rt.workspaceBoundary();
  const sandbox = rt.makeSandbox();
  await sandbox.prepare();
  const system = buildSystemPrompt({
    workspaceRoot: boundary?.root ?? null,
    workspaceName: rt.config.workspace.current?.name ?? null,
    config: rt.config,
    platform: process.platform,
    sandboxLabel: sandbox.selectedId() ?? 'none',
    toolNames: createToolRegistry().names(),
  });
  return { profile, provider, model, system };
}

/* ------------------------------------------------------------------ */
/* Workspace onboarding                                                */
/* ------------------------------------------------------------------ */

/**
 * Sandbox onboarding. When no isolated backend is available the console
 * explains why and offers the documented restricted-process fallback as an
 * explicit, revocable opt-in instead of leaving "command execution refused"
 * as a dead end.
 */
async function ensureSandbox(rt: Runtime): Promise<SandboxManager> {
  let sandbox = rt.makeSandbox();
  await sandbox.prepare();
  if (sandbox.selectedId()) return sandbox;

  const statuses = await sandbox.statuses();
  const docker = statuses.find((s) => s.id === 'docker');
  const restricted = statuses.find((s) => s.id === 'restricted-process');
  rt.ui.warn(`No sandbox available${docker?.reason ? ` (${docker.reason})` : ''} — commands are refused, file analysis still works.`);

  if (restricted && !rt.config.security.allowRestrictedProcessFallback && rt.ui.interactive) {
    rt.ui.info(rt.ui.dim('  Fallback (not a container): no filesystem/network isolation, no memory limits.'));
    rt.ui.info(rt.ui.dim('  Details: docs/sandbox.md'));
    const enable = await rt.ui.confirm('Enable the restricted-process fallback?', false);
    if (enable) {
      rt.config = await rt.store.update((config) => {
        config.security.allowRestrictedProcessFallback = true;
      });
      sandbox = rt.makeSandbox();
      await sandbox.prepare();
      if (sandbox.selectedId()) {
        rt.ui.success(`Sandbox: ${sandbox.selectedId()} (reduced isolation · docs/sandbox.md)`);
        return sandbox;
      }
    }
  }

  return sandbox;
}

async function ensureWorkspace(rt: Runtime): Promise<void> {
  const boundary = await rt.workspaceBoundary();
  if (boundary) {
    const keep = await rt.ui.confirm(`Use workspace ${boundary.root}?`, false);
    if (keep) return;
  }
  const answer = await rt.ui.promptInput('Workspace to authorize', { defaultValue: process.cwd(), required: true });
  await workspaceSelect(rt, path.resolve(answer));
  await workspaceShow(rt);
}

/* ------------------------------------------------------------------ */
/* Slash commands                                                      */
/* ------------------------------------------------------------------ */

interface SlashEnv {
  replaceStack: (stack: ConsoleStack) => void;
  clearHistory: () => void;
  /** Load a previous session's messages as this conversation's context. */
  replaceHistory: (messages: ChatMessage[]) => void;
  sandboxId?: string | null;
  sessionId?: string;
  historyCount?: number;
}

/** One line per session in the /resume picker. */
function sessionLabel(meta: SessionMeta): string {
  const when = new Date(meta.startedAt);
  const stamp = Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const model = [meta.provider, meta.model].filter(Boolean).join('/') || 'unknown model';
  return `${meta.id.slice(0, 8)} · ${stamp} · ${model} · ${meta.task.slice(0, 36)}`;
}

/** Sessions `/resume` may load: everything except the one already open, newest first. */
export async function listResumable(
  sessions: { list: (limit?: number) => Promise<SessionMeta[]> },
  currentSessionId: string | undefined,
  limit = 12,
): Promise<SessionMeta[]> {
  return (await sessions.list(limit)).filter((m) => m.id !== currentSessionId);
}

/**
 * Pick the session `/resume <id>` means: an id prefix, or the most recent
 * candidate when no argument was given. Matches stay in newest-first order.
 */
export function matchSession(
  candidates: readonly SessionMeta[],
  args: string,
): { target: SessionMeta | null; ambiguous: boolean; error: string | null } {
  const needle = args.trim().toLowerCase();
  if (needle === '') {
    const first = candidates[0] ?? null;
    return { target: first, ambiguous: false, error: first ? null : 'no previous session to resume yet' };
  }
  const matches = candidates.filter((m) => m.id.toLowerCase().startsWith(needle));
  if (matches.length === 0) return { target: null, ambiguous: false, error: `no session matches "${args.trim()}"` };
  return { target: matches[0]!, ambiguous: matches.length > 1, error: null };
}

async function handleSlash(rt: Runtime, slash: SlashCommand, stack: ConsoleStack, env: SlashEnv): Promise<'exit' | void> {
  switch (slash.name) {
    case 'exit':
    case 'quit':
      return 'exit';

    case 'help': {
      const usageWidth = Math.max(...SLASH_COMMANDS.map((c) => displayWidth(`/${c.name}${c.usage ? ` ${c.usage}` : ''}`))) + 2;
      for (const c of SLASH_COMMANDS) {
        const usage = `/${c.name}${c.usage ? ` ${c.usage}` : ''}`;
        const pad = ' '.repeat(Math.max(1, usageWidth - displayWidth(usage)));
        rt.ui.info(`  ${rt.ui.brand(usage)}${pad}${rt.ui.dim(c.help)}`);
      }
      rt.ui.info(`  ${rt.ui.dim('type')} ${rt.ui.brand('/')} ${rt.ui.dim('in the input box for the menu')}`);
      return;
    }

    case 'status':
      renderStatus(rt, stack, env.sandboxId ?? null, env.sessionId ?? '', env.historyCount ?? 0);
      return;

    case 'access': {
      if (slash.args === 'clear' || slash.args === 'revoke') {
        const removed = rt.access.revoke(null);
        await rt.makeAudit(env.sessionId ?? 'console').record({ event: 'access.revoke', decision: 'revoked', detail: { count: removed } });
        rt.ui.success(removed === 0 ? 'No access grants to revoke.' : `Revoked ${removed} read-only grant(s).`);
        return;
      }
      const grants = rt.access.list();
      if (grants.length === 0) {
        rt.ui.info(rt.ui.dim('  no paths granted · the agent asks for access with request_path_access'));
        return;
      }
      for (const g of grants) {
        rt.ui.info(`  ${rt.ui.brandLight('●')} ${rt.ui.brand(g.root)}${g.reason !== '' ? `  ${rt.ui.dim(`— ${g.reason}`)}` : ''}`);
      }
      rt.ui.info(rt.ui.dim('  read-only · this session · /access clear revokes all'));
      return;
    }

    case 'doctor':
      await doctor(rt);
      return;

    case 'clear':
      env.clearHistory();
      stdout.write('\x1b[2J\x1b[0;0H');
      await banner(rt);
      printHeader(rt, stack, env.sandboxId ?? null);
      rt.ui.info(rt.ui.dim('  context cleared'));
      return;

    case 'provider': {
      if (slash.args === '' || slash.args === 'list') {
        if (rt.config.providers.length === 0) {
          rt.ui.info(rt.ui.dim('  no profiles · /provider add'));
          return;
        }
        for (const p of rt.config.providers) {
          const current = p.id === stack.profile.id;
          rt.ui.info(
            `  ${current ? rt.ui.brandLight('●') : ' '} ${rt.ui.brand(p.id.padEnd(14))}${rt.ui.dim(p.type)}${p.model ? `${rt.ui.brandDark(' · ')}${p.model}` : ''}`,
          );
        }
        rt.ui.info(rt.ui.dim('  /provider use <id> · /provider add'));
        return;
      }
      if (slash.args === 'add') {
        const profile = await addProviderFlow(rt);
        const model = await ensureModel(rt, profile);
        env.replaceStack(await buildConsoleStack(rt, profile, model));
        rt.ui.success(`Now using ${profile.id} / ${model}`);
        return;
      }
      if (slash.args.startsWith('use ')) {
        const id = slash.args.slice(4).trim();
        const profile = rt.config.providers.find((p) => p.id === id);
        if (!profile) {
          rt.ui.error(`No profile named "${id}".`);
          return;
        }
        const model = await ensureModel(rt, profile, { keepCurrent: Boolean(profile.model) });
        env.replaceStack(await buildConsoleStack(rt, profile, model));
        rt.ui.success(`Now using ${profile.id} / ${model}`);
        return;
      }
      rt.ui.error('Usage: /provider use <id>  ·  /provider add');
      return;
    }

    case 'model': {
      if (slash.args === '') {
        rt.ui.info(`  ${rt.ui.brand(stack.model)} ${rt.ui.dim(`· ${stack.profile.id}`)}`);
        rt.ui.info(rt.ui.dim('  /model use <id> · /model reload'));
        return;
      }
      if (slash.args === 'reload') {
        const model = await ensureModel(rt, stack.profile);
        env.replaceStack(await buildConsoleStack(rt, stack.profile, model));
        rt.ui.success(`Model: ${model}`);
        return;
      }
      if (slash.args.startsWith('use ')) {
        const model = slash.args.slice(4).trim();
        if (model === '') {
          rt.ui.error('Missing model id.');
          return;
        }
        rt.config = await rt.store.update((config) => {
          config.providers = config.providers.map((p) => (p.id === stack.profile.id ? { ...p, model } : p));
          if (config.defaultProvider === stack.profile.id) config.defaultModel = model;
        });

        env.replaceStack(await buildConsoleStack(rt, stack.profile, model));
        rt.ui.success(`Model: ${model}`);
        return;
      }
      rt.ui.error('Usage: /model use <id>  ·  /model reload');
      return;
    }

    case 'workspace': {
      if (slash.args === '') {
        await workspaceShow(rt);
        return;
      }
      await workspaceSelect(rt, path.resolve(slash.args));
      env.replaceStack(await buildConsoleStack(rt, stack.profile, stack.model));
      return;
    }

    case 'sandbox':
      await sandboxStatus(rt);
      return;

    case 'resume': {
      let metas: SessionMeta[];
      try {
        metas = await listResumable(rt.sessions, env.sessionId);
      } catch (err) {
        rt.ui.error(`Could not read sessions: ${errorMessage(err)}`);
        return;
      }
      if (metas.length === 0) {
        rt.ui.info(rt.ui.dim('  no previous session to resume yet'));
        return;
      }

      const pick = matchSession(metas, slash.args);
      if (!pick.target) {
        rt.ui.error(`${pick.error} — type /resume alone to pick one.`);
        return;
      }
      let target = pick.target;
      if (slash.args === '' && metas.length > 1) {
        const idx = await rt.ui.promptSelect('Resume session', metas.map(sessionLabel));
        target = metas[idx]!;
      }
      if (pick.ambiguous) rt.ui.warn('Several sessions matched — loading the most recent one.');

      let messages: ChatMessage[];
      let meta: SessionMeta | null;
      try {
        const transcript = await rt.sessions.transcript(target.id);
        messages = transcript.messages.slice(-HISTORY_CAP);
        meta = transcript.meta;
      } catch (err) {
        rt.ui.error(`Could not read session ${target.id.slice(0, 8)}: ${errorMessage(err)}`);
        return;
      }
      if (messages.length === 0) {
        rt.ui.warn(`Session ${target.id.slice(0, 8)} has no messages yet.`);
        return;
      }

      env.replaceHistory(messages);
      const model = [meta?.provider, meta?.model].filter(Boolean).join('/') || 'unknown model';
      rt.ui.success(`Resumed ${target.id.slice(0, 8)} · ${messages.length} message(s) · ${model}`);
      rt.ui.info(rt.ui.dim('  earlier context is now part of this conversation'));
      return;
    }

    default: {
      const close = SLASH_COMMANDS.map((c) => `/${c.name}`).filter((c) => c.startsWith(`/${slash.name}`));
      rt.ui.error(`Unknown command: /${slash.name}${close.length > 0 ? ` — did you mean ${close.join(' or ')}?` : ' — try /help'}`);
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Running a chat task                                                 */
/* ------------------------------------------------------------------ */

interface TaskDeps {
  stack: ConsoleStack;
  sandbox: ReturnType<Runtime['makeSandbox']>;
  approval: ReturnType<Runtime['makeApproval']>;
  registry: ReturnType<typeof createToolRegistry>;
  sessionId: string;
  audit: ReturnType<Runtime['makeAudit']>;
  history: ChatMessage[];
  input: string;
  setController: (c: AbortController) => void;
}

async function runConsoleTask(rt: Runtime, deps: TaskDeps): Promise<void> {
  const { stack, sandbox, approval, registry, sessionId, audit, history, input } = deps;
  const controller = new AbortController();
  deps.setController(controller);

  const toolContext: ToolContext = {
    config: rt.config,
    workspace: await rt.workspaceBoundary(),
    access: rt.access,
    approval,
    audit,
    backups: rt.backups,
    sandbox,
    sessionId,
    dryRun: false,
    signal: controller.signal,
    agentLabel: `${stack.profile.type} (${stack.profile.id}) / ${stack.model}`,
  };

  const pending: Promise<void>[] = [rt.sessions.appendMessage(sessionId, { role: 'user', content: input })];
  const fresh: ChatMessage[] = [];
  let messageStarted = false;
  let stopThinking: () => void = () => undefined;
  const beginThinking = () => {
    stopThinking = rt.ui.startActivity('Thinking…');
  };
  const endThinking = () => {
    stopThinking();
    stopThinking = () => undefined;
  };

  let stopTool: () => void = () => undefined;

  const limits = rt.config.limits;
  beginThinking();
  let report;
  try {
    report = await runAgentLoop({
      provider: stack.provider,
      model: stack.model,
      system: stack.system,
      userTask: input,
      history: history.slice(),
      registry,
      toolContext,
      maxIterations: limits.maxIterations,
      maxToolCalls: limits.maxToolCalls,
      maxDurationMs: limits.maxDurationMs,
      ...(limits.maxTokens !== undefined ? { maxTokens: limits.maxTokens } : {}),
      stream: stack.provider.capabilities().streaming,
      signal: controller.signal,
      onModelRequest: () => beginThinking(),
      onText: (d) => {
        endThinking();
        if (!messageStarted) {
          rt.ui.startAnswer();
          messageStarted = true;
        }
        rt.ui.token(d);
      },
      onTextDone: () => {
        if (messageStarted) {
          rt.ui.endStream();
          messageStarted = false;
        }
      },
      onToolEvent: (ev) => {
        endThinking();
        if (ev.type === 'start') {
          stopTool = rt.ui.startActivity(`${ev.name}…`);
          return;
        }
        stopTool();
        stopTool = () => undefined;
        const summary = (ev.summary ?? '').replace(/\s+/g, ' ').trim();
        const room = Math.max(20, (stdout.columns ?? 80) - ev.name.length - 8);
        const detail = summary === '' ? '' : `  ${rt.ui.dim(truncateToWidth(summary, room))}`;
        rt.ui.info(`   ${ev.ok ? rt.ui.brandLight('✓') : rt.ui.red('✗')} ${rt.ui.brand(ev.name)}${detail}`);
      },
      onMessage: (m) => {
        fresh.push(m);
        pending.push(rt.sessions.appendMessage(sessionId, m));
      },
    });
  } finally {
    endThinking();
    stopTool();
    stopTool = () => undefined;
    if (messageStarted) {
      // An interrupted stream would otherwise leave the cursor mid-line and the
      // buffered tail unwritten — the next prompt would draw over the answer.
      rt.ui.endStream();
      messageStarted = false;
    }
  }

  history.push({ role: 'user', content: input }, ...fresh);
  if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);

  await Promise.allSettled(pending);
  await rt.sessions.appendReport(sessionId, report);
  await audit.record({ event: 'session.end', detail: { status: report.status, toolCalls: report.toolCallsTotal, denied: report.deniedCount, limitReason: report.limitReason ?? null } });

  // Only print the answer here when the loop could not deliver it as a stream;
  // printing both is what made every reply appear twice.
  if (!report.finalTextDelivered && report.finalText) {
    rt.ui.answer(report.finalText);
  }
  if (report.status !== 'completed') {
    rt.ui.warn(`${report.status}${report.limitReason ? `: ${report.limitReason}` : ''}`);
  }
  renderChangesBox(rt.ui, collectRunChanges(report.steps));
  if (report.toolCallsTotal > 0) {
    const sep = rt.ui.brandDark(' · ');
    const tools = `${report.toolCallsTotal} tool call${report.toolCallsTotal === 1 ? '' : 's'}`;
    const denied = report.deniedCount > 0 ? `${sep}${report.deniedCount} denied` : '';
    rt.ui.info(`   ${rt.ui.dim(`${tools}${denied}`)}${sep}${rt.ui.dim(`${(report.durationMs / 1000).toFixed(1)}s`)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

async function banner(rt: Runtime): Promise<void> {
  await rt.ui.splashScreen(VERSION);
}

/** Three quiet lines of context instead of a dashboard box on every launch. */
function printHeader(rt: Runtime, stack: ConsoleStack, sandboxId: string | null): void {
  const label = (text: string) => rt.ui.dim(text.padEnd(10));
  const ws = rt.config.workspace.current?.path ?? '(none)';
  rt.ui.info('');
  rt.ui.info(`  ${label('provider')}${rt.ui.brand(stack.profile.id)} ${rt.ui.brandDark('·')} ${stack.model}`);
  rt.ui.info(`  ${label('workspace')}${ws}`);
  rt.ui.info(`  ${label('sandbox')}${sandboxId ? rt.ui.brandLight(sandboxId) : rt.ui.dim('none (analysis only)')}`);
}

/** Full session dashboard, shown on demand with /status. */
function renderStatus(rt: Runtime, stack: ConsoleStack, sandboxId: string | null, sessionId: string, msgCount = 0): void {
  const wsPath = rt.config.workspace.current?.path ?? '(none)';
  const grants = rt.access.list();
  const granted = grants.length === 0 ? 'none (ask the agent to inspect a path)' : `${grants.length} read-only · ${grants.map((g) => g.root).slice(0, 3).join(', ')}${grants.length > 3 ? ' …' : ''}`;
  rt.ui.box('status', [
    `provider   ${stack.profile.id} (${stack.profile.type})`,
    `model      ${stack.model}`,
    `workspace  ${wsPath}`,
    `access     ${granted}`,
    `sandbox    ${sandboxId ?? 'none (analysis only)'}`,
    `session    ${sessionId.slice(0, 8)}${msgCount > 0 ? ` · ${msgCount} messages` : ''}`,
    `theme      ${BRAND_HEX}`,
  ]);
}

/** One chat input: a bordered text-area with an inline slash-command menu. */
async function ask(rt: Runtime, stack: ConsoleStack, history: readonly string[]): Promise<string> {
  rt.ui.info('');
  return rt.ui.promptTextArea({
    title: 'you',
    subtitle: `${stack.profile.id} · ${stack.model.split('/').pop() ?? stack.model}`,
    hint: [
      rt.ui.dim('↵ send'),
      rt.ui.dim('↑↓ history'),
      rt.ui.dim('Ctrl+J newline'),
      `${rt.ui.brand('/')} ${rt.ui.dim('commands')}`,
      rt.ui.dim('Ctrl+C ×2 exit'),
    ].join(rt.ui.brandDark(' · ')),
    suggestions: filterSlashCommands,
    history,
  });
}
