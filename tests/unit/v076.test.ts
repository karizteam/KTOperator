import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exactDestinationBlock, extractAbsoluteDestinations } from '../../src/core/agent/loop.js';
import { renderDiffLines } from '../../src/core/agent/checkpoints.js';
import { collectRunChanges, renderChangesBox } from '../../src/core/agent/changes.js';
import type { Ui } from '../../src/cli/ui.js';

describe('exact destination guard', () => {
  it('extracts windows, unc and posix absolute paths', () => {
    const found = extractAbsoluteDestinations('make notes.txt on D:\\docs\\notes.txt and /home/me/out.txt');
    assert.ok(found.some((f) => f === 'D:\\docs\\notes.txt'));
    assert.ok(found.some((f) => f === '/home/me/out.txt'));
  });
  it('allows create_file at the exact named destination', () => {
    assert.equal(
      exactDestinationBlock('make a txt file on D:\\docs\\notes.txt', 'create_file', { path: 'D:\\docs\\notes.txt' }),
      null,
    );
  });
  it('blocks a bare-name create that would land in the terminal folder', () => {
    const msg = exactDestinationBlock('make a txt file on D:\\docs\\notes.txt', 'create_file', { path: 'notes.txt' });
    assert.ok(msg !== null && msg.includes('D:\\docs\\notes.txt'));
  });
  it('blocks a workspace-relative create with the same file name', () => {
    const msg = exactDestinationBlock('make a txt file on D:\\docs\\notes.txt', 'create_file', { path: 'docs/notes.txt' });
    assert.ok(msg !== null);
  });
  it('blocks a different absolute location with the same file name', () => {
    const msg = exactDestinationBlock('make a txt file on D:\\docs\\notes.txt', 'create_file', { path: 'C:\\other\\notes.txt' });
    assert.ok(msg !== null);
  });
  it('does not block unrelated files or tasks without an absolute destination', () => {
    assert.equal(exactDestinationBlock('make a txt file on D:\\docs\\notes.txt', 'create_file', { path: 'other.txt' }), null);
    assert.equal(exactDestinationBlock('make a txt file called notes.txt in this folder', 'create_file', { path: 'notes.txt' }), null);
    assert.equal(exactDestinationBlock('make a txt file on D:\\docs\\notes.txt', 'read_file', { path: 'notes.txt' }), null);
  });
  it('applies to move_file destinations too', () => {
    assert.ok(
      exactDestinationBlock('move it to D:\\docs\\notes.txt', 'move_file', { destination: 'notes.txt' }) !== null,
    );
  });
});

describe('colored diff & changes rendering', () => {
  const style = {
    header: (s: string) => `<H>${s}</H>`,
    added: (s: string) => `<G>${s}</G>`,
    removed: (s: string) => `<R>${s}</R>`,
    context: (s: string) => `<D>${s}</D>`,
  };
  it('colors + lines green, - lines red, headers and context distinctly', () => {
    const lines = renderDiffLines(
      [{ path: 'a.txt', op: 'edit', lines: ['-old', '+new', ' same'], added: 1, removed: 1, truncated: false }],
      style,
    );
    assert.ok(lines.some((l) => l.includes('<G>')));
    assert.ok(lines.some((l) => l.includes('<R>')));
    assert.ok(lines.some((l) => l.includes('<H>')));
    assert.ok(lines.some((l) => l.includes('<D>')));
  });
  it('stays plain without a style (tests / non-color mode)', () => {
    const lines = renderDiffLines([{ path: 'a.txt', op: 'create', lines: ['+x'], added: 1, removed: 0, truncated: false }]);
    assert.deepEqual(lines, ['▸ a.txt  (create · +1 -0)', '  +x']);
  });
  it('colors the action word in the changes box like the UI icons', () => {
    const greenCalls: string[] = [];
    let boxLines: string[] = [];
    const ui = {
      jsonMode: false,
      green: (s: string) => { greenCalls.push(s); return `<G>${s}</G>`; },
      yellow: (s: string) => `<Y>${s}</Y>`,
      red: (s: string) => `<R>${s}</R>`,
      brand: (s: string) => s,
      brandLight: (s: string) => s,
      brandDark: (s: string) => s,
      bold: (s: string) => s,
      dim: (s: string) => s,
      info: () => undefined,
      box: (_title: string, lines: string[]) => { boxLines = lines; },
    } as unknown as Ui;
    const changes = collectRunChanges([
      {
        iteration: 1,
        assistantText: '',
        toolCalls: [{ name: 'create_file', ok: true, summary: 'Created notes.txt (4 bytes), verified after write.', args: { path: 'notes.txt' } }],
      },
    ]);
    renderChangesBox(ui, changes);
    assert.ok(greenCalls.some((s) => s.trim() === 'created'), 'created is passed through green()');
    assert.ok(boxLines.some((l) => l.includes('<G>created')));
  });
});
