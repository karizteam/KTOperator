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

  /** Permanently delete one session (and its transcript). Returns false when it did not exist. */
  async delete(id: string): Promise<boolean> {
    if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) return false;
    try {
      await fs.unlink(this.file(id));
      return true;
    } catch {
      return false;
    }
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

  /** Render a session as a shareable Markdown transcript. */
  async exportMarkdown(id: string): Promise<string> {
    const { meta, messages, report } = await this.transcript(id);
    if (!meta) throw new Error(`No session found with id ${id}.`);
    const lines: string[] = [
      `# Session ${meta.id}`,
      '',
      `- Task: ${meta.task}`,
      `- Started: ${meta.startedAt}${meta.endedAt ? ` · Ended: ${meta.endedAt}` : ''}`,
      `- Provider: ${meta.provider ?? '?'} · Model: ${meta.model ?? '?'}`,
      `- Workspace: ${meta.workspace ?? '(none)'}`,
      '',
    ];
    for (const m of messages) {
      const label = m.role === 'tool' ? `tool:${m.name ?? '?'}` : m.role;
      lines.push(`## ${label}`, '', m.content || '(empty)', '');
      if (m.toolCalls?.length) lines.push(`_Called: ${m.toolCalls.map((t) => t.name).join(', ')}_`, '');
    }
    if (report) {
      lines.push('## Report', '', `- Status: ${report.status}${report.limitReason ? ` (${report.limitReason})` : ''}`, `- Iterations: ${report.iterations} · Tool calls: ${report.toolCallsTotal} · Denied: ${report.deniedCount}`, `- Usage: ${report.usage.promptTokens} in / ${report.usage.completionTokens} out${report.usage.costUsd ? ` · $${report.usage.costUsd}` : ''}`, '');
      for (const s of report.steps) for (const tc of s.toolCalls) lines.push(`- [${tc.ok ? 'x' : ' '}] ${tc.name}: ${tc.summary}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * Compressed transcript for `/resume`: keeps the first user task, the last
   * 6 turns verbatim, and one-line summaries of everything older — so a
   * resumed session costs a fraction of the original context.
   */
  async compressedTranscript(id: string, keepLast = 6): Promise<ChatMessage[]> {
    const { messages } = await this.transcript(id);
    if (messages.length <= keepLast + 1) return messages;
    const first = messages[0]!;
    const tail = messages.slice(-keepLast);
    const middle = messages.slice(1, -keepLast);
    const summary: ChatMessage = {
      role: 'user',
      content: `[Resumed session context compressed: ${middle.length} earlier message(s) summarized. ` +
        middle.map((m) => `[${m.role}${m.name ? `:${m.name}` : ''}] ${m.content.slice(0, 120).replace(/\s+/g, ' ')}`).join(' | ') + `
Continue from here.]`,
    };
    return [first, summary, ...tail];
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
