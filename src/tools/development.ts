import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolExecutionError } from '../errors/errors.js';
import type { Tool, ToolContext, ToolResult } from './types.js';
import type { SandboxExecSpec } from '../sandbox/types.js';

const PROJECT_MARKERS: [string, string][] = [
  ['package.json', 'Node.js / JavaScript'],
  ['pnpm-workspace.yaml', 'Node.js (pnpm workspace)'],
  ['tsconfig.json', 'TypeScript'],
  ['pyproject.toml', 'Python'],
  ['requirements.txt', 'Python'],
  ['Cargo.toml', 'Rust'],
  ['go.mod', 'Go'],
  ['pom.xml', 'Java (Maven)'],
  ['build.gradle', 'Java (Gradle)'],
  ['.csproj', '.NET'],
  ['Gemfile', 'Ruby'],
  ['composer.json', 'PHP'],
  ['CMakeLists.txt', 'C/C++ (CMake)'],
  ['Dockerfile', 'Docker'],
];

export const detectProjectTypeTool: Tool = {
  name: 'detect_project_type',
  description: 'Detect project ecosystem(s) from manifest files at the workspace root (package.json, pyproject.toml, Cargo.toml, ...).',
  requiresWorkspace: true,
  schema: { type: 'object', additionalProperties: false, properties: {} },
  async run(_input, ctx) {
    const entries = await fs.readdir(ctx.workspace!.root, { withFileTypes: true });
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const detected: string[] = [];
    for (const [marker, label] of PROJECT_MARKERS) {
      if (marker.startsWith('.')) {
        if (entries.some((e) => e.isFile() && e.name.endsWith(marker))) detected.push(label);
      } else if (names.has(marker)) detected.push(label);
    }
    return {
      ok: true,
      summary: detected.length > 0 ? `Detected: ${detected.join(', ')}.` : 'No known project manifest found at the workspace root.',
      data: { detected },
    };
  },
};

export const inspectProjectTool: Tool = {
  name: 'inspect_project',
  description: 'Summarize project structure: directory tree (depth-limited), file counts by extension, detected ecosystems, and key manifests.',
  requiresWorkspace: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { maxDepth: { type: 'integer', description: 'Tree depth (default 3, max 6).', minimum: 1, maximum: 6 } },
  },
  async run(input, ctx) {
    const wsRoot = ctx.workspace!.root;
    const maxDepth = (input['maxDepth'] as number | undefined) ?? 3;
    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'target', 'coverage', '__pycache__', '.venv']);
    const tree: string[] = [];
    const extCounts = new Map<string, number>();
    let files = 0;
    let dirs = 0;

    async function recurse(dir: string, prefix: string, depth: number): Promise<void> {
      if (depth > maxDepth || tree.length > 400) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const visible = entries.filter((e) => !e.name.startsWith('.') && !SKIP.has(e.name)).slice(0, 40);
      for (let i = 0; i < visible.length; i++) {
        const e = visible[i]!;
        const last = i === visible.length - 1;
        const connector = last ? '└── ' : '├── ';
        tree.push(`${prefix}${connector}${e.name}${e.isDirectory() ? '/' : ''}`);
        if (e.isDirectory()) {
          dirs++;
          await recurse(path.join(dir, e.name), `${prefix}${last ? '    ' : '│   '}`, depth + 1);
        } else if (e.isFile()) {
          files++;
          const ext = path.extname(e.name).toLowerCase() || '(none)';
          extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
        }
      }
    }
    tree.push(`${path.basename(wsRoot)}/`);
    await recurse(wsRoot, '', 1);
    const counts = [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    return {
      ok: true,
      summary: `Project tree: ${dirs} directories, ${files} visible files (depth ≤ ${maxDepth}).`,
      data: {
        tree: tree.join('\n'),
        countsByExtension: Object.fromEntries(counts),
        truncated: tree.length >= 400,
      },
    };
  },
};

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  workspaces?: unknown;
  type?: string;
}

async function readPackageJson(ctx: ToolContext): Promise<{ pkg: PackageJson; rel: string }> {
  const entry = await ctx.workspace!.resolveFile('package.json');
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await fs.readFile(entry.realPath, 'utf8')) as PackageJson;
  } catch {
    throw new ToolExecutionError('inspect_package_json', 'package.json is not valid JSON.');
  }
  return { pkg, rel: entry.relativePath };
}

export const inspectPackageJsonTool: Tool = {
  name: 'inspect_package_json',
  description: 'Summarize package.json: name/version, scripts, dependency counts, package manager, workspaces. Values are untrusted project data.',
  requiresWorkspace: true,
  schema: { type: 'object', additionalProperties: false, properties: {} },
  async run(_input, ctx) {
    const { pkg } = await readPackageJson(ctx);
    const scripts = Object.keys(pkg.scripts ?? {});
    const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];
    const present = [];
    for (const lf of lockfiles) {
      try {
        await ctx.workspace!.resolveFile(lf);
        present.push(lf);
      } catch {
        /* absent */
      }
    }
    const summary = {
      name: pkg.name ?? '(unnamed)',
      version: pkg.version ?? '(unset)',
      description: pkg.description,
      moduleType: pkg.type ?? 'commonjs (default)',
      scripts: pkg.scripts ?? {},
      dependencyCount: Object.keys(pkg.dependencies ?? {}).length,
      devDependencyCount: Object.keys(pkg.devDependencies ?? {}).length,
      packageManager: pkg.packageManager ?? null,
      lockfiles: present,
      hasWorkspaces: pkg.workspaces !== undefined,
    };
    return {
      ok: true,
      summary: `package.json: ${summary.name}@${summary.version}, ${scripts.length} script(s), ${summary.dependencyCount}+${summary.devDependencyCount} deps.`,
      data: summary,
    };
  },
};

/* ------------------------------------------------------------------ */
/* Managed-execution development tools                                 */
/* ------------------------------------------------------------------ */

const EXEC_TIMEOUT_MS = 180_000;

async function sandboxSpec(ctx: ToolContext, argv: string[], opts: { writable: boolean; timeoutMs?: number }): Promise<SandboxExecSpec> {
  return {
    argv,
    workspaceRoot: ctx.workspace!.root,
    writable: opts.writable,
    network: ctx.config.sandbox.network,
    env: { CI: '1' },
    limits: {
      timeoutMs: opts.timeoutMs ?? EXEC_TIMEOUT_MS,
      maxOutputBytes: ctx.config.limits.maxOutputBytes,
      memoryMb: ctx.config.sandbox.memoryMb,
      cpus: ctx.config.sandbox.cpus,
      pidsLimit: ctx.config.sandbox.pidsLimit,
    },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

export const inspectGitStatusTool: Tool = {
  name: 'inspect_git_status',
  description: 'Current git status (branch + porcelain) of the workspace, run read-only inside the sandbox. Fails clearly if git or the sandbox is unavailable.',
  requiresWorkspace: true,
  schema: { type: 'object', additionalProperties: false, properties: {} },
  async run(_input, ctx) {
    try {
      await fs.access(path.join(ctx.workspace!.root, '.git'));
    } catch {
      return { ok: false, summary: 'Workspace is not a git repository.', error: 'No .git directory at the workspace root.' };
    }
    const spec = await sandboxSpec(ctx, ['git', 'status', '--porcelain=v1', '--branch'], { writable: false, timeoutMs: 30_000 });
    const result = await ctx.sandbox.execute(spec);
    const out = result.stdout.trim();
    return {
      ok: result.exitCode === 0,
      summary: result.exitCode === 0 ? `git status: ${out.split('\n').length - 1} change line(s).` : `git status failed (exit ${result.exitCode}).`,
      data: { status: out, stderr: result.stderr.trim().slice(0, 1000) },
      ...(result.exitCode !== 0 ? { error: result.stderr.trim().slice(0, 300) || 'git exited nonzero' } : {}),
    };
  },
};

/** Shared implementation for run_tests / run_typecheck / run_linter / run_build. */
function makeScriptRunner(
  name: string,
  verb: string,
  scriptCandidates: string[],
  description: string,
): Tool {
  return {
    name,
    description,
    requiresWorkspace: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        timeoutMs: { type: 'integer', description: `Max runtime in ms (default ${EXEC_TIMEOUT_MS}).`, minimum: 1000, maximum: 900_000 },
      },
    },
    describe: () => ({
      summary: `${verb} (npm script, inside sandbox)`,
      targets: ['package.json scripts'],
      preview: `Runs one of: ${scriptCandidates.map((s) => `npm run ${s}`).join(', ')} — whichever exists — inside the configured sandbox.`,
    }),
    async run(input, ctx): Promise<ToolResult> {
      const { pkg } = await readPackageJson(ctx);
      const scripts = pkg.scripts ?? {};
      const script = scriptCandidates.find((s) => scripts[s] !== undefined);
      if (!script) {
        return {
          ok: false,
          summary: `No npm script found for "${verb}".`,
          error: `Looked for: ${scriptCandidates.join(', ')}. Available scripts: ${Object.keys(scripts).join(', ') || '(none)'}. Script contents are project-defined and untrusted; only existing scripts are run.`,
        };
      }
      const argv = ['npm', 'run', script];
      const spec = await sandboxSpec(ctx, argv, { writable: true, ...(input['timeoutMs'] !== undefined ? { timeoutMs: input['timeoutMs'] as number } : {}) });
      await ctx.audit.record({ event: 'command.execute', tool: name, tier: 3, detail: { argv, sandbox: ctx.sandbox.selectedId() } });
      const result = await ctx.sandbox.execute(spec);
      const tail = (s: string) => {
        const lines = s.trim().split('\n').slice(-60).join('\n');
        return lines.length > 16_000 ? `[truncated]\n${lines.slice(-16_000)}` : lines;
      };
      const summaryText = `${verb} finished: exit ${result.exitCode ?? 'killed'}${result.timedOut ? ' (timed out)' : ''}${result.outputTruncated ? ' [output truncated]' : ''} in ${(result.durationMs / 1000).toFixed(1)}s.`;
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        summary: summaryText,
        data: {
          argv,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          processId: result.id,
          stdoutTail: tail(result.stdout),
          stderrTail: tail(result.stderr),
        },
        ...(result.exitCode !== 0 || result.timedOut ? { error: tail(result.stderr) || tail(result.stdout) || `${verb} did not succeed` } : {}),
      };
    },
  };
}

export const runTestsTool = makeScriptRunner(
  'run_tests',
  'Run the test suite',
  ['test', 'test:unit', 'tests'],
  'Run the project test suite (npm script) inside the sandbox with approval. Requires package.json with a test script.',
);
export const runTypecheckTool = makeScriptRunner(
  'run_typecheck',
  'Run the type checker',
  ['typecheck', 'type-check', 'tsc'],
  'Run the project type-check script inside the sandbox. Requires a matching npm script.',
);
export const runLinterTool = makeScriptRunner(
  'run_linter',
  'Run the linter',
  ['lint'],
  'Run the project lint script inside the sandbox. Requires an npm "lint" script.',
);
export const runBuildTool = makeScriptRunner(
  'run_build',
  'Run the build',
  ['build'],
  'Run the project build script inside the sandbox. Requires an npm "build" script.',
);

export const developmentTools: Tool[] = [
  inspectProjectTool,
  detectProjectTypeTool,
  inspectPackageJsonTool,
  inspectGitStatusTool,
  runTestsTool,
  runTypecheckTool,
  runLinterTool,
  runBuildTool,
];
