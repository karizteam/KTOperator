import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_CONFIRM_WINDOW_MS, filterSlashCommands, interruptDecision, parseSlashCommand, SLASH_COMMANDS } from '../../src/commands/console.js';
import {
  Ui,
  BRAND_HEX,
  BRAND_RGB,
  displayWidth,
  graphemes,
  parseChatKey,
  recallHistory,
  truncateToWidth,
  wrapLogicalLine,
} from '../../src/cli/ui.js';

describe('parseSlashCommand', () => {
  it('returns null for regular messages', () => {
    assert.equal(parseSlashCommand('run the tests'), null);
    assert.equal(parseSlashCommand(''), null);
    assert.equal(parseSlashCommand('explain /etc/hosts'), null);
  });

  it('parses a bare command', () => {
    assert.deepEqual(parseSlashCommand('/exit'), { name: 'exit', args: '' });
    assert.deepEqual(parseSlashCommand('/sandbox'), { name: 'sandbox', args: '' });
    assert.deepEqual(parseSlashCommand('/status'), { name: 'status', args: '' });
    assert.deepEqual(parseSlashCommand('/doctor'), { name: 'doctor', args: '' });
  });

  it('parses command plus arguments', () => {
    assert.deepEqual(parseSlashCommand('/provider use or'), { name: 'provider', args: 'use or' });
    assert.deepEqual(parseSlashCommand('/model reload'), { name: 'model', args: 'reload' });
    assert.deepEqual(parseSlashCommand('/workspace /tmp/foo bar'), { name: 'workspace', args: '/tmp/foo bar' });
  });

  it('normalizes case and surrounding whitespace', () => {
    assert.deepEqual(parseSlashCommand('  /EXIT  '), { name: 'exit', args: '' });
    assert.deepEqual(parseSlashCommand('/Model Use GPT'), { name: 'model', args: 'Use GPT' });
  });

  it('does not treat a lone slash as a command', () => {
    assert.equal(parseSlashCommand('/'), null);
    assert.equal(parseSlashCommand('/ '), null);
  });
});

describe('slash command menu', () => {
  it('offers every command with a help sentence for a lone slash', () => {
    const items = filterSlashCommands('/');
    assert.equal(items.length, SLASH_COMMANDS.length);
    for (const item of items) {
      assert.match(item.command, /^\/[a-z]+$/);
      assert.ok(item.help.length > 3, `${item.command} needs help text`);
    }
  });

  it('keeps the interface copy English-only', () => {
    const rtl = /[\u0600-\u06FF]/;
    for (const item of SLASH_COMMANDS) {
      assert.ok(!rtl.test(item.help), `${item.name} help contains Persian text`);
      assert.ok(!rtl.test(item.usage ?? ''), `${item.name} usage contains Persian text`);
    }
  });

  it('filters by prefix', () => {
    assert.deepEqual(filterSlashCommands('/mo').map((i) => i.command), ['/model']);
    assert.deepEqual(filterSlashCommands('/S').map((i) => i.command), ['/status', '/sandbox']);
  });

  it('hides the menu once the command has arguments or is not a command', () => {
    assert.deepEqual(filterSlashCommands('/model gpt-4'), []);
    assert.deepEqual(filterSlashCommands('hello'), []);
    assert.deepEqual(filterSlashCommands('/model\nsecond line'), []);
    assert.deepEqual(filterSlashCommands('/zzz'), []);
  });
});

describe('UI Theme (#8B9A6E) & Persian/RTL Text Support', () => {
  it('exports the #8B9A6E brand color constants', () => {
    assert.equal(BRAND_HEX, '#8B9A6E');
    assert.deepEqual(BRAND_RGB, [139, 154, 110]);
  });

  it('normalizes and isolates Persian text without breaking ZWNJ', () => {
    const ui = new Ui({ noColor: true, forceNonInteractive: true });
    const persian = 'سلام دنیا! این یک متن فارسی‌تست است.';
    const formatted = ui.formatPersianText(persian);
    assert.ok(formatted.includes('⁨'));
    assert.ok(formatted.includes('⁩'));
    assert.ok(formatted.includes('‌'), 'must preserve ZWNJ (نیم‌فاصله)');
    assert.equal(ui.visibleLength(formatted), [...persian].length);
  });

  it('leaves pure English text untouched', () => {
    const ui = new Ui({ noColor: true, forceNonInteractive: true });
    assert.equal(ui.formatPersianText('Hello KT Operator'), 'Hello KT Operator');
  });

  it('keeps ANSI styling outside the RTL isolate so mixed lines never reorder', () => {
    const ui = new Ui({ noColor: true, forceNonInteractive: true });
    const styled = '\x1b[2mدستور /help را بزن\x1b[0m';
    const formatted = ui.formatPersianText(styled);
    assert.ok(formatted.startsWith('\x1b[2m'), 'the style code is not swallowed by the isolate');
    assert.ok(formatted.endsWith('\x1b[0m'), 'the reset code stays outside the isolate');
    const closeIsolate = formatted.indexOf('⁩');
    const reset = formatted.lastIndexOf('\x1b[');
    assert.ok(closeIsolate < reset, 'no ANSI code sits inside the isolated run');
  });

  it('counts terminal columns per grapheme, not per UTF-16 unit', () => {
    assert.deepEqual(graphemes('سلام'), ['س', 'ل', 'ا', 'م']);
    assert.equal(displayWidth('سلام'), 4);
    assert.equal(displayWidth('👩‍💻'), 2, 'an emoji-zwj sequence is one wide grapheme');
  });
});

describe('wrapping & truncation (Persian safe)', () => {
  it('wraps without splitting graphemes and stays within the width', () => {
    const text = 'این یک جمله فارسی است که باید در چند خط شکسته شود بدون آنکه حروف از هم جدا شوند';
    const rows = wrapLogicalLine(text, 24);
    assert.ok(rows.length > 1);
    for (const row of rows) assert.ok(displayWidth(row.text) <= 24, `row too wide: ${row.text}`);
    const rejoined = rows.map((r) => r.text).join(' ');
    assert.equal(rejoined.replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
  });

  it('returns a single empty row for empty input', () => {
    assert.deepEqual(wrapLogicalLine('', 20), [{ text: '', start: 0, end: 0 }]);
  });

  it('truncates to the requested column width without breaking a cluster', () => {
    const cut = truncateToWidth('سلام دنیا', 6);
    assert.ok(displayWidth(cut) <= 6);
    assert.ok(cut.startsWith('س'));
    assert.equal(truncateToWidth('short', 10), 'short');
  });
});

describe('colorful output marks', () => {
  const ui = new Ui({ forceColor: true, forceNonInteractive: true });

  it('colors list bullets, numbers and quotes without changing their text', () => {
    const bullet = ui.formatAgentText('- first item');
    assert.match(bullet, /\x1b\[[0-9;]*m-/);
    assert.ok(bullet.includes('first item'));

    const ordered = ui.formatAgentText('1. step one');
    assert.match(ordered, /\x1b\[[0-9;]*m1\./);
    assert.ok(ordered.includes('step one'));

    const quote = ui.formatAgentText('> quoted');
    assert.match(quote, /\x1b\[[0-9;]*m>/);
  });

  it('colors headings, rules and inline code', () => {
    const heading = ui.formatAgentText('## Summary');
    assert.match(heading, /\x1b\[[0-9;]*m##/);
    assert.ok(heading.includes('Summary'));

    const rule = ui.formatAgentText('---');
    assert.ok(rule.startsWith('\x1b['));

    const code = ui.formatAgentText('run `npm test` now');
    assert.ok(code.includes('`'));
    assert.match(code, /\x1b\[[0-9;]*mnpm test/);
  });

  it('adds no escape codes when color is disabled', () => {
    const plain = new Ui({ noColor: true, forceNonInteractive: true });
    assert.equal(plain.formatAgentText('- item'), '- item');
    assert.equal(plain.formatAgentText('## Title'), '## Title');
  });

  it('truncates styled text without cutting escape sequences', () => {
    const styled = new Ui({ forceColor: true, forceNonInteractive: true }).formatAgentText('- a fairly long bullet that must be cut');
    const cut = truncateToWidth(styled, 20);
    assert.ok(displayWidth(cut) <= 20, `too wide: ${JSON.stringify(cut)}`);
    assert.ok(cut.endsWith('\x1b[0m…') || cut.endsWith('…'));
  });
});

describe('chat text-area key parsing', () => {
  it('recognizes editing keys and multi-byte text', () => {
    assert.deepEqual(parseChatKey('\r')?.key, { type: 'enter' });
    assert.deepEqual(parseChatKey('\n')?.key, { type: 'newline' });
    assert.deepEqual(parseChatKey('\t')?.key, { type: 'tab' });
    assert.deepEqual(parseChatKey('\x7f')?.key, { type: 'backspace' });
    assert.deepEqual(parseChatKey('\x03')?.key, { type: 'cancel' });
    assert.deepEqual(parseChatKey('\x1b[A')?.key, { type: 'up' });
    assert.deepEqual(parseChatKey('\x1b[3~')?.key, { type: 'delete' });
    assert.deepEqual(parseChatKey('\x1b\r')?.key, { type: 'newline' }, 'Alt+Enter inserts a newline');
    assert.deepEqual(parseChatKey('سلام دنیا')?.key, { type: 'text', value: 'سلام دنیا' });
  });

  it('waits for the rest of an incomplete escape sequence', () => {
    assert.equal(parseChatKey('\x1b'), null);
    assert.equal(parseChatKey('\x1b['), null);
    assert.deepEqual(parseChatKey('\x1b[1;5C')?.key, { type: 'escape' });
  });
});

describe('prompt history recall (↑/↓)', () => {
  const history = ['first prompt', 'second prompt', 'third prompt'];

  it('stays out of the way when there is no history', () => {
    const step = recallHistory([], 0, -1, '', 'draft');
    assert.equal(step.handled, false, 'the caret must keep moving the normal way');
    assert.equal(step.value, 'draft');
    assert.equal(recallHistory([], 0, 1, '', 'draft').handled, false);
  });

  it('walks backwards from the draft, preserving it for later', () => {
    let index = history.length;
    let draft = '';
    let current = 'work in progress';

    let step = recallHistory(history, index, -1, draft, current);
    assert.equal(step.handled, true);
    assert.equal(step.value, 'third prompt');
    assert.equal(step.draft, 'work in progress');
    ({ index, draft, value: current } = { index: step.index, draft: step.draft, value: step.value });

    step = recallHistory(history, index, -1, draft, current);
    assert.equal(step.value, 'second prompt');
    ({ index, draft, value: current } = { index: step.index, draft: step.draft, value: step.value });

    step = recallHistory(history, index, -1, draft, current);
    assert.equal(step.value, 'first prompt');
    assert.equal(step.index, 0);

    step = recallHistory(history, 0, -1, draft, 'first prompt');
    assert.equal(step.handled, true, 'the oldest prompt is the end of the road');
    assert.equal(step.value, 'first prompt', 'and it does not wrap around');
  });

  it('walks forwards and lands back on the untouched draft', () => {
    let index = 0;
    let draft = 'work in progress';
    let current = 'first prompt';

    let step = recallHistory(history, index, 1, draft, current);
    assert.equal(step.value, 'second prompt');
    ({ index, draft, value: current } = { index: step.index, draft: step.draft, value: step.value });

    step = recallHistory(history, index, 1, draft, current);
    assert.equal(step.value, 'third prompt');
    ({ index, draft, value: current } = { index: step.index, draft: step.draft, value: step.value });

    step = recallHistory(history, index, 1, draft, current);
    assert.equal(step.index, history.length, 'one step past the newest prompt is the draft');
    assert.equal(step.value, 'work in progress');

    step = recallHistory(history, history.length, 1, draft, 'work in progress');
    assert.equal(step.handled, true);
    assert.equal(step.value, 'work in progress', 'and it stays there');
  });

  it('keeps an empty draft empty on the way back', () => {
    const step = recallHistory(['only one'], 1, -1, '', '');
    assert.equal(step.value, 'only one');
    const back = recallHistory(['only one'], step.index, 1, step.draft, step.value);
    assert.equal(back.value, '', 'the draft restores exactly, not the last prompt');
  });
});

describe('Ctrl+C at the prompt', () => {
  it('warns on the first press and never exits', () => {
    assert.equal(interruptDecision(0, 5_000), 'clear');
  });

  it('leaves only on a deliberate second press', () => {
    const first = 10_000;
    assert.equal(interruptDecision(first, first + 300), 'confirm-exit');
    assert.equal(interruptDecision(first, first + EXIT_CONFIRM_WINDOW_MS), 'confirm-exit');
  });

  it('forgets a press once the window has passed', () => {
    const first = 10_000;
    assert.equal(interruptDecision(first, first + EXIT_CONFIRM_WINDOW_MS + 1), 'clear', 'a stale press must not kill the session later');
  });
});

describe('resume command', () => {
  it('is listed with help and reachable from the / menu', () => {
    const resume = SLASH_COMMANDS.find((c) => c.name === 'resume');
    assert.ok(resume, '/resume must be listed');
    assert.ok(resume.help.length > 10, 'every command carries a help sentence');
    assert.ok(resume.usage === '[id]');
    assert.ok(filterSlashCommands('/res').some((i) => i.command === '/resume'));
  });
});
