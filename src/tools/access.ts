import path from 'node:path';
import { ToolExecutionError } from '../errors/errors.js';
import { canonicalGrantRoot, covers } from '../security/access.js';
import type { Tool } from './types.js';

/**
 * request_path_access — the one tool that makes the agent dynamic.
 *
 * Without it every path outside the selected workspace is refused, so
 * "check drive C" or "fix D:\projects\shop" ended in "I don't have access".
 * With it the agent asks for one specific folder (or a whole drive), the user
 * approves it in the usual tier-3 prompt, and this new folder keeps working
 * for the rest of the session.
 *
 * Two modes, both an explicit user decision:
 *   - read  (default): list_directory / read_file / search_* / generate_diff;
 *   - write: also create_file / edit_file / move_file / delete_file — each of
 *     those still needs its own approval and is backed up first.
 * The agent must never write outside the workspace without the write mode
 * having been approved for that exact root.
 */

const MAX_REASON_LENGTH = 200;

function cleanReason(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
}

/** "C", "C:", "C:/", "D:\" → the drive root; anything else unchanged. */
function describeRoot(root: string): string {
  if (!/^[a-zA-Z]:[\\/]$/.test(root)) return root;
  return `${root.slice(0, 1).toUpperCase()}: (the whole drive)`;
}

export const requestPathAccessTool: Tool = {
  name: 'request_path_access',
  description:
    'Ask the user for access to a folder, drive or path outside the workspace (for example "C:\\", "C:", "D:\\projects\\shop", "/etc"). Use this whenever the user points at a location outside the workspace — never reply "I do not have access" before trying it. By default the grant is READ-ONLY and enables list_directory, read_file, search_files, search_text, inspect_file_metadata, get_disk_usage and generate_diff there. Pass write=true only when the user explicitly asked to change, fix or create something in that folder: writes are then allowed there too, still one approval per change and backed up first.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path of the folder, drive or file location to use (e.g. C:\\, C:, D:\\projects, /etc).',
        minLength: 1,
        maxLength: 1024,
      },
      write: {
        type: 'boolean',
        description: 'Also allow creating, editing, moving and deleting files there. Only when the user asked for changes. Default false.',
      },
      reason: {
        type: 'string',
        description: 'One short sentence explaining what you will do there.',
        maxLength: MAX_REASON_LENGTH,
      },
    },
  },
  async describe(input, ctx) {
    const raw = String(input['path'] ?? '');
    const write = input['write'] === true;
    const reason = cleanReason(input['reason']);
    let resolved: string | null = null;
    let problem: string | null = null;
    try {
      resolved = await canonicalGrantRoot(raw);
    } catch (err) {
      problem = (err as Error).message;
    }
    if (resolved !== null && ctx.workspace && covers(ctx.workspace.root, resolved)) {
      return {
        summary: `${describeRoot(resolved)} is already inside the workspace`,
        targets: [resolved],
        preview: 'No new access is needed — the normal tools already cover this folder, including writes.',
      };
    }
    const existing = resolved !== null ? ctx.access.covering(resolved) : null;
    const targets = [resolved ?? raw, `${write ? 'read + write' : 'read-only'}`, ...(reason !== '' ? [`why: ${reason}`] : [])];
    const coverage =
      resolved === null
        ? `${write ? 'Read + write' : 'Read-only'} access to ${raw}${problem !== null ? ` — ${problem}` : ''}`
        : `${write ? 'Grant READ + WRITE access to' : 'Grant read-only access to'} ${describeRoot(resolved)}`;
    const preview =
      resolved === null
        ? undefined
        : existing !== null
          ? existing.writable
            ? `Already granted earlier this session: ${existing.root} (read + write).`
            : write
              ? `Upgrade ${existing.root} from READ-ONLY to READ + WRITE for this session.`
              : `Already granted earlier this session: ${existing.root} (read-only).`
          : [
              `Access scope for this session:`,
              `  ${resolved}`,
              write
                ? '  reads (list/read/search/diff) and writes (create/edit/move/delete). Every write is approved separately and backed up first.'
                : '  reads only — create, edit, move and delete stay refused outside the workspace.',
            ].join('\n');
    return {
      summary: coverage,
      targets,
      ...(preview !== undefined ? { preview } : {}),
    };
  },
  async run(input, ctx) {
    const raw = String(input['path'] ?? '').trim();
    if (raw === '') throw new ToolExecutionError('request_path_access', 'A path is required.');
    const write = input['write'] === true;
    const root = await canonicalGrantRoot(raw);
    const reason = cleanReason(input['reason']);

    if (ctx.workspace && covers(ctx.workspace.root, root)) {
      return {
        ok: true,
        summary: `${root} is already inside the workspace — no grant needed; it can be read and written directly.`,
        data: { root, alreadyInsideWorkspace: true, writable: true },
      };
    }
    const existing = ctx.access.covering(root);
    if (existing !== null) {
      const exact = path.resolve(existing.root) === path.resolve(root);
      const where = exact ? root : `${root} (covered by the grant for ${existing.root})`;
      if (write && !existing.writable) {
        const upgraded = ctx.access.add(existing.root, reason, { writable: true });
        await ctx.audit.record({
          event: 'access.grant',
          tool: 'request_path_access',
          tier: 3,
          decision: 'granted',
          detail: { root: upgraded.root, reason, writable: true, upgraded: true },
        });
        return {
          ok: true,
          summary: `Write access granted for ${upgraded.root} (this session). You may now create, edit, move and delete files there — each write still needs approval.`,
          data: { root: upgraded.root, writable: true },
        };
      }
      return {
        ok: true,
        summary: existing.writable
          ? `Read + write access to ${where} was already granted earlier in this session.`
          : `Read-only access to ${where} was already granted earlier in this session.`,
        data: { root: existing.root, writable: existing.writable },
      };
    }

    const grant = ctx.access.add(root, reason, { writable: write });
    await ctx.audit.record({
      event: 'access.grant',
      tool: 'request_path_access',
      tier: 3,
      decision: 'granted',
      detail: { root, reason, writable: write },
    });
    return {
      ok: true,
      summary: write
        ? `Read + write access granted for ${root} (this session). Reads and writes both work there now; each write is still approved individually.`
        : `Read-only access granted for ${root} (this session). Use list_directory / read_file / search_files / search_text with absolute paths inside it. Writing there needs write=true approval.`,
      data: { root: grant.root, writable: grant.writable },
    };
  },
};

export const accessTools: Tool[] = [requestPathAccessTool];
