import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Runtime } from '../../src/commands/runtime.js';
import { workspaceSelect } from '../../src/commands/workspace.js';
import { createToolRegistry } from '../../src/tools/index.js';

/**
 * Regression: the console resolves (and caches) the workspace boundary while
 * onboarding, before the user has authorized a directory. A cached "null"
 * boundary used to survive the grant, so every filesystem tool answered
 * "No workspace is selected" and the agent claimed it could not read folders.
 */
describe('workspace grant reaches the agent tools', () => {
  let home: string;
  let workspace: string;
  let previousHome: string | undefined;

  before(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'op-runtime-home-'));
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'op-runtime-ws-'));
    await fs.writeFile(path.join(workspace, 'notes.txt'), 'content from the workspace\n');
    await fs.mkdir(path.join(workspace, 'src'));
    await fs.writeFile(path.join(workspace, 'src', 'index.ts'), 'export const x = 1;\n');
    previousHome = process.env['OPERATOR_HOME'];
    process.env['OPERATOR_HOME'] = home;
  });

  after(async () => {
    if (previousHome === undefined) delete process.env['OPERATOR_HOME'];
    else process.env['OPERATOR_HOME'] = previousHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('invalidates the cached empty boundary when a workspace is authorized later', async () => {
    const rt = await Runtime.create({ json: false, noColor: true });

    // Same order as the console: resolve first (no workspace yet), select after.
    assert.equal(await rt.workspaceBoundary(), null);
    await workspaceSelect(rt, workspace);

    const boundary = await rt.requireWorkspace();
    assert.equal(boundary.root, await fs.realpath(workspace));
  });

  it('lets the agent list and read folders/files inside the workspace', async () => {
    const rt = await Runtime.create({ json: false, noColor: true });
    const boundary = await rt.requireWorkspace();
    const registry = createToolRegistry();
    const context = {
      config: rt.config,
      workspace: boundary,
      access: rt.access,
      approval: rt.makeApproval({ yes: 'read' }),
      audit: rt.makeAudit('workspace-test'),
      backups: rt.backups,
      sandbox: rt.makeSandbox(),
      sessionId: 'workspace-test',
      dryRun: false,
    };

    const root = await registry.execute('list_directory', '{"path":"."}', context);
    assert.equal(root.ok, true, root.error);
    assert.match(root.summary, /entries in \./);

    const nested = await registry.execute('list_directory', '{"path":"src"}', context);
    assert.equal(nested.ok, true, nested.error);
    assert.match(nested.summary, /entries in src/);

    const read = await registry.execute('read_file', '{"path":"notes.txt"}', context);
    assert.equal(read.ok, true, read.error);
    assert.match(read.summary, /Read \d+ line\(s\) from notes\.txt/);
  });

  it('gives Ctrl+C to the console instead of killing the whole run', async () => {
    const rt = await Runtime.create({ json: false, noColor: true });
    let presses = 0;
    const release = rt.setInterruptHandler(() => {
      presses += 1;
    });

    rt.handleInterrupt();
    assert.equal(presses, 1, 'the console sees the key press');
    assert.equal(rt.signal.aborted, false, 'one Ctrl+C during a task must not poison the session');

    release();
    rt.handleInterrupt();
    assert.equal(rt.signal.aborted, true, 'without an owner (one-shot run) Ctrl+C cancels the run');

    rt.resetInterrupt();
    assert.equal(rt.signal.aborted, false, 'the next interactive phase starts with a fresh signal');
  });
});
