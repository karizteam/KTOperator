import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ToolExecutionError } from '../errors/errors.js';

/**
 * Desktop integration — the one place where Operator touches the user's GUI.
 *
 * Design rules (the same spirit as the command sandbox):
 *   - applications come from a fixed catalog. Arbitrary executables, paths,
 *     flags and shell interpreters are impossible here, not merely discouraged;
 *   - no shell is ever involved: every launch is spawn(argv[0], argv.slice(1))
 *     with detached stdio, so nothing is echoed, captured or re-parsed;
 *   - URLs are validated (http/https, no embedded credentials) before they can
 *     reach a browser;
 *   - a missing application fails with the exact paths that were checked, so
 *     the agent can tell the user what to install instead of guessing.
 */

export type DesktopPlatform = 'win32' | 'darwin' | 'linux';
export type AppKind = 'browser' | 'utility' | 'store';

export interface DesktopEnv {
  platform: DesktopPlatform;
  env: Record<string, string | undefined>;
  /** True when the path exists (file or .app bundle). Injectable for tests. */
  exists: (absPath: string) => boolean;
  /** Resolve a bare command on PATH; null when it is not installed. */
  which?: (command: string) => string | null;
}

export interface AppSpec {
  readonly label: string;
  readonly kind: AppKind;
  /** Absolute executable candidates, highest priority first (%VAR% expanded). */
  readonly paths: Partial<Record<DesktopPlatform, readonly string[]>>;
  /** Bare commands resolved on PATH when no absolute path matched. */
  readonly commands?: Partial<Record<DesktopPlatform, readonly string[]>>;
  /** macOS bundle name for `open -a`. */
  readonly macApp?: string;
  /** Shell-free OS handler for apps that are protocols rather than files. */
  readonly uri?: Partial<Record<DesktopPlatform, (target: string) => string>>;
}

/** Every application the agent may open. Nothing outside this map exists. */
export const DESKTOP_APPS: Record<string, AppSpec> = {
  chrome: {
    label: 'Google Chrome',
    kind: 'browser',
    paths: {
      win32: [
        '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
        '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
        '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
      ],
      darwin: ['/Applications/Google Chrome.app'],
      linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    },
    commands: { linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'] },
    macApp: 'Google Chrome',
  },
  edge: {
    label: 'Microsoft Edge',
    kind: 'browser',
    paths: {
      win32: [
        '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
        '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
      darwin: ['/Applications/Microsoft Edge.app'],
      linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    },
    commands: { linux: ['microsoft-edge', 'microsoft-edge-stable'] },
    macApp: 'Microsoft Edge',
  },
  firefox: {
    label: 'Mozilla Firefox',
    kind: 'browser',
    paths: {
      win32: [
        '%ProgramFiles%\\Mozilla Firefox\\firefox.exe',
        '%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe',
      ],
      darwin: ['/Applications/Firefox.app'],
      linux: ['/usr/bin/firefox'],
    },
    commands: { linux: ['firefox'] },
    macApp: 'Firefox',
  },
  notepad: {
    label: 'Notepad',
    kind: 'utility',
    paths: {
      win32: ['%SystemRoot%\\System32\\notepad.exe', '%WINDIR%\\notepad.exe'],
      darwin: ['/System/Applications/TextEdit.app'],
    },
    macApp: 'TextEdit',
  },
  explorer: {
    label: 'File Explorer',
    kind: 'utility',
    paths: {
      win32: ['%SystemRoot%\\explorer.exe'],
      darwin: ['/System/Library/CoreServices/Finder.app'],
      linux: ['/usr/bin/xdg-open'],
    },
    commands: { linux: ['xdg-open'] },
    macApp: 'Finder',
  },
  calculator: {
    label: 'Calculator',
    kind: 'utility',
    paths: {
      win32: ['%SystemRoot%\\System32\\calc.exe'],
      darwin: ['/System/Applications/Calculator.app'],
      linux: ['/usr/bin/gnome-calculator', '/usr/bin/kcalc'],
    },
    commands: { linux: ['gnome-calculator', 'kcalc', 'galculator'] },
    macApp: 'Calculator',
  },
  paint: {
    label: 'Paint',
    kind: 'utility',
    paths: { win32: ['%SystemRoot%\\System32\\mspaint.exe'] },
  },
  vscode: {
    label: 'Visual Studio Code',
    kind: 'utility',
    paths: {
      win32: [
        '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe',
        '%ProgramFiles%\\Microsoft VS Code\\Code.exe',
      ],
      darwin: ['/Applications/Visual Studio Code.app'],
      linux: ['/usr/bin/code', '/usr/share/code/code'],
    },
    commands: { linux: ['code', 'code-insiders'] },
    macApp: 'Visual Studio Code',
  },
  store: {
    label: 'Microsoft Store',
    kind: 'store',
    paths: {},
    uri: {
      win32: (target) =>
        target === '' ? 'ms-windows-store://home' : `ms-windows-store://search/?query=${encodeURIComponent(target)}`,
    },
  },
};

/** Stable ids offered to the model, in catalog order. */
export const DESKTOP_APP_IDS: string[] = Object.keys(DESKTOP_APPS);

export function currentPlatform(): DesktopPlatform {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function existsPath(candidate: string): boolean {
  try {
    fs.statSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function whichOnPath(command: string, env: Record<string, string | undefined>, exists: (p: string) => boolean): string | null {
  const dirs = (env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  const extensions = env['PATHEXT'] !== undefined ? env['PATHEXT'].split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      for (const name of new Set([command + ext, command + ext.toLowerCase(), command])) {
        if (name === '') continue;
        const candidate = path.join(dir, name);
        if (exists(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** The real machine, as the launcher sees it. */
export function desktopEnv(): DesktopEnv {
  return {
    platform: currentPlatform(),
    env: process.env,
    exists: existsPath,
    which: (command) => whichOnPath(command, process.env, existsPath),
  };
}

function expandVars(template: string, env: Record<string, string | undefined>): string | null {
  let missing = false;
  const expanded = template.replace(/%([^%]+)%/g, (_match, name: string) => {
    const value = env[name];
    if (value === undefined || value === '') {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? null : expanded;
}

export interface ResolvedApp {
  id: string;
  label: string;
  kind: AppKind;
  /** Absolute executable, or null for protocol-only apps. */
  executable: string | null;
  /** macOS `open -a` name when the platform launches bundles that way. */
  macApp: string | null;
  /** Protocol handler for this platform, when the app is a URI. */
  uri: ((target: string) => string) | null;
}

/**
 * Resolve one catalog id for a platform. Throws an actionable error listing
 * what was checked instead of silently launching the wrong thing.
 */
export function resolveDesktopApp(appId: string, deps: DesktopEnv = desktopEnv()): ResolvedApp {
  const spec = DESKTOP_APPS[appId];
  if (!spec) {
    throw new ToolExecutionError('launch_app', `Unknown application "${appId}".`, {
      hint: `Supported applications: ${DESKTOP_APP_IDS.join(', ')}.`,
    });
  }
  const { platform, env, exists } = deps;
  const uri = spec.uri?.[platform] ?? null;
  const checked: string[] = [];
  for (const template of spec.paths[platform] ?? []) {
    const expanded = expandVars(template, env);
    if (expanded === null) continue;
    checked.push(expanded);
    if (exists(expanded)) {
      // A macOS `.app` is a bundle, not an executable: launch it via `open -a`.
      const bundle = platform === 'darwin' && expanded.endsWith('.app');
      const macApp = bundle ? (spec.macApp ?? path.basename(expanded, '.app')) : null;
      return { id: appId, label: spec.label, kind: spec.kind, executable: macApp === null ? expanded : null, macApp, uri };
    }
  }
  for (const command of spec.commands?.[platform] ?? []) {
    const found = deps.which?.(command) ?? null;
    if (found !== null) {
      return { id: appId, label: spec.label, kind: spec.kind, executable: found, macApp: null, uri };
    }
    checked.push(command);
  }
  if (spec.uri !== undefined && uri === null) {
    throw new ToolExecutionError('launch_app', `${spec.label} is only available on Windows.`, {
      hint: 'Ask the user to open it from the system menu instead.',
    });
  }
  if (platform === 'darwin' && spec.macApp !== undefined) {
    // `open -a` finds the bundle itself, so an installed app is enough.
    if (exists(`/Applications/${spec.macApp}.app`) || exists(`/System/Applications/${spec.macApp}.app`)) {
      return { id: appId, label: spec.label, kind: spec.kind, executable: null, macApp: spec.macApp, uri };
    }
  }
  if (uri !== null) {
    return { id: appId, label: spec.label, kind: spec.kind, executable: null, macApp: null, uri };
  }

  const where = checked.length > 0 ? ` Looked at: ${checked.slice(0, 4).join(', ')}.` : '';
  throw new ToolExecutionError('launch_app', `${spec.label} is not installed (or not in a known location).`, {
    hint: `${where} Tell the user to install ${spec.label}, or use open_url for the web.`,
    details: { app: appId, platform },
  });
}

const MAX_URL_LENGTH = 2048;

/**
 * Validate a URL before it is handed to a browser. Unlike the web tools this
 * allows private hosts on purpose — opening the user's own dev server in their
 * own browser is not an SSRF — but it still refuses non-web schemes, embedded
 * credentials, and absurdly long input.
 */
export function validateOpenUrl(tool: string, rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new ToolExecutionError(tool, `Refusing a URL longer than ${MAX_URL_LENGTH} characters.`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ToolExecutionError(tool, `"${trimmed.slice(0, 120)}" is not a valid URL.`, {
      hint: 'Use an absolute http(s) URL, e.g. https://example.com.',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolExecutionError(tool, `Refusing ${url.protocol} URLs — only http and https can be opened.`, {
      hint: 'Browser hand-off is limited to the web; local files are opened with the file tools.',
    });
  }
  if (url.username !== '' || url.password !== '') {
    throw new ToolExecutionError(tool, 'URLs with embedded credentials are not allowed.');
  }
  return url;
}

export interface LaunchOptions {
  /** Absolute http(s) page to open in a browser. */
  url?: string | undefined;
  /** Search text: a browser search, or a Store search page. */
  search?: string | undefined;
}

export interface LaunchPlan {
  app: string;
  label: string;
  kind: AppKind;
  /** Ready-to-spawn argv. Never contains a shell. */
  argv: string[];
  /** One-line explanation for the approval prompt. */
  detail: string;
}

const MAX_SEARCH_LENGTH = 256;

function normalizeSearch(tool: string, raw: string): string {
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text === '') throw new ToolExecutionError(tool, 'Search text is empty.');
  if (text.length > MAX_SEARCH_LENGTH) {
    throw new ToolExecutionError(tool, `Search text is longer than ${MAX_SEARCH_LENGTH} characters.`);
  }
  return text;
}

function winSystemExe(env: Record<string, string | undefined>, fileName: string): string {
  return path.win32.join(env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows', 'System32', fileName);
}

function macOpen(app: string | null, args: string[]): string[] {
  return app === null ? ['open', ...args] : ['open', '-a', app, ...args];
}

/**
 * Build the argv that opens one catalog app. Pure: all machine facts arrive
 * through `deps`, so the plan can be inspected and tested without launching.
 */
export function buildLaunchPlan(appId: string, options: LaunchOptions = {}, deps: DesktopEnv = desktopEnv()): LaunchPlan {
  const resolved = resolveDesktopApp(appId, deps);
  const { platform } = deps;
  const search = options.search !== undefined ? normalizeSearch('launch_app', options.search) : '';
  const url = options.url !== undefined ? validateOpenUrl('launch_app', options.url).toString() : '';
  if (search !== '' && url !== '') {
    throw new ToolExecutionError('launch_app', 'Pass either a url or a search, not both.', {
      hint: 'Choose the exact page or the search query.',
    });
  }

  if (resolved.kind === 'store') {
    if (resolved.uri === null) {
      throw new ToolExecutionError('launch_app', `${resolved.label} is only available on Windows.`, {
        hint: 'Open the app from the system menu, or use open_url for a website.',
      });
    }
    const uri = resolved.uri(search);
    const argv =
      platform === 'darwin'
        ? macOpen(null, [uri])
        : platform === 'linux'
          ? ['xdg-open', uri]
          : [winSystemExe(deps.env, 'explorer.exe'), uri];
    return {
      app: resolved.id,
      label: resolved.label,
      kind: resolved.kind,
      argv,
      detail: search === '' ? `Open ${resolved.label}` : `Open ${resolved.label} and search for "${search}"`,
    };
  }

  if (resolved.kind === 'utility') {
    if (search !== '' || url !== '') {
      throw new ToolExecutionError('launch_app', `${resolved.label} does not accept a URL or search text.`, {
        hint: 'Use a browser id (chrome, edge, firefox) for web content.',
      });
    }
  }

  const target = url !== '' ? url : search !== '' ? `https://www.google.com/search?q=${encodeURIComponent(search)}` : '';
  const argv =
    resolved.macApp !== null
      ? macOpen(resolved.macApp, target === '' ? [] : [target])
      : resolved.executable !== null
        ? [resolved.executable, ...(target === '' ? [] : [target])]
        : null;
  if (argv === null) {
    throw new ToolExecutionError('launch_app', `${resolved.label} could not be located on this machine.`, {
      hint: 'Tell the user to install it, or use the web tools instead.',
    });
  }
  return {
    app: resolved.id,
    label: resolved.label,
    kind: resolved.kind,
    argv,
    detail:
      target === ''
        ? `Open ${resolved.label}`
        : search !== ''
          ? `Open ${resolved.label} and search for "${search}"`
          : `Open ${resolved.label} at ${target}`,
  };
}

/** Open a URL in the default browser, or in one specific browser. */
export function buildOpenUrlPlan(rawUrl: string, browser: string, deps: DesktopEnv = desktopEnv()): LaunchPlan {
  const url = validateOpenUrl('open_url', rawUrl).toString();
  if (browser !== 'default') {
    return buildLaunchPlan(browser, { url }, deps);
  }
  const { platform } = deps;
  const argv =
    platform === 'win32'
      ? [winSystemExe(deps.env, 'rundll32.exe'), 'url.dll,FileProtocolHandler', url]
      : platform === 'darwin'
        ? ['open', url]
        : ['xdg-open', url];
  return {
    app: 'default',
    label: 'default browser',
    kind: 'browser',
    argv,
    detail: `Open ${url} in the default browser`,
  };
}

/** Start a detached GUI process. Resolves once the OS really started it. */
export async function launchDetached(argv: string[]): Promise<void> {
  if (argv.length === 0) throw new ToolExecutionError('launch_app', 'Nothing to launch.');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: false,
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(
        new ToolExecutionError('launch_app', `Could not start ${path.basename(argv[0]!)}: ${err.message}`, {
          hint: 'The application may have been moved or removed. Ask the user to check it.',
        }),
      );
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}
