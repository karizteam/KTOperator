import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedProcessRunner, isShellExecutable, resolveExecutable, resolveWindowsScriptInvocation } from '../../src/core/execution/managed-process.js';
import { SandboxError } from '../../src/errors/errors.js';

const isWindows = process.platform === 'win32';
const PATH = process.env['PATH'] ?? '';

function echoSpec(args: string[], extra?: Partial<Parameters<ManagedProcessRunner['run']>[0]>) {
  return {
    argv: [process.execPath, '-e', `console.log(${JSON.stringify(args.join(' '))})`],
    cwd: os.tmpdir(),
    env: { PATH },
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    ...extra,
  };
}

describe('managed process runner', () => {
  it('runs structured argv without any shell', async () => {
    const runner = new ManagedProcessRunner();
    const r = await runner.run(echoSpec(['hello world; $(whoami) `id`']));
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /hello world; \$\(whoami\) `id`/, 'shell metacharacters must remain inert data');
  });

  it('enforces timeouts and kills the process', async () => {
    const runner = new ManagedProcessRunner();
    const r = await runner.run({
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
      cwd: os.tmpdir(),
      env: { PATH },
      timeoutMs: 300,
      maxOutputBytes: 1024,
    });
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
  });

  it('caps output and reports truncation', async () => {
    const runner = new ManagedProcessRunner();
    const r = await runner.run({
      argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(1_000_000))'],
      cwd: os.tmpdir(),
      env: { PATH },
      timeoutMs: 15_000,
      maxOutputBytes: 4096,
    });
    assert.equal(r.outputTruncated, true);
    assert.ok(r.stdout.length <= 4096);
  });

  it('kills the process tree on abort (child processes included)', async () => {
    const runner = new ManagedProcessRunner();
    const controller = new AbortController();
    // Spawn a node parent that spawns its own long-lived child.
    const script = isWindows
      ? `require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},9e5)']);setTimeout(()=>{},9e5)`
      : `require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},9e5)'],{detached:false});setTimeout(()=>{},9e5)`;
    const promise = runner.run({
      argv: [process.execPath, '-e', script],
      cwd: os.tmpdir(),
      env: { PATH },
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const r = await promise;
    assert.equal(r.aborted, true);
    assert.equal(r.exitCode, null, 'a killed process never chose its exit code');
    assert.ok(Date.now() - started < 10_000, 'abort must kill promptly, not wait for the 30s timeout');
  });

  it('settles after an abort even when the process ignores SIGTERM', async () => {
    const runner = new ManagedProcessRunner();
    const controller = new AbortController();
    const promise = runner.run({
      argv: [process.execPath, '-e', "process.on('SIGTERM',()=>{});setTimeout(()=>{},9e5)"],
      cwd: os.tmpdir(),
      env: { PATH },
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    const r = await promise;
    assert.equal(r.aborted, true);
    assert.ok(Date.now() - started < 9_000, 'the SIGKILL escalation plus watchdog must settle the call');
  });

  it('records history for inspect_command_result and supports terminate', async () => {
    const runner = new ManagedProcessRunner();
    const done = runner.run(echoSpec(['recorded']));
    const r = await done;
    const inspected = runner.inspect(r.id);
    assert.ok(inspected && 'exitCode' in inspected && inspected.exitCode === 0);

    const running = runner.run({
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'],
      cwd: os.tmpdir(),
      env: { PATH },
      timeoutMs: 60_000,
      maxOutputBytes: 1024,
    });
    await new Promise((res) => setTimeout(res, 200));
    const live = runner.list();
    assert.equal(live.length, 1);
    assert.equal(await runner.terminate(live[0]!.id), true);
    await running;
    assert.equal(runner.list().length, 0);
    assert.equal(await runner.terminate('no-such-id'), false);
  });

  it('never runs when the executable does not exist', async () => {
    const runner = new ManagedProcessRunner();
    const r = await runner.run(echoSpec(['x'], { argv: ['definitely-not-a-real-binary-xyz'] }));
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /spawn error/);
  });
});

describe('executable resolution & shell detection', () => {
  it('resolves real executables from PATH', async () => {
    const node = await resolveExecutable(isWindows ? 'node' : 'node', PATH);
    assert.ok(node.length > 0);
  });

  it('refuses unknown executables', async () => {
    await assert.rejects(() => resolveExecutable('not-real-xyz-123', PATH), SandboxError);
  });

  it('flags shell interpreter names', () => {
    for (const sh of ['sh', 'bash', '/bin/bash', 'cmd.exe', 'powershell', 'pwsh']) {
      assert.equal(isShellExecutable(sh), true, sh);
    }
    assert.equal(isShellExecutable('node'), false);
    assert.equal(isShellExecutable('git'), false);
  });
});

describe('windows script shims (.cmd/.bat)', () => {
  it('passes non-batch executables through untouched', async () => {
    assert.deepEqual(await resolveWindowsScriptInvocation(process.execPath), [process.execPath]);
  });

  it('rewrites npm.cmd to a shell-free node invocation', async (t) => {
    if (!isWindows) return t.skip('Windows-only');
    const npmCmd = await resolveExecutable('npm', PATH);
    const argv = await resolveWindowsScriptInvocation(npmCmd);
    assert.equal(argv.length, 2, `expected [node, entry.js], got: ${argv.join(' ')}`);
    assert.ok(/node\.exe$/i.test(argv[0]!), `node: ${argv[0]}`);
    assert.ok(/npm-cli\.js$/i.test(argv[1]!), `entry: ${argv[1]}`);
    assert.equal(isShellExecutable(argv[0]!), false);
  });

  it('refuses a batch file with no JavaScript entry point instead of failing with EINVAL', async (t) => {
    if (!isWindows) return t.skip('Windows-only');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shim-'));
    const script = path.join(dir, 'tool.bat');
    await fs.writeFile(script, '@ECHO OFF\r\necho hello\r\n');
    await assert.rejects(() => resolveWindowsScriptInvocation(script), /without a shell/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
