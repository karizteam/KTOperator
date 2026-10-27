import { ToolRegistry } from './registry.js';
import { filesystemTools } from './filesystem.js';
import { developmentTools } from './development.js';
import { systemTools } from './system.js';
import { processTools } from './processes.js';
import { shellTools } from './shell.js';
import { webFetchTool, webSearchTool } from './web.js';
import { desktopTools } from './desktop.js';
import { accessTools } from './access.js';
import type { Tool } from './types.js';

/** All model-facing tools. Privileged operations live outside this registry. */
export const ALL_TOOLS: Tool[] = [
  ...filesystemTools,
  ...accessTools,
  ...developmentTools,
  ...systemTools,
  ...processTools,
  ...shellTools,
  webSearchTool,
  webFetchTool,
  ...desktopTools,
];

export function createToolRegistry(extra: Tool[] = []): ToolRegistry {
  return new ToolRegistry([...ALL_TOOLS, ...extra]);
}

export { ToolRegistry } from './registry.js';
export type { Tool, ToolContext, ToolResult } from './types.js';
