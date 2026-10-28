import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ManagedProcessRunner } from '../../src/core/execution/managed-process.js';
import { TOOL_BASE_TIER } from '../../src/security/policy.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { makeHarness } from '../helpers.js';

/**
 * Background jobs are the half of command execution that must NOT wait:
 * a dev server, a watcher, a long build. The contract under test is
 * "start returns an id now, every line is handed out exactly once, and the
 * whole tree can always be stopped".
 */

const node = process.execPath;

async function waitUntil(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

function startNode(runner: ManagedProcessRunner, script: string, maxProcesses = 4): string {
  const started = runner.startBackground({
    argv: [node, '-e', script],
    cwd: process.cwd(),
    env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' },
    maxOutputBytes: 64 * 1024,
    maxProcesses,
    label: 'test job',
  });
  return started.id;
}

describe('ManagedProcessRunner background jobs', () => {
  it('returns immediately and hands out only the lines that are new', async () => {
    const runner = new ManagedProcessRunner();
    const id = startNode(runner, 'console.log("first"); setTimeout(() => console.log("second"), 120);');

    // Nothing to assert about speed beyond "it returned": the child has not
    // printed yet when startBackground resolves.
    await waitUntil(() => (runner.readBackground(id, { reset: true })?.stdout ?? '').includes('first'));
    const opening = runner.readBackground(id, { reset: true });
    assert.match(opening?.stdout ?? '', /first/);
    assert.equal(opening?.running, true);

    // A second read must not repeat the first line.
    const next = runner.readBackground(id);
    assert.ok(!(next?.stdout ?? '').includes('first'), `repeated output: ${next?.stdout ?? ''}`);

    await waitUntil(() => (runner.readBackground(id, { reset: true })?.stdout ?? '').includes('second'));
    assert.match(runner.readBackground(id, { reset: true })?.stdout ?? '', /second/);
  });

  it('reports the exit code once the job ends', async () => {
    const runner = new ManagedProcessRunner();
    const id = startNode(runner, 'console.error("missing config"); process.exit(2);');
    await waitUntil(() => runner.readBackground(id)?.running === false);

    const final = runner.readBackground(id, { reset: true });
    assert.equal(final?.exitCode, 2);
    assert.equal(final?.running, false);
    assert.match(final?.stderr ?? '', /missing config/);
  });

  it('stops the whole job and refuses more than the configured limit', async () => {
    const runner = new ManagedProcessRunner();
    const id = startNode(runner, 'setInterval(() => {}, 1000);', 1);
    await waitUntil(() => runner.readBackground(id)?.running === true);

    assert.throws(
      () => startNode(runner, 'setInterval(() => {}, 1000);', 1),
      /Already running 1 background process/,
      'the concurrency cap must be enforced',
    );

    assert.equal(await runner.terminate(id), true);
    await waitUntil(() => runner.readBackground(id)?.running === false);
    assert.equal(runner.stopAllBackground(), 0, 'nothing left to stop');
  });

  it('keeps a job listed and inspectable while it runs', async () => {
    const runner = new ManagedProcessRunner();
    const id = startNode(runner, 'setInterval(() => {}, 1000);');
    const info = runner.list().find((entry) => entry.id === id);
    assert.equal(info?.label, 'test job');
    assert.equal(info?.running, true);
    runner.stopAllBackground();
    await waitUntil(() => runner.inspect(id) !== undefined);
  });
});

describe('background tools', () => {
  it('are registered with honest tiers', () => {
    const names = ALL_TOOLS.map((tool) => tool.name);
    assert.ok(names.includes('start_background_process'));
    assert.ok(names.includes('read_process_output'));
    assert.equal(TOOL_BASE_TIER['start_background_process'], 3, 'it starts a real command');
    assert.equal(TOOL_BASE_TIER['read_process_output'], 0, 'reading captured output is free');
  });

  it('describes the job as running outside the sandbox', async () => {
    const h = await makeHarness();
    try {
      const tool = ALL_TOOLS.find((t) => t.name === 'start_background_process')!;
      const described = await tool.describe!({ command: 'npm run dev', label: 'dev server' }, h.toolContext);
      assert.match(described.summary, /dev server/);
      assert.match(String(described.preview), /keeps running/);
      assert.match(String(described.preview), /outside the sandbox/);
    } finally {
      await h.cleanup();
    }
  });

  it('starts, reads and stops a real server through the tool layer', async () => {
    const h = await makeHarness();
    try {
      const script = path.join(h.workspaceDir, 'server.js');
      await fs.writeFile(script, 'console.log("listening on 4321");\nsetInterval(() => {}, 1000);\n', 'utf8');
      const command = `"${node}" "${script}"`;

      const started = await h.registry.execute('start_background_process', JSON.stringify({ command, label: 'dev server' }), h.toolContext);
      assert.equal(started.ok, true, started.error);
      const job = JSON.parse(String(started.data)) as { id: string; label: string };
      assert.equal(job.label, 'dev server');
      assert.ok(job.id.length > 8);

      const read = async (extra: Record<string, unknown> = {}): Promise<{ ok: boolean; summary: string; data: string; error?: string }> =>
        (await h.registry.execute('read_process_output', JSON.stringify({ id: job.id, ...extra }), h.toolContext)) as unknown as {
          ok: boolean;
          summary: string;
          data: string;
          error?: string;
        };

      const deadline = Date.now() + 10_000;
      let output = '';
      while (Date.now() < deadline) {
        const snapshot = await read({ reset: true });
        const data = JSON.parse(String(snapshot.data)) as { stdout: string; running: boolean };
        output = data.stdout;
        if (output.includes('listening')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.match(output, /listening on 4321/);

      const stopped = await h.registry.execute('terminate_managed_process', JSON.stringify({ id: job.id }), h.toolContext);
      assert.equal(stopped.ok, true, stopped.error);
      await waitUntil(() => {
        const runner = h.sandbox.runner;
        return runner.readBackground(job.id)?.running === false;
      });
    } finally {
      h.sandbox.runner.stopAllBackground();
      await h.cleanup();
    }
  });

  it('reports a crashed job as a failure with its stderr', async () => {
    const h = await makeHarness();
    try {
      const script = path.join(h.workspaceDir, 'crash.js');
      await fs.writeFile(script, 'console.error("port already in use");\nprocess.exit(1);\n', 'utf8');
      const started = await h.registry.execute(
        'start_background_process',
        JSON.stringify({ command: `"${node}" "${script}"`, label: 'crashy' }),
        h.toolContext,
      );
      const job = JSON.parse(String(started.data)) as { id: string };
      await waitUntil(() => h.sandbox.runner.readBackground(job.id)?.running === false);

      const read = await h.registry.execute('read_process_output', JSON.stringify({ id: job.id, reset: true }), h.toolContext);
      assert.equal(read.ok, false);
      assert.match(String(read.error), /port already in use|exited with code 1/);
    } finally {
      h.sandbox.runner.stopAllBackground();
      await h.cleanup();
    }
  });

  it('answers an unknown id with a usable message instead of throwing', async () => {
    const h = await makeHarness();
    try {
      const read = await h.registry.execute('read_process_output', JSON.stringify({ id: 'nope' }), h.toolContext);
      assert.equal(read.ok, false);
      assert.match(String(read.error), /No background process/);
    } finally {
      await h.cleanup();
    }
  });
});
