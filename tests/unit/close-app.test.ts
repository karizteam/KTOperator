import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isProtectedPid,
  killArgv,
  matchHostProcesses,
  normalizeProcessName,
  parseWindowsProcessRows,
  type HostProcess,
} from '../../src/platform/processes.js';
import { TOOL_BASE_TIER } from '../../src/security/policy.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { closeAppTool } from '../../src/tools/processes.js';
import { makeHarness } from '../helpers.js';

const PROCESSES: HostProcess[] = [
  { pid: 10, name: 'opera.exe', command: 'Opera GX' },
  { pid: 11, name: 'opera_crashreporter.exe', command: 'Opera crash handler' },
  { pid: 12, name: 'chrome.exe', command: 'Google Chrome' },
  { pid: 13, name: 'notepad.exe', command: 'Untitled - Notepad' },
];

describe('close_app matching', () => {
  it('matches by name, case-insensitively and ignoring spacing', () => {
    assert.deepEqual(matchHostProcesses(PROCESSES, 'Opera').map((p) => p.pid), [10, 11]);
    assert.deepEqual(matchHostProcesses(PROCESSES, 'OPERA.EXE').map((p) => p.pid), [10, 11]);
    assert.deepEqual(matchHostProcesses(PROCESSES, 'chrome').map((p) => p.pid), [12]);
    assert.deepEqual(matchHostProcesses(PROCESSES, 'operaGX').map((p) => p.pid), [10], 'a glued name still finds the app');
  });

  it('matches a window title when the process name is not the app name', () => {
    assert.deepEqual(matchHostProcesses(PROCESSES, 'untitled').map((p) => p.pid), [13]);
  });

  it('refuses to guess from a too-short query', () => {
    assert.deepEqual(matchHostProcesses(PROCESSES, 'o'), []);
    assert.deepEqual(matchHostProcesses(PROCESSES, 'qqq'), []);
  });

  it('normalizes names for matching', () => {
    assert.equal(normalizeProcessName('Opera GX.exe'), 'operagx');
    assert.equal(normalizeProcessName('my-app_v2'), 'myappv2');
  });

  it('parses the PowerShell listing and tolerates junk', () => {
    assert.deepEqual(parseWindowsProcessRows(JSON.stringify({ Id: 42, ProcessName: 'opera', MainWindowTitle: 'Opera GX' })), [
      { pid: 42, name: 'opera', command: 'Opera GX' },
    ]);
    assert.deepEqual(parseWindowsProcessRows(JSON.stringify([{ Id: 7, ProcessName: 'x' }])), [{ pid: 7, name: 'x', command: 'x' }]);
    assert.deepEqual(parseWindowsProcessRows('not json at all'), []);
    assert.deepEqual(parseWindowsProcessRows(JSON.stringify([{ Id: 'x', ProcessName: 'y' }])), []);
  });
});

describe('close_app safety', () => {
  it('never targets the agent, its parents or the system', () => {
    assert.equal(isProtectedPid(0), true);
    assert.equal(isProtectedPid(1), true);
    assert.equal(isProtectedPid(4), true);
    assert.equal(isProtectedPid(process.pid), true);
    if (typeof process.ppid === 'number' && process.ppid > 0) assert.equal(isProtectedPid(process.ppid), true);
    assert.equal(isProtectedPid(999_999), false);
    assert.equal(isProtectedPid(-1), true);
  });

  it('builds a shell-free taskkill argv', () => {
    assert.deepEqual(killArgv(123, false), ['taskkill', '/pid', '123', '/T']);
    assert.deepEqual(killArgv(123, true), ['taskkill', '/pid', '123', '/T', '/F']);
  });

  it('is registered, destructive, and escalates when forcing', () => {
    assert.ok(ALL_TOOLS.some((t) => t.name === 'close_app'));
    assert.equal(TOOL_BASE_TIER['close_app'], 2);
    assert.equal(closeAppTool.escalateTier?.({ force: true }), 3);
    assert.equal(closeAppTool.escalateTier?.({}), null);
  });

  it('refuses to close Operator itself, even when asked directly', async () => {
    const h = await makeHarness();
    try {
      const result = await h.registry.execute(
        'close_app',
        JSON.stringify({ name: 'node', pid: process.pid }),
        h.toolContext,
      );
      assert.equal(result.ok, false);
      assert.match(String(result.error), /Refusing to close|protected/i);
    } finally {
      await h.cleanup();
    }
  });

  it('returns a clear result when nothing matches, without killing anything', async () => {
    const h = await makeHarness();
    try {
      const described = await closeAppTool.describe!({ name: 'qqqzzqxq' }, {} as never);
      assert.match(described.summary, /nothing matched/i);
      assert.deepEqual(described.targets, []);

      const result = await h.registry.execute('close_app', JSON.stringify({ name: 'qqqzzqxq' }), h.toolContext);
      assert.equal(result.ok, false);
      assert.match(String(result.error), /No running process matches/);
    } finally {
      await h.cleanup();
    }
  });

  it('stops at the approval gate when the user has not approved', async () => {
    const h = await makeHarness({ approvalMode: { kind: 'deny-all' } });
    try {
      const result = await h.registry.execute('close_app', JSON.stringify({ name: 'qqqzzqxq' }), h.toolContext);
      assert.equal(result.ok, false);
      assert.match(result.summary, /denied/i);
    } finally {
      await h.cleanup();
    }
  });
});
