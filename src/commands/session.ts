import { AuditLog } from '../security/audit.js';
import { NotFoundOrEmpty } from './agent.js';
import type { Runtime } from './runtime.js';

/** `operator session list` — recent agent sessions. */
export async function sessionList(rt: Runtime, limit: number): Promise<void> {
  const sessions = await rt.sessions.list(limit);
  rt.ui.emit({ sessions }, (d) => {
    const s = (d as { sessions: typeof sessions }).sessions;
    if (s.length === 0) return 'No sessions recorded yet. Run `operator run "<task>"` to start one.';
    return s
      .map(
        (m) =>
          `${m.startedAt.slice(0, 19).replace('T', ' ')}  ${m.id.slice(0, 8)}  ${(m.status ?? 'running').padEnd(9)}  ${(m.model ?? '?').padEnd(28)}  ${truncate(m.task, 60)}`,
      )
      .join('\n');
  });
}

/** `operator history [sessionId]` — audit trail or full session transcript. */
export async function history(rt: Runtime, sessionId: string | undefined, limit: number): Promise<void> {
  if (sessionId) {
    const { meta, messages, report } = await rt.sessions.transcript(sessionId).catch(() => {
      throw NotFoundOrEmpty(`No session found with id ${sessionId}.`);
    });
    if (!meta) throw NotFoundOrEmpty(`No session found with id ${sessionId}.`);
    const payload = {
      meta,
      report: report
        ? { status: report.status, iterations: report.iterations, toolCalls: report.toolCallsTotal, denied: report.deniedCount, usage: report.usage, durationMs: report.durationMs, limitReason: report.limitReason ?? null }
        : null,
      messages: messages.map((m) => ({ role: m.role, name: m.name ?? null, content: clip(m.content, 4000), toolCalls: m.toolCalls?.map((t) => t.name) ?? [] })),
    };
    rt.ui.emit(payload, () => '');
    if (!rt.ui.jsonMode) {
      rt.ui.info(rt.ui.bold(`Session ${sessionId.slice(0, 8)} — ${meta.task}`));
      rt.ui.info(rt.ui.dim(`started ${meta.startedAt}, status ${meta.status ?? 'unknown'}`));
      for (const m of messages) {
        const label = m.role === 'tool' ? `tool:${m.name ?? '?'}` : m.role;
        rt.ui.info(rt.ui.cyan(`\n[${label}]`));
        rt.ui.info(clip(m.content, 1200));
        if (m.toolCalls && m.toolCalls.length > 0) rt.ui.info(rt.ui.dim(`  → called: ${m.toolCalls.map((t) => t.name).join(', ')}`));
      }
      if (report) {
        rt.ui.info(rt.ui.bold('\nFinal report'));
        rt.ui.info(`  status: ${report.status}${report.limitReason ? ` (${report.limitReason})` : ''}`);
        rt.ui.info(`  iterations: ${report.iterations}, tool calls: ${report.toolCallsTotal}, denied: ${report.deniedCount}`);
      }
    }
    return;
  }
  // No id → recent audit log entries.
  const events = await AuditLog.read({ limit });
  rt.ui.emit({ events }, (d) => {
    const evs = (d as { events: typeof events }).events;
    if (evs.length === 0) return 'No audit events recorded yet.';
    return evs
      .map((e) => `${e.ts.slice(0, 19).replace('T', ' ')}  ${e.sessionId.slice(0, 8)}  ${e.event.padEnd(16)}  ${e.tool ?? ''} ${e.decision ?? ''}`)
      .join('\n');
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n[clipped]` : s;
}
