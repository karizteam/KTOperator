import fs from 'node:fs/promises';
import path from 'node:path';
import { PathSecurityError } from '../errors/errors.js';
import { isFilesystemRoot, pathsEqual } from '../platform/paths.js';

export type EntryKind = 'file' | 'directory' | 'missing';

export interface ResolvedEntry {
  /** Canonical, symlink-free absolute path inside the workspace. */
  realPath: string;
  /** Path relative to the workspace root (POSIX separators). */
  relativePath: string;
  kind: EntryKind;
  size?: number;
  mtimeMs?: number;
}

export interface ResolveOptions {
  /** When true, a non-existent final component is allowed (creation intent). */
  allowMissing?: boolean;
  /** When set, files larger than this many bytes are rejected. */
  maxFileBytes?: number;
}

/**
 * WorkspaceBoundary — the single choke point through which every filesystem
 * access flows. It resolves each candidate path through the filesystem itself
 * (realpath), never through string manipulation alone:
 *
 *  - lexical normalization against the canonical workspace root;
 *  - realpath of the deepest existing ancestor so symlink/junction escapes
 *    resolve to their target before containment is checked;
 *  - containment via path.relative segment analysis (not prefix matching);
 *  - rejection of special files (devices, sockets, FIFOs);
 *  - optional size enforcement.
 *
 * The root is re-canonicalized on every resolve, which narrows the TOCTOU
 * window if the workspace directory itself is swapped for a symlink.
 */
export class WorkspaceBoundary {
  private constructor(private readonly canonicalRoot: string) {}

  static async create(rootPath: string): Promise<WorkspaceBoundary> {
    if (typeof rootPath !== 'string' || rootPath.trim() === '' || rootPath.includes('\u0000')) {
      throw new PathSecurityError('Workspace path is empty or invalid.');
    }
    const abs = path.resolve(rootPath);
    if (isFilesystemRoot(abs)) {
      throw new PathSecurityError('A filesystem root cannot be used as a workspace.', {
        hint: 'Select a project directory, not the root of a drive.',
      });
    }
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      throw new PathSecurityError(`Workspace path does not exist: ${abs}`, {
        hint: 'Create the directory first, or run `operator workspace select` again.',
      });
    }
    const stat = await fs.lstat(real);
    if (!stat.isDirectory()) {
      throw new PathSecurityError(`Workspace path is not a directory: ${abs}`);
    }
    if (isFilesystemRoot(real)) {
      throw new PathSecurityError('A filesystem root cannot be used as a workspace.');
    }
    return new WorkspaceBoundary(real);
  }

  get root(): string {
    return this.canonicalRoot;
  }

  private async currentRoot(): Promise<string> {
    // Re-resolve to catch a swapped workspace directory (TOCTOU mitigation).
    const real = await fs.realpath(this.canonicalRoot);
    if (!pathsEqual(real, this.canonicalRoot)) {
      throw new PathSecurityError('Workspace path changed on disk since it was selected.', {
        hint: 'Re-run `operator workspace select` to re-authorize the new location.',
      });
    }
    return real;
  }

  private checkContained(real: string, root: string, original: string): void {
    const rel = path.relative(root, real);
    if (rel === '') return; // the root itself
    const segments = rel.split(path.sep);
    if (segments[0] === '..' || path.isAbsolute(rel)) {
      throw new PathSecurityError(`Path escapes the authorized workspace: ${original}`, {
        hint: 'The agent may only access files inside the selected workspace.',
        details: { root, resolved: real },
      });
    }
  }

  /**
   * Resolve `input` (absolute or workspace-relative) to a canonical in-scope
   * path, validating containment through the real filesystem.
   */
  async resolve(input: string, options: ResolveOptions = {}): Promise<ResolvedEntry> {
    if (typeof input !== 'string' || input.length === 0 || input.includes('\u0000')) {
      throw new PathSecurityError('Invalid path supplied to a filesystem tool.');
    }
    if (input.length > 4096) {
      throw new PathSecurityError('Path is unreasonably long.');
    }
    const root = await this.currentRoot();
    const candidate = path.resolve(root, input);

    // Walk up to the deepest existing ancestor to resolve links on the path,
    // even when the final component does not exist yet (creation case).
    const missing: string[] = [];
    let probe = candidate;
    for (;;) {
      try {
        await fs.lstat(probe);
        break;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) throw new PathSecurityError(`Path escapes the authorized workspace: ${input}`);
        missing.unshift(path.basename(probe));
        probe = parent;
      }
    }

    const ancestorReal = await fs.realpath(probe);
    this.checkContained(ancestorReal, root, input);

    let real: string;
    let kind: EntryKind = 'missing';
    let size: number | undefined;
    let mtimeMs: number | undefined;

    if (missing.length === 0) {
      real = await fs.realpath(candidate);
      this.checkContained(real, root, input);
      const stat = await fs.lstat(real);
      if (stat.isDirectory()) kind = 'directory';
      else if (stat.isFile()) {
        kind = 'file';
        size = stat.size;
        mtimeMs = stat.mtimeMs;
      } else {
        throw new PathSecurityError(`Unsupported file type (device, socket, or FIFO): ${input}`, {
          hint: 'Operator tools only work on regular files and directories.',
        });
      }
    } else {
      if (!options.allowMissing) {
        throw new PathSecurityError(`Path does not exist: ${input}`);
      }
      real = path.join(ancestorReal, ...missing);
      this.checkContained(real, root, input);
      // Guard against creating through a dangling symlink ancestor chain.
      if (missing.some((seg) => seg === '..' || seg === '.')) {
        throw new PathSecurityError(`Refusing to create through traversal segments: ${input}`);
      }
    }

    if (kind === 'file' && options.maxFileBytes !== undefined && size !== undefined && size > options.maxFileBytes) {
      throw new PathSecurityError(`File exceeds the ${formatBytes(options.maxFileBytes)} limit: ${input}`, {
        hint: 'Raise limits.maxFileBytes in config only if you really need to read very large files.',
      });
    }

    const relativePath = path.relative(root, real).split(path.sep).join('/');
    const entry: ResolvedEntry = { realPath: real, relativePath: relativePath === '' ? '.' : relativePath, kind };
    if (size !== undefined) entry.size = size;
    if (mtimeMs !== undefined) entry.mtimeMs = mtimeMs;
    return entry;
  }

  /** Convenience: assert the entry exists and is a file. */
  async resolveFile(input: string, options: ResolveOptions = {}): Promise<ResolvedEntry> {
    const e = await this.resolve(input, options);
    if (e.kind !== 'file') throw new PathSecurityError(`Not a regular file: ${input}`);
    return e;
  }

  /** Convenience: assert the entry exists and is a directory. */
  async resolveDirectory(input: string): Promise<ResolvedEntry> {
    const e = await this.resolve(input);
    if (e.kind !== 'directory') throw new PathSecurityError(`Not a directory: ${input}`);
    return e;
  }
}

/** Validate a path the user typed at the CLI (outside agent control). */
export async function validateUserWorkspaceSelection(p: string): Promise<string> {
  const boundary = await WorkspaceBoundary.create(p);
  return boundary.root;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u += 1;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}
