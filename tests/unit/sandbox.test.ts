import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../../src/config/schema.js';
import { SandboxError } from '../../src/errors/errors.js';
import { ManagedProcessRunner } from '../../src/core/execution/managed-process.js';
import { DockerBackend } from '../../src/sandbox/docker.js';
import { SandboxManager } from '../../src/sandbox/manager.js';
import { makeHarness } from '../helpers.js';
import os from 'node:os';

function spec(overrides?: Partial<Parameters<SandboxManager['execute']>[0]>) {
  return {
    argv: ['node', '--version'],
    workspaceRoot: os.tmpdir(),
    writable: false,
    network: false,
    env: {},
    limits: { timeoutMs: 10_000, maxOutputBytes: 4096, memoryMb: 128, cpus: 1, pidsLimit: 32 },
    ...overrides,
  };
}

describe('sandbox manager selection', () => {
  it('fails CLOSED with actionable diagnostics when no backend is available', async () => {
    const config = defaultConfig(); // fallback OFF, docker backend forced absent-ish on this host
    config.sandbox.backend = 'docker';
    config.sandbox.image = 'operator-test-image-that-does-not-exist:never';
    const manager = new SandboxManager(config);
    await manager.prepare();
    await assert.rejects(
      () => manager.execute(spec()),
      (err: unknown) => {
        assert.ok(err instanceof SandboxError);
        assert.match(err.message + (err.hint ?? ''), /Docker|fallback|refused/i);
        return true;
      },
    );
  });

  it('selects the restricted backend ONLY when explicitly enabled', async () => {
    const config = defaultConfig();
    config.sandbox.backend = 'restricted';
    const off = new SandboxManager(config);
    await off.prepare();
    assert.equal(off.isReady(), false, 'must not select the fallback without opt-in');

    config.security.allowRestrictedProcessFallback = true;
    const on = new SandboxManager(config);
    const status = await on.prepare();
    assert.equal(status.id, 'restricted-process');
    assert.equal(on.isReady(), true);
  });

  it('executes inside the restricted backend with isolation properties', async () => {
    const config = defaultConfig();
    config.sandbox.backend = 'restricted';
    config.security.allowRestrictedProcessFallback = true;
    const manager = new SandboxManager(config);
    const r = await manager.execute(spec({ argv: ['node', '-e', 'console.log(process.env.HOME ?? process.env.USERPROFILE)'] }));
    assert.equal(r.exitCode, 0);
    const home = r.stdout.trim();
    assert.ok(home.includes('sandbox-tmp'), `HOME must be isolated, got: ${home}`);
  });

  it('refuses to run shell interpreters', async () => {
    const config = defaultConfig();
    config.sandbox.backend = 'restricted';
    config.security.allowRestrictedProcessFallback = true;
    const manager = new SandboxManager(config);
    await assert.rejects(() => manager.execute(spec({ argv: ['sh', '-c', 'echo hi'] })), /shell interpreter/);
  });

  it('rejects workdirs that escape the workspace', async () => {
    const config = defaultConfig();
    config.sandbox.backend = 'restricted';
    config.security.allowRestrictedProcessFallback = true;
    const manager = new SandboxManager(config);
    await assert.rejects(() => manager.execute(spec({ workdir: '../../..' })), /escapes/);
  });
});

describe('docker backend argv construction', () => {
  it('builds a hardened, network-off, read-only container invocation', () => {
    const config = defaultConfig();
    const backend = new DockerBackend(config, new ManagedProcessRunner());
    const args = backend.buildArgs({
      argv: ['cat', '/work/x.txt'],
      workspaceRoot: '/home/user/project',
      writable: false,
      network: false,
      env: { FOO: 'bar' },
      limits: { timeoutMs: 5000, maxOutputBytes: 1000, memoryMb: 256, cpus: 0.5, pidsLimit: 64 },
    }, 'testrun');
    const joined = args.join(' ');
    assert.ok(joined.includes('--name operator-testrun'));
    assert.ok(args.includes('--read-only'));
    assert.ok(joined.includes('--network none'));
    assert.ok(joined.includes('--cap-drop ALL'));
    assert.ok(joined.includes('--security-opt no-new-privileges'));
    assert.ok(joined.includes('--user 65534:65534'));
    assert.ok(joined.includes('--memory 256m'));
    assert.ok(joined.includes('--pids-limit 64'));
    assert.ok(joined.includes('type=bind,source=/home/user/project,target=/work,ro'));
    assert.ok(!joined.includes('docker.sock'), 'never expose the runtime socket');
    assert.ok(joined.endsWith('cat /work/x.txt'));
  });

  it('refuses specs that try to touch the docker socket', async () => {
    const config = defaultConfig();
    const backend = new DockerBackend(config, new ManagedProcessRunner());
    await assert.rejects(
      () => backend.run(spec({ argv: ['sh', '-c', 'x', '/var/run/docker.sock'] })),
      /socket/,
    );
  });
});

describe('development-tool sandbox integration', () => {
  it('run_tests resolves npm scripts and reports outcomes through the sandbox', async () => {
    const h = await makeHarness({
      restrictedFallback: true,
      workspaceFiles: {
        'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "console.log(123)"' } }),
      },
    });
    try {
      const r = await h.registry.execute('run_tests', '{}', h.toolContext);
      assert.equal(r.ok, true, r.error);
      const data = JSON.parse(r.data as string) as { exitCode: number; argv: string[]; stdoutTail: string };
      // argv is what was actually executed: the absolute npm on POSIX, or
      // `<node> <npm-cli.js>` on Windows, where a .cmd cannot run without a shell.
      assert.deepEqual(data.argv.slice(-2), ['run', 'test'], `argv: ${data.argv.join(' ')}`);
      assert.ok(
        data.argv.some((a) => /(^|[/\\])npm(\.cmd)?$/i.test(a) || /npm-cli\.js$/i.test(a)),
        `expected an npm entry point, got: ${data.argv.join(' ')}`,
      );
      assert.ok(!/(^|[/\\])(cmd|sh|bash|powershell|pwsh)(\.exe)?$/i.test(data.argv[0] ?? ''), 'must not run through a shell');
      assert.equal(data.exitCode, 0);
      assert.match(data.stdoutTail, /123/);
    } finally {
      await h.cleanup();
    }
  });

  it('run_tests reports failures with exit codes (not fake success)', async () => {
    const h = await makeHarness({
      restrictedFallback: true,
      workspaceFiles: {
        'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "process.exit(1)"' } }),
      },
    });
    try {
      const r = await h.registry.execute('run_tests', '{}', h.toolContext);
      assert.equal(r.ok, false, 'a failing test suite must not be reported as success');
    } finally {
      await h.cleanup();
    }
  });

  it('run_build explains clearly when no script exists', async () => {
    const h = await makeHarness({
      workspaceFiles: { 'package.json': JSON.stringify({ name: 'fixture', scripts: {} }) },
    });
    try {
      const r = await h.registry.execute('run_build', '{}', h.toolContext);
      assert.equal(r.ok, false);
      assert.match(`${r.summary} ${r.error ?? ''}`, /No npm script/);
    } finally {
      await h.cleanup();
    }
  });
});
