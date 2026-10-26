import { configHome } from '../platform/paths.js';
import { VERSION } from '../version.js';
import type { Runtime } from './runtime.js';
import { workspaceSelect } from './workspace.js';

/** `operator init` — set up config home, write a valid config, greet honestly. */
export async function init(rt: Runtime): Promise<void> {
  const existed = await rt.store.exists();
  await rt.store.ensureHome();
  if (!existed) await rt.store.save(rt.config);

  const payload = {
    initialized: true,
    configHome: configHome(),
    configCreated: !existed,
    version: VERSION,
  };
  rt.ui.emit(payload, () => '');
  if (!rt.ui.jsonMode) {
    rt.ui.success(`KarizTeam Operator ${VERSION} initialized.`);
    rt.ui.info(`Config home: ${configHome()} ${existed ? '(existing config kept)' : '(fresh default config written)'}`);
    rt.ui.step('Next: run `ktoperator` — the console walks you through provider, API key and model, then opens the chatbox.');
  }

  if (rt.ui.interactive && !rt.config.workspace.current) {
    const yes = await rt.ui.confirm('Select a workspace now?');
    if (yes) await workspaceSelect(rt, undefined);
  }
}
