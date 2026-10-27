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
  /** Recursive listing of a directory tree (depth-capped); for app discovery. */
  walk?: (dir: string, maxDepth: number) => string[];
  /** Read a small text file, or null; for .desktop entries. */
  readText?: (file: string) => string | null;
  /** User home directory, for per-user Applications/.desktop folders. */
  home?: string;
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

/** Depth-capped directory walk. Unreadable folders are skipped, never fatal. */
function walkPaths(dir: string, maxDepth: number, maxEntries = 5_000): string[] {
  const out: string[] = [];
  const visit = (current: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      out.push(full);
      if (entry.isDirectory()) visit(full, depth + 1);
    }
  };
  visit(dir, 0);
  return out;
}

function readTextFile(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
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
    walk: walkPaths,
    readText: readTextFile,
    home: process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
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

/* ------------------------------------------------------------------ */
/* Any installed application, not just the catalog                     */
/* ------------------------------------------------------------------ */

/**
 * The catalog above is a fast path with exact executables. This section is the
 * dynamic fallback that makes "open Opera GX" work on a machine where Opera GX
 * is simply installed: it looks at the Windows Start Menu, the macOS
 * Applications folders, Linux .desktop entries and PATH.
 *
 * The one invariant that never moves: opening a shell or script host is
 * refused, because that would hand the model an unrestricted shell — exactly
 * what the catalog design exists to prevent.
 */

/** How a discovered application is started. */
export type DiscoveredLaunch =
  | { how: 'catalog'; id: string }
  | { how: 'exec'; executable: string; acceptsTarget: boolean }
  | { how: 'windows-shortcut'; path: string }
  | { how: 'mac-bundle'; path: string }
  | { how: 'linux-desktop'; argv: string[]; targetAt: number[] };

export interface DiscoveredApp {
  /** Display name, e.g. "Opera GX". */
  name: string;
  kind: AppKind;
  launch: DiscoveredLaunch;
  /** Where it was found (shortcut path, bundle, .desktop file, command). */
  source: string;
  /** Extra spellings that should match this app (e.g. "vscode"). */
  aliases?: string[];
}

const BLOCKED_EXECUTABLES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'ash', 'busybox',
  'cmd', 'command', 'powershell', 'pwsh', 'wsl', 'cscript', 'wscript', 'mshta', 'conhost', 'wsftp',
]);

/** Start-menu labels that are really shells even though the file is a .lnk. */
const BLOCKED_LABEL_PREFIXES = ['commandprompt', 'powershell', 'pwsh', 'windowsterminal', 'wsl', 'cmdexe'];

const SHORTCUT_SKIP_RE = /(uninstall|remove|repair|read ?me|release ?notes|documentation|manual|help|website|home ?page|support|licen[cs]e|upgrade|update|modify|setup|wizard)/i;

/** Directory-less, extension-less, lowercase form used for matching. */
export function normalizeAppName(value: string): string {
  return value
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|com|bat|cmd|lnk|app|desktop|url)$/, '')
    .replace(/[^a-z0-9\u0600-\u06ff]/g, '');
}

function baseName(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop() ?? value;
}

/** True for a shell, script host or terminal the model must never open. */
export function isBlockedLaunch(value: string): boolean {
  const base = baseName(value).trim().toLowerCase().replace(/\.(exe|com|bat|cmd|lnk|ps1)$/, '');
  if (base === '') return false;
  if (BLOCKED_EXECUTABLES.has(base)) return true;
  const label = normalizeAppName(base);
  return BLOCKED_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix));
}

function walk(deps: DesktopEnv, dir: string, maxDepth: number): string[] {
  if (!deps.walk) return [];
  try {
    return deps.walk(dir, maxDepth);
  } catch {
    return [];
  }
}

function startMenuDirs(deps: DesktopEnv): string[] {
  const programData = deps.env['ProgramData'] ?? deps.env['PROGRAMDATA'] ?? '';
  const appData = deps.env['APPDATA'] ?? '';
  const join = (dir: string, ...rest: string[]): string => (deps.platform === 'win32' ? path.win32.join(dir, ...rest) : path.join(dir, ...rest));
  const dirs: string[] = [];
  if (programData !== '') dirs.push(join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  if (appData !== '') dirs.push(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return dirs;
}

function applicationDirs(deps: DesktopEnv): string[] {
  const home = deps.home ?? '';
  const dirs = ['/Applications', '/System/Applications'];
  if (home !== '') dirs.push(path.join(home, 'Applications'));
  return dirs;
}

export function desktopEntryDirs(deps: DesktopEnv): string[] {
  const home = deps.home ?? '';
  const dirs = ['/usr/share/applications', '/usr/local/share/applications'];
  if (home !== '') dirs.push(path.join(home, '.local/share/applications'));
  return dirs;
}

/** One parsed `[Desktop Entry]` block. */
export interface DesktopEntry {
  name: string;
  exec: string;
  hidden: boolean;
}

/** Pure parser for a .desktop file (first `Name=`/`Exec=` in the main group). */
export function parseDesktopEntry(text: string): DesktopEntry | null {
  let name = '';
  let exec = '';
  let hidden = false;
  let inEntry = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntry || line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'Name' && name === '') name = value;
    else if (key === 'Exec' && exec === '') exec = value;
    else if (key === 'NoDisplay' || key === 'Terminal' || key === 'Hidden') hidden = hidden || value.toLowerCase() === 'true';
  }
  if (name === '' || exec === '') return null;
  return { name, exec, hidden };
}

const TARGET_SENTINEL = '\u0000target\u0000';

/**
 * Split a .desktop `Exec=` line into argv, shell-free, and mark where a URL or
 * search may be substituted (the `%u/%U/%f/%F` field codes). Quoting is
 * honoured so `Exec="/opt/My App/app" %U` stays one argument.
 */
export function parseDesktopExec(exec: string): { argv: string[]; targetAt: number[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of exec) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current !== '') tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '') tokens.push(current);

  const argv: string[] = [];
  const targetAt: number[] = [];
  for (const token of tokens) {
    if (token === '%%') {
      argv.push('%');
      continue;
    }
    if (/^%[a-zA-Z]$/.test(token)) {
      if (/^%[uUfF]$/.test(token)) {
        targetAt.push(argv.length);
        argv.push(TARGET_SENTINEL);
      }
      continue; // %i %c %k and any other code is dropped
    }
    const cleaned = token.replace(/%%/g, '\u0001');
    if (!/%[a-zA-Z]/.test(cleaned)) {
      argv.push(cleaned.replace(/\u0001/g, '%'));
      continue;
    }
    targetAt.push(argv.length);
    argv.push(cleaned.replace(/%(u|U|f|F)/, TARGET_SENTINEL).replace(/%[a-zA-Z]/g, '').replace(/\u0001/g, '%'));
  }
  return { argv, targetAt };
}

function catalogDiscoveredApps(deps: DesktopEnv): DiscoveredApp[] {
  const out: DiscoveredApp[] = [];
  for (const [id, spec] of Object.entries(DESKTOP_APPS)) {
    if (isBlockedLaunch(id)) continue;
    try {
      resolveDesktopApp(id, deps); // only apps that really are on this machine
    } catch {
      continue;
    }
    out.push({ name: spec.label, kind: spec.kind, launch: { how: 'catalog', id }, source: id, aliases: [id, spec.macApp ?? id] });
  }
  return out;
}

function windowsShortcutApps(deps: DesktopEnv): DiscoveredApp[] {
  const out: DiscoveredApp[] = [];
  const seen = new Set<string>();
  for (const dir of startMenuDirs(deps)) {
    for (const entry of walk(deps, dir, 3)) {
      if (!/\.lnk$/i.test(entry)) continue;
      const name = baseName(entry).replace(/\.lnk$/i, '').trim();
      if (name === '' || SHORTCUT_SKIP_RE.test(name)) continue;
      const key = normalizeAppName(name);
      if (key === '' || seen.has(key) || isBlockedLaunch(name)) continue;
      seen.add(key);
      out.push({ name, kind: 'utility', launch: { how: 'windows-shortcut', path: entry }, source: entry });
    }
  }
  return out;
}

function macBundleApps(deps: DesktopEnv): DiscoveredApp[] {
  const out: DiscoveredApp[] = [];
  const seen = new Set<string>();
  for (const dir of applicationDirs(deps)) {
    for (const entry of walk(deps, dir, 1)) {
      if (!/\.app$/i.test(entry)) continue;
      const name = baseName(entry).replace(/\.app$/i, '').trim();
      const key = normalizeAppName(name);
      if (name === '' || key === '' || seen.has(key) || isBlockedLaunch(name)) continue;
      seen.add(key);
      out.push({ name, kind: 'utility', launch: { how: 'mac-bundle', path: entry }, source: entry });
    }
  }
  return out;
}

function linuxDesktopApps(deps: DesktopEnv): DiscoveredApp[] {
  const out: DiscoveredApp[] = [];
  const seen = new Set<string>();
  for (const dir of desktopEntryDirs(deps)) {
    for (const entry of walk(deps, dir, 1)) {
      if (!/\.desktop$/i.test(entry)) continue;
      const text = deps.readText?.(entry) ?? null;
      if (text === null) continue;
      const parsed = parseDesktopEntry(text);
      if (parsed === null || parsed.hidden) continue;
      const { argv, targetAt } = parseDesktopExec(parsed.exec);
      if (argv.length === 0 || isBlockedLaunch(argv[0]!)) continue;
      const key = normalizeAppName(parsed.name);
      if (key === '' || seen.has(key) || isBlockedLaunch(parsed.name)) continue;
      seen.add(key);
      out.push({ name: parsed.name, kind: 'utility', launch: { how: 'linux-desktop', argv, targetAt }, source: entry });
    }
  }
  return out;
}

/** Every application the machine can find for this platform. */
export function discoverApps(deps: DesktopEnv = desktopEnv()): DiscoveredApp[] {
  const platformApps =
    deps.platform === 'win32' ? windowsShortcutApps(deps) : deps.platform === 'darwin' ? macBundleApps(deps) : linuxDesktopApps(deps);
  return [...catalogDiscoveredApps(deps), ...platformApps];
}

function executableFromPath(query: string, deps: DesktopEnv): DiscoveredApp | null {
  const candidates = new Set<string>([query.trim(), query.trim().replace(/\s+/g, '')]);
  for (const candidate of candidates) {
    if (candidate === '' || isBlockedLaunch(candidate)) continue;
    const found = deps.which?.(candidate) ?? null;
    if (found !== null && deps.exists(found)) {
      return { name: candidate, kind: 'utility', launch: { how: 'exec', executable: found, acceptsTarget: true }, source: found };
    }
  }
  return null;
}

function pathApp(value: string, deps: DesktopEnv): DiscoveredApp | null {
  if (!deps.exists(value)) return null;
  const name = baseName(value).replace(/\.(lnk|app|desktop|exe)$/i, '');
  if (/\.lnk$/i.test(value)) return { name, kind: 'utility', launch: { how: 'windows-shortcut', path: value }, source: value };
  if (/\.app$/i.test(value)) return { name, kind: 'utility', launch: { how: 'mac-bundle', path: value }, source: value };
  if (/\.desktop$/i.test(value)) {
    const text = deps.readText?.(value) ?? null;
    const parsed = text === null ? null : parseDesktopEntry(text);
    if (parsed === null) return null;
    const { argv, targetAt } = parseDesktopExec(parsed.exec);
    if (argv.length === 0) return null;
    return { name: parsed.name, kind: 'utility', launch: { how: 'linux-desktop', argv, targetAt }, source: value };
  }
  return { name, kind: 'utility', launch: { how: 'exec', executable: value, acceptsTarget: true }, source: value };
}

/** Match discovered apps by name or alias; best (most exact) first. */
export function matchDiscoveredApps(apps: readonly DiscoveredApp[], query: string): DiscoveredApp[] {
  const needle = normalizeAppName(query);
  if (needle.length < 2) return [];
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9\u0600-\u06ff]+/)
    .map((w) => w.replace(/\.(exe|app|lnk)$/, ''))
    .filter((w) => w.length >= 2);
  const scored: { app: DiscoveredApp; score: number }[] = [];
  for (const app of apps) {
    const keys = [normalizeAppName(app.name), ...(app.aliases ?? []).map(normalizeAppName)].filter((k) => k !== '');
    let score = -1;
    for (const key of keys) {
      if (key === needle) score = score === -1 ? 0 : Math.min(score, 0);
      else if (key.startsWith(needle)) score = score === -1 ? 1 : Math.min(score, 1);
      else if (needle.length >= 3 && key.includes(needle)) score = score === -1 ? 2 : Math.min(score, 2);
      else if (key.length >= 3 && needle.includes(key)) score = score === -1 ? 3 : Math.min(score, 3);
    }
    if (score === -1 && words.length > 0 && words.every((w) => keys.some((k) => k.includes(w)))) score = 4;
    if (score === -1) continue;
    scored.push({ app, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.app.name.length - b.app.name.length || a.app.name.localeCompare(b.app.name))
    .map((s) => s.app);
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /^[a-zA-Z]:/.test(value);
}

/** Installed names worth suggesting when nothing matched the request. */
export function nearMisses(apps: readonly DiscoveredApp[], query: string, limit = 6): string[] {
  const needle = normalizeAppName(query);
  if (needle.length < 2) return [];
  const head = needle.slice(0, 3);
  const found: string[] = [];
  for (const app of apps) {
    const keys = [normalizeAppName(app.name), ...(app.aliases ?? []).map(normalizeAppName)].filter((k) => k.length >= 3);
    if (!keys.some((k) => k.startsWith(head) || k.includes(needle) || needle.startsWith(k.slice(0, 4)))) continue;
    if (found.includes(app.name)) continue;
    found.push(app.name);
    if (found.length >= limit) break;
  }
  return found;
}

export interface InstalledAppLookup {
  app: DiscoveredApp | null;
  /** Names to suggest when no app matched. */
  suggestions: string[];
}

/** Find an installed application by name, alias or explicit path. */
export function findInstalledApp(query: string, deps: DesktopEnv = desktopEnv()): InstalledAppLookup {
  const trimmed = query.trim();
  if (trimmed === '') return { app: null, suggestions: [] };
  if (looksLikePath(trimmed)) {
    const direct = pathApp(trimmed, deps);
    if (direct !== null) return { app: direct, suggestions: [] };
  }
  const installed = discoverApps(deps).filter((app) => !isBlockedLaunch(app.name));
  const fromPath = executableFromPath(trimmed, deps);
  const matches = matchDiscoveredApps(fromPath ? [fromPath, ...installed] : installed, trimmed);
  if (matches.length === 0) return { app: null, suggestions: nearMisses(installed, trimmed) };
  return { app: matches[0]!, suggestions: matches.slice(1, 6).map((a) => a.name) };
}

function desktopArgv(argv: readonly string[], targetAt: readonly number[], target: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (!targetAt.includes(i)) {
      out.push(value);
      continue;
    }
    if (target === '') continue;
    out.push(value.split(TARGET_SENTINEL).join(target));
  }
  return out;
}

function acceptsTarget(launch: DiscoveredLaunch): boolean {
  switch (launch.how) {
    case 'catalog':
      return true;
    case 'exec':
      return launch.acceptsTarget;
    case 'mac-bundle':
      return true;
    case 'linux-desktop':
      return launch.targetAt.length > 0;
    case 'windows-shortcut':
      return false;
  }
}

/** Build the argv that opens a discovered application. Pure, like the catalog. */
export function buildDiscoveredLaunchPlan(app: DiscoveredApp, options: LaunchOptions = {}, deps: DesktopEnv = desktopEnv()): LaunchPlan {
  if (app.launch.how === 'catalog') return buildLaunchPlan(app.launch.id, options, deps);
  const search = options.search !== undefined ? normalizeSearch('launch_app', options.search) : '';
  const url = options.url !== undefined ? validateOpenUrl('launch_app', options.url).toString() : '';
  if (search !== '' && url !== '') {
    throw new ToolExecutionError('launch_app', 'Pass either a url or a search, not both.', { hint: 'Choose the exact page or the search query.' });
  }
  const target = url !== '' ? url : search !== '' ? `https://www.google.com/search?q=${encodeURIComponent(search)}` : '';
  if (target !== '' && !acceptsTarget(app.launch)) {
    throw new ToolExecutionError('launch_app', `${app.name} does not accept a URL or search text.`, {
      hint: 'Use a browser (chrome, edge, firefox) for web content, and open this application on its own.',
    });
  }

  let argv: string[];
  switch (app.launch.how) {
    case 'exec':
      argv = [app.launch.executable, ...(target === '' ? [] : [target])];
      break;
    case 'windows-shortcut':
      argv = [winSystemExe(deps.env, 'explorer.exe'), app.launch.path];
      break;
    case 'mac-bundle':
      argv = macOpen(null, [app.launch.path, ...(target === '' ? [] : [target])]);
      break;
    case 'linux-desktop':
      argv = desktopArgv(app.launch.argv, app.launch.targetAt, target);
      break;
  }
  if (argv.length === 0) throw new ToolExecutionError('launch_app', `Could not build a launch command for ${app.name}.`);
  return {
    app: app.source,
    label: app.name,
    kind: app.kind,
    argv,
    detail:
      target === ''
        ? `Open ${app.name}`
        : search !== ''
          ? `Open ${app.name} and search for "${search}"`
          : `Open ${app.name} at ${target}`,
  };
}

/**
 * Resolve any application the user names: the catalog first, then whatever is
 * installed. Shells, script hosts and terminals are refused before anything is
 * resolved, so opening one is impossible rather than merely discouraged.
 */
export function buildAppLaunchPlan(requested: string, options: LaunchOptions = {}, deps: DesktopEnv = desktopEnv()): LaunchPlan {
  const trimmed = requested.trim();
  if (trimmed === '') throw new ToolExecutionError('launch_app', 'No application was given.');
  if (isBlockedLaunch(trimmed)) {
    throw new ToolExecutionError('launch_app', `Refusing to open a shell, script host or terminal: ${trimmed}.`, {
      hint: 'Operator never hands the model a command shell. Open a normal application, or run a specific command with execute_approved_command.',
    });
  }
  const catalogId = Object.keys(DESKTOP_APPS).find((id) => id === trimmed.toLowerCase());
  if (catalogId !== undefined) return buildLaunchPlan(catalogId, options, deps);

  const { app, suggestions } = findInstalledApp(trimmed, deps);
  if (app === null) {
    throw new ToolExecutionError('launch_app', `No installed application matches "${trimmed}".`, {
      hint: `${suggestions.length > 0 ? `Installed apps with a similar name: ${suggestions.join(', ')}. ` : ''}Use the exact name shown in the Start Menu / Applications folder, or open_url for a website. Operator cannot install software.`,
      details: { requested: trimmed },
    });
  }
  return buildDiscoveredLaunchPlan(app, options, deps);
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
