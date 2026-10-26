import path from 'node:path';
import os from 'node:os';
import { WorkspaceError, UserCancelledError } from '../errors/errors.js';
import { WorkspaceBoundary, validateUserWorkspaceSelection } from '../security/path-validation.js';
import type { Runtime } from './runtime.js';

/**
 * `operator workspace select [path]` — explicit user authorization of the
 * only directory tree the agent may touch. Validates the canonical path,
 * records the grant, and warns (with confirmation) when the chosen scope is
 * unusually broad (the home directory).
 */
export async function workspaceSelect(rt: Runtime, target: string | undefined): Promise<void> {
  let chosen: string | undefined = target;

  if (!chosen && rt.ui.interactive) {
    const cwd = process.cwd();
    const recent = rt.config.workspace.recent.map((r) => r.path);
    const options = [...new Set([cwd, ...recent])];
    const idx = await rt.ui.promptSelect('Select the workspace to authorize:', [...options, 'Enter a different path…']);
    if (idx === options.length) {
      chosen = await rt.ui.promptInput('Workspace path', { required: true });
    } else {
      chosen = options[idx];
    }
  }

  if (!chosen) chosen = '.'; // non-interactive default: current directory
  const resolvedInput = path.resolve(chosen);

  const canonical = await validateUserWorkspaceSelection(resolvedInput).catch((err) => {
    throw new WorkspaceError(`Cannot use ${resolvedInput} as a workspace: ${(err as Error).message}`, {
      hint: 'Create the directory first; it cannot be a filesystem root or a special file.',
    });
  });

  if (canonical === os.homedir()) {
    rt.ui.warn('You selected your home directory. This grants read access to personal files within the workspace scope.');
    rt.ui.warn('A narrower project directory is strongly recommended.');
    const ok = rt.ui.interactive ? await rt.ui.confirm('Really authorize the entire home directory?') : false;
    if (!ok) throw new UserCancelledError('Home directory scope was not confirmed.');
  }

  // Prove we can construct the boundary before recording the grant.
  await WorkspaceBoundary.create(canonical);
  const name = path.basename(canonical);
  const selectedAt = new Date().toISOString();

  rt.config = await rt.store.update((config) => {
    config.workspace.current = { path: canonical, name, selectedAt };
    config.workspace.recent = [
      { path: canonical, name, selectedAt },
      ...config.workspace.recent.filter((r) => r.path !== canonical),
    ].slice(0, 10);
  });
  // The cached boundary belongs to the previous grant — rebuild for the new one.
  rt.invalidateWorkspace();

  const payload = { selected: true, workspace: { path: canonical, name, selectedAt } };
  rt.ui.emit(payload, () => '');
  if (!rt.ui.jsonMode) rt.ui.success(`Workspace authorized: ${canonical}`);
}

/** `operator workspace show` — display the current grant + its state. */
export async function workspaceShow(rt: Runtime): Promise<void> {
  const current = rt.config.workspace.current;
  const boundary = await rt.workspaceBoundary();
  const payload = {
    workspace: current ?? null,
    validNow: boundary !== null,
    recent: rt.config.workspace.recent,
  };
  rt.ui.emit(payload, (d) => {
    const p = d as typeof payload;
    if (!p.workspace) return 'No workspace selected. Run `operator workspace select`.';
    return [
      `Workspace : ${p.workspace.path}`,
      `Name      : ${p.workspace.name}`,
      `Selected  : ${p.workspace.selectedAt}`,
      `State     : ${p.validNow ? 'valid and enforced' : 'INVALID (path changed or missing — re-select)'}`,
    ].join('\n');
  });
}
