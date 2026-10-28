import { truncateToWidth, type Ui } from '../../cli/ui.js';
import type { AgentStep } from './loop.js';

/**
 * "What did this run actually change?" — one flat list of changes gathered
 * from the steps of an agent run, rendered as its own box after every run:
 *
 *   ╭─ changes ──────────────────────────╮
 *   │ ● files                            │
 *   │   + created   notes/todo.md        │
 *   │   ~ modified  src/app.ts           │
 *   │ ● apps                             │
 *   │   ↗ opened    chrome · search "…"  │
 *   ╰────────────────────────────────────╯
 *
 * Only successful, non-dry-run calls count as changes; read-only tools are
 * never listed. Repeated touches of the same target collapse into one row.
 */

export type ChangeKind = 'folder' | 'file' | 'app' | 'url' | 'command';

export interface RunChange {
  kind: ChangeKind;
  /** Short verb: created / modified / moved / deleted / opened / ran. */
  action: string;
  /** Path, app id, URL or what was executed. */
  target: string;
  /** Optional secondary note (search text, browser, exit code). */
  detail?: string;
  /** How many calls collapsed into this row. */
  count: number;
}

/** How much a row matters when the same target is touched more than once. */
const ACTION_RANK: Record<string, number> = { modified: 1, created: 2, opened: 2, ran: 2, started: 2, moved: 3, closed: 3, deleted: 4 };

const SCRIPT_LABELS: Record<string, string> = {
  run_tests: 'test suite',
  run_typecheck: 'type check',
  run_linter: 'linter',
  run_build: 'build',
};

const NEW_FOLDER_RE = /\[new folder: ([^\]]+)\]/;

function str(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : '';
}

/** Collect the changes a run made, in first-appearance order. */
export function collectRunChanges(steps: readonly AgentStep[]): RunChange[] {
  const changes: RunChange[] = [];
  const index = new Map<string, number>();

  const add = (entry: Omit<RunChange, 'count'>): void => {
    const key = `${entry.kind}|${entry.target}|${entry.detail ?? ''}`;
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, changes.length);
      changes.push({ ...entry, count: 1 });
      return;
    }
    const existing = changes[at]!;
    existing.count += 1;
    if ((ACTION_RANK[entry.action] ?? 0) > (ACTION_RANK[existing.action] ?? 0)) existing.action = entry.action;
    if (existing.detail === undefined) existing.detail = entry.detail;
  };

  for (const step of steps) {
    for (const call of step.toolCalls) {
      if (!call.ok) continue; // denied, failed and invalid calls changed nothing
      if (call.summary.startsWith('[dry-run]')) continue; // simulated, nothing written
      const a = call.args;
      switch (call.name) {
        case 'create_file': {
          const target = str(a['path']);
          if (target === '') break;
          const folder = NEW_FOLDER_RE.exec(call.summary)?.[1];
          if (folder !== undefined && folder !== '.' && folder !== '') {
            add({ kind: 'folder', action: 'created', target: folder });
          }
          add({ kind: 'file', action: /^Overwrote\b/.test(call.summary) ? 'modified' : 'created', target });
          break;
        }
        case 'edit_file': {
          if (!/^Applied \d+ edit/.test(call.summary)) break; // "no change" writes nothing
          const target = str(a['path']);
          if (target !== '') add({ kind: 'file', action: 'modified', target });
          break;
        }
        case 'move_file': {
          const from = str(a['source']);
          const to = str(a['destination']);
          if (from !== '' && to !== '') add({ kind: 'file', action: 'moved', target: `${from} → ${to}` });
          break;
        }
        case 'delete_file': {
          const target = str(a['path']);
          if (target !== '') add({ kind: 'file', action: 'deleted', target });
          break;
        }
        case 'launch_app': {
          const app = str(a['app']);
          if (app === '') break;
          const search = str(a['search']);
          const url = str(a['url']);
          const detail = search !== '' ? `search: "${search}"` : url;
          add({ kind: 'app', action: 'opened', target: app, ...(detail !== '' ? { detail: truncateToWidth(detail, 48) } : {}) });
          break;
        }
        case 'close_app': {
          const target = str(a['name']);
          if (target === '') break;
          const pid = typeof a['pid'] === 'number' ? `pid ${a['pid']}` : '';
          add({ kind: 'app', action: 'closed', target, ...(pid !== '' ? { detail: pid } : {}) });
          break;
        }
        case 'open_url': {
          const url = str(a['url']);
          if (url === '') break;
          const browser = str(a['browser']);
          add({
            kind: 'url',
            action: 'opened',
            target: truncateToWidth(url, 56),
            ...(browser !== '' && browser !== 'default' ? { detail: browser } : {}),
          });
          break;
        }
        case 'run_shell_command': {
          const command = str(a['command']);
          if (command === '') break;
          const exit = /Command exit (\S+)/.exec(call.summary)?.[1];
          add({
            kind: 'command',
            action: 'ran',
            target: truncateToWidth(command.replace(/\s+/g, ' '), 56),
            ...(exit !== undefined ? { detail: `exit ${exit}` } : {}),
          });
          break;
        }
        case 'start_background_process': {
          const command = str(a['command']);
          if (command === '') break;
          const label = str(a['label']);
          const target = (label !== '' ? label : command).replace(/\s+/g, ' ');
          add({ kind: 'command', action: 'started', target: truncateToWidth(target, 56), detail: 'background' });
          break;
        }
        case 'execute_approved_command': {
          const argv = Array.isArray(a['argv']) ? (a['argv'] as unknown[]).map(String).join(' ') : '';
          if (argv === '') break;
          const exit = /Command exited (\S+)/.exec(call.summary)?.[1];
          add({
            kind: 'command',
            action: 'ran',
            target: truncateToWidth(argv, 56),
            ...(exit !== undefined ? { detail: `exit ${exit}` } : {}),
          });
          break;
        }
        default: {
          const label = SCRIPT_LABELS[call.name];
          if (label === undefined) break;
          const exit = /\bexit (\S+)/.exec(call.summary)?.[1];
          add({ kind: 'command', action: 'ran', target: label, ...(exit !== undefined ? { detail: `exit ${exit}` } : {}) });
          break;
        }
      }
    }
  }
  return changes;
}

const GROUPS: { kind: ChangeKind; title: string }[] = [
  { kind: 'folder', title: 'folders' },
  { kind: 'file', title: 'files' },
  { kind: 'app', title: 'apps' },
  { kind: 'url', title: 'links' },
  { kind: 'command', title: 'commands' },
];

const TARGET_WIDTH = 52;

function icon(ui: Ui, action: string): string {
  switch (action) {
    case 'created':
      return ui.green('+');
    case 'modified':
      return ui.yellow('~');
    case 'moved':
      return ui.yellow('→');
    case 'deleted':
      return ui.red('×');
    case 'opened':
      return ui.brandLight('↗');
    case 'closed':
      return ui.yellow('■');
    case 'ran':
      return ui.brand('▸');
    case 'started':
      return ui.brand('▶');
    default:
      return ui.brandDark('·');
  }
}

/** Render the run's changes as one titled box. Silent when there are none. */
export function renderChangesBox(ui: Ui, changes: readonly RunChange[]): void {
  if (ui.jsonMode || changes.length === 0) return;
  const lines: string[] = [];
  for (const group of GROUPS) {
    const items = changes.filter((c) => c.kind === group.kind);
    if (items.length === 0) continue;
    lines.push(`${ui.brand('●')} ${ui.bold(group.title)}${ui.dim(` · ${items.length}`)}`);
    for (const item of items) {
      const count = item.count > 1 && group.kind !== 'folder' && group.kind !== 'file' ? ui.dim(` ×${item.count}`) : '';
      const detail = item.detail !== undefined ? ui.dim(` · ${item.detail}`) : '';
      const target = truncateToWidth(item.target, TARGET_WIDTH);
      lines.push(`  ${icon(ui, item.action)} ${item.action.padEnd(9)} ${target}${count}${detail}`);
    }
  }
  ui.info('');
  ui.box('changes', lines);
}