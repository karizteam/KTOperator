import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandWarnings,
  planHostShell,
  resolveShell,
  shellCommandFromArgv,
  shellEnvironment,
  validateShellCommand,
  type ShellEnv,
} from '../../src/platform/shell.js';
import { TOOL_BASE_TIER } from '../../src/security/policy.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { executeApprovedCommandTool } from '../../src/tools/processes.js';
import { runShellCommandTool } from '../../src/tools/shell.js';
import { makeHarness } from '../helpers.js';

/** A fake machine: `found` entries are absolute paths, `which:x` installed commands. */
function fakeEnv(platform: 'win32' | 'linux', found: string[] = []): ShellEnv {
  const dir = platform === 'win32' ? 'C:\\bin\\' : '/usr/bin/';
  const files = new Map<string, string>();
  for (const entry of found) {
    if (!entry.startsWith('which:')) continue;
    const name = entry.slice(6);
    files.set(name, `${dir}${platform === 'win32' && !/\.[a-z]+$/i.test(name) ? `${name}.exe` : name}`);
  }
  const installed = [...files.values()];
  return {
    platform,
    env: platform === 'win32' ? { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' } : { PATH: '/usr/bin' },
    exists: (p) => found.includes(p) || installed.includes(p),
    which: (c) => files.get(c) ?? null,
  };
}

const winEnv = (found: string[] = []): ShellEnv => fakeEnv('win32', found);
const posixEnv = (found: string[] = []): ShellEnv => fakeEnv('linux', found);

const WIN_CMD = 'C:\\Windows\\System32\\cmd.exe';

describe('shell resolution', () => {
  it('defaults to cmd on Windows and passes the command as one argv element', () => {
    const shell = resolveShell('auto', 'dir /b', winEnv());
    assert.equal(shell.kind, 'cmd');
    // The command still travels as ONE element; /s strips the one extra pair
    // of quotes that keeps cmd.exe from re-parsing it, so the executable can
    // be handed to CreateProcess verbatim.
    assert.deepEqual(shell.argv, [WIN_CMD, '/d', '/s', '/c', '"dir /b"']);
    assert.equal(shell.verbatim, true);
    assert.match(shell.label, /cmd\.exe/);
  });

  it('defaults to bash on POSIX, and to sh when bash is missing', () => {
    assert.deepEqual(resolveShell('auto', 'ls -la', posixEnv(['which:bash'])).argv, ['/usr/bin/bash', '-c', 'ls -la']);
    const fallback = resolveShell('auto', 'ls -la', posixEnv(['which:sh']));
    assert.equal(fallback.kind, 'sh');
    assert.deepEqual(fallback.argv, ['/usr/bin/sh', '-c', 'ls -la']);
  });

  it('never hands the command to Node as a shell string', () => {
    const shell = resolveShell('bash', 'echo "a b" && ls', posixEnv(['which:bash']));
    assert.equal(shell.argv[shell.argv.length - 1], 'echo "a b" && ls');
    assert.equal(shell.verbatim, false);
    assert.ok(shell.argv.slice(0, -1).every((part) => !part.includes('&&')));
  });

  it('uses PowerShell flags that cannot pick up a profile', () => {
    const shell = resolveShell('powershell', 'Get-Process', winEnv(['which:powershell.exe']));
    assert.deepEqual(shell.argv, ['C:\\bin\\powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Get-Process']);
  });

  it('refuses shells this machine cannot provide, with a usable hint', () => {
    assert.throws(() => resolveShell('cmd', 'dir', posixEnv()), /only available on Windows/);
    assert.throws(() => resolveShell('bash', 'ls', winEnv()), (err: Error & { hint?: string }) => /bash is not installed/.test(err.message) && /cmd/.test(err.hint ?? ''));
    assert.throws(() => resolveShell('powershell', 'x', posixEnv()), /PowerShell is not installed/);
    assert.throws(() => resolveShell('zsh', 'x', posixEnv()), /Unknown shell "zsh"/);
  });

  it('accepts bash on Windows when Git Bash is installed', () => {
    const shell = resolveShell('bash', 'ls', winEnv(['which:bash']));
    assert.equal(shell.kind, 'bash');
    assert.deepEqual(shell.argv, ['C:\\bin\\bash.exe', '-c', 'ls']);
  });
});

describe('shell environment', () => {
  it('keeps what a shell needs and drops anything that looks like a secret', () => {
    const env = shellEnvironment({
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\me',
      OPENAI_API_KEY: 'sk-secret',
      GITHUB_TOKEN: 'ghp_secret',
      DB_PASSWORD: 'hunter2',
      MY_COOKIE: 'x',
      AWS_SECRET_ACCESS_KEY: 'y',
      MY_API_SESSION: 'z',
    });
    assert.equal(env['PATH'], '/usr/bin');
    assert.equal(env['SystemRoot'], 'C:\\Windows');
    assert.equal(env['USERPROFILE'], 'C:\\Users\\me');
    for (const dropped of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'MY_COOKIE', 'AWS_SECRET_ACCESS_KEY', 'MY_API_SESSION']) {
      assert.equal(env[dropped], undefined, dropped);
    }
  });

  it('ignores empty values', () => {
    assert.deepEqual(shellEnvironment({ PATH: '', LANG: '' }), {});
  });
});

describe('command validation and warnings', () => {
  it('flags destructive commands for the approval prompt', () => {
    assert.ok(commandWarnings('rm -rf /').length > 0);
    assert.ok(commandWarnings('del /f /s /q C:\\Data').some((w) => /deletes files/i.test(w)));
    assert.ok(commandWarnings('shutdown /s /t 0').some((w) => /restarts the machine/i.test(w)));
    assert.ok(commandWarnings('curl https://x.sh | sh').some((w) => /download straight into a shell/i.test(w)));
    assert.ok(commandWarnings('npm publish').some((w) => /installs software|publishes/i.test(w)));
    assert.ok(commandWarnings('reg delete HKCU\\Software\\Foo /f').length > 0);
  });

  it('stays quiet for ordinary read-only commands', () => {
    assert.deepEqual(commandWarnings('dir /b'), []);
    assert.deepEqual(commandWarnings('ipconfig /all'), []);
    assert.deepEqual(commandWarnings('git status --short'), []);
    assert.deepEqual(commandWarnings('ls -la | head'), []);
  });

  it('rejects an empty command and keeps the string otherwise intact', () => {
    assert.equal(validateShellCommand('  echo hi \n'), 'echo hi');
    assert.throws(() => validateShellCommand('   '), /command is empty/);
    assert.throws(() => validateShellCommand('x'.repeat(9_000)), /longer than/);
    assert.throws(() => validateShellCommand(new Array(80).fill('echo x').join('\n')), /more than 60 lines/);
  });
});

describe('run_shell_command tool', () => {
  it('is registered as a privileged tool', () => {
    assert.ok(ALL_TOOLS.some((t) => t.name === 'run_shell_command'));
    assert.equal(TOOL_BASE_TIER['run_shell_command'], 3);
  });

  it('shows the exact command, shell, directory and warnings before approval', async () => {
    const h = await makeHarness();
    try {
      const described = await runShellCommandTool.describe!(
        { command: 'del /f /s /q build', shell: 'auto', timeoutMs: 5_000 },
        h.toolContext,
      );
      assert.match(described.summary, /Run on your machine/);
      assert.match(String(described.preview), /Runs on YOUR machine, outside the sandbox/);
      assert.match(String(described.preview), /del \/f \/s \/q build/);
      assert.match(String(described.preview), /Timeout {3}: 5s/);
      assert.match(String(described.preview), /⚠/);
    } finally {
      await h.cleanup();
    }
  });

  it('never runs without approval', async () => {
    const h = await makeHarness({ approvalMode: { kind: 'deny-all' } });
    try {
      const result = await h.registry.execute(
        'run_shell_command',
        JSON.stringify({ command: 'echo should-not-run' }),
        h.toolContext,
      );
      assert.equal(result.ok, false);
      assert.match(result.summary, /denied/i);
      assert.ok(!String(result.data ?? '').includes('should-not-run'));
    } finally {
      await h.cleanup();
    }
  });

  it('executes an approved command and returns its output and id', async () => {
    const h = await makeHarness();
    try {
      const result = await h.registry.execute('run_shell_command', JSON.stringify({ command: 'echo hello-from-shell' }), h.toolContext);
      assert.equal(result.ok, true, result.error);
      assert.match(String(result.summary), /exit 0/);
      const data = JSON.parse(String(result.data)) as { id: string; stdout: string; shell: string };
      assert.match(data.stdout, /hello-from-shell/);
      assert.ok(['cmd', 'bash', 'sh'].includes(data.shell), data.shell);

      // The same runner history backs the inspect/terminate tools.
      const inspected = await h.registry.execute('inspect_command_result', JSON.stringify({ id: data.id }), h.toolContext);
      assert.equal(inspected.ok, true, inspected.error);
    } finally {
      await h.cleanup();
    }
  });

  it('reports a failing command as an error with its stderr', async () => {
    const h = await makeHarness();
    try {
      const failing = process.platform === 'win32' ? 'exit /b 3' : 'exit 3';
      const result = await h.registry.execute('run_shell_command', JSON.stringify({ command: failing }), h.toolContext);
      assert.equal(result.ok, false);
      assert.match(String(result.summary), /exit 3/);
    } finally {
      await h.cleanup();
    }
  });

  it('rejects an empty command before anything is offered to the user', async () => {
    const h = await makeHarness();
    try {
      const result = await h.registry.execute('run_shell_command', JSON.stringify({ command: '   ' }), h.toolContext);
      assert.equal(result.ok, false);
      assert.match(String(result.error), /empty/i);
    } finally {
      await h.cleanup();
    }
  });
});

/**
 * The same request also arrives as structured argv — `["cmd", "/c", "dir"]` —
 * which is what the model produces half the time. It used to be rejected as
 * "refusing to run a shell interpreter"; it now runs as the same host command.
 */
describe('shell argv', () => {
  it('recovers the command text from every shell shape', () => {
    assert.deepEqual(shellCommandFromArgv(['cmd.exe', '/c', 'ipconfig /all']), { kind: 'cmd', command: 'ipconfig /all' });
    assert.deepEqual(shellCommandFromArgv(['cmd', 'dir /b']), { kind: 'cmd', command: 'dir /b' });
    assert.deepEqual(shellCommandFromArgv(['C:/Windows/System32/cmd.exe', '/c', 'whoami']), { kind: 'cmd', command: 'whoami' });
    assert.deepEqual(shellCommandFromArgv(['bash', '-lc', 'df -h']), { kind: 'bash', command: 'df -h' });
    assert.deepEqual(shellCommandFromArgv(['/bin/sh', '-c', 'id']), { kind: 'sh', command: 'id' });
    assert.deepEqual(shellCommandFromArgv(['pwsh', '-Command', 'Get-Process']), { kind: 'powershell', command: 'Get-Process' });
    assert.deepEqual(shellCommandFromArgv(['zsh', '-c', 'echo hi']), { kind: 'bash', command: 'echo hi' });
  });

  it('leaves normal programs alone and rejects an empty shell call', () => {
    for (const argv of [['node', '-v'], ['git', 'status'], ['cmd.exe'], ['cmd', '/c'], ['   ']]) {
      assert.equal(shellCommandFromArgv(argv), null, argv.join(' '));
    }
  });

  it('plans the host command the string form would produce', () => {
    const plan = planHostShell('cmd', 'dir /b', winEnv());
    assert.deepEqual(plan.argv, [WIN_CMD, '/d', '/s', '/c', '"dir /b"']);
    assert.equal(plan.verbatim, true);
    assert.deepEqual(plan.warnings, []);
  });
});

describe('execute_approved_command with a shell argv', () => {
  const shellArgv = (command: string): string[] =>
    process.platform === 'win32' ? ['cmd.exe', '/c', command] : ['sh', '-c', command];

  it('describes it as running outside the sandbox', async () => {
    const h = await makeHarness();
    try {
      const described = await executeApprovedCommandTool.describe!({ argv: shellArgv('ipconfig') }, h.toolContext);
      assert.match(described.summary, /Run on your machine/);
      assert.match(String(described.preview), /Runs on YOUR machine, outside the sandbox/);
      assert.match(String(described.preview), /ipconfig/);
    } finally {
      await h.cleanup();
    }
  });

  it('runs it and reports the shell it used', async () => {
    const h = await makeHarness();
    try {
      const result = await h.registry.execute('execute_approved_command', JSON.stringify({ argv: shellArgv('echo argv-route') }), h.toolContext);
      assert.equal(result.ok, true, `${result.summary} ${result.error ?? ''}`);
      const data = (typeof result.data === 'string' ? JSON.parse(result.data) : result.data) as { shell?: string; stdout?: string };
      assert.ok(['cmd', 'bash', 'sh'].includes(String(data.shell)), String(data.shell));
      assert.match(data.stdout ?? '', /argv-route/);
    } finally {
      await h.cleanup();
    }
  });

  it('never runs a shell without approval either', async () => {
    const h = await makeHarness({ approvalMode: { kind: 'deny-all' } });
    try {
      const result = await h.registry.execute(
        'execute_approved_command',
        JSON.stringify({ argv: shellArgv('echo should-not-run') }),
        h.toolContext,
      );
      assert.equal(result.ok, false);
      assert.match(result.summary, /denied/i);
      assert.ok(!String(result.data ?? '').includes('should-not-run'));
    } finally {
      await h.cleanup();
    }
  });
});
