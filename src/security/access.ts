import fs from 'node:fs/promises';
import path from 'node:path';
import { PathSecurityError } from '../errors/errors.js';
import type { EntryKind, ResolvedEntry, ResolveOptions } from './path-validation.js';

/**
 * Session-scoped, read-only access grants for paths outside the workspace.
 *
 * The workspace stays the only place the agent may WRITE. This module is what
 * makes Operator dynamic instead of rigid: when the user says "check drive C"
 * or "look at D:\projects\shop", the agent asks for a specific grant, the user
 * approves it once, and every read tool keeps working — in the workspace and
 * in the granted folder — for the rest of the session.
 *
 * Guarantees that do not change:
 *   - a grant is always an explicit user decision (tier 3 approval);
 *   - a grant is read-only: no create/edit/delete/move can cross it;
 *   - every path is still canonicalized through realpath and re-checked for
 *     containment, so a symlink inside a granted folder cannot escape it;
 *   - grants live in memory for one session; nothing is persisted.
 */

export interface PathGrant {
  /** Canonical absolute directory (drive roots are allowed here). */
  root: string;
  /** Short human label shown in /status and /access. */
  label: string;
  /** Why the user granted it, when the model explained. */
  reason: string;
  grantedAt: string;
}

/** True when `candidate` is `root` or sits underneath it. */
export function covers(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  return !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}

/**
 * Canonicalize a path the user approved. Unlike a workspace, a drive root or a
 * folder such as /etc is legitimate here — the user said "look there".
 */
export async function canonicalGrantRoot(input: string): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\u0000')) {
    throw new PathSecurityError('Invalid path: it is empty or contains NUL.');
  }
  const trimmed = input.trim();
  if (trimmed.length > 4096) throw new PathSecurityError('Path is unreasonably long.');
  const abs = path.resolve(trimmed);
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch {
    throw new PathSecurityError(`Path does not exist: ${abs}`, {
      hint: 'Check the spelling, or grant the parent folder instead (e.g. D:\\projects).',
    });
  }
  const stat = await fs.lstat(real);
  if (!stat.isDirectory()) {
    throw new PathSecurityError(`Not a directory: ${real}`, {
      hint: 'Grant the folder that contains the file, then read the file inside it.',
    });
  }
  return real;
}

export interface GrantEntry extends ResolvedEntry {
  /** Canonical root the path was resolved through. */
  root: string;
}

export class PathAccess {
  private readonly grants: PathGrant[] = [];

  list(): readonly PathGrant[] {
    return this.grants;
  }

  has(root: string): boolean {
    return this.grants.some((g) => path.resolve(g.root) === path.resolve(root));
  }

  /** Register a grant (idempotent per root). */
  add(root: string, reason = ''): PathGrant {
    const existing = this.grants.find((g) => g.root === root);
    if (existing) return existing;
    const grant: PathGrant = {
      root,
      label: root,
      reason: reason.slice(0, 200),
      grantedAt: new Date().toISOString(),
    };
    this.grants.push(grant);
    return grant;
  }

  /** Revoke one root, or every grant when `root` is null. Returns how many went. */
  revoke(root: string | null = null): number {
    if (root === null) {
      const count = this.grants.length;
      this.grants.length = 0;
      return count;
    }
    const before = this.grants.length;
    const target = path.resolve(root);
    for (let i = this.grants.length - 1; i >= 0; i--) {
      // Remove the grant for this path and any grant nested inside it.
      if (covers(target, this.grants[i]!.root)) this.grants.splice(i, 1);
    }
    return before - this.grants.length;
  }

  /** The most specific grant containing `candidate`, or null. */
  covering(candidate: string): PathGrant | null {
    const abs = path.resolve(candidate);
    let best: PathGrant | null = null;
    for (const grant of this.grants) {
      if (!covers(grant.root, abs)) continue;
      if (best === null || grant.root.length > best.root.length) best = grant;
    }
    return best;
  }

  /**
   * Resolve an absolute path inside a granted root. Symlinks are resolved
   * before containment is checked, exactly like the workspace boundary.
   */
  async resolve(input: string, options: ResolveOptions = {}): Promise<GrantEntry> {
    if (typeof input !== 'string' || input.length === 0 || input.includes('\u0000')) {
      throw new PathSecurityError('Invalid path supplied to a filesystem tool.');
    }
    if (input.length > 4096) throw new PathSecurityError('Path is unreasonably long.');
    if (!path.isAbsolute(input)) {
      throw new PathSecurityError(`Grants only resolve absolute paths: ${input}`, {
        hint: 'Pass the full path (e.g. C:\\Users\\me\\notes.txt) for a granted folder.',
      });
    }
    const abs = path.resolve(input);

    // Walk up to the deepest existing ancestor so a to-be-created path can be
    // checked too, then resolve links on that ancestor.
    const missing: string[] = [];
    let probe = abs;
    for (;;) {
      try {
        await fs.lstat(probe);
        break;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) throw new PathSecurityError(`Path does not exist: ${input}`);
        missing.unshift(path.basename(probe));
        probe = parent;
      }
    }
    const ancestorReal = await fs.realpath(probe);
    const target = missing.length === 0 ? await fs.realpath(abs) : path.join(ancestorReal, ...missing);
    const grant = this.covering(target);
    if (!grant) {
      throw new PathSecurityError(`No access to ${input}.`, {
        hint: 'Call request_path_access with this path (or its parent folder) to ask the user for read-only access.',
      });
    }

    let kind: EntryKind = 'missing';
    let size: number | undefined;
    let mtimeMs: number | undefined;
    if (missing.length === 0) {
      const stat = await fs.lstat(target);
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
    } else if (!options.allowMissing) {
      throw new PathSecurityError(`Path does not exist: ${input}`);
    }

    if (kind === 'file' && options.maxFileBytes !== undefined && size !== undefined && size > options.maxFileBytes) {
      throw new PathSecurityError(`File exceeds the ${options.maxFileBytes}-byte limit: ${input}`, {
        hint: 'Raise limits.maxFileBytes in config only if you really need to read very large files.',
      });
    }

    const entry: GrantEntry = {
      realPath: target,
      // Granted paths are displayed absolutely: they are not "relative" to anything.
      relativePath: target.split(path.sep).join('/'),
      kind,
      root: grant.root,
    };
    if (size !== undefined) entry.size = size;
    if (mtimeMs !== undefined) entry.mtimeMs = mtimeMs;
    return entry;
  }
}
