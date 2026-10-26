import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathSecurityError } from '../../src/errors/errors.js';
import { WorkspaceBoundary } from '../../src/security/path-validation.js';

let tmp: string;
let ws: WorkspaceBoundary;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-boundary-'));
  await fs.mkdir(path.join(tmp, 'sub', 'deep'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'file.txt'), 'hello');
  await fs.writeFile(path.join(tmp, 'sub', 'inner.txt'), 'inner');
  ws = await WorkspaceBoundary.create(tmp);
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('WorkspaceBoundary', () => {
  it('resolves normal in-scope paths', async () => {
    const e = await ws.resolveFile('file.txt');
    assert.equal(e.relativePath, 'file.txt');
    const d = await ws.resolve('sub/deep');
    assert.equal(d.kind, 'directory');
  });

  it('resolves absolute paths that point inside the workspace', async () => {
    const e = await ws.resolveFile(path.join(tmp, 'file.txt'));
    assert.equal(e.relativePath, 'file.txt');
  });

  it('rejects .. traversal', async () => {
    await assert.rejects(() => ws.resolve('../outside.txt'), PathSecurityError);
    await assert.rejects(() => ws.resolve('sub/../../outside.txt'), PathSecurityError);
    await assert.rejects(() => ws.resolve('..'), PathSecurityError);
  });

  it('rejects absolute paths outside the workspace', async () => {
    await assert.rejects(() => ws.resolve('/etc/passwd'), PathSecurityError);
    await assert.rejects(() => ws.resolve(os.tmpdir()), PathSecurityError);
  });

  it('rejects symlink escapes', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'op-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');
    const link = path.join(tmp, 'escape-link');
    try {
      await fs.symlink(outside, link, 'dir');
    } catch {
      // Symlinks unavailable (some Windows setups) — skip gracefully.
      return;
    }
    await assert.rejects(() => ws.resolve('escape-link/secret.txt'), PathSecurityError);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('rejects symlinked FILES pointing outside even for reads', async () => {
    const outsideFile = path.join(os.tmpdir(), `op-outside-file-${process.pid}`);
    await fs.writeFile(outsideFile, 'nope');
    const link = path.join(tmp, 'file-link');
    try {
      await fs.symlink(outsideFile, link);
    } catch {
      return;
    }
    await assert.rejects(() => ws.resolve('file-link'), PathSecurityError);
  });

  it('blocks creation through traversal segments', async () => {
    await assert.rejects(() => ws.resolve('sub/../../x.txt', { allowMissing: true }), PathSecurityError);
  });

  it('allows missing paths with allowMissing (create case)', async () => {
    const e = await ws.resolve('new-dir/new-file.txt', { allowMissing: true });
    assert.equal(e.kind, 'missing');
    assert.equal(e.relativePath, 'new-dir/new-file.txt');
  });

  it('enforces file size limits', async () => {
    await assert.rejects(() => ws.resolveFile('file.txt', { maxFileBytes: 3 }), PathSecurityError);
  });

  it('rejects non-regular files (FIFOs/devices)', async () => {
    if (process.platform === 'win32') return;
    const fifo = path.join(tmp, 'pipe');
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [fifo]);
    await assert.rejects(() => ws.resolve('pipe'), /Unsupported file type/);
  });

  it('refuses filesystem roots as workspaces', async () => {
    await assert.rejects(() => WorkspaceBoundary.create('/'), PathSecurityError);
    await assert.rejects(() => WorkspaceBoundary.create('C:\\'), (err: unknown) => err instanceof PathSecurityError || (err as Error).message.includes('root'));
  });

  it('rejects NUL bytes and absurd paths', async () => {
    await assert.rejects(() => ws.resolve('a\0b'), PathSecurityError);
    await assert.rejects(() => ws.resolve('x'.repeat(5000)), PathSecurityError);
  });

  it('detects a swapped workspace directory (TOCTOU guard)', async () => {
    if (process.platform === 'win32') return; // rename juggling differs
    const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'op-boundary2-'));
    const movable = path.join(os.tmpdir(), `op-movable-${process.pid}`);
    await fs.mkdir(movable);
    await fs.writeFile(path.join(movable, 'a.txt'), 'x');
    const b = await WorkspaceBoundary.create(movable);
    const backup = `${movable}-old`;
    await fs.rename(movable, backup);
    try {
      await fs.symlink(root2, movable, 'dir');
      await assert.rejects(() => b.resolve('a.txt'), /changed on disk/);
    } finally {
      await fs.rm(movable, { force: true, recursive: true });
      await fs.rename(backup, movable);
      await fs.rm(root2, { recursive: true, force: true });
      await fs.rm(movable, { recursive: true, force: true });
    }
  });
});
