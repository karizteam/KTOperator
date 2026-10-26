#!/usr/bin/env node
import { Command } from 'commander';
import { Runtime } from './commands/runtime.js';
import { planTask, requireTask, runTask } from './commands/agent.js';
import { configPath, configSet, configShow } from './commands/config.js';
import { consoleMain } from './commands/console.js';
import { doctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { modelList } from './commands/model.js';
import { providerAdd, providerList, providerRemove, providerTest } from './commands/provider.js';
import { backupsList, rollback } from './commands/rollback.js';
import { sandboxStatus } from './commands/sandbox.js';
import { history, sessionList } from './commands/session.js';
import { workspaceSelect, workspaceShow } from './commands/workspace.js';
import { isOperatorError, OperatorError, UserCancelledError } from './errors/errors.js';
import { PRODUCT_NAME, VERSION } from './version.js';

/**
 * KarizTeam Operator CLI. Global options: --json, --no-color.
 * Every command gets a Runtime (config + services) and returns an exit code.
 */

interface Globals {
  json?: boolean;
  color?: boolean;
  noColor?: boolean;
}

const program = new Command();
program
  .name('operator')
  .description(`${PRODUCT_NAME} — a secure, multi-provider AI operating-system agent`)
  .version(VERSION, '-v, --version')
  .option('--json', 'machine-readable output (implies non-interactive)')
  .option('--no-color', 'disable ANSI colors')
  .configureHelp({ sortSubcommands: true });

async function withRuntime(globals: Globals, fn: (rt: Runtime) => Promise<number | void>): Promise<number> {
  const noColor = globals.noColor ?? (globals.color === false);
  const rt = await Runtime.create({ json: globals.json ?? false, noColor });
  const onSigint = () => rt.handleInterrupt();
  process.on('SIGINT', onSigint);
  try {
    return (await fn(rt)) ?? 0;
  } finally {
    process.removeListener('SIGINT', onSigint);
    // Release the terminal (raw mode, readline) so cancellation can actually exit
    // instead of leaving an idle stdin handle holding the process open.
    rt.ui.close();
  }
}

/** Wrap a command action with uniform, redacted error reporting. */
function handle<A extends unknown[]>(fn: (rt: Runtime, ...args: A) => Promise<number | void>) {
  return async (...args: A) => {
    const globals = program.opts<Globals>();
    try {
      const code = await withRuntime(globals, (rt) => fn(rt, ...args));
      process.exitCode = code;
    } catch (err) {
      const ui = { json: globals.json ?? false };
      if (err instanceof UserCancelledError) {
        if (!ui.json) process.stderr.write('\nCancelled.\n');
        else process.stdout.write(`${JSON.stringify({ error: { code: 'CANCELLED', message: err.message } })}\n`);
        process.exitCode = 130;
        return;
      }
      if (isOperatorError(err)) {
        if (ui.json) {
          process.stdout.write(`${JSON.stringify({ error: { code: err.code, message: err.message, hint: err.hint ?? null, details: err.details ?? null } }, null, 2)}\n`);
        } else {
          process.stderr.write(`✖ ${err.message}\n`);
          if (err.hint) process.stderr.write(`~ hint: ${err.hint}\n`);
        }
        process.exitCode = err.exitCode;
        return;
      }
      const debug = process.env['OPERATOR_DEBUG'] === '1';
      process.stderr.write(`✖ Unexpected error: ${(err as Error).message}\n`);
      if (debug) process.stderr.write(`${(err as Error).stack ?? ''}\n`);
      else process.stderr.write('~ hint: rerun with OPERATOR_DEBUG=1 for a stack trace\n');
      process.exitCode = 1;
    }
  };
}

program
  .command('init')
  .description('Initialize Operator: create the config home and default config, then optionally select a workspace')
  .action(handle(async (rt) => init(rt)));

program
  .command('chat')
  .description('Open the interactive console (provider → key → model → chatbox). This is the default when ktoperator runs with no command.')
  .action(handle(async (rt) => consoleMain(rt)));

program
  .command('doctor')
  .description('Diagnose the environment: runtime, config, providers, workspace, sandbox backends')
  .action(handle(async (rt) => doctor(rt)));

const provider = program.command('provider').description('Manage AI provider profiles');
provider
  .command('list')
  .description('List configured provider profiles (never prints keys)')
  .action(handle(async (rt) => providerList(rt)));
provider
  .command('add')
  .description('Add a provider profile. Types: openrouter, openai, anthropic, google, openai-compatible, ollama')
  .requiredOption('--id <id>', 'profile id')
  .requiredOption('--type <type>', 'provider type')
  .option('--base-url <url>', 'custom API base URL (SSRF-validated)')
  .option('--model <model>', 'default model id')
  .option('--api-key-env <name>', 'environment variable that holds the API key')
  .option('--key <key>', 'API key to store securely (chmod 600). Prefer env vars in shared shells.')
  .option('--referer <url>', 'OpenRouter HTTP-Referer attribution header')
  .option('--title <title>', 'OpenRouter X-Title attribution header')
  .option('--trusted-local', 'trust a loopback/private endpoint (local inference only)')
  .option('--default', 'make this the default provider')
  .option('--skip-test', 'do not test the connection after adding')
  .action(
    handle(async (rt, opts: Record<string, unknown>) => {
      await providerAdd(rt, {
        id: opts['id'] as string,
        type: opts['type'] as string,
        baseUrl: opts['baseUrl'] as string | undefined,
        model: opts['model'] as string | undefined,
        apiKeyEnv: opts['apiKeyEnv'] as string | undefined,
        key: opts['key'] as string | undefined,
        referer: opts['referer'] as string | undefined,
        title: opts['title'] as string | undefined,
        trustedLocal: (opts['trustedLocal'] as boolean | undefined) ?? undefined,
        makeDefault: opts['default'] as boolean | undefined,
        skipTest: opts['skipTest'] as boolean | undefined,
      });
    }),
  );
provider
  .command('test [id]')
  .description('Test connectivity + authentication of a provider profile')
  .action(handle(async (rt, id?: string) => providerTest(rt, id)));
provider
  .command('remove <id>')
  .description('Remove a provider profile and any stored credentials')
  .action(handle(async (rt, id: string) => providerRemove(rt, id)));

const model = program.command('model').description('Model discovery');
model
  .command('list')
  .description('List models for a provider (default: the default provider)')
  .option('--provider <id>', 'provider profile id')
  .action(handle(async (rt, opts: { provider?: string }) => modelList(rt, opts.provider)));

const workspace = program.command('workspace').description('Workspace authorization');
workspace
  .command('select [path]')
  .description('Authorize a directory as the agent workspace (default: current directory / interactive picker)')
  .action(handle(async (rt, path?: string) => workspaceSelect(rt, path)));
workspace
  .command('show')
  .description('Show the currently authorized workspace')
  .action(handle(async (rt) => workspaceShow(rt)));

program
  .command('run <task...>')
  .description('Run a natural-language task end-to-end: the AI plans and acts; the security engine approves or denies each action')
  .option('--provider <id>', 'provider profile id')
  .option('--model <model>', 'model id override')
  .option('--yes [level]', 'auto-approve up to a tier: read | write | all (use with care; audited)')
  .option('--dry-run', 'simulate actions without modifying anything')
  .option('--max-steps <n>', 'iteration cap for this run', (v) => Number(v))
  .action(handle(async (rt, taskWords: string[], opts: Record<string, unknown>) => runTask(rt, requireTask(taskWords.join(' ')), {
    provider: opts['provider'] as string | undefined,
    model: opts['model'] as string | undefined,
    yes: opts['yes'] as string | boolean | undefined,
    dryRun: opts['dryRun'] as boolean | undefined,
    maxSteps: opts['maxSteps'] as number | undefined,
  })));

program
  .command('plan <task...>')
  .description('Produce an execution plan only — nothing is executed or modified')
  .option('--provider <id>', 'provider profile id')
  .option('--model <model>', 'model id override')
  .action(handle(async (rt, taskWords: string[], opts: Record<string, unknown>) => planTask(rt, requireTask(taskWords.join(' ')), {
    provider: opts['provider'] as string | undefined,
    model: opts['model'] as string | undefined,
  })));

const session = program.command('session').description('Session history');
session
  .command('list')
  .description('List recent sessions')
  .option('--limit <n>', 'max sessions', (v) => Number(v), 20)
  .action(handle(async (rt, opts: { limit: number }) => sessionList(rt, opts.limit)));

program
  .command('history [sessionId]')
  .description('Show the audit trail (no id) or a full session transcript (with id)')
  .option('--limit <n>', 'max audit entries', (v) => Number(v), 100)
  .action(handle(async (rt, sessionId: string | undefined, opts: { limit: number }) => history(rt, sessionId, opts.limit)));

const sandbox = program.command('sandbox').description('Execution sandbox');
sandbox
  .command('status')
  .description('Show sandbox backends, their availability, capabilities, and the active selection')
  .action(handle(async (rt) => sandboxStatus(rt)));

const config = program.command('config').description('Configuration');
config
  .command('show')
  .description('Show the effective configuration (secrets redacted)')
  .action(handle(async (rt) => configShow(rt)));
config
  .command('set <key> <value>')
  .description('Set a configuration value (schema-validated; `operator config set --help` for keys)')
  .action(handle(async (rt, key: string, value: string) => configSet(rt, key, value)));
config
  .command('path')
  .description('Print the config file location')
  .action(handle((rt) => {
    configPath(rt);
    return Promise.resolve(0);
  }));

program
  .command('backups [sessionId]')
  .description('List recovery snapshots (all sessions, or one session)')
  .action(handle(async (rt, sessionId?: string) => backupsList(rt, sessionId)));

program
  .command('rollback <sessionId>')
  .description('Restore file changes from a session using its snapshots (contents only; commands are not reversible)')
  .option('--yes [level]', 'confirm without prompting', '')
  .action(handle(async (rt, sessionId: string, opts: { yes?: string | boolean }) => rollback(rt, sessionId, opts.yes !== undefined)));

program.addHelpText(
  'after',
  `
Guiding principle: the AI decides what it wants to do; ktOperator's security engine decides what it is allowed to do.

Typical use:
  ktoperator                          # interactive console: pick provider, enter key, pick model, chat
  ktoperator run "Analyze this project"   # one-shot agent task
  ktoperator doctor                   # environment diagnostics

Security notes:
  - No API key is ever printed, logged, or sent anywhere but its provider endpoint.
  - Command execution requires a sandbox; without one it is refused, never downgraded silently.
  - Destructive changes need explicit approval and are snapshotted for rollback.
`,
);

// Bare invocation (nothing but optional global flags) opens the interactive console.
const globalOnlyFlags = new Set(['--json', '--no-color']);
const argsOnlyGlobals = process.argv.slice(2).every((a) => globalOnlyFlags.has(a));

if (argsOnlyGlobals) {
  program.parseOptions(process.argv);
  await handle(async (rt) => consoleMain(rt))();
} else {
  // Commander throws on unknown commands/options by default; keep that behavior.
  await program.parseAsync(process.argv).catch((err: unknown) => {
    if (err instanceof OperatorError) {
      process.stderr.write(`✖ ${err.message}\n`);
      process.exitCode = err.exitCode;
    } else {
      throw err;
    }
  });
}
