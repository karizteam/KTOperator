import readline from 'node:readline/promises';

import { stdin, stdout } from 'node:process';

import { UserCancelledError } from '../errors/errors.js';



/** Primary brand hex color: #8B9A6E (RGB: 139, 154, 110) */

export const BRAND_HEX = '#8B9A6E';

export const BRAND_RGB: readonly [number, number, number] = [139, 154, 110];

export const BRAND_LIGHT_RGB: readonly [number, number, number] = [178, 194, 148];

export const BRAND_DARK_RGB: readonly [number, number, number] = [98, 112, 74];



const ANSI_STRIP_RE = /\x1b\[[0-9;]*m/g;

const RTL_CHAR_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/** Zero-width marks that must never count as terminal columns. ZWNJ (U+200C) is kept. */

const ZERO_WIDTH_RE = /[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}

const graphemeSegmenter: GraphemeSegmenter | null =
  typeof Intl !== 'undefined' && typeof (Intl as unknown as { Segmenter?: unknown }).Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** Split text into user-perceived characters: Persian letters and emoji never break apart. */

export function graphemes(text: string): string[] {
  if (graphemeSegmenter) return [...graphemeSegmenter.segment(text)].map((s) => s.segment);
  return Array.from(text);
}

/** Terminal columns taken by one grapheme cluster. */

export function charWidth(cluster: string): number {
  const cp = cluster.codePointAt(0) ?? 0;
  if (cp === 0) return 0;
  const combining =
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0591 && cp <= 0x05c7) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x06d6 && cp <= 0x06ed) ||
    (cp >= 0x08d3 && cp <= 0x08ff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff;
  if (combining) return 0;
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd);
  return wide ? 2 : 1;
}

/** Terminal columns for a whole string (ANSI codes excluded). */

export function displayWidth(text: string): number {
  const clean = text.replace(ANSI_STRIP_RE, '');
  let width = 0;
  for (const cluster of graphemes(clean)) width += charWidth(cluster);
  return width;
}

export interface WrappedRow {
  text: string;
  /** Offset of the row inside the logical line. */
  start: number;
  /** Offset just past the row inside the logical line. */
  end: number;
}

/**

 * Wrap one logical line into rows that fit `width` terminal columns.

 * Breaks on grapheme boundaries (never inside a Persian letter or emoji) and

 * prefers the last space so words stay whole. Offsets are UTF-16 indexes.

 */

export function wrapLogicalLine(text: string, width: number): WrappedRow[] {
  const cells = graphemes(text);
  if (cells.length === 0) return [{ text: '', start: 0, end: 0 }];
  const offsets: number[] = [0];
  for (const cell of cells) offsets.push(offsets[offsets.length - 1]! + cell.length);
  const rows: WrappedRow[] = [];
  let start = 0;
  while (start < cells.length) {
    let rowWidth = 0;
    let lastSpace = -1;
    let cursor = start;
    while (cursor < cells.length) {
      const w = charWidth(cells[cursor]!);
      if (rowWidth + w > width && cursor > start) break;
      if (cells[cursor] === ' ' || cells[cursor] === '\t') lastSpace = cursor;
      rowWidth += w;
      cursor += 1;
    }
    if (cursor >= cells.length) {
      rows.push({ text: cells.slice(start).join(''), start: offsets[start]!, end: offsets[cells.length]! });
      break;
    }
    let end = cursor;
    let next = cursor;
    if (lastSpace > start) {
      end = lastSpace;
      next = lastSpace + 1;
    }
    if (end === start) {
      end = start + 1;
      next = end;
    }
    rows.push({ text: cells.slice(start, end).join(''), start: offsets[start]!, end: offsets[end]! });
    start = Math.max(next, start + 1);
  }
  return rows;
}

/** Cut a string to `maxWidth` columns without splitting graphemes; ANSI-aware. */

export function truncateToWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  if (displayWidth(text) <= maxWidth) return text;
  const budget = Math.max(0, maxWidth - displayWidth(ellipsis));
  let out = '';
  let width = 0;
  let sawAnsi = false;
  for (const token of text.split(/(\x1b\[[0-9;]*m)/)) {
    if (token.startsWith('\x1b[')) {
      sawAnsi = true;
      out += token;
      continue;
    }
    for (const cluster of graphemes(token)) {
      const w = charWidth(cluster);
      if (width + w > budget) return `${out}${sawAnsi ? '\x1b[0m' : ''}${ellipsis}`;
      out += cluster;
      width += w;
    }
  }
  return `${out}${sawAnsi ? '\x1b[0m' : ''}`;
}

export interface CommandSuggestion {
  /** Literal command including the leading slash, e.g. "/model". */
  command: string;
  /** One-line help shown next to the command. */
  help: string;
}

export interface TextAreaOptions {
  /** Box title (default "you"). */
  title?: string;
  /** Right-aligned context in the top border, e.g. "openrouter · gpt-4o". */
  subtitle?: string;
  /** Key hints shown under the box when no menu is open. */
  hint?: string;
  /** Return the commands to offer for the current input (empty = no menu). */
  suggestions?: (input: string) => CommandSuggestion[];
  /** Earlier prompts recalled with ↑/↓ from the first/last visual row. */
  history?: readonly string[];
}

/** Outcome of one prompt-history step. Exported for tests. */
export interface HistoryRecall {
  /** New position; `history.length` means "editing the draft". */
  index: number;
  /** Draft preserved while walking backwards through earlier prompts. */
  draft: string;
  /** Text the input box should show. */
  value: string;
  /** False → no history to move through; the caller moves the caret instead. */
  handled: boolean;
}

/**
 * Shell-style prompt history: ↑ walks backwards through earlier prompts, ↓
 * walks forwards and finally restores the untouched draft. Kept pure so the
 * text-area key handler stays a thin wrapper around it.
 */
export function recallHistory(history: readonly string[], index: number, direction: -1 | 1, draft: string, current: string): HistoryRecall {
  const idle = (handled: boolean): HistoryRecall => ({ index, draft, value: current, handled });
  if (history.length === 0) return idle(false);
  if (direction === 1) {
    if (index >= history.length) return idle(true);
    const next = index + 1;
    return { index: next, draft, value: next >= history.length ? draft : history[next]!, handled: true };
  }
  if (index <= 0) return idle(true);
  const savedDraft = index >= history.length ? current : draft;
  const next = Math.min(index, history.length) - 1;
  return { index: next, draft: savedDraft, value: history[next]!, handled: true };
}

/** Parsed keystroke for the chat text-area. Exported for tests. */
export type InputKey =
  | { type: 'text'; value: string }
  | { type: 'enter' }
  | { type: 'newline' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'tab' }
  | { type: 'escape' }
  | { type: 'cancel' };

export interface ParsedKey {
  key: InputKey;
  length: number;
}

/** Parse one key/escape sequence at `index`; null means "wait for more bytes". */
export function parseChatKey(buffer: string, index = 0): ParsedKey | null {
  const ch = buffer[index]!;
  if (ch === '\x1b') {
    const rest = buffer.slice(index);
    if (rest.startsWith(PASTE_START)) return null; // handled by the paste path
    if (rest.length === 1) return null; // possibly a lone Escape; the caller decides
    if (rest.startsWith('\x1b[') || rest.startsWith('\x1bO')) {
      const match = /^\x1b\[[0-9;]*[~A-Za-z]|^\x1bO[A-Za-z]/.exec(rest);
      if (!match) return null; // incomplete CSI sequence: wait for the rest
      const seq = match[0];
      const table: Record<string, InputKey> = {
        '\x1b[A': { type: 'up' },
        '\x1b[B': { type: 'down' },
        '\x1b[C': { type: 'right' },
        '\x1b[D': { type: 'left' },
        '\x1b[H': { type: 'home' },
        '\x1b[F': { type: 'end' },
        '\x1b[1~': { type: 'home' },
        '\x1b[4~': { type: 'end' },
        '\x1b[7~': { type: 'home' },
        '\x1b[8~': { type: 'end' },
        '\x1b[3~': { type: 'delete' },
        '\x1bOH': { type: 'home' },
        '\x1bOF': { type: 'end' },
        '\x1bOA': { type: 'up' },
        '\x1bOB': { type: 'down' },
        '\x1bOC': { type: 'right' },
        '\x1bOD': { type: 'left' },
      };
      return { key: table[seq] ?? { type: 'escape' }, length: seq.length };
    }
    // Alt+Enter inserts a newline; any other Alt+key is swallowed.
    if (rest[1] === '\r' || rest[1] === '\n') return { key: { type: 'newline' }, length: 2 };
    return { key: { type: 'escape' }, length: 1 };
  }
  if (ch === '\r') return { key: { type: 'enter' }, length: 1 };
  if (ch === '\n') return { key: { type: 'newline' }, length: 1 };
  if (ch === '\t') return { key: { type: 'tab' }, length: 1 };
  if (ch === '\x7f' || ch === '\b') return { key: { type: 'backspace' }, length: 1 };
  if (ch === '\x03') return { key: { type: 'cancel' }, length: 1 };
  if (ch === '\x04') return { key: { type: 'cancel' }, length: 1 }; // Ctrl+D on an empty box behaves like Ctrl+C
  if (ch === '\x01') return { key: { type: 'home' }, length: 1 };
  if (ch === '\x05') return { key: { type: 'end' }, length: 1 };
  const code = ch.charCodeAt(0);
  if (code < 0x20) return { key: { type: 'escape' }, length: 1 };
  // Plain text run: consume up to the next control character for fast paste/CJK input.
  let end = index;
  while (end < buffer.length) {
    const c = buffer.charCodeAt(end);
    if (c < 0x20 || c === 0x7f) break;
    end += 1;
  }
  return { key: { type: 'text', value: buffer.slice(index, end) }, length: Math.max(1, end - index) };
}

/** ANSI styling, RTL/Persian-safe text shaping, live activity indicator, and boxed input. */

export class Ui {

  readonly colorEnabled: boolean;

  readonly jsonMode: boolean;

  readonly interactive: boolean;

  private rl: readline.Interface | null = null;

  private pendingLines: string[] = [];

  private pendingInputs: { resolve: (line: string) => void; reject: (err: Error) => void }[] = [];

  private streamBuffer = '';

  /** True while an assistant answer is being written (gutter + fence state). */
  private answerOpen = false;

  /** False until the ✦ marker has been written for this answer. */
  private answerMarkerWritten = false;

  /** Active code-fence language, or null outside a fence. */
  private answerFence: string | null = null;

  private activityTimer: ReturnType<typeof setInterval> | null = null;

  private activityLabel = '';

  private activityFrame = 0;

  private activityVisible = false;

  private readonly interruptListeners = new Set<() => void>();

  constructor(options: { json?: boolean; noColor?: boolean; forceNonInteractive?: boolean; forceColor?: boolean } = {}) {

    this.jsonMode = options.json ?? false;

    this.interactive = !options.forceNonInteractive && Boolean(stdin.isTTY) && !this.jsonMode;

    this.colorEnabled =
      !options.noColor &&
      !this.jsonMode &&
      (options.forceColor ?? (Boolean(stdout.isTTY) && process.env['NO_COLOR'] === undefined));

    // Ensure UTF-8 encoding on stdio so Persian/RTL characters never break or garble.
    try {
      if (typeof stdin.setEncoding === 'function') stdin.setEncoding('utf8');
      if (typeof stdout.setDefaultEncoding === 'function') stdout.setDefaultEncoding('utf8');
    } catch {
      /* ignore if stream does not allow encoding changes */
    }
  }

  private paint(code: string, s: string): string {
    return this.colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : s;
  }

  /** Paint with 24-bit TrueColor RGB. */
  rgb(r: number, g: number, b: number, s: string): string {
    return this.paint(`38;2;${r};${g};${b}`, s);
  }

  /** Paint background with 24-bit TrueColor RGB. */
  bgRgb(r: number, g: number, b: number, s: string): string {
    return this.paint(`48;2;${r};${g};${b}`, s);
  }

  /** Brand primary color #8B9A6E (139, 154, 110). */
  brand(s: string): string {
    return this.rgb(BRAND_RGB[0], BRAND_RGB[1], BRAND_RGB[2], s);
  }

  /** Brand bold #8B9A6E. */
  brandBold(s: string): string {
    return this.colorEnabled ? `\x1b[1;38;2;${BRAND_RGB[0]};${BRAND_RGB[1]};${BRAND_RGB[2]}m${s}\x1b[0m` : s;
  }

  /** Lighter accent of #8B9A6E for highlights. */
  brandLight(s: string): string {
    return this.rgb(BRAND_LIGHT_RGB[0], BRAND_LIGHT_RGB[1], BRAND_LIGHT_RGB[2], s);
  }

  /** Darker shade of #8B9A6E for borders and subtle chrome. */
  brandDark(s: string): string {
    return this.rgb(BRAND_DARK_RGB[0], BRAND_DARK_RGB[1], BRAND_DARK_RGB[2], s);
  }

  /** High-contrast badge with #8B9A6E background. */
  brandBadge(s: string): string {
    return this.colorEnabled ? `\x1b[1;38;2;15;18;12;48;2;${BRAND_RGB[0]};${BRAND_RGB[1]};${BRAND_RGB[2]}m ${s} \x1b[0m` : `[${s}]`;
  }

  bold(s: string): string { return this.paint('1', s); }

  dim(s: string): string { return this.paint('2', s); }

  red(s: string): string { return this.paint('31', s); }

  green(s: string): string { return this.brandLight(s); }

  yellow(s: string): string { return this.paint('33', s); }

  blue(s: string): string { return this.brand(s); }

  magenta(s: string): string { return this.brandBold(s); }

  cyan(s: string): string { return this.brand(s); }

  /**

   * Normalize Persian/Arabic text for clean terminal rendering:

   * - NFC composition so detached hamza/yeh/kaf combine cleanly

   * - Zero-Width Non-Joiner (ZWNJ) preserved for proper Persian word joining

   * - Only the RTL text runs are wrapped in FSI…PDI isolates, so ANSI styling

   *   and LTR paths/commands inside the same line can never reorder the text

   *   or break the box borders.

   */

  formatPersianText(text: string): string {
    const normalized = text.normalize('NFC');
    if (!RTL_CHAR_RE.test(normalized)) return normalized;
    return normalized
      .split('\n')
      .map((line) => {
        if (!RTL_CHAR_RE.test(line)) return line;
        return line
          .split(/(\x1b\[[0-9;]*m)/)
          .map((part) => (part.startsWith('\x1b[') || !RTL_CHAR_RE.test(part) ? part : `\u2068${part}\u2069`))
          .join('');
      })
      .join('\n');
  }

  /** Visible character width ignoring ANSI codes and zero-width BiDi marks. */
  visibleLength(s: string): number {
    const clean = s.replace(ANSI_STRIP_RE, '').replace(ZERO_WIDTH_RE, '').normalize('NFC');
    return [...clean].length;
  }

  /**
   * Color the decorative marks of agent output — heading hashes, list bullets,
   * ordered markers, quotes, rules and inline code — while keeping the text
   * itself untouched. RTL isolation is applied afterwards.
   */
  formatAgentText(text: string): string {
    if (!this.colorEnabled) return this.formatPersianText(text);
    const colored = text.split('\n').map((line) => this.colorizeLine(line)).join('\n');
    return this.formatPersianText(colored);
  }

  private colorizeLine(line: string): string {
    if (line.trim() === '') return line;
    const indent = /^(\s*)/.exec(line)![1] ?? '';
    const body = line.slice(indent.length);
    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(body)) return `${indent}${this.brandDark(body.trim())}`;
    const heading = /^(#{1,6})(\s+)(.*)$/.exec(body);
    if (heading) return `${indent}${this.brandDark(heading[1]!)}${heading[2]}${this.brandBold(this.colorizeInline(heading[3]!))}`;
    const bullet = /^([-*+•])(\s+)(.*)$/.exec(body);
    if (bullet) return `${indent}${this.brandLight(bullet[1]!)}${bullet[2]}${this.colorizeInline(bullet[3]!)}`;
    const ordered = /^(\d+[.)])(\s+)(.*)$/.exec(body);
    if (ordered) return `${indent}${this.brandLight(ordered[1]!)}${ordered[2]}${this.colorizeInline(ordered[3]!)}`;
    const quote = /^(>)(\s?)(.*)$/.exec(body);
    if (quote) return `${indent}${this.brandDark(quote[1]!)}${quote[2]}${this.colorizeInline(quote[3]!)}`;
    return `${indent}${this.colorizeInline(body)}`;
  }

  private colorizeInline(text: string): string {
    return text
      .split(/(`[^`]+`|\*\*[^*]+\*\*)/)
      .map((part) => {
        if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
          return `${this.brandDark('`')}${this.brandLight(part.slice(1, -1))}${this.brandDark('`')}`;
        }
        if (part.length >= 4 && part.startsWith('**') && part.endsWith('**')) {
          return `${this.brandDark('**')}${this.brandBold(part.slice(2, -2))}${this.brandDark('**')}`;
        }
        return part;
      })
      .join('');
  }

  /** Print a non-streamed assistant answer through the same renderer. */
  answer(text: string): void {
    if (this.jsonMode || text === '') return;
    this.startAnswer();
    this.token(text);
    this.endStream();
  }

  /* ---------------------------------------------------------------- */
  /* Activity indicator ("Thinking…")                                  */
  /* ---------------------------------------------------------------- */

  /** Show a live spinner line; the returned stop function is idempotent. */
  startActivity(label: string): () => void {
    if (!this.interactive || this.jsonMode) return () => undefined;
    this.stopActivity();
    this.activityLabel = this.formatPersianText(label);
    this.activityFrame = 0;
    this.activityVisible = true;
    this.drawActivity();
    this.activityTimer = setInterval(() => {
      this.activityFrame += 1;
      this.drawActivity();
    }, 90);
    if (typeof this.activityTimer.unref === 'function') this.activityTimer.unref();
    return () => this.stopActivity();
  }

  /** Clear the spinner line without printing a newline. */
  stopActivity(): void {
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
    if (this.activityVisible) {
      stdout.write('\r\x1b[2K');
      this.activityVisible = false;
    }
  }

  private drawActivity(): void {
    const frame = this.brandLight(SPINNER_FRAMES[this.activityFrame % SPINNER_FRAMES.length]!);
    stdout.write(`\r${frame} ${this.brand(this.activityLabel)}   `);
  }

  /* ---------------------------------------------------------------- */
  /* Output                                                            */
  /* ---------------------------------------------------------------- */

  info(msg: string): void { if (!this.jsonMode) { this.stopActivity(); stdout.write(`${this.formatPersianText(msg)}\n`); } }

  step(msg: string): void { if (!this.jsonMode) { this.stopActivity(); stdout.write(`${this.brandBold('◈')} ${this.formatPersianText(msg)}\n`); } }

  success(msg: string): void { if (!this.jsonMode) { this.stopActivity(); stdout.write(`${this.brandLight('✔')} ${this.formatPersianText(msg)}\n`); } }

  warn(msg: string): void { if (!this.jsonMode) { this.stopActivity(); stdout.write(`${this.yellow('⚠')} ${this.formatPersianText(msg)}\n`); } }

  error(msg: string): void { this.stopActivity(); process.stderr.write(`${this.red('✖')} ${this.formatPersianText(msg)}\n`); }

  /**

   * Streamed model tokens. Tokens are buffered until a word boundary so a

   * Persian word is never written in pieces — partial writes are what make

   * RTL text render disconnected/"fragmented" in many terminals.

   */

  /**
   * Begin an assistant answer: one blank line, then the ✦ marker on the first
   * content row. Every following row is indented under it, so wrapped prose,
   * lists and code read as one block instead of raggedly hitting column 0.
   */
  startAnswer(): void {
    if (this.jsonMode) return;
    this.stopActivity();
    if (this.answerOpen) this.endStream();
    this.answerOpen = true;
    this.answerMarkerWritten = false;
    this.answerFence = null;
    this.streamBuffer = '';
    stdout.write('\n');
  }

  /**
   * Streamed model tokens.
   *
   * Text is buffered per logical line and rendered whole, so inline markdown,
   * RTL isolation and wrapping are decided once per line instead of per token
   * (partial words used to leave broken BiDi isolates and unformatted halves).
   * A long unterminated line is flushed at a word boundary so streaming still
   * feels live.
   */
  token(chunk: string): void {
    if (this.jsonMode) return;
    this.stopActivity();
    if (!this.answerOpen) this.startAnswer();
    this.streamBuffer += chunk.normalize('NFC').replace(/\r\n/g, '\n');
    this.pump(false);
  }

  /** Finish the current answer (idempotent: no stray newline when idle). */
  endStream(): void {
    if (this.jsonMode) return;
    this.stopActivity();
    if (!this.answerOpen) return;
    this.pump(true);
    if (this.answerFence !== null) {
      this.writeAnswerRow(this.brandDark('└─'), 'fence');
      this.answerFence = null;
    }
    // Rows always end with a newline, so no extra blank line is added here.
    this.answerOpen = false;
    this.answerMarkerWritten = false;
    this.streamBuffer = '';
  }

  /** Columns available for answer content (gutter and margin excluded). */
  private answerWidth(): number {
    const columns = stdout.columns ?? 80;
    // Leave a safety column: a row that exactly fills the terminal still wraps.
    return Math.max(24, Math.min(columns - 8, 120));
  }

  private pump(final: boolean): void {
    let buffer = this.streamBuffer;
    if (buffer !== '') {
      let index = 0;
      for (;;) {
        const nl = buffer.indexOf('\n', index);
        if (nl === -1) break;
        this.renderAnswerLine(buffer.slice(index, nl));
        index = nl + 1;
      }
      buffer = buffer.slice(index);
      if (!final && buffer !== '') {
        // Keep the stream moving on a very long paragraph, breaking on a space.
        if (displayWidth(buffer) > this.answerWidth() * 3) {
          const cut = buffer.lastIndexOf(' ');
          if (cut > 0) {
            this.renderAnswerLine(buffer.slice(0, cut));
            buffer = buffer.slice(cut + 1);
          }
        }
      }
    }
    this.streamBuffer = buffer;
    if (final && buffer !== '') {
      this.renderAnswerLine(buffer);
      this.streamBuffer = '';
    }
  }

  private renderAnswerLine(rawLine: string): void {
    const line = rawLine.replace(/\t/g, '  ').replace(/\s+$/, '');

    const fence = /^\s*```\s*(\S*)\s*$/.exec(line);
    if (fence) {
      if (this.answerFence === null) {
        const language = fence[1] === '' ? undefined : fence[1];
        this.answerFence = language ?? 'code';
        this.writeAnswerRow(`${this.brandDark('┌─')}${language !== undefined ? ` ${this.dim(language)}` : ''}`, 'fence');
      } else {
        this.answerFence = null;
        this.writeAnswerRow(this.brandDark('└─'), 'fence');
      }
      return;
    }

    if (this.answerFence !== null) {
      if (line === '') {
        this.writeAnswerRow('', 'code');
        return;
      }
      for (const row of wrapLogicalLine(line, this.answerWidth())) this.writeAnswerRow(row.text, 'code');
      return;
    }

    if (line.trim() === '') {
      this.writeAnswerRow('', 'blank');
      return;
    }

    // A thematic break becomes a real rule instead of three literal hyphens.
    if (/^([-*_])(?:\s*\1){2,}$/.test(line.trim())) {
      this.writeAnswerRow(this.brandDark('─'.repeat(this.answerWidth())), 'text');
      return;
    }

    // Continuation of a list item / quote hangs under its own text.
    const marker = /^(\s*(?:[-*+]|\d+[.)]|>)\s+)/.exec(line)?.[1] ?? '';
    const hang = Math.min(4, displayWidth(marker));
    const rows = wrapLogicalLine(line, hang > 0 ? this.answerWidth() - hang : this.answerWidth());
    rows.forEach((row, index) => {
      const text = index === 0 || hang === 0 ? row.text : `${' '.repeat(hang)}${row.text}`;
      this.writeAnswerRow(this.formatAgentText(text), 'text');
    });
  }

  private writeAnswerRow(styled: string, kind: 'text' | 'blank' | 'code' | 'fence'): void {
    if (kind === 'blank') {
      if (this.answerMarkerWritten) stdout.write('\n');
      return;
    }
    const lead = this.answerMarkerWritten ? '    ' : `  ${this.brandLight('✦')} `;
    this.answerMarkerWritten = true;
    if (kind === 'text' || kind === 'fence') {
      stdout.write(`${lead}${styled}\n`);
      return;
    }
    stdout.write(`${lead}${this.brandDark('│')} ${styled}\n`);
  }

  /* ---------------------------------------------------------------- */
  /* Splash                                                            */
  /* ---------------------------------------------------------------- */

/**
   * Animated console splash screen with #8B9A6E theme, KT Operator banner,
   * "MadeByKariz" slogan, and smooth loading bar.
   */
  async splashScreen(version: string): Promise<void> {
    if (this.jsonMode) return;

    const logoLines = [
      '  ██╗  ██╗████████╗     ██████╗ ██████╗ ███████╗██████╗  █████╗ ████████╗ ██████╗ ██████╗ ',
      '  ██║ ██╔╝╚══██╔══╝    ██╔═══██╗██╔══██╗██╔════╝██╔══██╗██╔══██╗╚══██╔══╝██╔═══██╗██╔══██╗',
      '  █████╔╝    ██║       ██║   ██║██████╔╝█████╗  ██████╔╝███████║   ██║   ██║   ██║██████╔╝',
      '  ██╔═██╗    ██║       ██║   ██║██╔═══╝ ██╔══╝  ██╔══██╗██╔══██║   ██║   ██║   ██║██╔══██╗',
      '  ██║  ██╗   ██║       ╚██████╔╝██║     ███████╗██║  ██║██║  ██║   ██║   ╚██████╔╝██║  ██║',
      '  ╚═╝  ╚═╝   ╚═╝        ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝',
    ];

    const divider = this.brandDark(`  ${'━'.repeat(88)}`); // matches the 90-column logo

    stdout.write('\n');
    for (let i = 0; i < logoLines.length; i++) {
      const shade = i < 2 ? this.brandLight(logoLines[i]!) : i < 4 ? this.brandBold(logoLines[i]!) : this.brand(logoLines[i]!);
      stdout.write(`${shade}\n`);
    }
    stdout.write(`${divider}\n`);
    stdout.write(
      `  ${this.brandBadge('KT Operator')} ${this.brandLight(`v${version}`)}  ${this.brandDark('│')}  ${this.brandBold('✦ MadeByKariz ✦')}  ${this.brandDark('│')}  ${this.dim('Ready to Help')}\n`,
    );
    stdout.write(`${divider}\n`);

    if (!this.interactive) {
      stdout.write('\n');
      return;
    }

    // Smooth console loading animation in #8B9A6E theme
    const stages = [
      'Initializing security engine...',
      'Loading multi-provider adapters...',
      'Configuring UTF-8 terminal...',
      'KT Operator Ready!',
    ];
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const totalTicks = 16;
    const barWidth = 28;

    for (let tick = 0; tick <= totalTicks; tick++) {
      const ratio = tick / totalTicks;
      const filled = Math.round(ratio * barWidth);
      const empty = barWidth - filled;
      const bar = `${this.brandBold('█'.repeat(filled))}${this.brandDark('░'.repeat(empty))}`;
      const pct = String(Math.round(ratio * 100)).padStart(3, ' ');
      const frame = this.brandLight(frames[tick % frames.length]!);
      const stageIdx = Math.min(stages.length - 1, Math.floor(ratio * stages.length));
      const stageText = this.brand(stages[stageIdx]!);
      stdout.write(`\r  ${frame} [${bar}] ${this.brandBold(`${pct}%`)} ${stageText}          `);
      await new Promise((r) => setTimeout(r, 35));
    }
    stdout.write(
      `\r  ${this.brandLight('✔')} [${this.brandBold('█'.repeat(barWidth))}] ${this.brandBold('100%')} ${this.brandLight('KT Operator Ready ·')}            \n\n`,
    );
  }

  /** Run an async task with an inline #8B9A6E spinner in interactive mode. */

  async withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {

    if (!this.interactive || this.jsonMode) {
      this.step(label);
      return fn();
    }

    const formatted = this.formatPersianText(label);
    const stop = this.startActivity(label);
    try {
      const result = await fn();
      stop();
      stdout.write(`${this.brandLight('✔')} ${this.brand(formatted)}\n`);
      return result;
    } catch (err) {
      stop();
      stdout.write(`${this.red('✖')} ${formatted}\n`);
      throw err;
    }

  }

  /** Emit a machine-readable result; in human mode render via `render`. */

  emit(data: unknown, render?: (data: never) => string): void {

    if (this.jsonMode) {
      stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    } else if (render) {
      const out = render(data as never);
      if (out !== '') stdout.write(`${this.formatPersianText(out)}\n`);
    }

  }

  /* ---------------------------------------------------------------- */
  /* Line input (readline)                                             */
  /* ---------------------------------------------------------------- */

  private getRl(): readline.Interface {

    if (!this.rl) {
      this.rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
      this.rl.on('line', (line) => {
        const normalized = line.normalize('NFC');
        const pending = this.pendingInputs.shift();
        if (pending) pending.resolve(normalized);
        else this.pendingLines.push(normalized);
        this.maybePause();
      });
      this.rl.on('close', () => {
        this.rl = null;
        for (const pending of this.pendingInputs.splice(0)) pending.reject(new UserCancelledError());
      });
      this.rl.on('SIGINT', () => {
        this.notifyInterrupt();
        const pending = this.pendingInputs.shift();
        pending?.reject(new UserCancelledError());
      });
    }

    return this.rl;
  }

  private maybePause(): void {
    if (this.rl && this.pendingInputs.length === 0 && this.pendingLines.length === 0) this.rl.pause();
  }

  /** Ask one line of input, honoring queued typeahead first. */

  private lineQuestion(promptText: string): Promise<string> {

    if (!this.interactive) return Promise.reject(new UserCancelledError('Interactive input requested in a non-interactive session.'));

    this.stopActivity();

    if (this.pendingLines.length > 0) {
      const line = this.pendingLines.shift()!;
      stdout.write(`${promptText}${line}\n`);
      return Promise.resolve(line);
    }

    const rl = this.getRl();
    rl.resume();
    stdout.write(promptText);
    return new Promise<string>((resolve, reject) => {
      this.pendingInputs.push({
        resolve: (line) => resolve(line),
        reject: (err) => reject(err),
      });
    });

  }

  /** Low-level single-line prompt (non-chat flows). */

  async question(prompt: string): Promise<string> {
    return this.lineQuestion(prompt);
  }

  /* ---------------------------------------------------------------- */
  /* Boxed, multi-line chat input                                      */
  /* ---------------------------------------------------------------- */

  /**

   * Chat input rendered as a bordered text-area: the box grows with the text,

   * wraps on grapheme boundaries, accepts multiple lines (Ctrl+J / Alt+Enter)

   * and shows a filtered slash-command menu with help text.

   */
  async promptTextArea(options: TextAreaOptions = {}): Promise<string> {
    if (!this.interactive || this.jsonMode) {
      throw new UserCancelledError('Interactive input requested in a non-interactive session.');
    }
    this.stopActivity();

    if (this.pendingLines.length > 0) {
      const queued = this.pendingLines.shift()!;
      stdout.write(`${queued}\n`);
      return queued;
    }

    // Detach the line reader completely: a paused readline interface still
    // echoes and consumes the same keystrokes on some terminals, which made
    // typed text appear twice and corrupted the box.
    if (this.rl) {
      const rl = this.rl;
      this.rl = null;
      try {
        rl.close();
      } catch {
        /* already closed */
      }
    }

    const title = options.title ?? 'you';
    const hint = options.hint ?? this.buildHint();
    const state = { value: '', cursor: 0, selection: 0, menuDismissed: false };
    const history = options.history ?? [];
    let historyIndex = history.length; // equals the length → editing the draft
    let historyDraft = '';

    return new Promise<string>((resolve, reject) => {
      let finished = false;
      let drawnLines = 0;
      let cursorLine = 0;
      let pending = '';
      let pasting = false;
      let pasteBuffer = '';
      let escapeTimer: ReturnType<typeof setTimeout> | null = null;

      const menuItems = (): CommandSuggestion[] => {
        if (state.menuDismissed) return [];
        return options.suggestions?.(state.value) ?? [];
      };

      const layout = (width: number) => {
        const rows: WrappedRow[] = [];
        let offset = 0;
        for (const line of state.value.split('\n')) {
          for (const row of wrapLogicalLine(line, width)) {
            rows.push({ text: row.text, start: offset + row.start, end: offset + row.end });
          }
          offset += line.length + 1;
        }
        let cursorRow = 0;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i]!.start <= state.cursor) cursorRow = i;
        }
        const row = rows[cursorRow]!;
        const upto = Math.max(row.start, Math.min(state.cursor, row.end));
        const cursorCol = Math.min(displayWidth(state.value.slice(row.start, upto)), width);
        return { rows, cursorRow, cursorCol };
      };

      const build = (withFooter: boolean) => {
        const width = Math.max(32, Math.min((stdout.columns ?? 80) - 2, 96));
        const inner = width - 4;
        const { rows, cursorRow, cursorCol } = layout(inner);
        const titleText = this.formatPersianText(title);
        const subText = options.subtitle ? this.formatPersianText(options.subtitle) : '';
        const titleLen = displayWidth(titleText);
        const subLen = displayWidth(subText);
        const gap = width - titleLen - subLen - (subText ? 7 : 5);
        const top = subText && gap >= 3
          ? `${this.brand('╭')}${this.brandDark('─')} ${this.brandBold(titleText)} ${this.brandDark('─'.repeat(gap))} ${this.dim(subText)} ${this.brand('╮')}`
          : `${this.brand('╭')}${this.brandDark('─')} ${this.brandBold(titleText)} ${this.brandDark('─'.repeat(Math.max(1, width - titleLen - 5)))}${this.brand('╮')}`;
        const lines: string[] = [top];
        for (const row of rows) {
          const pad = ' '.repeat(Math.max(0, inner - displayWidth(row.text)));
          lines.push(`${this.brandDark('│')} ${row.text}${pad} ${this.brandDark('│')}`);
        }
        lines.push(`${this.brand('╰')}${this.brandDark('─'.repeat(width - 2))}${this.brand('╯')}`);
        const items = withFooter ? menuItems() : [];
        if (withFooter) {
          if (items.length > 0) {
            const nameWidth = Math.min(18, Math.max(...items.map((i) => displayWidth(i.command))) + 2);
            const helpWidth = Math.max(0, width - 4 - nameWidth);
            items.forEach((item, index) => {
              const marker = index === state.selection ? this.brandBold('▸') : ' ';
              const pad = ' '.repeat(Math.max(0, nameWidth - displayWidth(item.command)));
              const label = index === state.selection ? this.brand(item.command) : this.dim(item.command);
              lines.push(`  ${marker} ${label}${pad}${this.dim(truncateToWidth(item.help, helpWidth))}`);
            });
            lines.push(this.dim(`  ${truncateToWidth('↑↓ move · Tab complete · ↵ run · Esc close', width - 2)}`));
          } else if (hint !== '') {
            // Never let a long hint wrap: a wrapped line would break cursor math.
            lines.push(`  ${truncateToWidth(hint, width - 2)}`);
          }
        }
        return { lines, targetLine: 1 + cursorRow, targetCol: 2 + cursorCol };
      };

      const render = (withFooter: boolean): void => {
        const { lines, targetLine, targetCol } = build(withFooter);
        let out = '';
        if (drawnLines > 0) {
          out += '\r';
          if (cursorLine > 0) out += `\x1b[${cursorLine}A`;
          out += '\x1b[J';
        }
        out += lines.join('\n');
        if (withFooter) {
          const up = lines.length - 1 - targetLine;
          if (up > 0) out += `\x1b[${up}A`;
          out += '\r';
          if (targetCol > 0) out += `\x1b[${targetCol}C`;
        }
        stdout.write(out);
        drawnLines = lines.length;
        cursorLine = withFooter ? targetLine : lines.length - 1;
      };

      const erase = (): void => {
        if (drawnLines === 0) return;
        let out = '\r';
        if (cursorLine > 0) out += `\x1b[${cursorLine}A`;
        out += '\x1b[J';
        stdout.write(out);
        drawnLines = 0;
        cursorLine = 0;
      };

      const cleanup = (): void => {
        if (escapeTimer) {
          clearTimeout(escapeTimer);
          escapeTimer = null;
        }
        stdin.removeListener('data', onData);
        if (stdin.isTTY) stdin.setRawMode(false);
        stdout.write('\x1b[?2004l');
        stdin.pause();
      };

      const finish = (value: string): void => {
        if (finished) return;
        finished = true;
        cleanup();
        render(false);
        stdout.write('\n');
        drawnLines = 0;
        resolve(value);
      };

      const cancel = (): void => {
        if (finished) return;
        finished = true;
        cleanup();
        erase();
        this.notifyInterrupt();
        reject(new UserCancelledError());
      };

      const insertText = (text: string): void => {
        const clean = text.replace(CONTROL_CHARS_RE, '');
        if (clean === '') return;
        state.value = state.value.slice(0, state.cursor) + clean + state.value.slice(state.cursor);
        state.cursor += clean.length;
        state.menuDismissed = false;
        state.selection = 0;
      };

      const prevGraphemeLength = (at: number): number => {
        if (at === 0) return 0;
        const before = state.value.slice(0, at);
        const cells = graphemes(before);
        return cells.length > 0 ? cells[cells.length - 1]!.length : 0;
      };

      const nextGraphemeLength = (at: number): number => {
        if (at >= state.value.length) return 0;
        const cells = graphemes(state.value.slice(at));
        return cells.length > 0 ? cells[0]!.length : 0;
      };

      /** Move the caret up/down between wrapped visual rows, keeping the column. */
      const moveVertical = (direction: -1 | 1): void => {
        const width = Math.max(32, Math.min((stdout.columns ?? 80) - 2, 96)) - 4;
        const { rows, cursorRow, cursorCol } = layout(width);
        const next = rows[cursorRow + direction];
        if (!next) return;
        let textOffset = 0;
        let column = 0;
        for (const cluster of graphemes(state.value.slice(next.start, next.end))) {
          const w = charWidth(cluster);
          if (column + w > cursorCol) break;
          column += w;
          textOffset += cluster.length;
        }
        state.cursor = next.start + textOffset;
      };

      /**
       * Shell-style recall: ↑ at the top row walks backwards through earlier
       * prompts, ↓ at the bottom row walks forwards back to the draft. Rows
       * in between keep moving the caret, so multi-line editing is untouched.
       */
      const recall = (direction: -1 | 1): boolean => {
        if (history.length === 0) return false;
        const width = Math.max(32, Math.min((stdout.columns ?? 80) - 2, 96)) - 4;
        const { rows, cursorRow } = layout(width);
        if (direction === -1 && cursorRow !== 0) return false;
        if (direction === 1 && cursorRow !== rows.length - 1) return false;
        const next = recallHistory(history, historyIndex, direction, historyDraft, state.value);
        if (!next.handled) return false;
        historyIndex = next.index;
        historyDraft = next.draft;
        state.value = next.value;
        state.cursor = state.value.length;
        state.menuDismissed = false;
        state.selection = 0;
        return true;
      };

      const handle = (key: InputKey): void => {
        switch (key.type) {
          case 'text':
            insertText(key.value);
            return render(true);
          case 'newline':
            insertText('\n');
            return render(true);
          case 'enter': {
            const items = menuItems();
            if (items.length > 0) {
              const chosen = items[Math.min(state.selection, items.length - 1)]!;
              state.value = chosen.command;
              state.cursor = state.value.length;
            }
            return finish(state.value);
          }
          case 'tab': {
            const items = menuItems();
            if (items.length > 0) {
              const chosen = items[Math.min(state.selection, items.length - 1)]!;
              state.value = `${chosen.command} `;
              state.cursor = state.value.length;
              state.menuDismissed = true;
              return render(true);
            }
            insertText('  ');
            return render(true);
          }
          case 'backspace': {
            const len = prevGraphemeLength(state.cursor);
            if (len > 0) {
              state.value = state.value.slice(0, state.cursor - len) + state.value.slice(state.cursor);
              state.cursor -= len;
            }
            return render(true);
          }
          case 'delete': {
            const len = nextGraphemeLength(state.cursor);
            if (len > 0) state.value = state.value.slice(0, state.cursor) + state.value.slice(state.cursor + len);
            return render(true);
          }
          case 'left': {
            state.cursor = Math.max(0, state.cursor - prevGraphemeLength(state.cursor));
            return render(true);
          }
          case 'right': {
            state.cursor = Math.min(state.value.length, state.cursor + nextGraphemeLength(state.cursor));
            return render(true);
          }
          case 'home': {
            state.cursor = state.value.lastIndexOf('\n', Math.max(0, state.cursor - 1)) + 1;
            return render(true);
          }
          case 'end': {
            const nextBreak = state.value.indexOf('\n', state.cursor);
            state.cursor = nextBreak === -1 ? state.value.length : nextBreak;
            return render(true);
          }
          case 'up':
          case 'down': {
            const items = menuItems();
            if (items.length > 0) {
              const delta = key.type === 'up' ? -1 : 1;
              state.selection = Math.max(0, Math.min(state.selection + delta, items.length - 1));
              return render(true);
            }
            if (recall(key.type === 'up' ? -1 : 1)) return render(true);
            moveVertical(key.type === 'up' ? -1 : 1);
            return render(true);
          }
          case 'escape': {
            if (menuItems().length > 0) {
              state.menuDismissed = true;
              state.selection = 0;
              return render(true);
            }
            return;
          }
          case 'cancel':
            return cancel();
        }
      };

      const consume = (): void => {
        if (escapeTimer) {
          clearTimeout(escapeTimer);
          escapeTimer = null;
        }
        if (pasting) {
          const end = pending.indexOf(PASTE_END);
          if (end < 0) {
            pasteBuffer += pending;
            pending = '';
            return;
          }
          pasteBuffer += pending.slice(0, end);
          pending = pending.slice(end + PASTE_END.length);
          pasting = false;
          insertText(pasteBuffer.replace(/\r\n?/g, '\n'));
          pasteBuffer = '';
          render(true);
        }
        while (pending.length > 0 && !finished) {
          if (pending.startsWith(PASTE_START)) {
            pending = pending.slice(PASTE_START.length);
            pasting = true;
            pasteBuffer = '';
            return consume();
          }
          if (pending[0] === '\x1b' && pending.length === 1) {
            // A lone ESC may be the Escape key: decide after a very short pause.
            escapeTimer = setTimeout(() => {
              escapeTimer = null;
              if (pending === '\x1b') {
                pending = '';
                handle({ type: 'escape' });
              }
            }, 45);
            if (typeof escapeTimer.unref === 'function') escapeTimer.unref();
            return;
          }
          const parsed = parseChatKey(pending, 0);
          if (!parsed) {
            if (pending.length > 32) pending = ''; // malformed/desynced sequence: drop it
            return;
          }
          pending = pending.slice(parsed.length);
          handle(parsed.key);
        }
      };

      function onData(chunk: Buffer | string): void {
        pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        consume();
      }

      stdout.write('\x1b[?2004h');
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
      stdout.write('\r');
      render(true);
    });
  }

  /** Default key hint with colored separators. */
  private buildHint(parts?: readonly string[]): string {
    const items = parts ?? ['↵ send', 'Ctrl+J newline', `${this.brand('/')} commands`, 'Ctrl+C ×2 exit'];
    return items.map((part) => this.dim(part)).join(this.brandDark(' · '));
  }

  /* ---------------------------------------------------------------- */
  /* Other prompts                                                     */
  /* ---------------------------------------------------------------- */

  /** Free-form input. `mask` replaces typed characters (API keys). */

  async promptInput(question: string, options: { mask?: boolean; defaultValue?: string; required?: boolean } = {}): Promise<string> {

    if (!this.interactive) throw new UserCancelledError('Interactive input requested in a non-interactive session.');

    const styledQ = this.brandBold(`◈ ${this.formatPersianText(question)}`);

    if (!options.mask) {

      const suffix = options.defaultValue ? ` ${this.dim(`(${options.defaultValue})`)}` : '';

      const answer = await this.lineQuestion(`${styledQ}${suffix}: `);

      const value = answer.trim() === '' && options.defaultValue !== undefined ? options.defaultValue : answer.trim();

      if (options.required && value === '') throw new UserCancelledError('A value is required.');

      return value.normalize('NFC');

    }

    if (this.pendingLines.length > 0) {

      const typed = this.pendingLines.shift()!;

      if (options.required && typed.trim() === '') throw new UserCancelledError('A value is required.');

      stdout.write(`${styledQ}: ${this.brandLight('*'.repeat(typed.trim().length))}\n`);

      return typed.trim();

    }

    // Masked input needs raw mode: close the line reader so it cannot fight for stdin.
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    return new Promise<string>((resolve, reject) => {

      let buf = '';

      const cleanup = () => {
        stdin.removeListener('data', onData);
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
      };

      const finish = (err?: Error) => {

        cleanup();

        stdout.write('\n');

        if (err !== undefined) { this.notifyInterrupt(); reject(err); }

        else if (options.required && buf.trim() === '') reject(new UserCancelledError('A value is required.'));

        else resolve(buf.trim().normalize('NFC'));

      };

      const onData = (chunk: Buffer | string) => {

        const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

        for (const ch of str) {

          if (ch === '\u0003') { finish(new UserCancelledError()); return; }

          if (ch === '\r' || ch === '\n') { finish(); return; }

          if (ch === '\u007f' || ch === '\b') {
            if (buf.length > 0) {
              buf = [...buf].slice(0, -1).join('');
              stdout.write('\b \b');
            }
          } else {
            buf += ch;
            stdout.write(this.brandLight('*'));
          }

        }

      };

      if (stdin.isTTY) stdin.setRawMode(true);

      stdin.resume();

      stdout.write(`${styledQ}: `);

      stdin.on('data', onData);

    });

  }

  /** Single-key choice, e.g. approval prompts. Returns the chosen key. */

  async promptChoice(question: string, choices: readonly { key: string; label: string }[]): Promise<string> {

    if (!this.interactive) throw new UserCancelledError('Approval requested in a non-interactive session.');

    const rendered = choices.map((c) => `${this.brandDark('[')}${this.brandBold(c.key)}${this.brandDark(']')} ${c.label}`).join('   ');

    const valid = new Set(choices.map((c) => c.key.toLowerCase()));

    for (;;) {

      const answer = (await this.lineQuestion(`${this.brandBold('◈')} ${this.formatPersianText(question)}\n  ${rendered}: `)).trim().toLowerCase();

      if (valid.has(answer)) return answer;

      stdout.write(`Please answer one of: ${choices.map((c) => c.key).join(', ')}\n`);

    }

  }

  async confirm(question: string, defaultNo = true): Promise<boolean> {

    const answer = await this.promptChoice(question, [
      { key: 'y', label: this.brandLight('yes') },
      { key: 'n', label: this.dim(defaultNo ? 'no (default)' : 'no') },
    ]);

    return answer === 'y';

  }

  /** Vertical list picker for setup wizards; returns the selected index. */

  async promptSelect(question: string, options: readonly string[]): Promise<number> {

    if (!this.interactive) throw new UserCancelledError('Interactive selection requested in a non-interactive session.');

    stdout.write(`\n${this.brandBold('╭─')} ${this.bold(this.formatPersianText(question))}\n`);

    options.forEach((opt, i) => {

      const num = String(i + 1).padStart(2, ' ');

      stdout.write(`${this.brandBold('│')}  ${this.brandLight(`${num})`)} ${this.formatPersianText(opt)}\n`);

    });

    for (;;) {

      const answer = (await this.lineQuestion(`${this.brandBold('╰─›')} ${this.brand(`Choose 1-${options.length}`)}: `)).trim();

      const n = Number.parseInt(answer, 10);

      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;

      stdout.write(`${this.yellow('⚠')} Invalid selection. Please enter a number between 1 and ${options.length}.\n`);

    }

  }

  /** Render a titled detail box themed in #8B9A6E with accurate width for Persian/UTF-8 text. */

  box(title: string, lines: readonly string[]): void {

    if (this.jsonMode) return;

    this.stopActivity();

    const formattedTitle = this.formatPersianText(title);

    const rendered = lines.map((l) => this.formatPersianText(l));

    const contentWidth = Math.max(displayWidth(formattedTitle) + 4, ...rendered.map((l) => displayWidth(l)), 20);

    const width = Math.min(contentWidth + 4, Math.max(40, Math.min((stdout.columns ?? 80) - 2, 100)));

    const inner = width - 4;    const dashes = '─'.repeat(Math.max(1, width - displayWidth(formattedTitle) - 5));
    stdout.write(`${this.brand('╭')}${this.brandDark('─')} ${this.brandBold(formattedTitle)} ${this.brandDark(dashes)}${this.brand('╮')}\n`);

    for (const line of rendered) {
      const clipped = truncateToWidth(line, inner);
      const pad = ' '.repeat(Math.max(0, inner - displayWidth(clipped)));
      stdout.write(`${this.brandDark('│')} ${clipped}${pad} ${this.brandDark('│')}\n`);
    }

    stdout.write(`${this.brand('╰')}${this.brandDark('─'.repeat(width - 2))}${this.brand('╯')}\n`);

  }

  /**
   * Print a bounded, colorized unified diff for approval previews: additions
   * in brand light, removals red, hunk headers cyan and file headers dim.
   * Only ANSI styling is added — not one character of the diff changes.
   */
  printDiffPreview(preview: string, maxLines = 40): void {
    if (this.jsonMode) return;
    const all = preview.split('\n');
    const shown = all.slice(0, maxLines);
    const hidden = all.length - shown.length;
    this.info(this.dim(`--- preview${hidden > 0 ? ` (${hidden} more lines not shown)` : ''} ---`));
    for (const line of shown) this.info(this.colorizeDiffLine(line));
    this.info(this.dim('--- end preview ---'));
  }

  private colorizeDiffLine(line: string): string {
    if (!this.colorEnabled) return line;
    if (line.startsWith('+++') || line.startsWith('---')) return this.dim(line);
    if (line.startsWith('@@')) return this.cyan(line);
    if (line.startsWith('+')) return this.green(line);
    if (line.startsWith('-')) return this.red(line);
    return this.dim(line);
  }

  /* ---------------------------------------------------------------- */
  /* Interrupts & teardown                                             */
  /* ---------------------------------------------------------------- */

  /** Subscribe to Ctrl+C presses that arrive while a prompt is reading input. */

  onInterrupt(listener: () => void): () => void {
    this.interruptListeners.add(listener);
    return () => this.interruptListeners.delete(listener);
  }

  private notifyInterrupt(): void {
    for (const listener of [...this.interruptListeners]) {
      try {
        listener();
      } catch {
        /* a listener must never break input handling */
      }
    }
  }

  /**
   * Put the terminal back into a sane, usable state (idempotent). Called after
   * a cancellation so a half-drawn stream or a stale raw-mode setting can
   * never leave the shell looking frozen.
   */
  resetTerminal(): void {
    this.stopActivity();
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {
      /* not a TTY */
    }
    if (this.jsonMode) return;
    if (this.answerOpen) this.endStream();
    stdout.write('\x1b[?2004l\x1b[0m');
  }

  /** Release stdin/readline so the process can exit cleanly (idempotent). */

  close(): void {
    this.stopActivity();
    if (this.answerOpen) this.endStream();
    if (this.rl) {
      const rl = this.rl;
      this.rl = null;
      try {
        rl.close();
      } catch {
        /* already closed */
      }
    }
    for (const pending of this.pendingInputs.splice(0)) pending.reject(new UserCancelledError());
    this.pendingLines.length = 0;
    this.interruptListeners.clear();
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    stdin.pause();
  }

}
