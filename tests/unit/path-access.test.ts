import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathAccess, canonicalGrantRoot, covers, normalizeGrantInput } from '../../src/security/access.js';
import { TOOL_BASE_TIER } from '../../src/security/policy.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { makeHarness } from '../helpers.js';

async function tempDir(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

describe('path grants', () => {
  it('canonicalizes a folder the user approved', async () => {
    const dir = await tempDir('op-grant-');
    try {
      assert.equal(await canonicalGrantRoot(dir), dir);
      // A drive or filesystem root is a legitimate thing to inspect.
      assert.equal(await canonicalGrantRoot(path.parse(dir).root), path.parse(dir).root);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses paths that do not exist or are not directories', async () => {
    const dir = await tempDir('op-grant-');
    try {
      await assert.rejects(canonicalGrantRoot(path.join(dir, 'nope')), /does not exist/);
      const file = path.join(dir, 'file.txt');
      await fs.writeFile(file, 'x');
      await assert.rejects(canonicalGrantRoot(file), /Not a directory/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('covers a path and its descendants, but not its parent', () => {
    const root = path.resolve(os.tmpdir(), 'op-root');
    assert.equal(covers(root, root), true);
    assert.equal(covers(root, path.join(root, 'a', 'b')), true);
    assert.equal(covers(root, path.dirname(root)), false);
    assert.equal(covers(path.join(root, 'a'), path.join(root, 'ab')), false, 'a shared prefix is not containment');
  });

  it('keeps the most specific grant and revokes by path', () => {
    const base = path.resolve(os.tmpdir(), 'op-access');
    const nested = path.join(base, 'project');
    const access = new PathAccess();

    access.add(base, 'whole drive');
    access.add(nested, 'one project');
    assert.equal(access.covering(path.join(nested, 'src', 'x.ts'))?.root, nested);
    assert.equal(access.covering(path.join(base, 'other.txt'))?.root, base);
    assert.equal(access.covering(path.resolve(os.tmpdir(), 'op-elsewhere')), null);

    assert.equal(access.revoke(nested), 1, 'revoking a folder removes only grants inside it');
    assert.equal(access.list().length, 1);
    assert.equal(access.revoke(null), 1, 'revoking everything clears the list');
    assert.equal(access.list().length, 0);
  });

  it('resolves paths through realpath and stays inside the grant', async () => {
    const dir = await tempDir('op-grant-');
    try {
      await fs.mkdir(path.join(dir, 'sub'));
      await fs.writeFile(path.join(dir, 'sub', 'notes.md'), 'hello\n');
      const access = new PathAccess();
      access.add(dir, 'test');

      const entry = await access.resolve(path.join(dir, 'sub', 'notes.md'));
      assert.equal(entry.kind, 'file');
      assert.equal(entry.root, dir);
      assert.ok(entry.relativePath.toLowerCase().endsWith('sub/notes.md'));

      await assert.rejects(access.resolve(path.dirname(dir)), (err: Error & { hint?: string }) => /No access to/.test(err.message) && /request_path_access/.test(err.hint ?? ''));
      await assert.rejects(access.resolve(path.join(dir, 'missing.txt')), /does not exist/);
      const missing = await access.resolve(path.join(dir, 'missing.txt'), { allowMissing: true });
      assert.equal(missing.kind, 'missing');
      await assert.rejects(access.resolve('relative/path'), /absolute/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('write grants', () => {
  it('turns a bare drive letter into that drive root', () => {
    assert.equal(normalizeGrantInput('d'), 'D:\\');
    assert.equal(normalizeGrantInput('c:'), 'C:\\');
    assert.equal(normalizeGrantInput('C:/'), 'C:\\');
    assert.equal(normalizeGrantInput('D:\\'), 'D:\\');
    assert.equal(normalizeGrantInput('/etc'), '/etc');
    assert.equal(normalizeGrantInput('  "D:/"  '), 'D:\\');
  });

  it('upgrades an existing grant instead of duplicating it, and never downgrades', () => {
    const access = new PathAccess();
    const readOnly = access.add(path.resolve(os.tmpdir(), 'op-up'), 'look');
    assert.equal(readOnly.writable, false);
    assert.equal(access.writableCovering(path.join(readOnly.root, 'a.txt')), null);

    const upgraded = access.add(readOnly.root, 'fix', { writable: true });
    assert.equal(upgraded.writable, true);
    assert.equal(access.list().length, 1, 'the same root is one grant');
    assert.equal(access.writableCovering(path.join(readOnly.root, 'a.txt'))?.root, readOnly.root);

    assert.equal(access.add(readOnly.root).writable, true, 'a later read-only request must not downgrade the grant');
  });

  it('writes outside the workspace only where the user approved write access', async () => {
    const h = await makeHarness();
    const readOnlyDir = await tempDir('op-ro-');
    const writableDir = await tempDir('op-rw-');
    try {
      // 1. A read-only grant still refuses writes, and says how to get access.
      const readGrant = await h.registry.execute('request_path_access', JSON.stringify({ path: readOnlyDir }), h.toolContext);
      assert.equal(readGrant.ok, true, readGrant.error);
      const refused = await h.registry.execute(
        'create_file',
        JSON.stringify({ path: path.join(readOnlyDir, 'n.txt'), content: 'x' }),
        h.toolContext,
      );
      assert.equal(refused.ok, false);
      assert.match(String(refused.error), /READ-ONLY/);
      assert.match(String(refused.error), /write=true/);
      await assert.rejects(fs.access(path.join(readOnlyDir, 'n.txt')), 'nothing may be written under a read-only grant');

      // 2. A write grant enables create/edit/delete there.
      const writeGrant = await h.registry.execute(
        'request_path_access',
        JSON.stringify({ path: writableDir, write: true, reason: 'user asked to fix these files' }),
        h.toolContext,
      );
      assert.equal(writeGrant.ok, true, writeGrant.error);
      assert.equal(h.access.covering(writableDir)?.writable, true);

      const target = path.join(writableDir, 'notes.md');
      const created = await h.registry.execute('create_file', JSON.stringify({ path: target, content: 'hello\n' }), h.toolContext);
      assert.equal(created.ok, true, created.error);
      assert.equal(await fs.readFile(target, 'utf8'), 'hello\n');

      const edited = await h.registry.execute(
        'edit_file',
        JSON.stringify({ path: target, edits: [{ find: 'hello', replace: 'bye' }] }),
        h.toolContext,
      );
      assert.equal(edited.ok, true, edited.error);
      assert.equal(await fs.readFile(target, 'utf8'), 'bye\n');

      // The approval preview reads the folder through the grant, not the workspace.
      const preview = await h.registry.get('create_file')!.describe!({ path: target, content: 'bye\n' }, h.toolContext);
      assert.match(String(preview.preview), /no change|identical/i);

      const deleted = await h.registry.execute('delete_file', JSON.stringify({ path: target }), h.toolContext);
      assert.equal(deleted.ok, true, deleted.error);
      await assert.rejects(fs.access(target));

      // 3. The workspace keeps working, and a path with no grant is still refused.
      const inside = await h.registry.execute('create_file', JSON.stringify({ path: 'inside.txt', content: 'x' }), h.toolContext);
      assert.equal(inside.ok, true, inside.error);
      const stranger = await h.registry.execute(
        'create_file',
        JSON.stringify({ path: path.join(h.tmp, 'stranger.txt'), content: 'x' }),
        h.toolContext,
      );
      assert.equal(stranger.ok, false);
      assert.match(String(stranger.error), /outside the workspace/);
    } finally {
      await h.cleanup();
      await fs.rm(readOnlyDir, { recursive: true, force: true });
      await fs.rm(writableDir, { recursive: true, force: true });
    }
  });

  it('never grants write access without approval', async () => {
    const h = await makeHarness({ approvalMode: { kind: 'deny-all' } });
    const outside = await tempDir('op-rw-');
    try {
      const result = await h.registry.execute(
        'request_path_access',
        JSON.stringify({ path: outside, write: true }),
        h.toolContext,
      );
      assert.equal(result.ok, false);
      assert.match(result.summary, /denied/i);
      assert.equal(h.access.list().length, 0);
      assert.equal(await h.registry.execute('create_file', JSON.stringify({ path: path.join(outside, 'x.txt'), content: 'x' }), h.toolContext).then((r) => r.ok), false);
    } finally {
      await h.cleanup();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('request_path_access tool', () => {
  it('is registered as a privileged tool', () => {
    assert.ok(ALL_TOOLS.some((t) => t.name === 'request_path_access'));
    assert.equal(TOOL_BASE_TIER['request_path_access'], 3);
  });

  it('turns "I do not have access" into approved, working reads', async () => {
    const h = await makeHarness({ workspaceFiles: { 'inside.txt': 'inside\n' } });
    const outside = await tempDir('op-outside-');
    try {
      await fs.writeFile(path.join(outside, 'notes.md'), 'outside content\n');

      // 1. Nothing is granted yet: the error tells the model exactly what to do.
      const before = await h.registry.execute('list_directory', JSON.stringify({ path: outside }), h.toolContext);
      assert.equal(before.ok, false);
      assert.match(String(before.error), /request_path_access/);

      // 2. Ask for access (the harness auto-approves up to tier 3).
      const granted = await h.registry.execute('request_path_access', JSON.stringify({ path: outside, reason: 'user asked to check it' }), h.toolContext);
      assert.equal(granted.ok, true, granted.error);
      assert.equal(h.access.list().length, 1);

      // 3. The same tools now work there.
      const listed = await h.registry.execute('list_directory', JSON.stringify({ path: outside }), h.toolContext);
      assert.equal(listed.ok, true, listed.error);
      assert.match(listed.summary, /notes\.md|1 entries/);

      const read = await h.registry.execute('read_file', JSON.stringify({ path: path.join(outside, 'notes.md') }), h.toolContext);
      assert.equal(read.ok, true, read.error);
      assert.match(String(read.data), /outside content/);

      const meta = await h.registry.execute('inspect_file_metadata', JSON.stringify({ path: path.join(outside, 'notes.md') }), h.toolContext);
      assert.equal(meta.ok, true, meta.error);

      // 4. The workspace still works exactly as before.
      const inside = await h.registry.execute('read_file', JSON.stringify({ path: 'inside.txt' }), h.toolContext);
      assert.equal(inside.ok, true, inside.error);

      // 5. Grants stay read-only.
      const write = await h.registry.execute('create_file', JSON.stringify({ path: path.join(outside, 'new.txt'), content: 'x' }), h.toolContext);
      assert.equal(write.ok, false);
      assert.match(String(write.error), /outside the workspace|read-only/i);
      await assert.rejects(fs.access(path.join(outside, 'new.txt')), 'nothing may be written outside the workspace');
    } finally {
      await h.cleanup();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('needs no grant for a folder already inside the workspace', async () => {
    const h = await makeHarness();
    try {
      const result = await h.registry.execute('request_path_access', JSON.stringify({ path: h.workspaceDir }), h.toolContext);
      assert.equal(result.ok, true, result.error);
      assert.equal(h.access.list().length, 0, 'an existing workspace covers its own folders');
    } finally {
      await h.cleanup();
    }
  });

  it('is blocked when the user has not approved it', async () => {
    const h = await makeHarness({ approvalMode: { kind: 'deny-all' } });
    try {
      const outside = await tempDir('op-outside-');
      const result = await h.registry.execute('request_path_access', JSON.stringify({ path: outside }), h.toolContext);
      assert.equal(result.ok, false);
      assert.match(result.summary, /denied/i);
      assert.equal(h.access.list().length, 0);
      await fs.rm(outside, { recursive: true, force: true });
    } finally {
      await h.cleanup();
    }
  });

  it('explains a missing path instead of granting it', async () => {
    const h = await makeHarness();
    try {
      const result = await h.registry.execute('request_path_access', JSON.stringify({ path: path.join(h.tmp, 'does-not-exist') }), h.toolContext);
      assert.equal(result.ok, false);
      assert.match(String(result.error), /does not exist/);
      assert.equal(h.access.list().length, 0);
    } finally {
      await h.cleanup();
    }
  });
});
