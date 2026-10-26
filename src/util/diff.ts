/**
 * Line-based unified diff. LCS via dynamic programming is fine here because
 * every caller enforces file-size limits upstream.
 */

export interface DiffOptions {
  contextLines?: number;
  fromLabel?: string;
  toLabel?: string;
}

interface Op {
  type: 'keep' | 'del' | 'add';
  line: string;
}

export function computeLineDiff(oldText: string, newText: string): Op[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    // Extremely large: fall back to a coarse replace-all diff.
    return [...a.map((line) => ({ type: 'del' as const, line })), ...b.map((line) => ({ type: 'add' as const, line }))];
  }
  // Standard LCS DP.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'keep', line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: 'del', line: a[i]! });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', line: a[i++]! });
  while (j < m) ops.push({ type: 'add', line: b[j++]! });
  return ops;
}

export function unifiedDiff(oldText: string, newText: string, options: DiffOptions = {}): string {
  const context = options.contextLines ?? 3;
  const fromLabel = options.fromLabel ?? 'a/file';
  const toLabel = options.toLabel ?? 'b/file';
  const ops = computeLineDiff(oldText, newText);
  if (ops.every((o) => o.type === 'keep')) return '';

  const lines: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];

  // Collect change indices and group those close enough to share context.
  const changeIdx: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.type !== 'keep') changeIdx.push(k);
  }
  const groups: [number, number][] = []; // [startIdx, endIdx] per hunk
  let groupStart = changeIdx[0]!;
  let prev = groupStart;
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k]!;
    if (idx - prev > context * 2 + 1) {
      groups.push([groupStart, prev]);
      groupStart = idx;
    }
    prev = idx;
  }
  groups.push([groupStart, prev]);

  for (const [first, last] of groups) {
    const start = Math.max(0, first - context);
    const end = Math.min(ops.length, last + context + 1);
    const hunk = ops.slice(start, end);
    const delCount = hunk.filter((o) => o.type !== 'add').length;
    const addCount = hunk.filter((o) => o.type !== 'del').length;
    const oldStart = lineNumberBefore(ops, start, 'old');
    const newStart = lineNumberBefore(ops, start, 'new');
    lines.push(`@@ -${oldStart},${delCount} +${newStart},${addCount} @@`);
    for (const op of hunk) {
      lines.push(op.type === 'keep' ? ` ${op.line}` : op.type === 'del' ? `-${op.line}` : `+${op.line}`);
    }
  }
  return lines.join('\n');
}

function lineNumberBefore(ops: Op[], index: number, side: 'old' | 'new'): number {
  let line = 1;
  for (let k = 0; k < index; k++) {
    const t = ops[k]!.type;
    if (side === 'old' ? t !== 'add' : t !== 'del') line++;
  }
  return line;
}
