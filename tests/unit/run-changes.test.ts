import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectRunChanges, renderChangesBox, type RunChange } from '../../src/core/agent/changes.js';
import type { AgentStep } from '../../src/core/agent/loop.js';
import { Ui } from '../../src/cli/ui.js';
import { makeHarness } from '../helpers.js';

const ANSI = /\x1b\[[0-9;]*m/g;

interface CallInput {
  name: string;
  summary: string;
  args?: Record<string, unknown>;
  ok?: boolean;
}

function step(calls: CallInput[]): AgentStep {
  return {
    iteration: 1,
    assistantText: '',
    toolCalls: calls.map((c) => ({ name: c.name, ok: c.ok ?? true, summary: c.summary, args: c.args ?? {} })),
  };
}

/** Capture everything a Ui writes to stdout, restoring the real stream after. */
function capture(run: () => void): string {
  const chunks: string[] = [];
  const stream = process.stdout as unknown as { write: (chunk: string) => boolean };
  const original = stream.write.bind(process.stdout);
  stream.write = (chunk: string) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    run();
  } finally {
    stream.write = original;
  }
  return chunks.join('');
}

function renderBox(changes: RunChange[]): string {
  return capture(() => renderChangesBox(new Ui({ forceNonInteractive: true, noColor: true }), changes));
}

describe('collectRunChanges', () => {
  it('reports created files and the folder that was created with them', () => {
    const changes = collectRunChanges([
      step([
        {
          name: 'create_file',
          summary: 'Created notes/today/todo.md (12 bytes), verified after write. [new folder: notes/today]',
          args: { path: 'notes/today/todo.md', content: 'hello world!' },
        },
      ]),
    ]);
    assert.deepEqual(
      changes.map((c) => `${c.kind}:${c.action}:${c.target}`),
      ['folder:created:notes/today', 'file:created:notes/today/todo.md'],
    );
  });

  it('separates created, overwritten, edited, moved and deleted files', () => {
    const changes = collectRunChanges([
      step([
        { name: 'create_file', summary: 'Created a.ts (1 byte), verified after write.', args: { path: 'a.ts', content: 'x' } },
        { name: 'create_file', summary: 'Overwrote a.ts (2 bytes), verified after write.', args: { path: 'a.ts', content: 'xy' } },
        { name: 'edit_file', summary: 'Applied 2 edit(s) to b.ts and verified the result.', args: { path: 'b.ts' } },
        { name: 'move_file', summary: 'Moved old.ts → new.ts.', args: { source: 'old.ts', destination: 'new.ts' } },
        { name: 'delete_file', summary: 'Deleted tmp.ts (snapshot kept for rollback).', args: { path: 'tmp.ts' } },
      ]),
    ]);
    const rows = changes.map((c) => `${c.action} ${c.target}`);
    // a.ts was created and then overwritten — one row, strongest action wins.
    assert.deepEqual(rows, ['created a.ts', 'modified b.ts', 'moved old.ts → new.ts', 'deleted tmp.ts']);
  });

  it('ignores failed, denied, dry-run and no-op calls', () => {
    const changes = collectRunChanges([
      step([
        { name: 'create_file', summary: 'Action denied (create_file)', ok: false, args: { path: 'x.ts' } },
        { name: 'create_file', summary: '[dry-run] would create y.ts (1 bytes).', args: { path: 'y.ts' } },
        { name: 'edit_file', summary: 'Edits produced no change in z.ts; nothing written.', args: { path: 'z.ts' } },
        { name: 'delete_file', summary: 'Not a regular file: w.ts', ok: false, args: { path: 'w.ts' } },
      ]),
    ]);
    assert.deepEqual(changes, []);
  });

  it('collapses repeated touches of the same target and keeps the strongest action', () => {
    const changes = collectRunChanges([
      step([
        { name: 'edit_file', summary: 'Applied 1 edit(s) to a.ts and verified the result.', args: { path: 'a.ts' } },
        { name: 'edit_file', summary: 'Applied 3 edit(s) to a.ts and verified the result.', args: { path: 'a.ts' } },
        { name: 'delete_file', summary: 'Deleted a.ts (snapshot kept for rollback).', args: { path: 'a.ts' } },
      ]),
    ]);
    assert.equal(changes.length, 1, 'one file, one row');
    assert.equal(changes[0]!.action, 'deleted');
    assert.equal(changes[0]!.count, 3);
  });

  it('describes desktop launches, links and commands', () => {
    const changes = collectRunChanges([
      step([
        {
          name: 'launch_app',
          summary: 'Open Chrome and search for "cats". It is opening on the user\'s desktop now.',
          args: { app: 'chrome', search: 'cats' },
        },
        { name: 'open_url', summary: 'Open https://example.com in edge', args: { url: 'https://example.com', browser: 'edge' } },
        {
          name: 'execute_approved_command',
          summary: 'Command exited 0 in 1.2s. Process id: p1.',
          args: { argv: ['ls', '-la'] },
        },
        { name: 'run_tests', summary: 'Run the test suite finished: exit 1 in 2.1s.' },
        { name: 'run_build', summary: 'Run the build finished: exit 0 in 4.0s.' },
      ]),
    ]);
    const rows = changes.map((c) => `${c.kind} ${c.action} ${c.target} ${c.detail ?? ''}`.trim());
    assert.deepEqual(rows, [
      'app opened chrome search: "cats"',
      'url opened https://example.com edge',
      'command ran ls -la exit 0',
      'command ran test suite exit 1',
      'command ran build exit 0',
    ]);
  });

  it('counts repeated identical app launches instead of repeating the row', () => {
    const call = { name: 'launch_app', summary: 'Opened calculator.', args: { app: 'calculator' } };
    const changes = collectRunChanges([step([call]), step([call])]);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.count, 2);
  });

  it('reports a shell command the run executed', () => {
    const changes = collectRunChanges([
      step([
        {
          name: 'run_shell_command',
          summary: 'Command exit 0 in 0.1s (cmd). Process id: p1.',
          args: { command: 'ipconfig /all' },
        },
        { name: 'run_shell_command', summary: 'Action denied (run_shell_command)', ok: false, args: { command: 'format C:' } },
      ]),
    ]);
    assert.deepEqual(
      changes.map((c) => `${c.kind} ${c.action} ${c.target} ${c.detail ?? ''}`.trim()),
      ['command ran ipconfig /all exit 0'],
    );
  });

  it('reports an application the run closed', () => {
    const changes = collectRunChanges([
      step([{ name: 'close_app', summary: 'Closed Opera GX (pid 4211).', args: { name: 'Opera GX', pid: 4211 } }]),
    ]);
    assert.deepEqual(
      changes.map((c) => `${c.kind} ${c.action} ${c.target} ${c.detail ?? ''}`.trim()),
      ['app closed Opera GX pid 4211'],
    );
  });

  it('ignores a close that was denied or failed', () => {
    const changes = collectRunChanges([
      step([
        { name: 'close_app', summary: 'Action denied (close_app)', ok: false, args: { name: 'chrome' } },
        { name: 'close_app', summary: 'Nothing matched "qqq"', ok: false, args: { name: 'qqq' } },
      ]),
    ]);
    assert.deepEqual(changes, []);
  });
});

describe('changes box', () => {
  it('draws one titled box grouped by kind', () => {
    const out = renderBox(
      collectRunChanges([
        step([
          {
            name: 'create_file',
            summary: 'Created src/app.ts (5 bytes), verified after write. [new folder: src]',
            args: { path: 'src/app.ts' },
          },
          { name: 'launch_app', summary: 'Opened.', args: { app: 'chrome', search: 'weather' } },
        ]),
      ]),
    ).replace(ANSI, '');
    assert.match(out, /╭─ changes /, 'a single titled box');
    assert.match(out, /● folders · 1/);
    assert.match(out, /\+ created {3}src +│/m);
    assert.match(out, /● files · 1/);
    assert.match(out, /\+ created {3}src\/app\.ts/m);
    assert.match(out, /● apps · 1/);
    assert.match(out, /↗ opened {4}chrome · search: "weather"/m);
    assert.match(out, /╰─╯|╰─+╯/, 'the box is closed');
  });

  it('stays silent when the run changed nothing', () => {
    const out = renderBox([]);
    assert.equal(out, '');
  });
});

describe('create_file new-folder marker', () => {
  it('marks the folder a create just brought into existence', async () => {
    const h = await makeHarness();
    try {
      const created = await h.registry.execute(
        'create_file',
        JSON.stringify({ path: 'brand/new/dir/file.txt', content: 'hello' }),
        h.toolContext,
      );
      assert.equal(created.ok, true, created.summary);
      assert.match(created.summary, /\[new folder: brand\/new\/dir\]/);

      const existing = await h.registry.execute(
        'create_file',
        JSON.stringify({ path: 'top.txt', content: 'hello' }),
        h.toolContext,
      );
      assert.equal(existing.ok, true, existing.summary);
      assert.ok(!existing.summary.includes('[new folder:'), 'the workspace root already exists');
    } finally {
      await h.cleanup();
    }
  });
});