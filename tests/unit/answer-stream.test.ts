import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Ui } from '../../src/cli/ui.js';

const ANSI = /\x1b\[[0-9;]*m/g;

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

function plain(text: string): string {
  return text.replace(ANSI, '');
}

function render(...chunks: string[]): string {
  return capture(() => {
    const ui = new Ui({ forceNonInteractive: true, noColor: true });
    ui.startAnswer();
    for (const chunk of chunks) ui.token(chunk);
    ui.endStream();
  });
}

describe('streamed answer rendering', () => {
  it('marks the first row and indents every later row', () => {
    const out = plain(render('Hello there.\nSecond line.\n\nThird paragraph.\n'));
    const lines = out.split('\n').filter((l) => l !== '');
    assert.equal(lines[0], '  ✦ Hello there.');
    assert.equal(lines[1], '    Second line.');
    assert.equal(lines[2], '    Third paragraph.', 'blank lines separate paragraphs');
  });

  it('wraps long prose at the terminal width with a stable gutter', () => {
    const long = 'word '.repeat(80).trim();
    const out = plain(render(`${long}\n`));
    const lines = out.split('\n').filter((l) => l !== '');
    assert.ok(lines.length > 3, 'a long paragraph must wrap into several rows');
    for (const line of lines) assert.ok(line.length <= 76, `row too wide (${line.length}): ${line}`);
    assert.ok(lines[0]!.startsWith('  ✦ word'));
    for (const line of lines.slice(1)) assert.ok(line.startsWith('    '), `missing gutter: ${line}`);
  });

  it('hangs list continuation rows under the item text', () => {
    const out = plain(render(`- ${'item '.repeat(40).trim()}\n`));
    const lines = out.split('\n').filter((l) => l !== '');
    assert.ok(lines[0]!.startsWith('  ✦ - item'));
    for (const line of lines.slice(1)) assert.ok(line.startsWith('      item'), `list hang wrong: ${JSON.stringify(line)}`);
  });

  it('draws code fences as a box and leaves the code itself unstyled', () => {
    const out = plain(render('Before.\n```ts\nconst a = `x`;\n```\nAfter.\n'));
    const lines = out.split('\n');
    assert.ok(lines.some((l) => l.trim() === '┌─ ts'), 'opening corner with language');
    assert.ok(lines.some((l) => l === '    │ const a = `x`;'), 'code row aligned behind the bar');
    assert.ok(lines.some((l) => l.trim() === '└─'), 'closing corner');
    assert.ok(lines.some((l) => l === '    After.'), 'text resumes after the fence');
    assert.ok(!lines.some((l) => l.includes('**') && l.includes('const')), 'no markdown inside code');
  });

  it('renders a thematic break as a real rule', () => {
    const out = plain(render('above\n---\nbelow\n'));
    assert.ok(!out.includes('---'), 'the literal hyphens are replaced');
    assert.ok(out.split('\n').some((l) => l.trim().startsWith('──')), 'a rule line is drawn');
  });

  it('produces the same output whether the text arrives in one piece or in tokens', () => {
    const text = '## Title\n\n- one\n- two\n\nA paragraph that is long enough to wrap across the terminal width for sure, because it keeps going and going.\n\n```js\nrun();\n```\n';
    const oneShot = capture(() => new Ui({ forceNonInteractive: true, noColor: true }).answer(text));
    const streamed = plain(render(...text.match(/[\s\S]{1,7}/g) ?? []));
    assert.equal(streamed, plain(oneShot));
  });

  it('is idempotent when the stream is closed twice', () => {
    const first = plain(render('Done.\n'));
    const double = capture(() => {
      const ui = new Ui({ forceNonInteractive: true, noColor: true });
      ui.startAnswer();
      ui.token('Done.\n');
      ui.endStream();
      const before = plain('');
      ui.endStream();
      assert.equal(before, '');
    });
    assert.equal(plain(double), first, 'a second endStream must not add blank lines');
  });

  it('colorizes markdown when color is enabled', () => {
    const raw = capture(() => {
      const ui = new Ui({ forceNonInteractive: true, forceColor: true });
      ui.answer('## Heading\n\n- bullet\n\n**bold** and `code`\n');
    });
    assert.match(raw, /\x1b\[[0-9;]*m/, 'some styling is present');
    assert.ok(plain(raw).includes('## Heading'), 'text itself is unchanged');
    assert.ok(plain(raw).includes('**bold**'), 'markdown markers stay visible');
  });

  it('keeps Persian text in one isolated run', () => {
    const out = render('سلام دنیا\n');
    assert.ok(out.includes('\u2068'), 'FSI isolate opens the RTL run');
    assert.ok(out.includes('\u2069'), 'PDI closes it');
    assert.ok(plain(out).includes('سلام دنیا'));
  });
});
