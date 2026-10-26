import os from 'node:os';
import path from 'node:path';

export type Platform = 'linux' | 'darwin' | 'win32' | 'other';

export function platform(): Platform {
  switch (process.platform) {
    case 'linux':
    case 'darwin':
    case 'win32':
      return process.platform;
    default:
      return 'other';
  }
}

export const isWindows = process.platform === 'win32';
export const isMacOS = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/**
 * Root of all Operator state (config, credentials, sessions, audit, backups).
 * OPERATOR_HOME is honored first (also used by tests to get hermetic state);
 * otherwise we follow each platform's conventional per-user location.
 */
export function configHome(): string {
  const override = process.env['OPERATOR_HOME'];
  if (override && override.trim().length > 0) return path.resolve(override);
  switch (platform()) {
    case 'win32': {
      const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'KarizTeam', 'Operator');
    }
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'KarizTeam', 'Operator');
    default: {
      const xdg = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
      return path.join(xdg, 'operator');
    }
  }
}

export function configFilePath(): string {
  return path.join(configHome(), 'config.json');
}
export function credentialsFilePath(): string {
  return path.join(configHome(), 'credentials.json');
}
export function sessionsDir(): string {
  return path.join(configHome(), 'sessions');
}
export function auditDir(): string {
  return path.join(configHome(), 'audit');
}
export function backupsDir(): string {
  return path.join(configHome(), 'backups');
}
export function sandboxTempRoot(): string {
  return path.join(configHome(), 'sandbox-tmp');
}

const WINDOWS_FORBIDDEN_ROOT_RE = /^[A-Za-z]:[\\/]?$/;

/** True if `p` is a filesystem root ("/", "C:\" ...). Never a valid workspace. */
export function isFilesystemRoot(p: string): boolean {
  const resolved = path.resolve(p);
  const parsed = path.parse(resolved);
  if (parsed.root === resolved) return true;
  return isWindows && WINDOWS_FORBIDDEN_ROOT_RE.test(resolved);
}

/** Compare two paths for equality on case-insensitive platforms. */
export function pathsEqual(a: string, b: string): boolean {
  return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
}
