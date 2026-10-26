import path from 'node:path';
import { ToolExecutionError } from '../errors/errors.js';
import { canonicalGrantRoot, covers } from '../security/access.js';
import type { Tool } from './types.js';

/**
 * request_path_access — the one tool that makes the agent dynamic.
 *
 * Without it every path outside the selected workspace is refused, so "check
 * drive C" or "look at D:\projects\shop" ended in "I don't have access". With
 * it the agent asks for one specific folder, the user approves it in the usual
 * tier-3 prompt, and the read tools work there for the rest of the session.
 *
 * It is deliberately read-only: no write tool can cross a grant.
 */

const MAX_REASON_LENGTH = 200;

function cleanReason(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
}

export const requestPathAccessTool: Tool = {
  name: 'request_path_access',
  description:
    'Ask the user for READ-ONLY access to a folder or drive outside the workspace (for example "C:\\", "D:\\projects\\shop", "/etc"). Use this whenever the user points at a location outside the workspace — never reply "I do not have access" before trying it. After approval, list_directory, read_file, search_files, search_text, inspect_file_metadata and generate_diff work there for the rest of the session. Writing outside the workspace is not granted.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path of the folder or drive to inspect (e.g. C:\\ or D:\\projects).',
        minLength: 1,
        maxLength: 1024,
      },
      reason: {
        type: 'string',
        description: 'One short sentence explaining what you will inspect there.',
        maxLength: MAX_REASON_LENGTH,
      },
    },
  },
  async describe(input, ctx) {
    const raw = String(input['path'] ?? '');
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
        summary: `${resolved} is already inside the workspace`,
        targets: [resolved],
        preview: 'No new access is needed — the normal read tools already cover this folder.',
      };
    }
    const targets = [resolved ?? raw, ...(reason !== '' ? [`why: ${reason}`] : [])];
    return {
      summary:
        resolved === null
          ? `Read-only access to ${raw}${problem !== null ? ` — ${problem}` : ''}`
          : `Grant read-only access to ${resolved}`,
      targets,
      ...(resolved !== null
        ? { preview: `Read-only access for this session:\n  ${resolved}\nNo write, move or delete is possible outside the workspace.` }
        : {}),
    };
  },
  async run(input, ctx) {
    const raw = String(input['path'] ?? '').trim();
    if (raw === '') throw new ToolExecutionError('request_path_access', 'A path is required.');
    const root = await canonicalGrantRoot(raw);
    const reason = cleanReason(input['reason']);

    if (ctx.workspace && covers(ctx.workspace.root, root)) {
      return { ok: true, summary: `${root} is already inside the workspace — no grant needed.`, data: { root, alreadyInsideWorkspace: true } };
    }
    const existing = ctx.access.covering(root);
    if (existing !== null) {
      const exact = path.resolve(existing.root) === path.resolve(root);
      return {
        ok: true,
        summary: exact
          ? `Read-only access to ${root} was already granted earlier in this session.`
          : `${root} is already covered by the read-only grant for ${existing.root}.`,
        data: { root, coveredBy: existing.root },
      };
    }

    const grant = ctx.access.add(root, reason);
    await ctx.audit.record({
      event: 'access.grant',
      tool: 'request_path_access',
      tier: 3,
      decision: 'granted',
      detail: { root, reason },
    });
    return {
      ok: true,
      summary: `Read-only access granted for ${root} (this session). Use list_directory / read_file / search_files / search_text with absolute paths inside it. Writing there is not allowed.`,
      data: { root: grant.root, readOnly: true },
    };
  },
};

export const accessTools: Tool[] = [requestPathAccessTool];
