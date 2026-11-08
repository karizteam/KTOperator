// Measure per-turn token floor: system prompt + tool definitions.
// Usage: node scripts/measure-tokens.mjs [path-to-compact.mjs]
const tok = (s) => Math.round(s.length / 4);

async function measureOriginal() {
  const { createToolRegistry } = await import('../src/tools/index.ts');
  const { buildSystemPrompt } = await import('../src/core/agent/system-prompt.ts');
  const { defaultConfig } = await import('../src/config/schema.ts');
  const r = createToolRegistry();
  const defs = JSON.stringify(r.toDefinition());
  const sys = buildSystemPrompt({ workspaceRoot: '/ws', workspaceName: 'ws', config: defaultConfig(), platform: process.platform, sandboxLabel: 'docker', toolNames: r.names() });
  return { tools: r.names().length, defsChars: defs.length, sysChars: sys.length, perTurn: tok(defs) + tok(sys) };
}

const target = process.argv[2];
if (target) {
  const m = await import(new URL(`file://${process.cwd()}/${target}`));
  const defs = JSON.stringify(m.TOOL_DEFS ?? []);
  const sys = m.SYSTEM_PROMPT ?? '';
  console.log(JSON.stringify({ target, tools: (m.TOOL_DEFS ?? []).length, defsChars: defs.length, sysChars: sys.length, perTurn: tok(defs) + tok(sys) }, null, 2));
} else {
  console.log(JSON.stringify(await measureOriginal(), null, 2));
}
