import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { BackupEntry, BackupManager } from '../../recovery/backups.js';

/**
 * A checkpoint is a position in a session's backup manifest: "everything
 * after this many backup entries happened after the checkpoint". `/undo`
 * restores those entries; `/diff` previews them as a unified, line-level diff
 * between the snapshot (before) and the file on disk now (after).
 *
 * Checkpoints are created automatically before every console task and can be
 * created manually with `/checkpoint <label>`.
 */

export interface Checkpoint {
  id: string;
  label: string;
  ts: string;
  /** Number of backup entries that existed when the checkpoint was taken. */
  startIndex: number;
}

export function createCheckpoint(label: string, startIndex: number): Checkpoint {
  return { id: randomUUID(), label: label.slice(0, 80), ts: new Date().toISOString(), startIndex };
}

/** Entries that happened after this checkpoint. */
export async function entriesAfter(backups: BackupManager, sessionId: string, checkpoint: Checkpoint): Promise<BackupEntry[]> {
  return (await backups.list(sessionId)).slice(checkpoint.startIndex);
}

/* ------------------------------------------------------------------ */
/* Line diff (LCS, capped — preview only, never for correctness)       */
/* ------------------------------------------------------------------ */

const MAX_DIFF_LINES_PER_FILE = 200;
const MAX_DIFF_FILES = 10;

export interface FileDiff {
  path: string;
  op: BackupEntry['op'];
  lines: string[]; // "-old" / "+new" / " ctx"
  truncated: boolean;
  added: number;
  removed: number;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/** Minimal LCS line diff. Pure — exported for tests. */
export function diffLines(oldText: string, newText: string, maxLines = MAX_DIFF_LINES_PER_FILE): { lines: string[]; added: number; removed: number; truncated: boolean } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // Cap the DP table: huge files fall back to a whole-file replace preview.
  if (a.length * b.length > 250_000) {
    const lines = [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)];
    return { lines: lines.slice(0, maxLines), added: b.length, removed: a.length, truncated: lines.length > maxLines };
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  let contextRun = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      contextRun += 1;
      if (contextRun <= 2 || lines.length === 0) lines.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      lines.push(`+${b[j]}`);
      added += 1;
      contextRun = 0;
      j += 1;
    } else {
      lines.push(`-${a[i]}`);
      removed += 1;
      contextRun = 0;
      i += 1;
    }
  }
  return { lines: lines.slice(0, maxLines), added, removed, truncated: lines.length > maxLines };
}

async function readMaybe(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Diff preview for the entries after a checkpoint: snapshot → current file.
 * One entry per file (the earliest snapshot wins — that is the "before").
 * Created-then-edited files show as new; files deleted since show as removed.
 */
export async function diffForEntries(entries: readonly BackupEntry[]): Promise<FileDiff[]> {
  const byPath = new Map<string, BackupEntry>();
  for (const e of entries) {
    if (!byPath.has(e.source)) byPath.set(e.source, e);
  }
  const out: FileDiff[] = [];
  for (const entry of byPath.values()) {
    if (out.length >= MAX_DIFF_FILES) break;
    const before = entry.backupPath ? await readMaybe(entry.backupPath) : null;
    const after = await readMaybe(entry.source);
    if (before === null && after === null) continue;
    if (before === null && after !== null) {
      const d = diffLines('', after);
      out.push({ path: entry.source, op: 'create', ...d });
    } else if (before !== null && after === null) {
      const d = diffLines(before, '');
      out.push({ path: entry.source, op: 'delete', ...d });
    } else if (before !== after) {
      out.push({ path: entry.source, op: entry.op, ...diffLines(before!, after!) });
    }
  }
  return out;
}

/** Optional color hooks — the console passes its Ui colors, tests pass plains. */
export interface DiffStyle {
  header: (s: string) => string;
  added: (s: string) => string;
  removed: (s: string) => string;
  context: (s: string) => string;
}

const PLAIN_STYLE: DiffStyle = {
  header: (s) => s,
  added: (s) => s,
  removed: (s) => s,
  context: (s) => s,
};

/** Render diffs as lines for a UI box (green + / red − / dim context). */
export function renderDiffLines(diffs: readonly FileDiff[], style: DiffStyle = PLAIN_STYLE): string[] {
  const lines: string[] = [];
  for (const d of diffs) {
    lines.push(style.header(`▸ ${d.path}  (${d.op} · +${d.added} -${d.removed})`));
    for (const l of d.lines) {
      if (l.startsWith('+')) lines.push(`  ${style.added(l)}`);
      else if (l.startsWith('-')) lines.push(`  ${style.removed(l)}`);
      else lines.push(`  ${style.context(l)}`);
    }
    if (d.truncated) lines.push(style.context('  … (truncated)'));
  }
  return lines;
}
