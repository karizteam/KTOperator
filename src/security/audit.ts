import fs from 'node:fs/promises';
import path from 'node:path';
import { auditDir } from '../platform/paths.js';
import { redactValue } from './redaction.js';

/**
 * Append-only structured audit log (JSONL, one file per day). Tool calls,
 * policy decisions, approvals, executions, and session lifecycle events all
 * land here. Everything passes through the redactor first.
 */
export type AuditEventType =
  | 'session.start'
  | 'session.end'
  | 'tool.request'
  | 'tool.result'
  | 'approval'
  | 'command.execute'
  | 'desktop.launch'
  | 'process.close'
  | 'access.grant'
  | 'access.revoke'
  | 'file.backup'
  | 'file.restore'
  | 'sandbox.select'
  | 'error';

export interface AuditEvent {
  ts: string;
  sessionId: string;
  event: AuditEventType;
  tool?: string;
  tier?: number;
  decision?: string;
  detail?: Record<string, unknown>;
}

export class AuditLog {
  private readonly dir: string;
  private readonly sessionId: string;

  constructor(sessionId: string, dir?: string) {
    this.sessionId = sessionId;
    this.dir = dir ?? auditDir();
  }

  private fileForToday(): string {
    return path.join(this.dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  async record(event: Omit<AuditEvent, 'ts' | 'sessionId'>): Promise<void> {
    const entry: AuditEvent = {
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      ...redactValue(event),
    };
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fs.appendFile(this.fileForToday(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // Auditing must never crash the agent; diagnostics surface elsewhere.
    }
  }

  /** Read audit entries, newest last. */
  static async read(options: { dir?: string; limit?: number; sessionId?: string }): Promise<AuditEvent[]> {
    const dir = options.dir ?? auditDir();
    const limit = options.limit ?? 200;
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      return [];
    }
    const events: AuditEvent[] = [];
    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        for (const line of raw.split('\n')) {
          if (line.trim() === '') continue;
          try {
            const ev = JSON.parse(line) as AuditEvent;
            if (options.sessionId && ev.sessionId !== options.sessionId) continue;
            events.push(ev);
          } catch {
            /* tolerate torn writes */
          }
        }
      } catch {
        /* unreadable file */
      }
    }
    return events.slice(-limit);
  }
}
