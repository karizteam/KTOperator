import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeHarness, type TestHarness } from '../helpers.js';

let h: TestHarness;

before(async () => {
  h = await makeHarness({
    workspaceFiles: {
      'hello.txt': 'hello world\nsecond line\n',
      'src/a.ts': 'export const a = 1;\nexport const SECRET = "sk-or-v1-livesecretkey12345";\n',
      'src/b.ts': 'export const b = 2;\n',
      'docs/readme.md': '# Project\n\nSome text.\n',
    },
  });
});

after(async () => h.cleanup());

const call = (name: string, args: Record<string, unknown>) => h.registry.execute(name, JSON.stringify(args), h.toolContext);

describe('filesystem tools via registry', () => {
  it('list_directory lists sorted entries', async () => {
    const r = await call('list_directory', { path: '.' });
    assert.equal(r.ok, true);
    const data = JSON.parse(r.data as string) as { entries: { name: string; type: string }[] };
    const names = data.entries.map((e) => e.name);
    assert.ok(names.includes('hello.txt'));
    assert.ok(names.includes('src'));
    assert.ok(data.entries[0]!.type === 'directory');
  });

  it('read_file returns content with line ranges', async () => {
    const r = await call('read_file', { path: 'hello.txt', startLine: 2, endLine: 2 });
    assert.equal(r.ok, true);
    const data = JSON.parse(r.data as string) as { content: string; totalLines: number };
    assert.equal(data.content, 'second line');
    assert.equal(data.totalLines, 3);
  });

  it('redacts secrets found in files before the model sees them', async () => {
    const r = await call('read_file', { path: 'src/a.ts' });
    assert.equal(r.ok, true);
    const blob = `${r.summary} ${r.data}`;
    assert.ok(!blob.includes('sk-or-v1-livesecretkey12345'), 'the secret must be redacted, got: ' + blob);
    assert.match(blob, /REDACTED/);
  });

  it('search_files matches globs and stays bounded', async () => {
    const r = await call('search_files', { pattern: '**/*.ts' });
    assert.equal(r.ok, true);
    const data = JSON.parse(r.data as string) as { matches: string[] };
    assert.deepEqual(data.matches.sort(), ['src/a.ts', 'src/b.ts']);
  });

  it('search_text finds matches with line numbers', async () => {
    const r = await call('search_text', { query: 'second' });
    assert.equal(r.ok, true);
    const data = JSON.parse(r.data as string) as { matches: { file: string; line: number }[] };
    assert.deepEqual(data.matches[0], { file: 'hello.txt', line: 2, snippet: 'second line' });
  });

  it('create_file writes and verifies new content', async () => {
    const r = await call('create_file', { path: 'new/created.txt', content: 'fresh\n' });
    assert.equal(r.ok, true);
    assert.equal(await fs.readFile(path.join(h.workspaceDir, 'new/created.txt'), 'utf8'), 'fresh\n');
  });

  it('create_file refuses to overwrite without the flag', async () => {
    const r = await call('create_file', { path: 'hello.txt', content: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /already exists/);
  });

  it('create_file keeps a backup when overwriting an existing file', async () => {
    const r = await call('create_file', { path: 'hello.txt', content: 'replaced', overwrite: true });
    assert.equal(r.ok, true);
    const entries = await h.backups.list('test-session');
    assert.ok(entries.some((e) => e.source.endsWith('hello.txt') && e.backupPath !== null));
  });

  it('edit_file applies exact replacements and returns a diff', async () => {
    const r = await call('edit_file', { path: 'src/b.ts', edits: [{ find: 'b = 2', replace: 'b = 42' }] });
    assert.equal(r.ok, true);
    const file = await fs.readFile(path.join(h.workspaceDir, 'src/b.ts'), 'utf8');
    assert.match(file, /b = 42/);
    const data = JSON.parse(r.data as string) as { diff: string };
    assert.match(data.diff, /-export const b = 2;/);
    assert.match(data.diff, /\+export const b = 42;/);
  });

  it('edit_file fails atomically when a find snippet is absent', async () => {
    const before = await fs.readFile(path.join(h.workspaceDir, 'src/b.ts'), 'utf8');
    const r = await call('edit_file', { path: 'src/b.ts', edits: [{ find: 'b = 42', replace: 'b = 43' }, { find: 'NOT PRESENT', replace: 'x' }] });
    assert.equal(r.ok, false);
    const after = await fs.readFile(path.join(h.workspaceDir, 'src/b.ts'), 'utf8');
    assert.equal(before, after, 'no partial edits may be applied');
  });

  it('move_file relocates within the workspace only', async () => {
    const r = await call('move_file', { source: 'docs/readme.md', destination: 'README.md' });
    assert.equal(r.ok, true);
    assert.ok(await exists(path.join(h.workspaceDir, 'README.md')));
    const escape = await call('move_file', { source: 'hello.txt', destination: '../evil.txt' });
    assert.equal(escape.ok, false);
  });

  it('delete_file removes with backup; generate_diff previews only', async () => {
    await call('create_file', { path: 'to-delete.txt', content: 'bye' });
    const diff = await call('generate_diff', { path: 'to-delete.txt', proposedContent: 'changed' });
    assert.equal(diff.ok, true);
    assert.equal(await fs.readFile(path.join(h.workspaceDir, 'to-delete.txt'), 'utf8'), 'bye', 'generate_diff must not modify');
    const del = await call('delete_file', { path: 'to-delete.txt' });
    assert.equal(del.ok, true);
    assert.equal(await exists(path.join(h.workspaceDir, 'to-delete.txt')), false);
  });

  it('blocks traversal attempts through the registry', async () => {
    for (const tool of ['read_file', 'list_directory']) {
      const r = await call(tool, { path: '../../etc/passwd' });
      assert.equal(r.ok, false);
      assert.match(`${r.summary} ${r.error}`, /escape|traversal|not exist/i);
    }
  });
});

describe('registry pipeline behavior', () => {
  it('rejects unknown tools and invalid arguments', async () => {
    const unknown = await h.registry.execute('rm_rf_everything', '{}', h.toolContext);
    assert.equal(unknown.ok, false);
    const invalid = await call('read_file', { path: 42 });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error ?? '', /expected string/);
  });

  it('deny-all approval mode blocks tier-2 actions without prompting', async () => {
    const strict = await makeHarness({ approvalMode: { kind: 'deny-all' }, workspaceFiles: { 'x.txt': 'data' } });
    try {
      const r = await strict.registry.execute('delete_file', JSON.stringify({ path: 'x.txt' }), strict.toolContext);
      assert.equal(r.ok, false);
      assert.match(r.error ?? '', /Approval requires|denied/i);
      assert.ok(await exists(path.join(strict.workspaceDir, 'x.txt')), 'file must survive a denied delete');
    } finally {
      await strict.cleanup();
    }
  });

  it('dry-run simulates writes without touching disk', async () => {
    const dry = await makeHarness({ dryRun: true, workspaceFiles: {} });
    try {
      const r = await dry.registry.execute('create_file', JSON.stringify({ path: 'ghost.txt', content: 'boo' }), dry.toolContext);
      assert.equal(r.ok, true);
      assert.match(r.summary, /dry-run/);
      assert.equal(await exists(path.join(dry.workspaceDir, 'ghost.txt')), false);
    } finally {
      await dry.cleanup();
    }
  });

  it('audit log records requests, approvals and results', async () => {
    await call('read_file', { path: 'hello.txt' });
    const events = await import('../../src/security/audit.js').then((m) => m.AuditLog.read({ dir: path.join(h.tmp, 'audit'), limit: 50 }));
    const kinds = events.map((e) => e.event);
    assert.ok(kinds.includes('tool.request'));
    assert.ok(kinds.includes('tool.result'));
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
