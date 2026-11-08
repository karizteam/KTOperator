import { resolveKey } from './lib.mjs';

const BASE = { openrouter: 'https://openrouter.ai/api/v1', openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com', google: 'https://generativelanguage.googleapis.com', ollama: 'http://localhost:11434/v1', 'openai-compatible': '' };
export const baseFor = (p) => (p.baseUrl || BASE[p.type] || '').replace(/\/+$/, '');

async function httpJson(url, opts, retries = 3) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.ok) return await r.json();
      last = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      if (r.status === 401 || r.status === 403) last.kind = 'auth';
      if (r.status === 429 || r.status >= 500) { const w = Number(r.headers.get('retry-after') || 0) * 1000 || 500 * 2 ** i; if (i < retries) { await new Promise((s) => setTimeout(s, w)); continue; } }
      throw last;
    } catch (e) { last = e; if (i === retries) throw e; await new Promise((s) => setTimeout(s, 400 * 2 ** i)); }
  }
  throw last;
}
async function* sseLines(res) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let idx; while ((idx = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2); for (const line of chunk.split('\n')) if (line.startsWith('data:')) yield line.slice(5).trim(); } }
}

export async function chat(profile, model, messages, tools, opts = {}) {
  const { key } = resolveKey(profile);
  if (profile.type === 'anthropic') return chatAnthropic(profile, key, model, messages, tools, opts);
  if (profile.type === 'google') return chatGoogle(profile, key, model, messages, tools, opts);
  return chatOpenAI(profile, key, model, messages, tools, opts);
}

async function chatOpenAI(profile, key, model, messages, tools, opts) {
  const url = `${baseFor(profile)}/chat/completions`;
  const wire = messages.map((m) => m.role === 'tool' ? { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '', name: m.name } : m.role === 'assistant' && m.toolCalls?.length ? { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) } : { role: m.role, content: m.content });
  const body = { model, messages: wire, ...(tools?.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.desc, parameters: t.schema } })), tool_choice: 'auto' } : {}), ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}) };
  const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(profile.referer ? { 'HTTP-Referer': profile.referer } : {}) };
  if (opts.stream && opts.onToken) {
    body.stream = true; body.stream_options = { include_usage: true };
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = []; const acc = new Map(); let usage;
    for await (const data of sseLines(res)) { if (data === '[DONE]') break; let c; try { c = JSON.parse(data); } catch { continue; } if (c.usage) usage = { promptTokens: c.usage.prompt_tokens, completionTokens: c.usage.completion_tokens, costUsd: c.usage.cost }; const d = c.choices?.[0]?.delta; if (d?.content) { text.push(d.content); opts.onToken(d.content); } for (const t of d?.tool_calls ?? []) { const a = acc.get(t.index ?? 0) ?? { id: '', name: '', args: '' }; if (t.id) a.id = t.id; if (t.function?.name) a.name = t.function.name; if (t.function?.arguments) a.args += t.function.arguments; acc.set(t.index ?? 0, a); } }
    return { text: text.join(''), toolCalls: [...acc.values()].filter((t) => t.name).map((t, i) => ({ id: t.id || `call_${i}`, name: t.name, arguments: t.args })), usage };
  }
  const j = await httpJson(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
  const msg = j.choices?.[0]?.message ?? {};
  return { text: msg.content ?? '', toolCalls: (msg.tool_calls ?? []).map((t, i) => ({ id: t.id ?? `call_${i}`, name: t.function.name, arguments: t.function.arguments ?? '{}' })), usage: j.usage ? { promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens, costUsd: j.usage.cost } : undefined };
}

async function chatAnthropic(profile, key, model, messages, tools, opts) {
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const conv = [];
  for (const m of rest) {
    if (m.role === 'tool') { conv.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }] }); continue; }
    if (m.role === 'assistant' && m.toolCalls?.length) { conv.push({ role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.toolCalls.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: safeJson(t.arguments) }))] }); continue; }
    conv.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  // Prompt caching: system prompt is stable across turns -> cache it.
  const body = { model, max_tokens: opts.maxTokens ?? 8192, messages: conv, ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}), ...(tools?.length ? { tools: tools.map((t) => ({ name: t.name, description: t.desc, input_schema: t.schema })) } : {}) };
  const j = await httpJson(`${baseFor(profile)}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key }, body: JSON.stringify(body), signal: opts.signal });
  const text = [], toolCalls = [];
  for (const b of j.content ?? []) { if (b.type === 'text') { text.push(b.text); opts.onToken?.(b.text); } else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }); }
  return { text: text.join(''), toolCalls, usage: j.usage ? { promptTokens: j.usage.input_tokens, completionTokens: j.usage.output_tokens } : undefined };
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

async function chatGoogle(profile, key, model, messages, tools, opts) {
  if (!key) throw new Error('GOOGLE_API_KEY not set');
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const contents = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents, ...(tools?.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.desc, parameters: t.schema })) }] } : {}), generationConfig: { maxOutputTokens: opts.maxTokens ?? 8192 } };
  const j = await httpJson(`${baseFor(profile)}/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: opts.signal });
  const parts = j.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => p.text).map((p) => p.text).join('');
  opts.onToken?.(text);
  const toolCalls = parts.filter((p) => p.functionCall).map((p, i) => ({ id: `g${i}`, name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}), signature: p.thoughtSignature }));
  return { text, toolCalls, usage: j.usageMetadata ? { promptTokens: j.usageMetadata.promptTokenCount, completionTokens: j.usageMetadata.candidatesTokenCount } : undefined };
}

export async function listModels(profile) {
  const { key } = resolveKey(profile);
  if (profile.type === 'anthropic') return [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-6' }, { id: 'claude-haiku-4-5' }];
  if (profile.type === 'google') return [{ id: 'gemini-2.5-flash' }, { id: 'gemini-2.5-pro' }];
  const j = await httpJson(`${baseFor(profile)}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  return (j.data ?? []).map((m) => ({ id: m.id }));
}
export async function testConnection(profile) { try { const ms = await listModels(profile); return { ok: true, detail: `${ms.length} model(s) visible` }; } catch (e) { return { ok: false, detail: e.message }; } }
