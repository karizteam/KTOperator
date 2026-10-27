import path from 'node:path';
import { ToolExecutionError } from '../errors/errors.js';
import { desktopEnv } from './desktop.js';

/**
 * Shell resolution for the one tool that runs a real command line: turning a
 * natural-language request into an actual `cmd`/`bash`/PowerShell command.
 *
 * Everything else in Operator refuses shells on purpose — the sandbox runs
 * structured argv only, and `execute_approved_command` rejects interpreters.
 * This module exists for the case the user asks for a command line explicitly,
 * so the rules are kept in one place:
 *   - the shell is chosen per platform, never inherited from a string;
 *   - the command travels as ONE argv element to `-c` / `/c` / `-Command`, with
 *     `shell: false`, so Node never re-parses anything;
 *   - the child gets a small environment allowlist (never API keys);
 *   - obvious catastrophes are surfaced as warnings in the approval prompt.
 * Approval itself is not enforced here: the tool is tier 3 and always asks.
 */

export type ShellKind = 'cmd' | 'powershell' | 'bash' | 'sh';

export const SHELL_KINDS: readonly ShellKind[] = ['cmd', 'powershell', 'bash', 'sh'];

export interface ShellEnv {
  platform: 'win32' | 'darwin' | 'linux';
  env: Record<string, string | undefined>;
  exists: (absPath: string) => boolean;
  which?: ((command: string) => string | null) | undefined;
}

/** The real machine, as the launcher sees it (also injectable for tests). */
export function shellEnv(): ShellEnv {
  const base = desktopEnv();
  return {
    platform: base.platform,
    env: base.env,
    exists: base.exists,
    ...(base.which ? { which: base.which } : {}),
  };
}

export interface ResolvedShell {
  kind: ShellKind;
  /** Label shown in the approval prompt, e.g. "cmd.exe". */
  label: string;
  /** Absolute executable (or bare name resolved on PATH). */
  executable: string;
  /** Complete argv; the command string is always the last element. */
  argv: string[];
}

function winSystemExe(env: Record<string, string | undefined>, fileName: string): string {
  return path.win32.join(env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows', 'System32', fileName);
}

function findOnPath(env: ShellEnv, names: readonly string[]): string | null {
  for (const name of names) {
    const found = env.which?.(name) ?? null;
    if (found !== null && env.exists(found)) return found;
  }
  return null;
}

/**
 * Build the argv that runs `command` in the requested shell. `shell: 'auto'`
 * means cmd on Windows and bash (or sh) everywhere else.
 */
export function resolveShell(requested: string, command: string, env: ShellEnv): ResolvedShell {
  const kind = requested === 'auto' || requested === '' ? (env.platform === 'win32' ? 'cmd' : 'bash') : requested;
  switch (kind) {
    case 'cmd': {
      if (env.platform !== 'win32') {
        throw new ToolExecutionError('run_shell_command', 'cmd.exe is only available on Windows.', {
          hint: 'Use shell="bash" or shell="sh" on this platform.',
        });
      }
      const executable = winSystemExe(env.env, 'cmd.exe');
      return { kind, label: 'cmd.exe (Windows command prompt)', executable, argv: [executable, '/d', '/s', '/c', command] };
    }
    case 'powershell': {
      if (env.platform === 'win32') {
        const executable = findOnPath(env, ['powershell.exe', 'pwsh.exe']) ?? winSystemExe(env.env, 'powershell.exe');
        return {
          kind,
          label: 'PowerShell',
          executable,
          argv: [executable, '-NoProfile', '-NonInteractive', '-Command', command],
        };
      }
      const executable = findOnPath(env, ['pwsh', 'powershell']);
      if (executable === null) {
        throw new ToolExecutionError('run_shell_command', 'PowerShell is not installed on this machine.', {
          hint: 'Install PowerShell Core (pwsh), or use shell="bash" or shell="sh".',
        });
      }
      return { kind, label: 'PowerShell Core', executable, argv: [executable, '-NoProfile', '-NonInteractive', '-Command', command] };
    }
    case 'bash': {
      // Git Bash / WSL-style bash exists on Windows too; use it when present.
      const executable = findOnPath(env, ['bash']) ?? (env.platform === 'win32' ? null : '/bin/bash');
      if (executable === null || !env.exists(executable)) {
        if (env.platform === 'win32') {
          throw new ToolExecutionError('run_shell_command', 'bash is not installed on this machine.', {
            hint: 'Use shell="cmd" or shell="powershell"; bash is only available when Git Bash/WSL is installed.',
          });
        }
        return resolveShell('sh', command, env);
      }
      return { kind, label: 'bash', executable, argv: [executable, '-c', command] };
    }
    case 'sh': {
      const executable = findOnPath(env, ['sh']) ?? (env.platform === 'win32' ? null : '/bin/sh');
      if (executable === null || !env.exists(executable)) {
        throw new ToolExecutionError('run_shell_command', 'No POSIX shell (sh) was found on this machine.', {
          hint: 'On Windows use shell="cmd" or shell="powershell".',
        });
      }
      return { kind, label: 'sh (POSIX shell)', executable, argv: [executable, '-c', command] };
    }
    default:
      throw new ToolExecutionError('run_shell_command', `Unknown shell "${requested}".`, {
        hint: `Valid values: auto, ${SHELL_KINDS.join(', ')}.`,
      });
  }
}

/** Environment names a shell genuinely needs to behave like a normal shell. */
const ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'SystemDrive',
  'ComSpec',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'ProgramData',
  'LOCALAPPDATA',
  'APPDATA',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'PSModulePath',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

/** Anything that looks like a credential is never handed to a child process. */
const SECRET_NAME_RE = /(key|token|secret|password|passwd|credential|auth|session|cookie)/i;

/**
 * The child's environment: everything a normal shell needs, minus anything
 * that looks like a secret. A command that needs an API key must be told to
 * read it from the user's own configuration instead of inheriting it.
 */
export function shellEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = env[name];
    if (value !== undefined && value !== '' && !SECRET_NAME_RE.test(name)) out[name] = value;
  }
  return out;
}

interface DangerPattern {
  re: RegExp;
  warning: string;
}

/** Cheap, honest signals shown next to the command — never a silent block. */
const DANGER_PATTERNS: readonly DangerPattern[] = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+(\/|~|\$HOME|\/home|\/Users)/, warning: 'recursive delete of a root or home path' },
  { re: /\b(del|erase)\b(?=[^\n]*\/[a-zA-Z]*[sq])/i, warning: 'deletes files recursively and quietly' },
  { re: /\b(rd|rmdir)\s+\/s|\brm\s+-r/i, warning: 'removes a directory tree' },
  { re: /\b(mkfs|fdisk|diskpart|diskutil\s+erase)/i, warning: 'formats or repartitions a disk' },
  { re: /\bformat\s+[a-z]:/i, warning: 'formats a drive' },
  { re: /\b(shutdown|reboot|halt|poweroff|Restart-Computer|Stop-Computer)\b/i, warning: 'shuts down or restarts the machine' },
  { re: /\breg\s+(delete|add)\b/i, warning: 'changes the Windows registry' },
  { re: /\b(cipher\s+\/w|sdelete)\b/i, warning: 'wipes data so it cannot be recovered' },
  { re: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-zA-Z]*f)/i, warning: 'publishes or discards git history' },
  { re: /\b(curl|wget|irm|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression)/i, warning: 'pipes a download straight into a shell' },
  { re: />\s*\/dev\/(sd|nvme|disk)/i, warning: 'writes directly to a block device' },
  { re: /\b(npm\s+(publish|i\s+-g|install\s+-g)|pip\s+install|choco\s+install|winget\s+install|brew\s+install|apt(-get)?\s+install)/i, warning: 'installs software or publishes a package' },
  { re: /\b(sudo|runas|Start-Process\s+-Verb\s+RunAs)\b/i, warning: 'requests administrator/root privileges' },
  { re: /\b(net\s+user|New-LocalUser|Set-LocalUser|chpasswd)\b/i, warning: 'changes user accounts' },
  { re: /\bchmod\s+(-R\s+)?777|icacls\b.*\/grant/i, warning: 'loosens filesystem permissions' },
  { re: /\b(taskkill|crontab|schtasks|Register-ScheduledTask)\b/i, warning: 'kills processes or changes scheduled tasks' },
  { re: /\bcurl\b[^|]*--data|\bInvoke-RestMethod\b[\s\S]*-Method\s+Post/i, warning: 'sends data to a remote server' },
];

/** Warnings for what this command appears to do, most serious first. */
export function commandWarnings(command: string, limit = 4): string[] {
  const out: string[] = [];
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.re.test(command) && !out.includes(pattern.warning)) out.push(pattern.warning);
    if (out.length >= limit) break;
  }
  if (out.length === 0 && /(\*|\?)/.test(command) && /(del|rm|rmdir|rd|Remove-Item)/i.test(command)) {
    out.push('deletes by wildcard — check the pattern');
  }
  return out;
}

const MAX_COMMAND_LENGTH = 8_000;
const MAX_COMMAND_LINES = 60;

/** Validate the command string before it is offered to the user. */
export function validateShellCommand(raw: string): string {
  const command = raw.replace(/\r\n/g, '\n').trim();
  if (command === '') throw new ToolExecutionError('run_shell_command', 'The command is empty.');
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new ToolExecutionError('run_shell_command', `The command is longer than ${MAX_COMMAND_LENGTH} characters.`, {
      hint: 'Split it into several commands instead of one huge script.',
    });
  }
  if (command.split('\n').length > MAX_COMMAND_LINES) {
    throw new ToolExecutionError('run_shell_command', `The command has more than ${MAX_COMMAND_LINES} lines.`, {
      hint: 'Put a real script in the workspace and run that instead.',
    });
  }
  if (command.includes('\u0000')) throw new ToolExecutionError('run_shell_command', 'The command contains a NUL character.');
  return command;
}
