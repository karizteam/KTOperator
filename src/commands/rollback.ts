import { OperatorError } from '../errors/errors.js';
import type { Runtime } from './runtime.js';

/** `operator backups <sessionId>` — list what can be restored. */
export async function backupsList(rt: Runtime, sessionId: string | undefined): Promise<void> {
  if (sessionId) {
    const entries = await rt.backups.list(sessionId);
    rt.ui.emit({ sessionId, entries }, (d) => {
      const e = (d as { entries: typeof entries }).entries;
      if (e.length === 0) return `No backups recorded for session ${sessionId}.`;
      return e
        .map((b) => `${b.ts.slice(0, 19).replace('T', ' ')}  ${b.op.padEnd(7)}  ${b.source}${b.backupPath ? '  (snapshot)' : '  (NO snapshot)'}`)
        .join('\n');
    });
    return;
  }
  const sessions = await rt.backups.listSessions();
  rt.ui.emit({ sessions }, (d) => {
    const s = (d as { sessions: string[] }).sessions;
    return s.length === 0 ? 'No backups recorded yet.' : `Sessions with backups:\n${s.map((x) => `  ${x}`).join('\n')}\nRun \`operator backups <sessionId>\` for details.`;
  });
}

/** `operator rollback <sessionId>` — restore backed-up changes, best-effort. */
export async function rollback(rt: Runtime, sessionId: string, confirm: boolean): Promise<void> {
  const entries = await rt.backups.list(sessionId);
  if (entries.length === 0) {
    throw new OperatorError('NOT_FOUND', `No backups exist for session ${sessionId}.`, {
      hint: 'operator backups — lists sessions that have snapshots.',
    });
  }
  if (!confirm) {
    rt.ui.warn(`This will attempt to restore ${entries.length} change(s) from session ${sessionId.slice(0, 8)}:`);
    for (const b of entries.slice(0, 10)) rt.ui.info(`  ${b.op.padEnd(7)} ${b.source}${b.backupPath ? '' : '  (no snapshot → file will be REMOVED if it was created by the agent)'}`);
    if (entries.length > 10) rt.ui.info(`  … and ${entries.length - 10} more`);
    const ok = rt.ui.interactive ? await rt.ui.confirm('Proceed with rollback?') : false;
    if (!ok) throw new OperatorError('APPROVAL_DENIED', 'Rollback not confirmed. Pass --yes all in non-interactive mode only if you understand the impact.');
  }
  const result = await rt.backups.rollback(sessionId);
  const audit = rt.makeAudit(sessionId);
  await audit.record({ event: 'file.restore', detail: result as unknown as Record<string, unknown> });
  rt.ui.emit({ sessionId, ...result, note: 'Rollback covers file contents only; external side effects (commands already run, installs) cannot be undone.' }, () => '');
  if (!rt.ui.jsonMode) {
    for (const p of result.restored) rt.ui.success(`restored  ${p}`);
    for (const p of result.deleted) rt.ui.success(`removed   ${p} (was created by the agent)`);
    for (const f of result.failed) rt.ui.error(`FAILED    ${f.path}: ${f.reason}`);
    rt.ui.warn('Note: rollback restores file contents only; commands already executed are not reversible.');
  }
}
