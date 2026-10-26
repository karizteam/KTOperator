import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFileTool, editFileTool } from '../../src/tools/filesystem.js';
import type { ApprovalEngine } from '../../src/security/approval.js';
import { Ui } from '../../src/cli/ui.js';
import { makeHarness } from '../helpers.js';

describe('diff-before-write previews', () => {
  it('shows a +line preview for a brand new file', async () => {
    const h = await makeHarness({ workspaceFiles: { 'existing.txt': 'keep\n' } });
    try {
      const described = await createFileTool.describe!({ path: 'fresh.txt', content: 'one\ntwo\n' }, h.toolContext);
      assert.equal(described.summary, 'Create file fresh.txt (8 bytes)');
      assert.deepEqual(described.targets, ['fresh.txt']);
      assert.ok(described.preview?.startsWith('+one'), `preview: ${described.preview}`);
    } finally {
      await h.cleanup();
    }
  });

  it('shows a real unified diff when create_file would overwrite', async () => {
    const h = await makeHarness({ workspaceFiles: { 'existing.txt': 'line one\nline two\n' } });
    try {
      const described = await createFileTool.describe!(
        { path: 'existing.txt', content: 'line one\nline two changed\n', overwrite: true },
        h.toolContext,
      );
      assert.equal(described.summary, 'Overwrite file existing.txt (26 bytes)');
      const preview = described.preview ?? '';
      assert.match(preview, /^--- a\/existing\.txt/m, `preview: ${preview}`);
      assert.match(preview, /^\+\+\+ b\/existing\.txt/m, `preview: ${preview}`);
      assert.match(preview, /^-line two$/m, `preview: ${preview}`);
      assert.match(preview, /^\+line two changed$/m, `preview: ${preview}`);
    } finally {
      await h.cleanup();
    }
  });

  it('shows the resulting edit for edit_file before anything is written', async () => {
    const h = await makeHarness({ workspaceFiles: { 'app.ts': 'const a = 1;\nconst b = 2;\n' } });
    try {
      const described = await editFileTool.describe!(
        { path: 'app.ts', edits: [{ find: 'const a = 1;', replace: 'const a = 42;' }] },
        h.toolContext,
      );
      assert.equal(described.summary, 'Apply 1 edit(s) to app.ts');
      const preview = described.preview ?? '';
      assert.match(preview, /^--- a\/app\.ts/m, `preview: ${preview}`);
      assert.match(preview, /^-const a = 1;$/m, `preview: ${preview}`);
      assert.match(preview, /^\+const a = 42;$/m, `preview: ${preview}`);
      assert.match(preview, /^ const b = 2;$/m, 'unchanged context lines stay as context');
    } finally {
      await h.cleanup();
    }
  });

  it('explains a find snippet that is not in the file yet', async () => {
    const h = await makeHarness({ workspaceFiles: { 'app.ts': 'nothing here\n' } });
    try {
      const described = await editFileTool.describe!(
        { path: 'app.ts', edits: [{ find: 'does not exist', replace: 'x' }] },
        h.toolContext,
      );
      assert.match(described.preview ?? '', /not present/);
      assert.match(described.preview ?? '', /does not exist/);
    } finally {
      await h.cleanup();
    }
  });

  it('never lets a preview failure block the approval prompt', async () => {
    const h = await makeHarness({ workspaceFiles: { 'app.ts': 'x\n' } });
    try {
      const described = await editFileTool.describe!({ path: 'missing.ts', edits: [{ find: 'a', replace: 'b' }] }, h.toolContext);
      assert.equal(described.summary, 'Apply 1 edit(s) to missing.ts');
      assert.equal(described.preview, undefined, 'unreadable file → summary only, no crash');
    } finally {
      await h.cleanup();
    }
  });

  it('hands the preview to the approval prompt through the registry', async () => {
    const h = await makeHarness({ workspaceFiles: { 'app.ts': 'const a = 1;\n' } });
    const seen: { preview?: string; summary?: string } = {};
    const fakeApproval = {
      request: async (req: { preview?: string; summary: string }) => {
        seen.preview = req.preview;
        seen.summary = req.summary;
        return { approved: false, reason: 'Denied by the test.', via: 'denied' as const };
      },
    } as unknown as ApprovalEngine;
    try {
      const result = await h.registry.execute(
        'edit_file',
        JSON.stringify({ path: 'app.ts', edits: [{ find: 'const a = 1;', replace: 'const a = 2;' }] }),
        { ...h.toolContext, approval: fakeApproval },
      );
      assert.equal(result.ok, false, 'the fake approval denies, so nothing is written');
      assert.match(seen.preview ?? '', /-const a = 1;/, 'the approval prompt received the diff');
      assert.match(seen.summary ?? '', /Apply 1 edit\(s\) to app\.ts/);
      const still = await h.registry.execute('read_file', JSON.stringify({ path: 'app.ts' }), h.toolContext);
      assert.match(still.data ?? '', /const a = 1;/, 'the file was not modified');
    } finally {
      await h.cleanup();
    }
  });
});

describe('approval preview rendering', () => {
  const diff = ['--- a/app.ts', '+++ b/app.ts', '@@ -1,2 +1,2 @@', '-const a = 1;', '+const a = 2;', ' const b = 3;'].join('\n');

  function capture(fn: () => void): string {
    const chunks: string[] = [];
    const original = process.stdout.write;
    (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      fn();
    } finally {
      (process.stdout as unknown as { write: typeof original }).write = original;
    }
    return chunks.join('');
  }

  it('colors additions, removals and hunk headers without altering the text', () => {
    const ui = new Ui({ forceColor: true, forceNonInteractive: true });
    const out = capture(() => ui.printDiffPreview(diff, 40));
    assert.match(out, /\x1b\[[0-9;]*m-const a = 1;/, 'removal is colored');
    assert.match(out, /\x1b\[[0-9;]*m\+const a = 2;/, 'addition is colored');
    assert.match(out, /\x1b\[[0-9;]*m@@/, 'hunk header is colored');
    assert.ok(out.includes('--- a/app.ts'), 'file header stays readable');
    assert.ok(out.includes('--- preview'), 'bounded block is labelled');
    assert.ok(out.includes('--- end preview'));
  });

  it('caps a long preview and says how many lines were hidden', () => {
    const ui = new Ui({ forceColor: true, forceNonInteractive: true });
    const long = Array.from({ length: 120 }, (_, i) => `+line ${i}`).join('\n');
    const out = capture(() => ui.printDiffPreview(long, 40));
    const shown = out.split('\n').filter((l) => l.includes('+line ')).length;
    assert.equal(shown, 40, `expected 40 preview lines, got ${shown}`);
    assert.match(out, /80 more lines not shown/);
  });

  it('stays plain when color is disabled', () => {
    const ui = new Ui({ noColor: true, forceNonInteractive: true });
    const out = capture(() => ui.printDiffPreview(diff, 40));
    assert.ok(!out.includes('\x1b['), `unexpected escapes: ${JSON.stringify(out)}`);
    assert.ok(out.includes('+const a = 2;'));
  });
});
