import fs from 'node:fs/promises';
import { AuditLog } from '../security/audit.js';
import { addUsage, cacheHitRate, emptyTotals, formatCost, formatTokens, usageSummaryLines } from '../util/usage.js';
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

/** `operator session delete <id>` — permanently delete one previous session. */
export async function sessionDelete(rt: Runtime, sessionId: string): Promise<void> {
  const match = (await rt.sessions.list(100)).find((m) => m.id.startsWith(sessionId));
  if (!match) throw NotFoundOrEmpty(`No session matches "${sessionId}".`);
  const ok = await rt.sessions.delete(match.id);
  if (!ok) throw NotFoundOrEmpty(`No session matches "${sessionId}".`);
  rt.ui.emit({ sessionId: match.id, deleted: true }, () => `Deleted session ${match.id.slice(0, 8)} (${match.task}).`);
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

/** `operator session export <id> [--out file]` — Markdown transcript. */
export async function sessionExport(rt: Runtime, sessionId: string, outPath?: string): Promise<void> {
  const md = await rt.sessions.exportMarkdown(sessionId).catch(() => {
    throw NotFoundOrEmpty(`No session found with id ${sessionId}.`);
  });
  if (outPath) {
    await fs.writeFile(outPath, md, 'utf8');
    rt.ui.emit({ sessionId, out: outPath, bytes: md.length }, () => `Exported session ${sessionId.slice(0, 8)} to ${outPath} (${md.length} bytes).`);
    return;
  }
  rt.ui.emit({ sessionId, markdown: md }, () => md);
}

/** `operator usage [sessionId]` — token/cache/cost breakdown for one session, or totals across all sessions. */
export async function usage(rt: Runtime, sessionId: string | undefined): Promise<void> {
  const totals = emptyTotals();
  const rows: { id: string; task: string; prompt: number; completion: number; cached: number; cost: number }[] = [];
  const ids = sessionId ? [sessionId] : (await rt.sessions.list(100)).map((m) => m.id);
  for (const id of ids) {
    const { meta, report } = await rt.sessions.transcript(id);
    if (!meta || !report) continue;
    addUsage(totals, report.usage);
    rows.push({ id: meta.id.slice(0, 8), task: meta.task, prompt: report.usage.promptTokens, completion: report.usage.completionTokens, cached: report.usage.cachedTokens ?? 0, cost: report.usage.costUsd ?? 0 });
  }
  const payload = { totals, sessions: rows };
  rt.ui.emit(payload, (d) => {
    const p = d as typeof payload;
    const lines = usageSummaryLines(p.totals, { tokenBudget: rt.config.limits.tokenBudget });
    const perSession = p.sessions.slice(0, 10).map((s) => `  ${s.id}  ${formatTokens(s.prompt + s.completion)} tok${s.cached > 0 ? ` (${formatTokens(s.cached)} cached)` : ''}${s.cost > 0 ? ` · ${formatCost(s.cost)}` : ''}  ${truncate(s.task, 50)}`);
    return [`Usage — ${sessionId ? `session ${sessionId.slice(0, 8)}` : `${p.sessions.length} session(s)`}`, ...lines.map((l) => `  ${l}`), ...(perSession.length ? ['', 'Per session:', ...perSession] : ['  (no finished sessions with usage yet)'])].join('\n');
  });
  if (!rt.ui.jsonMode && totals.cachedTokens > 0) {
    rt.ui.info(rt.ui.dim(`  cache hit rate: ${cacheHitRate(totals).toFixed(0)}% of prompt tokens served from cache`));
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n[clipped]` : s;
}
