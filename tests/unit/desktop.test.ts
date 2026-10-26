import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP_APP_IDS,
  buildLaunchPlan,
  buildOpenUrlPlan,
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

  it('never launches an app outside the catalog, even if asked directly', async () => {
    const h = await makeHarness();
    try {
      const result = await h.registry.execute('launch_app', JSON.stringify({ app: 'cmd.exe' }), h.toolContext);
      assert.equal(result.ok, false);
      assert.match(String(result.error), /must be one of/);
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
