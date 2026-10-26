import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { backupsDir } from '../platform/paths.js';
import type { OperatorConfig } from '../config/schema.js';
import type { AuditLog } from '../security/audit.js';

/**
 * Snapshot-based recovery. Before any approved modification of an existing
 * file, its content (and metadata) is copied into the backup store keyed by
 * session. `rollback` restores what is restorable and reports what is not —
 * rollback is never claimed for side effects outside the file itself.
 */

export interface BackupEntry {
  id: string;
  sessionId: string;
  ts: string;
  op: 'create' | 'edit' | 'move' | 'delete';
  /** Original absolute path (inside the then-active workspace). */
  source: string;
  /** Backup copy path, null for create-of-new-file (rollback = delete). */
  backupPath: string | null;
  sha256: string | null;
  sizeBytes: number;
  /** For move: where the file was moved to. */
  movedTo?: string;
}

export class BackupManager {
  private readonly root: string;

  constructor(
    private readonly config: OperatorConfig,
    root?: string,
  ) {
    this.root = root ?? backupsDir();
  }

  private manifestPath(sessionId: string): string {
    return path.join(this.root, sessionId, 'manifest.jsonl');
  }

  /** Snapshot `absPath` before mutation. */
  async backup(sessionId: string, absPath: string, op: BackupEntry['op'], opts: { movedTo?: string; audit?: AuditLog } = {}): Promise<BackupEntry> {
    const id = crypto.randomUUID();
    let backupPath: string | null = null;
    let sha256: string | null = null;
    let sizeBytes = 0;
    try {
      const content = await fs.readFile(absPath);
      sizeBytes = content.length;
      sha256 = crypto.createHash('sha256').update(content).digest('hex');
      if (this.config.backups.enabled) {
        const dir = path.join(this.root, sessionId, id);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        backupPath = path.join(dir, path.basename(absPath));
        await fs.writeFile(backupPath, content, { mode: 0o600 });
      }
    } catch {
      // File may not exist yet (create); that is fine.
    }
    const entry: BackupEntry = {
      id,
      sessionId,
      ts: new Date().toISOString(),
      op,
      source: absPath,
      backupPath,
      sha256,
      sizeBytes,
      ...(opts.movedTo ? { movedTo: opts.movedTo } : {}),
    };
    if (this.config.backups.enabled) {
      await fs.mkdir(path.join(this.root, sessionId), { recursive: true, mode: 0o700 });
      await fs.appendFile(this.manifestPath(sessionId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      await this.prune();
    }
    await opts.audit?.record({ event: 'file.backup', detail: { id, op, source: redactish(absPath), sizeBytes } });
    return entry;
  }

  async list(sessionId: string): Promise<BackupEntry[]> {
    try {
      const raw = await fs.readFile(this.manifestPath(sessionId), 'utf8');
      return raw
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as BackupEntry);
    } catch {
      return [];
    }
  }

  async listSessions(): Promise<string[]> {
    try {
      return (await fs.readdir(this.root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** Restore every change from a session, newest first. Returns a report per file. */
  async rollback(sessionId: string): Promise<{ restored: string[]; deleted: string[]; failed: { path: string; reason: string }[] }> {
    const entries = (await this.list(sessionId)).reverse();
    const restored: string[] = [];
    const deleted: string[] = [];
    const failed: { path: string; reason: string }[] = [];
    for (const entry of entries) {
      try {
        if (entry.op === 'create' && entry.backupPath === null) {
          await fs.rm(entry.source, { force: true });
          deleted.push(entry.source);
          continue;
        }
        if (entry.backupPath === null) {
          failed.push({ path: entry.source, reason: 'no snapshot exists for this entry' });
          continue;
        }
        const backupContent = await fs.readFile(entry.backupPath);
        if (entry.sha256) {
          const actual = crypto.createHash('sha256').update(backupContent).digest('hex');
          if (actual !== entry.sha256) throw new Error('backup integrity check failed (sha256 mismatch)');
        }
        await fs.mkdir(path.dirname(entry.source), { recursive: true });
        await fs.writeFile(entry.source, backupContent);
        if (entry.op === 'move' && entry.movedTo) {
          await fs.rm(entry.movedTo, { force: true });
        }
        restored.push(entry.source);
      } catch (err) {
        failed.push({ path: entry.source, reason: (err as Error).message });
      }
    }
    return { restored, deleted, failed };
  }

  /** Enforce backups.maxMb by deleting oldest session backup dirs. */
  private async prune(): Promise<void> {
    const maxBytes = this.config.backups.maxMb * 1024 * 1024;
    let total = 0;
    const dirs: { name: string; size: number; mtimeMs: number }[] = [];
    for (const session of await this.listSessions()) {
      const dir = path.join(this.root, session);
      const size = await dirSize(dir).catch(() => 0);
      const stat = await fs.stat(dir).catch(() => null);
      dirs.push({ name: session, size, mtimeMs: stat?.mtimeMs ?? 0 });
      total += size;
    }
    dirs.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const d of dirs) {
      if (total <= maxBytes) break;
      await fs.rm(path.join(this.root, d.name), { recursive: true, force: true }).catch(() => undefined);
      total -= d.size;
    }
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fs.stat(p)).size;
  }
  return total;
}

function redactish(p: string): string {
  return p.replace(/\\/g, '/');
}
