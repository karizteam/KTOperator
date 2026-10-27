import {
  DESKTOP_APP_IDS,
  buildAppLaunchPlan,
  buildOpenUrlPlan,
  launchDetached,
  type LaunchPlan,
} from '../platform/desktop.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

/**
 * Desktop tools — let the agent act on the user's machine the way a person
 * would: open an application, open a browser page.
 *
 * launch_app resolves any application that is actually installed on the
 * machine: the common catalog first (exact executables), then the Windows
 * Start Menu, the macOS Applications folders, Linux .desktop entries and PATH.
 * Shells, script hosts and terminals are refused before resolution, so opening
 * one is impossible rather than merely discouraged. Every launch is tier 3:
 * the user sees the exact argv and approves it.
 */

const BROWSERS = ['chrome', 'edge', 'firefox'] as const;

async function execute(plan: LaunchPlan, ctx: ToolContext): Promise<ToolResult> {
  await ctx.audit.record({
    event: 'desktop.launch',
    tool: plan.app === 'default' ? 'open_url' : 'launch_app',
    tier: 3,
    detail: { app: plan.app, label: plan.label, argv: plan.argv.slice(0, 3), detail: plan.detail },
  });
  try {
    await launchDetached(plan.argv);
  } catch (err) {
    const message = (err as Error).message;
    return { ok: false, summary: message, error: message };
  }
  return {
    ok: true,
    summary: `${plan.detail}. It is opening on the user's desktop now.`,
    data: { app: plan.app, label: plan.label, kind: plan.kind, detail: plan.detail },
  };
}

/** Plan an app launch without ever throwing, for the approval prompt. */
function tryPlan(app: string, options: { search?: string | undefined; url?: string | undefined }): LaunchPlan | null {
  try {
    return buildAppLaunchPlan(app, options);
  } catch {
    return null;
  }
}

export const launchAppTool: Tool = {
  name: 'launch_app',
  description:
    `Open an application on the user's own machine. Any installed application works — pass the name as the user says it ("opera", "Opera GX", "spotify", "notepad", "vscode") and Operator finds it in the Start Menu, the Applications folder or PATH; the well-known ones (${DESKTOP_APP_IDS.join(', ')}) are mapped directly. Pass \`search\` to run a web search in a browser, or \`url\` to open one specific http(s) page in a browser. It cannot install or download software: for the Store it opens the search page and the user clicks Install. Command shells, script hosts and terminals can never be opened.`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['app'],
    properties: {
      app: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Application to open: a catalog id (chrome, notepad, explorer, vscode, store, …) or any installed app name such as "Opera GX" or "Spotify".',
      },
      search: {
        type: 'string',
        maxLength: 256,
        description: 'Optional search text. Browsers open it as a web search; `store` opens the Store search page for it.',
      },
      url: {
        type: 'string',
        maxLength: 2048,
        description: 'Optional absolute http(s) URL, for browser apps only.',
      },
    },
  },
  describe: (input) => {
    const app = String(input['app'] ?? '');
    const search = typeof input['search'] === 'string' ? input['search'] : undefined;
    const url = typeof input['url'] === 'string' ? input['url'] : undefined;
    const plan = tryPlan(app, { ...(search !== undefined ? { search } : {}), ...(url !== undefined ? { url } : {}) });
    const targets = [url, search !== undefined ? `search: ${search}` : undefined, `app: ${app}`].filter(
      (t): t is string => typeof t === 'string' && t !== '',
    );
    return {
      summary: plan?.detail ?? `Open ${app}${search !== undefined ? ` and search for "${search}"` : ''}`,
      targets,
      ...(plan !== null ? { preview: `Launch: ${plan.argv.join(' ')}` } : {}),
    };
  },
  async run(input, ctx) {
    const search = typeof input['search'] === 'string' ? input['search'] : undefined;
    const url = typeof input['url'] === 'string' ? input['url'] : undefined;
    const plan = buildAppLaunchPlan(String(input['app'] ?? ''), {
      ...(search !== undefined ? { search } : {}),
      ...(url !== undefined ? { url } : {}),
    });
    return execute(plan, ctx);
  },
};

export const openUrlTool: Tool = {
  name: 'open_url',
  description:
    "Open an http(s) URL in the user's desktop browser — the default browser or one of chrome, edge, firefox. Use it to show the user a page, docs, or a search result. Only http/https can be opened.",
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', maxLength: 2048, description: 'Absolute http(s) URL to open.' },
      browser: { type: 'string', enum: ['default', ...BROWSERS], description: 'Which browser (default: the system default).' },
    },
  },
  describe: (input) => {
    const url = String(input['url'] ?? '');
    const browser = typeof input['browser'] === 'string' ? input['browser'] : 'default';
    return {
      summary: `Open ${url} in ${browser === 'default' ? 'the default browser' : browser}`,
      targets: [url],
    };
  },
  async run(input, ctx) {
    const browser = typeof input['browser'] === 'string' ? input['browser'] : 'default';
    const plan = buildOpenUrlPlan(String(input['url'] ?? ''), browser);
    return execute(plan, ctx);
  },
};

export const desktopTools: Tool[] = [launchAppTool, openUrlTool];
