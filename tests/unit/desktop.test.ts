import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP_APP_IDS,
  buildAppLaunchPlan,
  buildLaunchPlan,
  buildOpenUrlPlan,
  discoverApps,
  findInstalledApp,
  isBlockedLaunch,
  matchDiscoveredApps,
  normalizeAppName,
  parseDesktopEntry,
  parseDesktopExec,
  resolveDesktopApp,
  validateOpenUrl,
  type DesktopEnv,
} from '../../src/platform/desktop.js';
import { TOOL_BASE_TIER } from '../../src/security/policy.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { openUrlTool } from '../../src/tools/desktop.js';
import { makeHarness } from '../helpers.js';

/** Windows env the launcher sees; paths are expanded with the same variables. */
function win(present: string[] = []): DesktopEnv {
  const env = {
    ProgramFiles: 'C:\\PF',
    'ProgramFiles(x86)': 'C:\\PF86',
    LOCALAPPDATA: 'C:\\LA',
    SystemRoot: 'C:\\Windows',
    windir: 'C:\\Windows',
    PATH: 'C:\\tools',
  };
  return { platform: 'win32', env, exists: (p) => present.includes(p), which: (c) => (present.includes(`which:${c}`) ? `which:${c}` : null) };
}

const CHROME_WIN = 'C:\\PF\\Google\\Chrome\\Application\\chrome.exe';
const NOTEPAD_WIN = 'C:\\Windows\\System32\\notepad.exe';
const EXPLORER_WIN = 'C:\\Windows\\System32\\explorer.exe';
const RUNDLL32_WIN = 'C:\\Windows\\System32\\rundll32.exe';

function mac(present: string[] = []): DesktopEnv {
  return { platform: 'darwin', env: { PATH: '/usr/bin' }, exists: (p) => present.includes(p) };
}

function linux(present: string[] = []): DesktopEnv {
  return { platform: 'linux', env: { PATH: '/usr/bin' }, exists: (p) => present.includes(p), which: (c) => (present.includes(`which:${c}`) ? `/usr/bin/${c}` : null) };
}

describe('validateOpenUrl', () => {
  it('accepts absolute http(s) URLs and keeps the query', () => {
    assert.equal(validateOpenUrl('open_url', 'https://example.com/docs?q=1').toString(), 'https://example.com/docs?q=1');
    assert.equal(validateOpenUrl('open_url', 'http://example.com/').toString(), 'http://example.com/');
    // Private hosts are fine: this is the user's own browser, not an SSRF proxy.
    assert.equal(validateOpenUrl('open_url', 'http://localhost:3000/').toString(), 'http://localhost:3000/');
  });

  it('refuses anything that is not a web page', () => {
    for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/System32/cmd.exe', 'data:text/html,<h1>x</h1>', 'ms-settings:privacy']) {
      assert.throws(() => validateOpenUrl('open_url', bad), /only http and https/);
    }
  });

  it('refuses embedded credentials and unparseable input', () => {
    assert.throws(() => validateOpenUrl('open_url', 'https://user:secret@example.com/'), /credentials/);
    assert.throws(() => validateOpenUrl('open_url', 'example.com'), /not a valid URL/);
    assert.throws(() => validateOpenUrl('open_url', `https://example.com/${'a'.repeat(3000)}`), /longer than/);
  });
});

describe('resolveDesktopApp', () => {
  it('only knows the catalog', () => {
    assert.throws(() => resolveDesktopApp('cmd', win()), /Unknown application "cmd"/);
    assert.ok(DESKTOP_APP_IDS.includes('chrome'));
    assert.ok(DESKTOP_APP_IDS.includes('store'));
    // Shell interpreters are absent by construction.
    for (const forbidden of ['cmd', 'powershell', 'bash', 'sh']) assert.ok(!DESKTOP_APP_IDS.includes(forbidden));
  });

  it('resolves an installed browser on Windows', () => {
    const app = resolveDesktopApp('chrome', win([CHROME_WIN]));
    assert.equal(app.executable, CHROME_WIN);
    assert.equal(app.kind, 'browser');
  });

  it('reports exactly what it looked for when the app is missing', () => {
    assert.throws(
      () => resolveDesktopApp('paint', win()),
      (err: Error & { hint?: string }) => err.message.includes('Paint is not installed') && (err.hint ?? '').includes('mspaint.exe'),
    );
  });

  it('treats the Microsoft Store as a Windows-only protocol app', () => {
    const store = resolveDesktopApp('store', win());
    assert.equal(store.uri?.('vscode'), 'ms-windows-store://search/?query=vscode');
    assert.throws(() => resolveDesktopApp('store', linux()), /only available on Windows/);
  });

  it('resolves macOS bundles by name', () => {
    const app = resolveDesktopApp('chrome', mac(['/Applications/Google Chrome.app']));
    assert.equal(app.macApp, 'Google Chrome');
    assert.equal(app.executable, null);
  });
});

describe('buildLaunchPlan', () => {
  it('opens a browser search', () => {
    const plan = buildLaunchPlan('chrome', { search: 'windows 11' }, win([CHROME_WIN]));
    assert.deepEqual(plan.argv, [CHROME_WIN, 'https://www.google.com/search?q=windows%2011']);
    assert.match(plan.detail, /search for "windows 11"/);
  });

  it('opens a specific page', () => {
    const plan = buildLaunchPlan('chrome', { url: 'https://example.com/a' }, win([CHROME_WIN]));
    assert.deepEqual(plan.argv, [CHROME_WIN, 'https://example.com/a']);
  });

  it('opens an app with no target', () => {
    const plan = buildLaunchPlan('notepad', {}, win([NOTEPAD_WIN]));
    assert.deepEqual(plan.argv, [NOTEPAD_WIN]);
  });

  it('opens the Store search page instead of pretending to install', () => {
    const plan = buildLaunchPlan('store', { search: 'spotify' }, win());
    assert.equal(plan.argv[0], EXPLORER_WIN);
    assert.equal(plan.argv[1], 'ms-windows-store://search/?query=spotify');
    assert.match(plan.detail, /Open Microsoft Store and search for "spotify"/);
  });

  it('uses `open -a` on macOS', () => {
    const plan = buildLaunchPlan('chrome', { url: 'https://example.com/' }, mac(['/Applications/Google Chrome.app']));
    assert.deepEqual(plan.argv, ['open', '-a', 'Google Chrome', 'https://example.com/']);
  });

  it('rejects nonsense combinations instead of guessing', () => {
    assert.throws(() => buildLaunchPlan('notepad', { url: 'https://example.com/' }, win([NOTEPAD_WIN])), /does not accept a URL/);
    assert.throws(() => buildLaunchPlan('chrome', { search: '   ' }, win([CHROME_WIN])), /Search text is empty/);
    assert.throws(
      () => buildLaunchPlan('chrome', { url: 'https://a.example/', search: 'b' }, win([CHROME_WIN])),
      /either a url or a search/,
    );
  });
});

describe('buildOpenUrlPlan', () => {
  it('hands the URL to the OS default browser without a shell', () => {
    const plan = buildOpenUrlPlan('https://example.com/', 'default', win());
    assert.deepEqual(plan.argv, [RUNDLL32_WIN, 'url.dll,FileProtocolHandler', 'https://example.com/']);
  });

  it('uses the default browser helper on macOS and Linux', () => {
    assert.deepEqual(buildOpenUrlPlan('https://example.com/', 'default', mac()).argv, ['open', 'https://example.com/']);
    assert.deepEqual(buildOpenUrlPlan('https://example.com/', 'default', linux()).argv, ['xdg-open', 'https://example.com/']);
  });

  it('routes a named browser through the app catalog', () => {
    const plan = buildOpenUrlPlan('https://example.com/', 'chrome', win([CHROME_WIN]));
    assert.deepEqual(plan.argv, [CHROME_WIN, 'https://example.com/']);
  });
});

describe('desktop tool exposure', () => {
  it('is registered and privileged', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    assert.ok(names.includes('launch_app'));
    assert.ok(names.includes('open_url'));
    assert.equal(TOOL_BASE_TIER['launch_app'], 3);
    assert.equal(TOOL_BASE_TIER['open_url'], 3);
  });

  it('describes the action for the approval prompt', async () => {
    const described = await openUrlTool.describe!({ url: 'https://example.com/' }, {} as never);
    assert.match(described.summary, /default browser/);
    assert.deepEqual(described.targets, ['https://example.com/']);
  });

  it('stops at the approval gate when the user has not approved', async () => {
    const h = await makeHarness({ approvalMode: { kind: 'deny-all' } });
    try {
      const result = await h.registry.execute('launch_app', JSON.stringify({ app: 'chrome' }), h.toolContext);
      assert.equal(result.ok, false);
      assert.match(result.summary, /denied/i);
    } finally {
      await h.cleanup();
    }
  });

  it('never opens a shell, script host or terminal, however it is named', async () => {
    const h = await makeHarness();
    try {
      for (const app of ['cmd.exe', 'powershell', 'bash', 'Command Prompt', 'Windows Terminal']) {
        const result = await h.registry.execute('launch_app', JSON.stringify({ app }), h.toolContext);
        assert.equal(result.ok, false, app);
        assert.match(String(result.error), /shell|script host|terminal/i, app);
      }
    } finally {
      await h.cleanup();
    }
  });

  it('refuses a non-web URL before spawning anything', async () => {
    const h = await makeHarness();
    try {
      const result = await h.registry.execute('open_url', JSON.stringify({ url: 'file:///C:/Windows/System32/cmd.exe' }), h.toolContext);
      assert.equal(result.ok, false);
      assert.match(String(result.error), /only http and https/i);
    } finally {
      await h.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Dynamic discovery: any installed application, not just the catalog  */
/* ------------------------------------------------------------------ */

const START_MENU = 'C:\\PD\\Microsoft\\Windows\\Start Menu\\Programs';

/** A Windows machine whose Start Menu holds the given shortcuts. */
function winMachine(shortcuts: string[], installed: string[] = []): DesktopEnv {
  return {
    platform: 'win32',
    env: {
      ProgramData: 'C:\\PD',
      APPDATA: 'C:\\AD',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      PATH: 'C:\\tools',
      ProgramFiles: 'C:\\PF',
      'ProgramFiles(x86)': 'C:\\PF86',
      LOCALAPPDATA: 'C:\\LA',
    },
    exists: (p) => installed.includes(p) || shortcuts.includes(p) || p.startsWith('C:\\bin\\'),
    which: (c) => (installed.includes(`which:${c}`) ? `C:\\bin\\${c}.exe` : null),
    walk: (dir) => (dir === START_MENU ? [START_MENU, ...shortcuts] : []),
  };
}

/** A Linux machine with the given .desktop files. */
function linuxMachine(files: Record<string, string>, present: string[] = []): DesktopEnv {
  return {
    platform: 'linux',
    env: { PATH: '/usr/bin', HOME: '/home/me' },
    home: '/home/me',
    exists: (p) => present.includes(p) || p in files,
    which: (c) => (present.includes(`which:${c}`) ? `/usr/bin/${c}` : null),
    walk: (dir) => Object.keys(files).filter((f) => f.startsWith(`${dir}/`)),
    readText: (f) => files[f] ?? null,
  };
}

describe('installed application discovery', () => {
  it('opens an app that is not in the catalog, matched by its Start Menu name', () => {
    const plan = buildAppLaunchPlan('operaGX', {}, winMachine([`${START_MENU}\\Opera GX.lnk`]));
    assert.deepEqual(plan.argv, [EXPLORER_WIN, `${START_MENU}\\Opera GX.lnk`]);
    assert.equal(plan.detail, 'Open Opera GX');
  });

  it('finds an app installed on PATH when there is no shortcut', () => {
    const plan = buildAppLaunchPlan('opera', {}, winMachine([], ['which:opera']));
    assert.deepEqual(plan.argv, ['C:\\bin\\opera.exe']);
  });

  it('never offers uninstallers, readme shortcuts or shells', () => {
    const env = winMachine([
      `${START_MENU}\\Uninstall Opera.lnk`,
      `${START_MENU}\\Opera Help.lnk`,
      `${START_MENU}\\Command Prompt.lnk`,
      `${START_MENU}\\Windows Terminal.lnk`,
    ]);
    assert.equal(findInstalledApp('uninstall opera', env).app, null);
    assert.throws(() => buildAppLaunchPlan('Command Prompt', {}, env), /Refusing to open a shell/);
    assert.throws(() => buildAppLaunchPlan('Windows Terminal', {}, env), /Refusing to open a shell/);
    assert.ok(!discoverApps(env).some((a) => /prompt|terminal/i.test(a.name)));
  });

  it('suggests similar installed apps when nothing matches', () => {
    const env = winMachine([`${START_MENU}\\Opera GX.lnk`]);
    assert.throws(
      () => buildAppLaunchPlan('operashot', {}, env),
      (err: Error & { hint?: string }) => /No installed application matches/.test(err.message) && (err.hint ?? '').includes('Opera GX'),
    );
  });

  it('lists catalog apps only when they are really installed', () => {
    const names = discoverApps(winMachine([], [CHROME_WIN])).map((a) => a.name);
    assert.ok(names.includes('Google Chrome'));
    assert.ok(!names.includes('Visual Studio Code'));
  });

  it('opens a macOS bundle by name and accepts a search', () => {
    const env: DesktopEnv = {
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      home: '/Users/me',
      exists: (p) => p === '/Applications/Opera GX.app',
      walk: (dir) => (dir === '/Applications' ? ['/Applications/Opera GX.app'] : []),
    };
    const plan = buildAppLaunchPlan('opera gx', { search: 'kt operator' }, env);
    assert.deepEqual(plan.argv, ['open', '/Applications/Opera GX.app', 'https://www.google.com/search?q=kt%20operator']);
  });

  it('launches a Linux desktop entry and substitutes the URL field code', () => {
    const env = linuxMachine({
      '/usr/share/applications/opera.desktop': '[Desktop Entry]\nName=Opera GX\nExec=opera --url=%U\nTerminal=false\n',
    });
    const plan = buildAppLaunchPlan('Opera GX', { url: 'https://example.com/' }, env);
    assert.deepEqual(plan.argv, ['opera', '--url=https://example.com/']);
  });

  it('skips hidden, terminal-only and shell desktop entries', () => {
    const env = linuxMachine({
      '/usr/share/applications/hidden.desktop': '[Desktop Entry]\nName=Hidden App\nExec=x\nNoDisplay=true\n',
      '/usr/share/applications/terminal.desktop': '[Desktop Entry]\nName=Terminal App\nExec=t\nTerminal=true\n',
      '/usr/share/applications/shell.desktop': '[Desktop Entry]\nName=Shell App\nExec=bash -c "x"\n',
    });
    assert.equal(findInstalledApp('Hidden App', env).app, null);
    assert.equal(findInstalledApp('Terminal App', env).app, null);
    assert.equal(findInstalledApp('Shell App', env).app, null);
  });
});

describe('discovery helpers', () => {
  it('normalizes names and paths for matching', () => {
    assert.equal(normalizeAppName('Opera GX.exe'), 'operagx');
    assert.equal(normalizeAppName('C:\\PF\\Foo\\bar.exe'), 'bar');
    assert.equal(normalizeAppName('/Applications/My App.app'), 'myapp');
  });

  it('blocks shells and script hosts, and nothing else', () => {
    for (const blocked of ['bash', 'cmd.exe', 'powershell.exe', 'C:\\Windows\\System32\\wscript.exe', 'Windows Terminal']) {
      assert.equal(isBlockedLaunch(blocked), true, blocked);
    }
    for (const allowed of ['opera', 'chrome.exe', 'notepad', 'C:\\PF\\Opera\\opera.exe']) {
      assert.equal(isBlockedLaunch(allowed), false, allowed);
    }
  });

  it('prefers an exact match over a prefix or a substring', () => {
    const apps = [
      { name: 'Opera', kind: 'utility' as const, launch: { how: 'exec' as const, executable: 'a', acceptsTarget: true }, source: 'a' },
      { name: 'Opera GX', kind: 'utility' as const, launch: { how: 'exec' as const, executable: 'b', acceptsTarget: true }, source: 'b' },
    ];
    assert.equal(matchDiscoveredApps(apps, 'Opera')[0]!.name, 'Opera');
    assert.equal(matchDiscoveredApps(apps, 'opera gx')[0]!.name, 'Opera GX');
    assert.equal(matchDiscoveredApps(apps, 'zz')[0], undefined, 'a two-letter query matches nothing');
  });

  it('parses desktop entries and Exec lines without a shell', () => {
    const entry = parseDesktopEntry('[Desktop Entry]\nName=My App\nExec="/opt/My App/app" %u %i\n');
    assert.equal(entry?.name, 'My App');
    const { argv, targetAt } = parseDesktopExec(entry!.exec);
    assert.deepEqual(targetAt, [1]);
    assert.deepEqual(argv, ['/opt/My App/app', '\u0000target\u0000']);
    assert.equal(parseDesktopEntry('[Desktop Entry]\nName=No Exec\n')?.exec, undefined);
  });
});
