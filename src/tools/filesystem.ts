import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PathSecurityError, ToolExecutionError, WorkspaceError } from '../errors/errors.js';
import { unifiedDiff } from '../util/diff.js';
import type { Tool, ToolContext } from './types.js';
import type { ResolvedEntry, ResolveOptions, WorkspaceBoundary } from '../security/path-validation.js';
import { covers } from '../security/access.js';

/** Hard ceilings for recursive traversal (defense against runaway walks). */
const WALK_MAX_DEPTH = 8;
const WALK_MAX_VISITS = 20_000;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.idea', '.vscode']);

function ws(ctx: ToolContext): WorkspaceBoundary {
  if (!ctx.workspace) throw new WorkspaceError('No workspace selected.');
  return ctx.workspace;
}

function cap(ctx: ToolContext, requested: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(requested ?? fallback, 10_000));
}

/**
 * Resolve a path for a READ. Workspace-relative paths stay workspace-relative;
 * absolute paths may also fall inside a folder the user granted read-only
 * access to for this session (`request_path_access`).
 */
export async function resolveReadPath(ctx: ToolContext, input: string, options: ResolveOptions = {}): Promise<ResolvedEntry> {
  const absolute = path.isAbsolute(input);
  if (ctx.workspace && (!absolute || covers(ctx.workspace.root, path.resolve(input)))) {
    return ctx.workspace.resolve(input, options);
  }
  if (absolute && ctx.access.covering(path.resolve(input))) {
    return ctx.access.resolve(input, options);
  }
  if (!ctx.workspace) {
    if (!absolute) {
      throw new WorkspaceError('No workspace selected.', {
        hint: 'Select a workspace, or call request_path_access with a full path for read-only access to it.',
      });
    }
    throw new PathSecurityError(
      `No access to ${input}: it is outside the workspace. Call request_path_access with that path (or its parent folder) to ask the user for read-only access.`,
      { hint: 'Do not report a missing access right before trying request_path_access.' },
    );
  }
  if (!absolute) return ctx.workspace.resolve(input, options);
  throw new PathSecurityError(
    `No access to ${input}: it is outside the workspace. Call request_path_access with that path (or its parent folder) to ask the user for read-only access.`,
    { hint: 'Do not report a missing access right before trying request_path_access.' },
  );
}

/** Resolve an absolute-or-relative path for a WRITE (workspace only). */
async function resolveWrite(ctx: ToolContext, input: string, options: ResolveOptions = {}): Promise<ResolvedEntry> {
  const boundary = ws(ctx);
  if (path.isAbsolute(input) && !covers(boundary.root, path.resolve(input))) {
    throw new PathSecurityError(`Refusing to write outside the workspace: ${input}`, {
      hint: 'Access grants are read-only by design. Add the folder as the workspace if it really must be edited.',
    });
  }
  return boundary.resolve(input, options);
}

async function readTextBounded(absPath: string, ctx: ToolContext, maxBytes?: number): Promise<{ text: string; truncated: boolean }> {
  const limit = Math.min(maxBytes ?? ctx.config.limits.maxOutputBytes, ctx.config.limits.maxFileBytes);
  const handle = await fs.open(absPath, 'r');
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, limit);
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, size, 0);
    if (buf.includes(0)) {
      throw new ToolExecutionError('read_file', 'File appears to be binary; refusing to return it as text.');
    }
    return { text: buf.toString('utf8'), truncated: stat.size > limit };
  } finally {
    await handle.close();
  }
}

interface WalkOptions {
  maxResults: number;
  includeHidden: boolean;
  onEntry: (rel: string, abs: string, isDir: boolean) => boolean | void | Promise<boolean | void>; // return false to prune
}

async function walk(resolve: (input: string) => Promise<ResolvedEntry>, startRel: string, options: WalkOptions): Promise<{ rel: string; abs: string; isDir: boolean }[]> {
  const rootEntry = await resolve(startRel);
  if (rootEntry.kind !== 'directory') throw new PathSecurityError(`Not a directory: ${startRel}`);
  const found: { rel: string; abs: string; isDir: boolean }[] = [];
  let visited = 0;

  async function recurse(absDir: string, relDir: string, depth: number): Promise<void> {
    if (depth > WALK_MAX_DEPTH || visited > WALK_MAX_VISITS || found.length >= options.maxResults) return;
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: skip rather than explode
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      visited += 1;
      if (visited > WALK_MAX_VISITS || found.length >= options.maxResults) return;
      if (!options.includeHidden && e.name.startsWith('.')) continue;
      if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
      const abs = path.join(absDir, e.name);
      const rel = relDir === '.' ? e.name : `${relDir}/${e.name}`;
      const isDir = e.isDirectory();
      const verdict = await options.onEntry(rel, abs, isDir);
      if (verdict === false) continue; // caller asked to prune this subtree
      if (isDir) await recurse(abs, rel, depth + 1);
    }
  }
  await recurse(rootEntry.realPath, startRel === '.' ? '.' : rootEntry.relativePath, 0);
  return found;
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // **/ matches zero or more segments
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/* ------------------------------------------------------------------ */
/* Read-only tools                                                     */
/* ------------------------------------------------------------------ */

export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description:
    'List entries of a directory (type, size, modified time). Paths are workspace-relative; an absolute path works inside the workspace or in a folder granted with request_path_access.',
  requiresWorkspace: true,
  workspaceOptional: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Workspace-relative directory path (default ".").', maxLength: 1024 },
      maxEntries: { type: 'integer', description: 'Maximum entries to return (default 200).', minimum: 1, maximum: 10000 },
    },
  },
  async run(input, ctx) {
    const entry = await resolveReadPath(ctx, (input['path'] as string | undefined) ?? '.');
    if (entry.kind !== 'directory') throw new PathSecurityError(`Not a directory: ${entry.relativePath}`);
    const maxEntries = cap(ctx, input['maxEntries'] as number | undefined, 200);
    const dirents = await fs.readdir(entry.realPath, { withFileTypes: true });
    dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const limited = dirents.slice(0, maxEntries);
    const rows = [];
    for (const d of limited) {
      const stat = await fs.lstat(path.join(entry.realPath, d.name)).catch(() => null);
      rows.push({
        name: d.name,
        type: d.isDirectory() ? 'directory' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'symlink' : 'other',
        ...(stat?.isFile() ? { sizeBytes: stat.size } : {}),
        ...(stat ? { modifiedAt: stat.mtime.toISOString() } : {}),
      });
    }
    return {
      ok: true,
      summary: `Listed ${rows.length} of ${dirents.length} entries in ${entry.relativePath}.`,
      data: { path: entry.relativePath, totalEntries: dirents.length, entries: rows },
    };
  },
};

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file, with optional line range. Paths are workspace-relative; an absolute path works inside the workspace or in a folder granted with request_path_access.',
  requiresWorkspace: true,
  workspaceOptional: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.', minLength: 1, maxLength: 1024 },
      startLine: { type: 'integer', description: '1-based first line to return.', minimum: 1 },
      endLine: { type: 'integer', description: '1-based last line to return (inclusive).', minimum: 1 },
      maxBytes: { type: 'integer', description: 'Read at most this many bytes.', minimum: 1 },
    },
  },
  async run(input, ctx) {
    const entry = await resolveReadPath(ctx, input['path'] as string, { maxFileBytes: ctx.config.limits.maxFileBytes });
    if (entry.kind !== 'file') throw new PathSecurityError(`Not a regular file: ${entry.relativePath}`);
    const { text, truncated } = await readTextBounded(entry.realPath, ctx, input['maxBytes'] as number | undefined);
    const allLines = text.split('\n');
    const start = Math.max(1, (input['startLine'] as number | undefined) ?? 1);
    const end = Math.min(allLines.length, (input['endLine'] as number | undefined) ?? allLines.length);
    const slice = allLines.slice(start - 1, end);
    return {
      ok: true,
      summary: `Read ${slice.length} line(s) from ${entry.relativePath}${truncated ? ' (file truncated by size cap)' : ''}.`,
      data: { path: entry.relativePath, totalLines: allLines.length, content: slice.join('\n') },
    };
  },
};

export const searchFilesTool: Tool = {
  name: 'search_files',
  description:
    'Find files whose path matches a glob pattern (e.g. "**/*.ts"). Works in the workspace and in granted folders. Traversal is depth- and count-limited.',
  requiresWorkspace: true,
  workspaceOptional: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['pattern'],
    properties: {
      pattern: { type: 'string', description: 'Glob pattern matched against workspace-relative paths.', minLength: 1, maxLength: 256 },
      path: { type: 'string', description: 'Subdirectory to search (default ".").', maxLength: 1024 },
      maxResults: { type: 'integer', description: 'Maximum results (default 100).', minimum: 1, maximum: 10000 },
      includeHidden: { type: 'boolean', description: 'Include dotfiles.' },
    },
  },
  async run(input, ctx) {
    const maxResults = cap(ctx, input['maxResults'] as number | undefined, 100);
    let regex: RegExp;
    try {
      regex = globToRegExp(input['pattern'] as string);
    } catch {
      throw new ToolExecutionError('search_files', `Invalid glob pattern: ${input['pattern'] as string}`);
    }
    const results: string[] = [];
    await walk((p) => resolveReadPath(ctx, p), (input['path'] as string | undefined) ?? '.', {
      maxResults,
      includeHidden: (input['includeHidden'] as boolean | undefined) ?? false,
      onEntry: (rel, _abs, isDir) => {
        if (!isDir && regex.test(rel)) results.push(rel);
      },
    });
    return { ok: true, summary: `Found ${results.length} file(s) matching "${input['pattern'] as string}".`, data: { matches: results.slice(0, maxResults) } };
  },
};

export const searchTextTool: Tool = {
  name: 'search_text',
  description: 'Search file contents for a string or regular expression. Returns file:line:snippet matches, capped.',
  requiresWorkspace: true,
  workspaceOptional: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search string or regex.', minLength: 1, maxLength: 500 },
      regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive matching (default false).' },
      path: { type: 'string', description: 'Subdirectory to search (default ".").', maxLength: 1024 },
      maxResults: { type: 'integer', description: 'Maximum matches (default 50).', minimum: 1, maximum: 1000 },
    },
  },
  async run(input, ctx) {
    const maxResults = cap(ctx, input['maxResults'] as number | undefined, 50);
    const query = input['query'] as string;
    const useRegex = (input['regex'] as boolean | undefined) ?? false;
    const flags = (input['caseSensitive'] as boolean | undefined) === true ? 'g' : 'gi';
    let re: RegExp;
    try {
      re = new RegExp(useRegex ? clampRegex(query) : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch {
      throw new ToolExecutionError('search_text', `Invalid regular expression: ${query}`);
    }
    const matches: { file: string; line: number; snippet: string }[] = [];
    await walk((p) => resolveReadPath(ctx, p), (input['path'] as string | undefined) ?? '.', {
      maxResults: 10_000,
      includeHidden: false,
      onEntry: async (rel, abs, isDir) => {
        if (isDir || matches.length >= maxResults) return;
        await searchOneFile(abs, rel, re, matches, maxResults, ctx);
      },
    });
    return {
      ok: true,
      summary: `Found ${matches.length} match(es) for "${query}".`,
      data: { matches },
    };
  },
};

function clampRegex(q: string): string {
  if (q.length > 300 || /(\{[0-9]{4,}|\*\*|\+\+|\*\{|\+\{)/.test(q)) {
    throw new ToolExecutionError('search_text', 'Regular expression rejected (complexity limit).');
  }
  return q;
}

async function searchOneFile(abs: string, rel: string, re: RegExp, matches: { file: string; line: number; snippet: string }[], max: number, ctx: ToolContext): Promise<void> {
  try {
    const stat = await fs.stat(abs);
    if (stat.size > ctx.config.limits.maxFileBytes) return;
    const handle = await fs.open(abs, 'r');
    let content: string;
    try {
      const probe = Buffer.alloc(Math.min(8192, stat.size));
      await handle.read(probe, 0, probe.length, 0);
      if (probe.includes(0)) return; // binary file
      const rest = await handle.readFile('utf8');
      content = probe.toString('utf8', 0, Math.min(probe.length, stat.size)) + (stat.size > probe.length ? rest : '');
    } finally {
      await handle.close();
    }
    const lines = content.split('\n');
    for (let idx = 0; idx < lines.length && matches.length < max; idx++) {
      re.lastIndex = 0;
      const line = lines[idx]!;
      if (re.test(line)) {
        matches.push({ file: rel, line: idx + 1, snippet: line.trim().slice(0, 200) });
      }
    }
  } catch {
    /* unreadable file: skip */
  }
}

export const inspectFileMetadataTool: Tool = {
  name: 'inspect_file_metadata',
  description: 'Return metadata for a file (also in granted folders): size, timestamps, permissions, and a SHA-256 hash.',
  requiresWorkspace: true,
  workspaceOptional: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: { type: 'string', description: 'Workspace-relative file path.', minLength: 1, maxLength: 1024 } },
  },
  async run(input, ctx) {
    const entry = await resolveReadPath(ctx, input['path'] as string, { maxFileBytes: ctx.config.limits.maxFileBytes });
    const stat = await fs.lstat(entry.realPath);
    let sha256: string | undefined;
    if (entry.kind === 'file') {
      sha256 = crypto.createHash('sha256').update(await fs.readFile(entry.realPath)).digest('hex');
    }
    return {
      ok: true,
      summary: `Metadata for ${entry.relativePath} (${entry.kind}).`,
      data: {
        path: entry.relativePath,
        kind: entry.kind,
        sizeBytes: stat.size,
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
        mode: stat.mode.toString(8),
        ...(sha256 ? { sha256 } : {}),
      },
    };
  },
};

export const generateDiffTool: Tool = {
  name: 'generate_diff',
  description: 'Preview the unified diff between an existing file and proposed new content. Makes NO changes.',
  requiresWorkspace: true,
  workspaceOptional: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'proposedContent'],
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.', minLength: 1, maxLength: 1024 },
      proposedContent: { type: 'string', description: 'Full proposed file content.', maxLength: 2_000_000 },
    },
  },
  async run(input, ctx) {
    const rel = input['path'] as string;
    const proposed = input['proposedContent'] as string;
    let oldText = '';
    const resolved = await resolveReadPath(ctx, rel, { allowMissing: true });
    if (resolved.kind === 'file') oldText = (await readTextBounded(resolved.realPath, ctx, ctx.config.limits.maxFileBytes)).text;
    const diff = unifiedDiff(oldText, proposed, { fromLabel: `a/${rel}`, toLabel: `b/${rel}` });
    return {
      ok: true,
      summary: diff === '' ? 'No difference: proposed content is identical.' : `Diff for ${rel} (${diff.split('\n').length} lines).`,
      data: { diff: diff === '' ? '(no changes)' : diff },
    };
  },
};

/* ------------------------------------------------------------------ */
/* Mutating tools (approval + backup handled by registry / helpers)    */
/* ------------------------------------------------------------------ */

async function writeVerified(absPath: string, content: string, rel: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.operator-tmp-${process.pid}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, absPath);
  const verify = await fs.readFile(absPath, 'utf8');
  if (verify !== content) {
    throw new ToolExecutionError('write', `Post-write verification failed for ${rel}.`, {
      hint: 'The file was modified concurrently; re-read it and retry.',
    });
  }
}

export const createFileTool: Tool = {
  name: 'create_file',
  description: 'Create a new file inside the workspace with given content. Requires approval; overwriting an existing file escalates to a destructive approval.',
  requiresWorkspace: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', description: 'Workspace-relative destination path.', minLength: 1, maxLength: 1024 },
      content: { type: 'string', description: 'Full file content (UTF-8).', maxLength: 2_000_000 },
      overwrite: { type: 'boolean', description: 'Allow replacing an existing file (destructive). Default false.' },
    },
  },
  escalateTier(input) {
    const overwrite = (input['overwrite'] as boolean | undefined) ?? false;
    return overwrite ? 2 : null; // existence re-checked at describe/run time
  },
  async describe(input, ctx) {
    const rel = input['path'] as string;
    const content = input['content'] as string;
    const fresh = {
      summary: `Create file ${rel} (${content.length} bytes)`,
      targets: [rel],
      preview: content.split('\n').slice(0, 30).map((l) => `+${l}`).join('\n'),
    };
    if (!ctx.workspace) return fresh;
    try {
      const resolved = await ctx.workspace.resolve(rel, { allowMissing: true });
      if (resolved.kind === 'file') {
        const original = await fs.readFile(resolved.realPath, 'utf8');
        const diff = unifiedDiff(original, content, { fromLabel: `a/${rel}`, toLabel: `b/${rel}` });
        return {
          summary: `Overwrite file ${rel} (${content.length} bytes)`,
          targets: [rel],
          preview: diff === '' ? '(identical to the current file — nothing would change)' : diff,
        };
      }
      if (resolved.kind === 'directory') return { summary: `Create file ${rel} — a directory already exists there`, targets: [rel] };
    } catch {
      /* preview is best effort */
    }
    return fresh;
  },
  async run(input, ctx) {
    const rel = input['path'] as string;
    const content = input['content'] as string;
    const overwrite = (input['overwrite'] as boolean | undefined) ?? false;
    const resolved = await resolveWrite(ctx, rel, { allowMissing: true });
    if (resolved.kind === 'directory') throw new PathSecurityError(`A directory already exists at ${rel}.`);
    if (resolved.kind === 'file' && !overwrite) {
      throw new ToolExecutionError('create_file', `File already exists: ${rel}. Pass overwrite=true (requires destructive approval).`);
    }
    if (ctx.dryRun) return { ok: true, summary: `[dry-run] would create ${rel} (${content.length} bytes).` };
    if (resolved.kind === 'file') await ctx.backups.backup(ctx.sessionId, resolved.realPath, 'edit', { audit: ctx.audit });
    else await ctx.backups.backup(ctx.sessionId, resolved.realPath, 'create', { audit: ctx.audit });
    await writeVerified(resolved.realPath, content, rel);
    return { ok: true, summary: `${resolved.kind === 'file' ? 'Overwrote' : 'Created'} ${rel} (${content.length} bytes), verified after write.` };
  },
};

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Edit a file with exact find/replace operations. Each "find" snippet must match the file exactly (whitespace included). Set all=true to replace every occurrence. Shows a diff preview and backs up before writing.',
  requiresWorkspace: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'edits'],
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.', minLength: 1, maxLength: 1024 },
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['find', 'replace'],
          properties: {
            find: { type: 'string', description: 'Exact text to find (must be present).', minLength: 1, maxLength: 100_000 },
            replace: { type: 'string', description: 'Replacement text.', maxLength: 100_000 },
            all: { type: 'boolean', description: 'Replace all occurrences (default: first occurrence only).' },
          },
        },
      },
    },
  },
  async describe(input, ctx) {
    const rel = input['path'] as string;
    const edits = input['edits'] as { find: string; replace: string; all?: boolean }[];
    const summary = `Apply ${edits.length} edit(s) to ${rel}`;
    const targets = [rel];
    if (!ctx.workspace) return { summary, targets };

    let original: string;
    try {
      const entry = await ctx.workspace.resolveFile(rel, { maxFileBytes: ctx.config.limits.maxFileBytes });
      original = await fs.readFile(entry.realPath, 'utf8');
    } catch {
      return { summary, targets }; // unreadable/missing: approval still shows the summary
    }

    let updated = original;
    let missing = false;
    for (const { find, replace, all } of edits) {
      if (!updated.includes(find)) {
        missing = true;
        break;
      }
      updated = all ? updated.split(find).join(replace) : updated.replace(find, replace);
    }
    if (missing) {
      const listed = edits.map((e, i) => `${i + 1}. find: ${JSON.stringify(e.find.slice(0, 120))}`).join('\n');
      return { summary, targets, preview: `A "find" snippet is not present in ${rel} yet — nothing would be written.\n${listed}` };
    }
    if (updated === original) return { summary, targets, preview: '(the edits cancel out — no change)' };
    return { summary, targets, preview: unifiedDiff(original, updated, { fromLabel: `a/${rel}`, toLabel: `b/${rel}` }) };
  },
  async run(input, ctx) {
    const rel = input['path'] as string;
    const entry = await resolveWrite(ctx, rel, { maxFileBytes: ctx.config.limits.maxFileBytes });
    if (entry.kind !== 'file') throw new PathSecurityError(`Not a regular file: ${rel}`);
    const original = await fs.readFile(entry.realPath, 'utf8');
    const edits = input['edits'] as { find: string; replace: string; all?: boolean }[];
    let updated = original;
    const applied: number[] = [];
    for (let i = 0; i < edits.length; i++) {
      const { find, replace, all } = edits[i]!;
      if (!updated.includes(find)) {
        throw new ToolExecutionError('edit_file', `Edit #${i + 1}: "find" text not found in ${rel}. No changes were written.`, {
          hint: 'Re-read the file to get the exact current text (whitespace matters).',
        });
      }
      updated = all ? updated.split(find).join(replace) : updated.replace(find, replace);
      applied.push(i + 1);
    }
    if (updated === original) {
      return { ok: true, summary: `Edits produced no change in ${rel}; nothing written.` };
    }
    const diff = unifiedDiff(original, updated, { fromLabel: `a/${rel}`, toLabel: `b/${rel}` });
    if (ctx.dryRun) return { ok: true, summary: `[dry-run] would apply ${applied.length} edit(s) to ${rel}.`, data: { diff } };
    await ctx.backups.backup(ctx.sessionId, entry.realPath, 'edit', { audit: ctx.audit });
    await writeVerified(entry.realPath, updated, rel);
    return { ok: true, summary: `Applied ${applied.length} edit(s) to ${rel} and verified the result.`, data: { diff } };
  },
};

export const moveFileTool: Tool = {
  name: 'move_file',
  description: 'Move/rename a file within the workspace. Destination must also be inside the workspace.',
  requiresWorkspace: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['source', 'destination'],
    properties: {
      source: { type: 'string', description: 'Current workspace-relative path.', minLength: 1, maxLength: 1024 },
      destination: { type: 'string', description: 'Destination workspace-relative path.', minLength: 1, maxLength: 1024 },
      overwrite: { type: 'boolean', description: 'Replace destination if it exists.' },
    },
  },
  escalateTier(input) {
    return (input['overwrite'] as boolean | undefined) === true ? 2 : null;
  },
  describe(input) {
    return {
      summary: `Move ${input['source'] as string} → ${input['destination'] as string}`,
      targets: [input['source'] as string, input['destination'] as string],
    };
  },
  async run(input, ctx) {
    const src = await resolveWrite(ctx, input['source'] as string);
    if (src.kind !== 'file') throw new PathSecurityError(`Not a regular file: ${input['source'] as string}`);
    const dst = await resolveWrite(ctx, input['destination'] as string, { allowMissing: true });
    if (dst.kind === 'directory') throw new PathSecurityError(`Destination is a directory: ${input['destination'] as string}`);
    const overwrite = (input['overwrite'] as boolean | undefined) ?? false;
    if (dst.kind === 'file' && !overwrite) {
      throw new ToolExecutionError('move_file', `Destination exists: ${input['destination'] as string}. Pass overwrite=true.`);
    }
    if (ctx.dryRun) return { ok: true, summary: `[dry-run] would move ${src.relativePath} → ${input['destination'] as string}.` };
    await ctx.backups.backup(ctx.sessionId, src.realPath, 'move', { movedTo: dst.realPath, audit: ctx.audit });
    if (dst.kind === 'file') await ctx.backups.backup(ctx.sessionId, dst.realPath, 'edit', { audit: ctx.audit });
    await fs.mkdir(path.dirname(dst.realPath), { recursive: true });
    try {
      await fs.rename(src.realPath, dst.realPath);
    } catch {
      // Cross-device fallback: copy + delete.
      await fs.copyFile(src.realPath, dst.realPath);
      await fs.unlink(src.realPath);
    }
    await fs.access(dst.realPath);
    return { ok: true, summary: `Moved ${src.relativePath} → ${dst.relativePath}.` };
  },
};

export const deleteFileTool: Tool = {
  name: 'delete_file',
  description:
    'Delete a single file after operation-specific approval. Always backed up first when backups are enabled. Directories and recursive deletion are NOT supported by design.',
  requiresWorkspace: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: { type: 'string', description: 'Workspace-relative file path.', minLength: 1, maxLength: 1024 } },
  },
  describe(input) {
    return { summary: `DELETE file ${input['path'] as string}`, targets: [input['path'] as string] };
  },
  async run(input, ctx) {
    const entry = await resolveWrite(ctx, input['path'] as string);
    if (entry.kind !== 'file') throw new PathSecurityError(`Not a regular file: ${input['path'] as string}`);
    if (ctx.dryRun) return { ok: true, summary: `[dry-run] would delete ${entry.relativePath} (${entry.size ?? 0} bytes).` };
    const backup = await ctx.backups.backup(ctx.sessionId, entry.realPath, 'delete', { audit: ctx.audit });
    await fs.unlink(entry.realPath);
    const gone = await fs.access(entry.realPath).then(() => false, () => true);
    if (!gone) throw new ToolExecutionError('delete_file', `File still exists after delete: ${entry.relativePath}`);
    return {
      ok: true,
      summary: `Deleted ${entry.relativePath}${backup.backupPath ? ' (snapshot kept for rollback)' : ' (no snapshot; NOT recoverable)'}.`,
    };
  },
};

export const filesystemTools: Tool[] = [
  listDirectoryTool,
  readFileTool,
  searchFilesTool,
  searchTextTool,
  inspectFileMetadataTool,
  createFileTool,
  editFileTool,
  moveFileTool,
  deleteFileTool,
  generateDiffTool,
];
