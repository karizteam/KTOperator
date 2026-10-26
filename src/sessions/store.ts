import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sessionsDir } from '../platform/paths.js';
import type { AgentReport } from '../core/agent/loop.js';
import type { ChatMessage } from '../providers/interfaces/types.js';

/**
 * Session history: append-only JSONL per session. Streams are never held
 * whole in memory; `list` reads just enough to summarize.
 */

export interface SessionMeta {
  id: string;
  startedAt: string;
  task: string;
  provider?: string;
  model?: string;
  workspace?: string;
  status?: AgentReport['status'];
  endedAt?: string;
  iterations?: number;
  toolCalls?: number;
}

type SessionEntry =
  | ({ type: 'meta' } & SessionMeta)
  | { type: 'message'; ts: string; message: ChatMessage }
  | { type: 'event'; ts: string; event: string; detail?: string }
  | { type: 'report'; ts: string; report: AgentReport };

export class SessionStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? sessionsDir();
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  async create(meta: Omit<SessionMeta, 'id' | 'startedAt'> & { id?: string }): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = meta.id ?? randomUUID();
    const entry: SessionEntry = { type: 'meta', id, startedAt: new Date().toISOString(), ...meta } as SessionEntry;
    await fs.writeFile(this.file(id), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return id;
  }

  async appendMessage(id: string, message: ChatMessage): Promise<void> {
    await this.append(id, { type: 'message', ts: new Date().toISOString(), message });
  }

  async appendEvent(id: string, event: string, detail?: string): Promise<void> {
    await this.append(id, { type: 'event', ts: new Date().toISOString(), event, ...(detail !== undefined ? { detail } : {}) });
  }

  async appendReport(id: string, report: AgentReport): Promise<void> {
    await this.append(id, { type: 'report', ts: new Date().toISOString(), report });
  }

  private async append(id: string, entry: SessionEntry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.appendFile(this.file(id), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  private async entries(id: string): Promise<SessionEntry[]> {
    const raw = await fs.readFile(this.file(id), 'utf8');
    const out: SessionEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as SessionEntry);
      } catch {
        /* tolerate torn tail writes */
      }
    }
    return out;
  }

  async list(limit = 20): Promise<SessionMeta[]> {
    let files: string[];
    try {
      files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const file of files) {
      try {
        const id = file.replace(/\.jsonl$/, '');
        const meta = (await this.entries(id)).find((e) => e.type === 'meta');
        if (meta && meta.type === 'meta') metas.push({ ...meta });
      } catch {
        /* unreadable session */
      }
    }
    return metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit);
  }

  /** Full transcript for `operator history <id>`. */
  async transcript(id: string): Promise<{ meta: SessionMeta | null; messages: ChatMessage[]; report: AgentReport | null }> {
    const entries = await this.entries(id);
    const meta = (entries.find((e) => e.type === 'meta') as ({ type: 'meta' } & SessionMeta) | undefined) ?? null;
    const report = (entries.find((e) => e.type === 'report') as { type: 'report'; report: AgentReport } | undefined)?.report ?? null;
    const messages = entries.filter((e): e is { type: 'message'; ts: string; message: ChatMessage } => e.type === 'message').map((e) => e.message);
    return { meta, messages, report };
  }
}
