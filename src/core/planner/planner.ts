import type { AIProvider } from '../../providers/interfaces/types.js';
import { PLANNER_SYSTEM_APPENDIX } from '../agent/system-prompt.js';

/**
 * Plan-only mode: asks the model for a structured execution plan without
 * executing anything. Uses JSON structured output when the provider/model
 * supports it; degrades to lenient parsing of numbered lists.
 */

export interface PlanStep {
  title: string;
  detail?: string;
  tools?: string[];
}

export interface Plan {
  steps: PlanStep[];
  raw: string;
  parsedFromJson: boolean;
}

export async function buildPlan(options: {
  provider: AIProvider;
  model: string;
  system: string;
  task: string;
  signal?: AbortSignal | undefined;
}): Promise<Plan> {
  const caps = options.provider.capabilities();
  const result = await options.provider.chat({
    model: options.model,
    messages: [
      { role: 'system', content: options.system + PLANNER_SYSTEM_APPENDIX },
      { role: 'user', content: options.task },
    ],
    ...(caps.structuredOutputs ? { responseFormat: 'json' as const } : {}),
    stream: false,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return parsePlan(result.text);
}

export function parsePlan(text: string | undefined | null): Plan {
  const safeText = text ?? '';
  const json = extractJson(safeText);
  if (json) {
    try {
      const parsed = JSON.parse(json) as { steps?: { title?: unknown; detail?: unknown; tools?: unknown }[] };
      if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
        const steps: PlanStep[] = parsed.steps.slice(0, 50).map((s, i) => ({
          title: typeof s.title === 'string' ? s.title : `Step ${i + 1}`,
          ...(typeof s.detail === 'string' ? { detail: s.detail } : {}),
          ...(Array.isArray(s.tools) ? { tools: s.tools.filter((t): t is string => typeof t === 'string') } : {}),
        }));
        return { steps, raw: safeText, parsedFromJson: true };
      }
    } catch {
      /* fall through to heuristic */
    }
  }
  // Heuristic: numbered / bulleted lines become steps.
  const steps: PlanStep[] = [];
  for (const line of safeText.split('\n')) {
    const m = /^\s*(?:\d+[.)]\s+|[-*]\s+)(.+)$/.exec(line);
    if (m && m[1] && steps.length < 50) steps.push({ title: m[1].trim() });
  }
  if (steps.length === 0 && safeText.trim() !== '') steps.push({ title: safeText.trim().split('\n')[0]!.slice(0, 200) });
  return { steps, raw: safeText, parsedFromJson: false };
}

function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}
