import { ApprovalDeniedError, PathSecurityError, ToolExecutionError } from '../errors/errors.js';
import { wrapUntrusted } from '../security/injection.js';
import { redactText } from '../security/redaction.js';
import { evaluateTier, TOOL_BASE_TIER, type RiskTier } from '../security/policy.js';
import { parseToolArguments } from './json-schema.js';
import type { ToolDefinition } from '../providers/interfaces/types.js';
import type { Tool, ToolContext, ToolDescription, ToolResult } from './types.js';

/**
 * Permission-aware tool registry. Every model-requested tool call flows
 * through the same pipeline:
 *
 *   exists? → schema validation → tier classification → policy verdict
 *   → approval (when required) → dry-run interception → execution
 *   → output capping → secret redaction → injection screening → audit
 *
 * `execute` never throws for expected failures; it returns a structured
 * error result so the agent loop can continue or stop gracefully.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  toDefinition(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.schema }));
  }

  async execute(name: string, rawArguments: string, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    const startedAt = Date.now();
    if (!tool) {
      return { ok: false, summary: `Unknown tool: ${name}`, error: `Tool "${name}" is not registered.` };
    }

    await ctx.audit.record({ event: 'tool.request', tool: name, detail: { argsPreview: rawArguments.slice(0, 500) } });

    // 1. Schema validation.
    const parsed = parseToolArguments(rawArguments, tool.schema);
    if (!parsed.ok) {
      const result: ToolResult = { ok: false, summary: `Invalid arguments for ${name}`, error: parsed.error };
      await ctx.audit.record({ event: 'tool.result', tool: name, decision: 'invalid', detail: { error: parsed.error } });
      return result;
    }
    const input = parsed.value;

    // 2. Workspace (or granted folder) requirement.
    const grantedFolders = ctx.access.list().length > 0;
    if (tool.requiresWorkspace && !ctx.workspace && !(tool.workspaceOptional === true && grantedFolders)) {
      return {
        ok: false,
        summary: `Tool ${name} requires an authorized folder`,
        error:
          'No workspace is selected and no folder has been granted. Call request_path_access with a full path (for example C:\\) to ask the user for read-only access, or ask them to select a workspace.',
      };
    }

    // 3. Tier classification (base + argument-driven escalation).
    const baseTier: RiskTier = TOOL_BASE_TIER[name] ?? 2;
    let tier = baseTier;
    try {
      const escalation = tool.escalateTier?.(input);
      if (escalation !== null && escalation !== undefined) tier = Math.max(baseTier, escalation) as RiskTier;
    } catch {
      tier = Math.max(baseTier, 2) as RiskTier; // fail safe on escalation errors
    }

    // 4. Policy + approval.
    const verdict = evaluateTier(tier, ctx.config);
    let preview: string | undefined;
    let described: ToolDescription | undefined;
    // The description (and its diff preview) is only needed when the call will
    // be shown to the user or simulated — reading a file for it otherwise.
    if (verdict.decision === 'requires-approval' || (ctx.dryRun && tier > 0)) {
      try {
        described = await tool.describe?.(input, ctx);
        preview = described?.preview;
      } catch (err) {
        preview = `(preview unavailable: ${(err as Error).message})`;
      }
    }
    if (verdict.decision === 'requires-approval') {
      const outcome = await ctx.approval.request({
        tool: name,
        tier,
        summary: described?.summary ?? `${name} ${summarizeTargets(input)}`,
        targets: described?.targets ?? targetGuess(input),
        ...(preview ? { preview } : {}),
        contextLines: ctx.agentLabel ? [`Requested by: ${ctx.agentLabel}`] : [],
      });
      await ctx.audit.record({ event: 'approval', tool: name, tier, decision: outcome.approved ? 'approved' : 'denied', detail: { via: outcome.via, reason: outcome.reason } });
      if (!outcome.approved) {
        return {
          ok: false,
          summary: `Action denied (${name})`,
          error: `${outcome.reason} The action was NOT performed. Do not retry the same action; either propose an alternative or explain the blocker to the user.`,
        };
      }
    }

    // 5. Dry-run: report intent without touching anything.
    if (ctx.dryRun && tier > 0) {
      const result: ToolResult = {
        ok: true,
        summary: `[dry-run] ${name} would run: ${described?.summary ?? 'see arguments'}`,
        data: { dryRun: true, targets: described?.targets ?? targetGuess(input) },
      };
      await ctx.audit.record({ event: 'tool.result', tool: name, tier, decision: 'dry-run' });
      return result;
    }

    // 6. Execution with size caps; wrap downstream processing uniformly.
    let result: ToolResult;
    try {
      result = await tool.run(input, ctx);
    } catch (err) {
      if (err instanceof ApprovalDeniedError || err instanceof ToolExecutionError || err instanceof PathSecurityError) {
        result = { ok: false, summary: err.message, error: err.message };
      } else {
        result = {
          ok: false,
          summary: `${name} failed: ${(err as Error).message}`,
          error: (err as Error).message,
        };
      }
    }

    // 7. Redact secrets in whatever text the model will read.
    const serialized = result.data !== undefined ? JSON.stringify(result.data) : '';
    const cap = ctx.config.limits.maxOutputBytes;
    if (serialized.length > cap) {
      result = { ...result, data: undefined, summary: `${result.summary} [output truncated at ${cap} bytes of structured data]` };
    }
    const redactedSummary = redactText(result.summary);
    const redactedError = result.error ? redactText(result.error).text : undefined;
    const redactedData = result.data !== undefined ? redactText(JSON.stringify(result.data)).text : undefined;

    await ctx.audit.record({
      event: 'tool.result',
      tool: name,
      tier,
      decision: result.ok ? 'ok' : 'error',
      detail: { durationMs: Date.now() - startedAt, summary: redactedSummary.text.slice(0, 300) },
    });

    return {
      ok: result.ok,
      summary: redactedSummary.text,
      ...(redactedData !== undefined ? { data: redactedData } : {}),
      ...(redactedError !== undefined ? { error: redactedError } : {}),
    };
  }

  /** Format a tool result as the message sent back to the model. */
  renderForModel(name: string, result: ToolResult): string {
    const body = result.ok
      ? `${result.summary}${result.data !== undefined ? `\n${typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 1)}` : ''}`
      : `ERROR: ${result.error ?? result.summary}`;
    return wrapUntrusted(name, body);
  }
}

function summarizeTargets(input: Record<string, unknown>): string {
  const targets = targetGuess(input);
  return targets.length > 0 ? targets.join(', ') : JSON.stringify(input).slice(0, 120);
}

function targetGuess(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['path', 'source', 'destination', 'file', 'directory']) {
    const v = input[key];
    if (typeof v === 'string' && out.length < 3) out.push(v);
  }
  const argv = input['argv'];
  if (Array.isArray(argv)) out.push(argv.map(String).join(' ').slice(0, 120));
  return out;
}
