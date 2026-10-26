import fs from 'node:fs/promises';
import { configHome } from '../platform/paths.js';
import { getRuntimeVersions } from '../platform/system-info.js';
import type { Runtime } from './runtime.js';

interface Check {
  name: string;
  ok: boolean;
  severity: 'critical' | 'warning' | 'info';
  detail: string;
}

/** `operator doctor` — environment diagnostics without leaking secrets. */
export async function doctor(rt: Runtime): Promise<number> {
  const checks: Check[] = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node-runtime',
    ok: nodeMajor >= 20,
    severity: nodeMajor >= 20 ? 'info' : 'critical',
    detail: `Node ${process.versions.node} (requires >= 20; 22+ recommended).`,
  });

  const home = configHome();
  let homeOk = true;
  let homeDetail = `Config home: ${home}`;
  try {
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const probe = `${home}/.doctor-probe-${process.pid}`;
    await fs.writeFile(probe, '');
    await fs.rm(probe);
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(home)).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        homeOk = false;
        homeDetail += ` — permissions ${mode.toString(8)} are too open (expected 700)`;
      } else {
        homeDetail += ' (permissions 700)';
      }
    }
  } catch (err) {
    homeOk = false;
    homeDetail = `Config home is not writable: ${(err as Error).message}`;
  }
  checks.push({ name: 'config-home', ok: homeOk, severity: homeOk ? 'info' : 'critical', detail: homeDetail });

  const cfgOk = rt.config.providers.length >= 0; // config already validated at load time
  checks.push({ name: 'config-valid', ok: cfgOk, severity: 'info', detail: 'Configuration loaded and passed schema validation.' });

  if (rt.config.providers.length === 0) {
    checks.push({ name: 'providers', ok: false, severity: 'warning', detail: 'No AI provider configured yet. Run `ktoperator` — the console guides setup.' });
  }
  for (const profile of rt.config.providers) {
    const key = await rt.credentials.resolve(profile);
    checks.push({
      name: `provider:${profile.id}`,
      ok: key.value !== null || profile.type === 'ollama',
      severity: key.value !== null || profile.type === 'ollama' ? 'info' : 'warning',
      detail: `${profile.type} profile "${profile.id}" — key source: ${key.source === 'environment' ? `env ${key.envName}` : key.source}${profile.type === 'ollama' ? ' (key not required)' : ''}.`,
    });
  }

  const current = rt.config.workspace.current;
  if (!current) {
    checks.push({ name: 'workspace', ok: false, severity: 'warning', detail: 'No workspace selected. Run `operator workspace select`.' });
  } else {
    const boundary = await rt.workspaceBoundary();
    checks.push({
      name: 'workspace',
      ok: boundary !== null,
      severity: boundary ? 'info' : 'critical',
      detail: boundary ? `Workspace authorized and valid: ${current.path}` : `Workspace INVALID: ${current.path} no longer resolves safely. Re-select it.`,
    });
  }

  const sandbox = rt.makeSandbox();
  const statuses = await sandbox.statuses();
  for (const s of statuses) {
    checks.push({
      name: `sandbox:${s.id}`,
      ok: s.available,
      severity: s.available ? 'info' : 'warning',
      detail: `${s.label}: ${s.available ? 'available' : `NOT available — ${s.reason ?? 'unknown'}`}`,
    });
  }
  const anySandbox = statuses.some((s) => s.available);
  checks.push({
    name: 'sandbox-overall',
    ok: anySandbox,
    severity: anySandbox ? 'info' : 'warning',
    detail: anySandbox ? 'Command execution is possible inside a sandbox.' : 'No sandbox backend available: command execution will be REFUSED (read-only analysis still works). See docs/sandbox.md.',
  });

  const versions = getRuntimeVersions();
  checks.push({
    name: 'tools',
    ok: versions.git !== null,
    severity: versions.git ? 'info' : 'warning',
    detail: `git: ${versions.git ?? 'not found'}, docker: ${versions.docker ?? 'not found'}, npm: ${versions.npm ?? 'not found'}.`,
  });

  const hasCritical = checks.some((c) => !c.ok && c.severity === 'critical');
  const payload = { healthy: !hasCritical, checks };
  rt.ui.emit(payload, (d) => {
    const p = d as typeof payload;
    const lines = p.checks.map((c) => {
      const icon = c.ok ? '✔' : c.severity === 'critical' ? '✖' : '!';
      return `${c.ok ? icon : icon} ${c.name}: ${c.detail}`;
    });
    lines.push(p.healthy ? '\nOverall: healthy.' : '\nOverall: problems need attention (see above).');
    return lines.join('\n');
  });
  return hasCritical ? 1 : 0;
}
