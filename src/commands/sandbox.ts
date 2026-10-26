import type { Runtime } from './runtime.js';

/** `operator sandbox status` — honest picture of execution isolation. */
export async function sandboxStatus(rt: Runtime): Promise<void> {
  const manager = rt.makeSandbox();
  const selected = await manager.prepare();
  const statuses = await manager.statuses();
  const payload = {
    selected: statuses.find((s) => s.available)?.id ?? null,
    backendPreference: rt.config.sandbox.backend,
    image: rt.config.sandbox.image,
    networkEnabled: rt.config.sandbox.network,
    restrictedFallbackEnabled: rt.config.security.allowRestrictedProcessFallback,
    backends: statuses.map((s) => ({
      id: s.id,
      label: s.label,
      available: s.available,
      reason: s.reason ?? null,
      capabilities: s.capabilities,
      limitations: s.limitations,
    })),
  };
  rt.ui.emit(payload, () => '');
  if (!rt.ui.jsonMode) {
    rt.ui.info(rt.ui.bold('Sandbox status'));
    for (const b of payload.backends) {
      rt.ui.info(`  ${b.available ? rt.ui.green('●') : rt.ui.yellow('○')} ${b.label} (${b.id}) — ${b.available ? 'available' : b.reason ?? 'unavailable'}`);
      for (const cap of b.capabilities) rt.ui.info(rt.ui.dim(`      + ${cap}`));
      if (b.available) for (const lim of b.limitations) rt.ui.info(rt.ui.dim(`      - ${lim}`));
    }
    const sel = payload.selected;
    if (sel) rt.ui.success(`Active backend for command execution: ${sel}`);
    else rt.ui.warn(`No backend available — AI-directed command execution will be refused. ${selected.reason ?? ''}`);
  }
}
