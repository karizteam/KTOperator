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
import {
  discoverInstructionFiles,
  instructionDecisionsFor,
  rememberInstructionDecision,
  type InstructionFile,
} from '../core/agent/instructions.js';
import { estimateTokens, runAgentLoop } from '../core/agent/loop.js';
import { collectRunChanges, renderChangesBox } from '../core/agent/changes.js';
import { createCheckpoint, diffForEntries, entriesAfter, renderDiffLines, type Checkpoint } from '../core/agent/checkpoints.js';
import {
  deletePromptDoc,
  deleteSkill,
  ensureOperatorDir,
  isValidDocName,
  listPrompts,
  listSkills,
  listWorkspaceChats,
  renderWorkspaceDocs,
  sanitizeDocName,
  writeChatMirror,
  writePrompt,
  writeSkill,
  type WorkspaceDoc,
} from '../core/agent/workspace-state.js';
import { VERSION } from '../version.js';
import { BRAND_HEX, displayWidth, truncateToWidth } from '../cli/ui.js';
import { addUsage, cacheHitRate, emptyTotals, formatCost, usageLabel, usageSummaryLines, type UsageTotals } from '../util/usage.js';
import type { SandboxManager } from '../sandbox/manager.js';
import { providerRemove } from './provider.js';
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
  /** Group shown in /help; also the icon prefix in the menu. */
  group: 'Session' | 'Setup' | 'System';
  icon: string;
}

/** Every console command, also used by the "type /" menu in the input box. */
export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { name: 'help', group: 'System', icon: '?', help: 'list every console command' },
  { name: 'status', group: 'Session', icon: '●', help: 'session, provider, workspace and sandbox dashboard' },
  { name: 'usage', group: 'Session', icon: '◈', help: 'token, cache and cost breakdown for this console session' },
  { name: 'provider', group: 'Setup', icon: '◆', usage: '[list|use <id>|add|delete <id>]', help: 'list, switch, add, or delete provider profiles' },
  { name: 'model', group: 'Setup', icon: '◆', usage: '[use <id>|reload]', help: 'show or switch the model' },
  { name: 'workspace', group: 'Setup', icon: '◆', usage: '[path]', help: 'show or re-authorize the workspace' },
  { name: 'access', group: 'Setup', icon: '◆', usage: '[list|clear]', help: 'paths you granted outside the workspace (read, or read + write)' },
  { name: 'sandbox', group: 'System', icon: '▣', help: 'sandbox backends and availability' },
  { name: 'resume', group: 'Session', icon: '↺', usage: '[id]', help: 'continue a previous session (context is compressed)' },
  { name: 'sessions', group: 'Session', icon: '☰', usage: '[delete <id>|clear]', help: 'manage previous sessions — list or delete them' },
  { name: 'export', group: 'Session', icon: '↥', usage: '[id] [--out file]', help: 'export a session transcript as Markdown' },
  { name: 'skill', group: 'Setup', icon: '✦', usage: '[use <name>|add <name>|show <name>|delete <name>]', help: 'list, use, write or delete .operator skills' },
  { name: 'prompt', group: 'Setup', icon: '✎', usage: '[use <name>|add <name>|delete <name>]', help: 'list, use, write or delete .operator prompt templates' },
  { name: 'checkpoint', group: 'Session', icon: '⚑', usage: '[label]', help: 'mark a restore point (one is taken before every task)' },
  { name: 'undo', group: 'Session', icon: '↩', usage: '[n]', help: 'restore the workspace to the last checkpoint' },
  { name: 'diff', group: 'Session', icon: '±', usage: '[n]', help: 'preview the changes since the last checkpoint' },
  { name: 'doctor', group: 'System', icon: '✚', help: 'full environment diagnostics' },
  { name: 'clear', group: 'System', icon: '✕', help: 'clear the conversation view and context' },
  { name: 'exit', group: 'System', icon: '→', help: 'leave the console (alias: /quit)' },
];

/** Subcommands offered after "/provider " etc. — the menu must not vanish at the space. */
const SUBCOMMANDS: Record<string, { name: string; help: string }[]> = {
  provider: [
    { name: 'list', help: 'list provider profiles' },
    { name: 'use', help: 'switch to a provider profile (then its id)' },
    { name: 'add', help: 'add a new provider profile' },
    { name: 'delete', help: 'delete a provider profile and its stored credentials' },
    { name: 'remove', help: 'alias of delete' },
  ],
  model: [
    { name: 'use', help: 'switch model (then the model id)' },
    { name: 'reload', help: 'reload the model list and pick again' },
  ],
  access: [
    { name: 'list', help: 'list granted paths' },
    { name: 'clear', help: 'revoke all access grants' },
  ],
  sessions: [
    { name: 'list', help: 'list previous sessions' },
    { name: 'delete', help: 'delete a previous session (then its id)' },
    { name: 'clear', help: 'delete all previous sessions' },
  ],
  skill: [
    { name: 'list', help: 'list skills in .operator/skills' },
    { name: 'use', help: 'load a skill into this chat (then its name)' },
    { name: 'add', help: 'write a new skill (then its name)' },
    { name: 'show', help: 'show a skill without loading it' },
    { name: 'delete', help: 'delete a skill (then its name)' },
  ],
  prompt: [
    { name: 'list', help: 'list prompt templates in .operator/prompts' },
    { name: 'use', help: 'start this chat from a prompt template' },
    { name: 'add', help: 'write a new prompt template (then its name)' },
    { name: 'delete', help: 'delete a prompt template (then its name)' },
  ],
  checkpoint: [{ name: 'list', help: 'list checkpoints taken in this console' }],
  undo: [{ name: 'list', help: 'list checkpoints (same as /checkpoint list)' }],
  diff: [{ name: 'list', help: 'list checkpoints (same as /checkpoint list)' }],
};

/**
 * Commands offered for a bare "/prefix" — feeds the chat input menu.
 * Prefix matches rank first, then substring matches, so /stat, /statu and
 * /tatus all find /status — forgiving typos without a fuzzy library.
 * After the first space, subcommands are offered instead ("/provider d"
 * → "/provider delete"), so the menu does not disappear at the space.
 */
export function filterSlashCommands(input: string): { command: string; help: string }[] {
  const value = input.trimStart();
  if (!value.startsWith('/') || value.includes('\n')) return [];
  const space = value.indexOf(' ');
  if (space !== -1) {
    const head = value.slice(1, space).toLowerCase();
    const tail = value.slice(space + 1).trimStart().toLowerCase();
    const subs = SUBCOMMANDS[head];
    if (!subs || tail.includes(' ')) return [];
    const prefix = subs.filter((s) => s.name.startsWith(tail));
    if (tail === '' || prefix.length > 0) {
      return (tail === '' ? subs : prefix).map((s) => ({ command: `/${head} ${s.name}`, help: s.help }));
    }
    return subs.filter((s) => s.name.includes(tail)).map((s) => ({ command: `/${head} ${s.name}`, help: s.help }));
  }
  const needle = value.slice(1).toLowerCase();
  if (needle === '') return SLASH_COMMANDS.map((c) => ({ command: `/${c.name}`, help: `${c.icon} ${c.usage ? `${c.help} (${c.usage})` : c.help}` }));
  const prefix = SLASH_COMMANDS.filter((c) => c.name.startsWith(needle));
  const substring = SLASH_COMMANDS.filter((c) => !c.name.startsWith(needle) && c.name.includes(needle));
  return [...prefix, ...substring].map((c) => ({
    command: `/${c.name}`,
    help: `${c.icon} ${c.usage ? `${c.help} (${c.usage})` : c.help}`,
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

export async function consoleMain(rt: Runtime, options: { resumeSessionId?: string } = {}): Promise<number> {
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

  // ── Phase 2a: .operator/ home for this path (skills, prompts, chat mirrors) ──
  const workspaceRoot = rt.config.workspace.current?.path ?? '';
  if (workspaceRoot !== '') {
    await ensureOperatorDir(workspaceRoot);
    const chats = await listWorkspaceChats(workspaceRoot);
    if (chats.length > 0) {
      rt.ui.info(rt.ui.dim(`  .operator · ${chats.length} previous chat(s) in this path · latest: ${chats[0]!.id.slice(0, 8)} — /resume to continue`));
    }
  }

  // ── Phase 2b: project instructions (only content the user has seen) ───────
  rt.projectInstructions = await ensureProjectInstructions(rt, workspaceRoot);

  // ── Phase 2c: .operator skills & prompts (approved once, then loaded) ────
  rt.workspaceDocs = workspaceRoot !== '' ? await loadWorkspaceDocs(rt, workspaceRoot) : [];

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
  // Resume (`ktoperator <sessionId>`) reuses the stored session and reloads
  // its compressed transcript as context — the same chat, continued.
  let resumeMessages: ChatMessage[] = [];
  let sessionId: string;
  if (options.resumeSessionId) {
    const metas = await rt.sessions.list(50);
    const pick = matchSession(metas, options.resumeSessionId);
    if (!pick.target) {
      throw new ConfigError(`No session matches "${options.resumeSessionId}".`, {
        hint: 'Run `ktoperator session list` to see session ids, or `ktoperator` alone for a new chat.',
      });
    }
    sessionId = pick.target.id;
    resumeMessages = await rt.sessions.compressedTranscript(sessionId);
    rt.ui.success(`Resuming chat ${sessionId.slice(0, 8)} · ${resumeMessages.length} message(s) restored`);
  } else {
    sessionId = await rt.sessions.create({
      task: '(interactive console session)',
      provider: stack.profile.type,
      model: stack.model,
      ...(rt.config.workspace.current ? { workspace: rt.config.workspace.current.path } : {}),
    });
  }
  const audit = rt.makeAudit(sessionId);
  await audit.record({ event: 'session.start', detail: { console: true, provider: stack.profile.type, model: stack.model } });

  const history: ChatMessage[] = [...resumeMessages];
  /** Checkpoints taken in this console, oldest first — `/undo` pops the last. */
  const checkpoints: Checkpoint[] = [];
  /** Earlier prompts, newest last — recalled with ↑/↓ in the input box. */
  const promptHistory: string[] = [];
  /** Tokens and cost for the whole console session, shown in the chat box. */
  const spend: UsageTotals = emptyTotals();
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
        // Corner shows only cost/tokens — context % lives in /usage.
        input = (await ask(rt, stack, promptHistory, usageLabel(spend))).trim();
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
          spend,
          history,
          checkpoints,
          injectContext: (text) => history.push({ role: 'user', content: text }),
          corner: usageLabel(spend),
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
          spend,
          checkpoints,
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
    // A server started by the agent must not outlive the session silently.
    const stopped = sandbox.runner.stopAllBackground();
    if (stopped > 0) rt.ui.info(rt.ui.dim(`  stopped ${stopped} background process${stopped === 1 ? '' : 'es'}`));
  }

  rt.ui.info(`  ${rt.ui.brandLight('✦')} ${rt.ui.dim('Goodbye')}`);
  rt.ui.info(`  ${rt.ui.dim('to continue this chat, enter')} ${rt.ui.brand('ktoperator')} ${rt.ui.brand(sessionId)}`);
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

/**
 * Delete a provider profile from the console: picker when no id is given,
 * explicit confirmation, stored credentials removed too. Deleting the
 * active provider first switches to another profile; deleting the last
 * remaining profile is refused (add a new one first).
 */
export async function deleteProviderFlow(rt: Runtime, stack: ConsoleStack, env: SlashEnv, targetId: string): Promise<void> {
  if (rt.config.providers.length === 0) {
    rt.ui.info(rt.ui.dim('  no profiles to delete'));
    return;
  }
  let id = targetId;
  if (id === '') {
    const idx = await rt.ui.promptSelect('Delete provider profile', rt.config.providers.map((p) => `${p.id} (${p.type})${p.id === stack.profile.id ? ' — in use' : ''}`));
    id = rt.config.providers[idx]!.id;
  }
  const profile = rt.config.providers.find((p) => p.id === id);
  if (!profile) {
    rt.ui.error(`No profile named "${id}".`);
    return;
  }
  if (rt.config.providers.length === 1) {
    rt.ui.error('Cannot delete the only provider profile. Add another one first (/provider add), then delete this one.');
    return;
  }
  const inUse = id === stack.profile.id;
  const confirmed = await rt.ui.confirm(`Delete provider "${id}" and its stored credentials?${inUse ? ' This profile is in use — you will be switched to another provider.' : ''}`, false);
  if (!confirmed) {
    rt.ui.info(rt.ui.dim('  kept — nothing deleted'));
    return;
  }
  if (inUse) {
    const others = rt.config.providers.filter((p) => p.id !== id);
    const idx = await rt.ui.promptSelect('Switch to provider', others.map((p) => `${p.id} (${p.type})`));
    const next = others[idx]!;
    const model = await ensureModel(rt, next, { keepCurrent: Boolean(next.model) });
    env.replaceStack(await buildConsoleStack(rt, next, model));
    rt.ui.success(`Switched to ${next.id} / ${model}`);
  }
  await providerRemove(rt, id);
  rt.ui.success(`Deleted provider "${id}" (stored credentials deleted if any).`);
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
  const provider = await rt.buildProviderWithFallback(profile, model);
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
    projectInstructions: rt.projectInstructions,
    workspaceDocs: renderWorkspaceDocs(
      rt.workspaceDocs.filter((d) => d.name.startsWith('skill:')),
      rt.workspaceDocs.filter((d) => d.name.startsWith('prompt:')),
    ),
  });
  return { profile, provider, model, system };
}

/* ------------------------------------------------------------------ */
/* Project instructions                                                */
/* ------------------------------------------------------------------ */

/** How much of one instruction file is shown before asking. */
const INSTRUCTION_PREVIEW_LINES = 14;

/**
 * Show each instruction file once and ask before it is trusted.
 *
 * A file in the workspace is normally untrusted data; a cloned repository must
 * not be able to inject instructions into the system prompt. So the user sees
 * the content, the answer is remembered against that exact hash, and a file
 * that changes is asked about again.
 */
async function ensureProjectInstructions(rt: Runtime, workspaceRoot: string): Promise<InstructionFile[]> {
  if (workspaceRoot === '' || !rt.ui.interactive) return [];
  const files = await discoverInstructionFiles(workspaceRoot).catch(() => []);
  if (files.length === 0) return [];
  const decisions = await instructionDecisionsFor(workspaceRoot).catch(() => new Map());
  const approved: InstructionFile[] = [];

  for (const file of files) {
    const known = decisions.get(file.path);
    if (known !== undefined && known.hash === file.hash) {
      if (known.decision === 'allow') approved.push(file);
      continue;
    }
    const lines = file.content.split('\n');
    const shown = lines.slice(0, INSTRUCTION_PREVIEW_LINES);
    const rest = lines.length - shown.length;
    rt.ui.box(`project instructions · ${file.path}`, [
      ...shown,
      ...(rest > 0 ? [rt.ui.dim(`… ${rest} more line${rest === 1 ? '' : 's'}`)] : []),
      '',
      rt.ui.dim(`${file.bytes} bytes${file.truncated ? ' (only the first 16 KB are used)' : ''}`),
    ]);
    const load = await rt.ui.confirm(`Load ${file.path} as project instructions?`, false);
    await rememberInstructionDecision(workspaceRoot, file.path, file.hash, load ? 'allow' : 'skip').catch(() => undefined);
    if (load) approved.push(file);
  }

  if (approved.length > 0) {
    rt.ui.success(`Project instructions loaded: ${approved.map((f) => f.path).join(', ')}`);
  }
  return approved;
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
  /** Live token/cost totals for /usage and /status. */
  spend?: UsageTotals;
  /** Current conversation, for context-size estimates. */
  history?: readonly ChatMessage[];
  /** Checkpoints taken in this console (shared array, oldest first). */
  checkpoints?: Checkpoint[];
  /** Inject a message into this chat's context (skills/prompts). */
  injectContext?: (text: string) => void;
  /** Chat-box corner (cost/tokens) for multi-line prompts. */
  corner?: string;
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

/**
 * Load .operator skills & prompts for this path. A doc enters the system
 * prompt only after the user approves its exact content (hash-remembered,
 * like AGENTS.md) — contents could otherwise inject instructions.
 */
export async function loadWorkspaceDocs(rt: Runtime, workspaceRoot: string): Promise<WorkspaceDoc[]> {
  const approved: WorkspaceDoc[] = [];
  const groups: { kind: 'skill' | 'prompt'; docs: WorkspaceDoc[] }[] = [
    { kind: 'skill', docs: await listSkills(workspaceRoot).catch(() => []) },
    { kind: 'prompt', docs: await listPrompts(workspaceRoot).catch(() => []) },
  ];
  for (const group of groups) {
    for (const doc of group.docs) {
      const pathLabel = `.operator/${group.kind}s/${doc.name}.md`;
      const known = rt.workspaceDocs.find((d) => d.name === `${group.kind}:${doc.name}`);
      if (known && known.content === doc.content) {
        approved.push(known);
        continue;
      }
      const lines = doc.content.split('\n');
      rt.ui.box(`${group.kind} · ${pathLabel}`, [
        ...lines.slice(0, INSTRUCTION_PREVIEW_LINES),
        ...(lines.length > INSTRUCTION_PREVIEW_LINES ? [rt.ui.dim(`… ${lines.length - INSTRUCTION_PREVIEW_LINES} more lines`)] : []),
        '',
        rt.ui.dim(`${doc.bytes} bytes`),
      ]);
      const load = await rt.ui.confirm(`Load ${pathLabel} for this session?`, false);
      if (load) {
        approved.push({ name: `${group.kind}:${doc.name}`, content: doc.content, bytes: doc.bytes });
        rt.ui.success(`Loaded ${group.kind} "${doc.name}".`);
      }
    }
  }
  return approved;
}

/** `/skill` and `/prompt`: list / use / add / show / delete workspace docs. */
export async function manageDocs(
  rt: Runtime,
  kind: 'skill' | 'prompt',
  args: string,
  env: SlashEnv,
): Promise<void> {
  const root = rt.config.workspace.current?.path ?? '';
  if (root === '') {
    rt.ui.error('No workspace selected — select one first (/workspace) so .operator/ has a home.');
    return;
  }
  await ensureOperatorDir(root);
  const list = kind === 'skill' ? listSkills : listPrompts;
  const write = kind === 'skill' ? writeSkill : writePrompt;
  const remove = kind === 'skill' ? deleteSkill : deletePromptDoc;
  const arg = args.trim();
  const [verbRaw, ...rest] = arg.split(/\s+/);
  const verb = (verbRaw ?? '').toLowerCase();
  const target = rest.join(' ').trim();

  if (arg === '' || verb === 'list') {
    const docs = await list(root);
    if (docs.length === 0) {
      rt.ui.info(rt.ui.dim(`  no ${kind}s yet · /${kind} add <name> writes one into .operator/${kind}s/`));
      return;
    }
    for (const d of docs) {
      rt.ui.info(`  ${rt.ui.brandLight('●')} ${rt.ui.brand(d.name.padEnd(20))}${rt.ui.dim(`${d.bytes} bytes`)}${rt.workspaceDocs.some((a) => a.name === `${kind}:${d.name}`) ? rt.ui.brandLight('  loaded') : ''}`);
    }
    rt.ui.info(rt.ui.dim(`  /${kind} use <name> · /${kind} add <name> · /${kind} delete <name>`));
    return;
  }

  if (verb === 'add') {
    const name = target === '' ? await rt.ui.promptInput(`${kind === 'skill' ? 'Skill' : 'Prompt template'} name`, { required: true }) : target;
    const clean = sanitizeDocName(name);
    if (!isValidDocName(clean)) {
      rt.ui.error(`Invalid name "${name}" — use letters, numbers, dashes or underscores.`);
      return;
    }
    const content = await rt.ui.promptTextArea({
      title: `${kind} ${clean}`,
      hint: rt.ui.dim('Ctrl+J newline · Enter sends · the text is saved as-is'),
      ...(env.corner ? { corner: env.corner } : {}),
    });
    if (content.trim() === '') {
      rt.ui.info(rt.ui.dim('  empty — nothing saved'));
      return;
    }
    await write(root, clean, content);
    rt.ui.success(`Saved ${kind} "${clean}" → .operator/${kind}s/${clean}.md`);
    rt.ui.info(rt.ui.dim(`  /${kind} use ${clean} loads it into this chat`));
    return;
  }

  if (verb === 'use' || verb === 'show' || verb === 'delete') {
    const docs = await list(root);
    let name = target;
    if (name === '') {
      if (docs.length === 0) {
        rt.ui.info(rt.ui.dim(`  no ${kind}s to ${verb}`));
        return;
      }
      const idx = await rt.ui.promptSelect(`${verb === 'use' ? 'Use' : verb === 'show' ? 'Show' : 'Delete'} ${kind}`, docs.map((d) => d.name));
      name = docs[idx]!.name;
    }
    const doc = docs.find((d) => d.name === sanitizeDocName(name));
    if (!doc) {
      rt.ui.error(`No ${kind} named "${name}". /${kind} lists them.`);
      return;
    }
    if (verb === 'show') {
      rt.ui.box(`${kind} · ${doc.name}`, doc.content.split('\n'));
      return;
    }
    if (verb === 'delete') {
      const confirmed = await rt.ui.confirm(`Delete ${kind} "${doc.name}" (.operator/${kind}s/${doc.name}.md)?`, false);
      if (!confirmed) {
        rt.ui.info(rt.ui.dim('  kept — nothing deleted'));
        return;
      }
      await remove(root, doc.name);
      rt.ui.success(`Deleted ${kind} "${doc.name}".`);
      return;
    }
    // use: inject into this chat's context and into the system prompt docs.
    env.injectContext?.(`[${kind === 'skill' ? 'Skill' : 'Prompt template'}: ${doc.name}]\n${doc.content}`);
    if (!rt.workspaceDocs.some((a) => a.name === `${kind}:${doc.name}`)) {
      rt.workspaceDocs.push({ name: `${kind}:${doc.name}`, content: doc.content, bytes: doc.bytes });
    }
    rt.ui.success(`Loaded ${kind} "${doc.name}" into this chat.`);
    return;
  }

  rt.ui.error(`Usage: /${kind}  ·  /${kind} use <name>  ·  /${kind} add <name>  ·  /${kind} delete <name>`);
}

/**
 * Session manager: list previous sessions, delete one (picker or id), or
 * clear them all. The session currently open in this console is protected.
 */
export async function manageSessions(rt: Runtime, args: string, env: SlashEnv): Promise<void> {
  let metas: SessionMeta[];
  try {
    metas = await rt.sessions.list(50);
  } catch (err) {
    rt.ui.error(`Could not read sessions: ${errorMessage(err)}`);
    return;
  }
  const previous = metas.filter((m) => m.id !== env.sessionId);
  const arg = args.trim();

  if (arg === '' || arg === 'list') {
    if (metas.length === 0) {
      rt.ui.info(rt.ui.dim('  no sessions yet'));
      return;
    }
    for (const m of metas) {
      rt.ui.info(`  ${m.id === env.sessionId ? rt.ui.brandLight('●') : ' '} ${rt.ui.brand(sessionLabel(m))}`);
    }
    rt.ui.info(rt.ui.dim('  /sessions delete <id> · /sessions clear'));
    return;
  }

  if (arg === 'clear') {
    if (previous.length === 0) {
      rt.ui.info(rt.ui.dim('  no previous sessions to delete'));
      return;
    }
    const confirmed = await rt.ui.confirm(`Delete all ${previous.length} previous session(s)? This cannot be undone.`, false);
    if (!confirmed) {
      rt.ui.info(rt.ui.dim('  kept — nothing deleted'));
      return;
    }
    let deleted = 0;
    for (const m of previous) if (await rt.sessions.delete(m.id)) deleted += 1;
    rt.ui.success(`Deleted ${deleted} session(s).`);
    return;
  }

  if (arg === 'delete' || arg.startsWith('delete ')) {
    let targetId = arg.replace(/^delete\s*/, '').trim();
    if (targetId === '') {
      if (previous.length === 0) {
        rt.ui.info(rt.ui.dim('  no previous sessions to delete'));
        return;
      }
      const idx = await rt.ui.promptSelect('Delete session', previous.map(sessionLabel));
      targetId = previous[idx]!.id;
    }
    if (targetId === env.sessionId) {
      rt.ui.error('Cannot delete the session that is open right now — exit the console first.');
      return;
    }
    const target = metas.find((m) => m.id.startsWith(targetId));
    const confirmed = await rt.ui.confirm(`Delete session ${targetId.slice(0, 8)}${target ? ` (${target.task.slice(0, 60)})` : ''}? This cannot be undone.`, false);
    if (!confirmed) {
      rt.ui.info(rt.ui.dim('  kept — nothing deleted'));
      return;
    }
    const ok = await rt.sessions.delete(target?.id ?? targetId);
    if (!ok) rt.ui.error(`No session matches "${targetId}".`);
    else rt.ui.success(`Deleted session ${targetId.slice(0, 8)}.`);
    return;
  }

  rt.ui.error('Usage: /sessions  ·  /sessions delete <id>  ·  /sessions clear');
}

/** Diff colors — green additions, red removals, brand headers, dim context. */
function diffStyle(ui: Runtime['ui']): { header: (s: string) => string; added: (s: string) => string; removed: (s: string) => string; context: (s: string) => string } {
  return {
    header: (s) => ui.brandLight(s),
    added: (s) => ui.green(s),
    removed: (s) => ui.red(s),
    context: (s) => ui.dim(s),
  };
}

/** `/undo 2` / `/diff 1` → 0-based checkpoint index; default is the latest. */
export function parseCheckpointIndex(args: string, count: number): number {
  const n = Number.parseInt(args.trim(), 10);
  if (Number.isFinite(n) && n >= 1 && n <= count) return n - 1;
  return count - 1;
}

async function handleSlash(rt: Runtime, slash: SlashCommand, stack: ConsoleStack, env: SlashEnv): Promise<'exit' | void> {
  switch (slash.name) {
    case 'exit':
    case 'quit':
      return 'exit';

    case 'help': {
      for (const group of ['Session', 'Setup', 'System'] as const) {
        const commands = SLASH_COMMANDS.filter((c) => c.group === group);
        if (commands.length === 0) continue;
        rt.ui.info(`  ${rt.ui.brandBold(group)}`);
        const usageWidth = Math.max(...commands.map((c) => displayWidth(`/${c.name}${c.usage ? ` ${c.usage}` : ''}`))) + 2;
        for (const c of commands) {
          const usage = `/${c.name}${c.usage ? ` ${c.usage}` : ''}`;
          const pad = ' '.repeat(Math.max(1, usageWidth - displayWidth(usage)));
          rt.ui.info(`    ${rt.ui.brandLight(c.icon)} ${rt.ui.brand(usage)}${pad}${rt.ui.dim(c.help)}`);
        }
      }
      rt.ui.info(`  ${rt.ui.dim('type')} ${rt.ui.brand('/')} ${rt.ui.dim('in the input box for the menu · fuzzy matching · ↑↓ wraps')}`);
      return;
    }

    case 'usage': {
      const spend = env.spend ?? emptyTotals();
      const context = env.history ? estimateTokens([...env.history]) : undefined;
      const lines = usageSummaryLines(spend, {
        tokenBudget: rt.config.limits.tokenBudget,
        ...(context !== undefined ? { contextTokens: context } : {}),
        ...(rt.config.limits.costCapUsd !== undefined ? { costCapUsd: rt.config.limits.costCapUsd } : {}),
      });
      rt.ui.box('usage · this console session', [
        ...lines,
        `provider     ${stack.profile.id} (${stack.profile.type})`,
        `model        ${stack.model}`,
        ...(spend.cachedTokens > 0 ? [`cache hit    ${cacheHitRate(spend).toFixed(0)}% of prompt tokens served from cache`] : []),
      ]);
      rt.ui.info(rt.ui.dim('  prompt caching is automatic for Anthropic and OpenAI-compatible providers — keep the system prompt stable to stay cached'));
      return;
    }

    case 'status':
      renderStatus(rt, stack, env.sandboxId ?? null, env.sessionId ?? '', env.historyCount ?? 0, env.spend ?? emptyTotals(), env.history ? estimateTokens([...env.history]) : 0, rt.config.limits.tokenBudget);
      return;

    case 'access': {
      if (slash.args === 'clear' || slash.args === 'revoke') {
        const removed = rt.access.revoke(null);
        await rt.makeAudit(env.sessionId ?? 'console').record({ event: 'access.revoke', decision: 'revoked', detail: { count: removed } });
        rt.ui.success(removed === 0 ? 'No access grants to revoke.' : `Revoked ${removed} grant(s).`);
        return;
      }
      const grants = rt.access.list();
      if (grants.length === 0) {
        rt.ui.info(rt.ui.dim('  no paths granted · the agent asks with request_path_access'));
        return;
      }
      for (const g of grants) {
        const level = g.writable ? rt.ui.yellow('read + write') : rt.ui.dim('read');
        rt.ui.info(
          `  ${rt.ui.brandLight('●')} ${rt.ui.brand(g.root)}${g.reason !== '' ? `  ${rt.ui.dim(`— ${g.reason}`)}` : ''}  ${rt.ui.brandDark('·')} ${level}`,
        );
      }
      rt.ui.info(rt.ui.dim('  this session · read + write grants still approve every single change · /access clear revokes all'));
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
      if (slash.args === 'delete' || slash.args === 'remove' || slash.args.startsWith('delete ') || slash.args.startsWith('remove ')) {
        const targetId = slash.args.replace(/^(delete|remove)\s*/, '').trim();
        await deleteProviderFlow(rt, stack, env, targetId);
        return;
      }
      rt.ui.error('Usage: /provider use <id>  ·  /provider add  ·  /provider delete <id>');
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
      rt.projectInstructions = await ensureProjectInstructions(rt, rt.config.workspace.current?.path ?? '');
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
        // Compressed resume: first task + summary of older turns + last turns,
        // so resuming a long session costs a fraction of the original context.
        messages = await rt.sessions.compressedTranscript(target.id);
        meta = (await rt.sessions.transcript(target.id)).meta;
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

    case 'sessions': {
      await manageSessions(rt, slash.args, env);
      return;
    }

    case 'skill':
      await manageDocs(rt, 'skill', slash.args, env);
      return;

    case 'prompt':
      await manageDocs(rt, 'prompt', slash.args, env);
      return;

    case 'checkpoint': {
      const list = env.checkpoints ?? [];
      if (slash.args.trim() === 'list' || slash.args.trim() === 'undo') {
        if (list.length === 0) rt.ui.info(rt.ui.dim('  no checkpoints yet — one is taken automatically before every task'));
        else list.forEach((c, i) => rt.ui.info(`  ${rt.ui.brandLight(String(i + 1).padStart(2))} ${c.ts.slice(11, 19)}  ${rt.ui.brand(c.label)}`));
        return;
      }
      const startIndex = env.sessionId ? (await rt.backups.list(env.sessionId)).length : 0;
      const checkpoint = createCheckpoint(slash.args.trim() || 'manual checkpoint', startIndex);
      list.push(checkpoint);
      rt.ui.success(`Checkpoint ${list.length} marked: ${checkpoint.label} (/undo restores to here)`);
      return;
    }

    case 'diff': {
      const list = env.checkpoints ?? [];
      const target = list[parseCheckpointIndex(slash.args, list.length)];
      if (!target) {
        rt.ui.info(rt.ui.dim('  no checkpoint to diff against yet — run a task first (checkpoints are automatic)'));
        return;
      }
      const entries = env.sessionId ? await entriesAfter(rt.backups, env.sessionId, target) : [];
      const diffs = await diffForEntries(entries);
      if (diffs.length === 0) {
        rt.ui.info(rt.ui.dim('  no file changes since this checkpoint'));
        return;
      }
      rt.ui.box(`diff · since checkpoint "${target.label}"`, renderDiffLines(diffs, diffStyle(rt.ui)));
      return;
    }

    case 'undo': {
      const list = env.checkpoints ?? [];
      const at = parseCheckpointIndex(slash.args, list.length);
      const target = list[at];
      if (!target) {
        rt.ui.info(rt.ui.dim('  nothing to undo — no checkpoint yet'));
        return;
      }
      if (!env.sessionId) return;
      const entries = await entriesAfter(rt.backups, env.sessionId, target);
      if (entries.length === 0) {
        rt.ui.info(rt.ui.dim('  no file changes after this checkpoint — nothing to undo'));
        list.splice(at);
        return;
      }
      const diffs = await diffForEntries(entries);
      if (diffs.length > 0) rt.ui.box(`undo preview · "${target.label}"`, renderDiffLines(diffs, diffStyle(rt.ui)));
      const confirmed = await rt.ui.confirm(`Restore ${entries.length} change(s) made after checkpoint "${target.label}"?`, false);
      if (!confirmed) {
        rt.ui.info(rt.ui.dim('  kept — nothing restored'));
        return;
      }
      const result = await rt.backups.rollbackEntries(entries);
      list.splice(at); // this and all later checkpoints are consumed
      await rt.makeAudit(env.sessionId).record({ event: 'file.restore', detail: { via: 'checkpoint.undo', label: target.label, ...result } as unknown as Record<string, unknown> });
      for (const p of result.restored) rt.ui.success(`restored  ${p}`);
      for (const p of result.deleted) rt.ui.success(`removed   ${p} (was created after the checkpoint)`);
      for (const f of result.failed) rt.ui.error(`FAILED    ${f.path}: ${f.reason}`);
      rt.ui.warn('Note: the conversation still references the reverted work — tell the agent what changed.');
      return;
    }

    case 'export': {
      const targetId = slash.args.trim() || env.sessionId;
      if (!targetId) { rt.ui.error('No session to export — pass an id: /export <id>'); return; }
      try {
        const md = await rt.sessions.exportMarkdown(targetId);
        rt.ui.info(md);
        rt.ui.success(`Exported session ${targetId.slice(0, 8)} (${md.length} bytes). Use \`operator session export ${targetId.slice(0, 8)} --out file.md\` to save it.`);
      } catch (err) {
        rt.ui.error(`Could not export session: ${errorMessage(err)}`);
      }
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
  /** Session totals, updated in place so the next prompt shows them. */
  spend: UsageTotals;
  /** Checkpoints for this console — one is pushed before every task. */
  checkpoints: Checkpoint[];
  setController: (c: AbortController) => void;
}

async function runConsoleTask(rt: Runtime, deps: TaskDeps): Promise<void> {
  const { stack, sandbox, approval, registry, sessionId, audit, history, input, spend } = deps;
  // Checkpoint first: /undo and /diff are relative to this marker.
  const checkpoint = createCheckpoint(input.slice(0, 80), (await rt.backups.list(sessionId)).length);
  deps.checkpoints.push(checkpoint);
  let warnedContext = false;
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
      tokenBudget: limits.tokenBudget,
      ...(limits.costCapUsd !== undefined ? { costCapUsd: limits.costCapUsd } : {}),
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
      onContextUsage: ({ percent }) => {
        if (percent >= 80 && !warnedContext) {
          warnedContext = true;
          rt.ui.warn(`Context is at ${percent}% of the token budget — older turns will compress automatically. /usage shows the breakdown.`);
        }
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
  addUsage(spend, report.usage);

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
  // Diff preview of exactly what this task changed (snapshot → now).
  const changed = await entriesAfter(rt.backups, sessionId, checkpoint);
  if (changed.length > 0) {
    const diffs = await diffForEntries(changed);
    if (diffs.length > 0) rt.ui.box('diff preview', renderDiffLines(diffs, diffStyle(rt.ui)));
  }
  // Mirror the chat into .operator/sessions/<id>.md for this path.
  const wsRoot = rt.config.workspace.current?.path ?? '';
  if (wsRoot !== '') {
    await writeChatMirror(wsRoot, sessionId, history, { provider: stack.profile.type, model: stack.model }).catch(() => undefined);
  }
  if (report.toolCallsTotal > 0) {
    const sep = rt.ui.brandDark(' · ');
    const tools = `${report.toolCallsTotal} tool call${report.toolCallsTotal === 1 ? '' : 's'}`;
    const denied = report.deniedCount > 0 ? `${sep}${report.deniedCount} denied` : '';
    const runCost = report.usage.costUsd !== undefined && report.usage.costUsd > 0 ? `${sep}${rt.ui.dim(formatCost(report.usage.costUsd))}` : '';
    rt.ui.info(`   ${rt.ui.dim(`${tools}${denied}`)}${sep}${rt.ui.dim(`${(report.durationMs / 1000).toFixed(1)}s`)}${runCost}`);
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
  if (rt.projectInstructions.length > 0) {
    rt.ui.info(`  ${label('rules')}${rt.ui.brandLight(rt.projectInstructions.map((f) => f.path).join(', '))}`);
  }
}

/** Full session dashboard, shown on demand with /status. */
function renderStatus(rt: Runtime, stack: ConsoleStack, sandboxId: string | null, sessionId: string, msgCount = 0, spend: UsageTotals = emptyTotals(), contextTokens = 0, tokenBudget = 30_000): void {
  const wsPath = rt.config.workspace.current?.path ?? '(none)';
  const grants = rt.access.list();
  const writable = grants.filter((g) => g.writable).length;
  const granted =
    grants.length === 0
      ? 'none (ask the agent to inspect a path)'
      : `${grants.length} grant(s)${writable > 0 ? ` · ${writable} read + write` : ' · read-only'} · ${grants.map((g) => g.root).slice(0, 3).join(', ')}${grants.length > 3 ? ' …' : ''}`;
  const contextPct = tokenBudget > 0 ? Math.min(100, Math.round((contextTokens / tokenBudget) * 100)) : 0;
  rt.ui.box('status', [
    `provider   ${stack.profile.id} (${stack.profile.type})`,
    `model      ${stack.model}`,
    `workspace  ${wsPath}`,
    `access     ${granted}`,
    `sandbox    ${sandboxId ?? 'none (analysis only)'}`,
    `rules      ${rt.projectInstructions.length > 0 ? rt.projectInstructions.map((f) => f.path).join(', ') : 'none (add AGENTS.md to the workspace)'}`,
    `session    ${sessionId.slice(0, 8)}${msgCount > 0 ? ` · ${msgCount} messages` : ''}`,
    `usage      ${usageLabel(spend) || 'no tokens yet'} · /usage for breakdown`,
    `context    ~${contextTokens} of ${tokenBudget} tokens (${contextPct}% used)`,
    `theme      ${BRAND_HEX}`,
  ]);
}

/** One chat input: a bordered text-area with an inline slash-command menu. */
async function ask(rt: Runtime, stack: ConsoleStack, history: readonly string[], corner = ''): Promise<string> {
  rt.ui.info('');
  return rt.ui.promptTextArea({
    title: 'you',
    subtitle: `${stack.profile.id} · ${stack.model.split('/').pop() ?? stack.model}`,
    ...(corner !== '' ? { corner } : {}),
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
