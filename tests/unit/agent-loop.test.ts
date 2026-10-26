import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../../src/core/agent/loop.js';
import { makeHarness, MockProvider, textResult, toolCallResult } from '../helpers.js';
import type { ChatMessage } from '../../src/providers/interfaces/types.js';

async function loopWith(provider: MockProvider, opts?: { maxIterations?: number; signal?: AbortSignal }) {
  const h = await makeHarness({ workspaceFiles: { 'note.txt': 'content-of-note' } });
  const captured: ChatMessage[][] = [];
  void captured;
  const events: string[] = [];
  const report = await runAgentLoop({
    provider,
    model: 'mock-model',
    system: 'system rules',
    userTask: 'do the task',
    registry: h.registry,
    toolContext: h.toolContext,
    maxIterations: opts?.maxIterations ?? 5,
    maxToolCalls: 10,
    maxDurationMs: 60_000,
    stream: false,
    ...(opts?.signal ? { signal: opts.signal } : {}),
    onToolEvent: (e) => events.push(`${e.type}:${e.name}`),
  });
  return { report, h, events };
}

describe('agent loop', () => {
  it('completes immediately on a pure text answer', async () => {
    const provider = new MockProvider().queue(() => textResult('All done.'));
    const { report } = await loopWith(provider);
    assert.equal(report.status, 'completed');
    assert.equal(report.finalText, 'All done.');
    assert.equal(report.toolCallsTotal, 0);
    assert.equal(provider.calls, 1);
  });

  it('executes a tool call then continues until the final answer', async () => {
    const provider = new MockProvider()
      .queue(() => toolCallResult('read_file', { path: 'note.txt' }))
      .queue((req) => {
        const toolMsg = req.messages.find((m) => m.role === 'tool');
        assert.ok(toolMsg, 'tool result must be fed back to the model');
        assert.match(toolMsg!.content, /content-of-note/);
        assert.match(toolMsg!.content, /UNTRUSTED OUTPUT/);
        return textResult('The file says: content-of-note');
      });
    const { report, events } = await loopWith(provider);
    assert.equal(report.status, 'completed');
    assert.equal(report.toolCallsTotal, 1);
    assert.deepEqual(events, ['start:read_file', 'done:read_file']);
    assert.equal(report.finalText, 'The file says: content-of-note');
  });

  it('stops on stall detection (identical repeated tool calls)', async () => {
    const provider = new MockProvider().queue(() => toolCallResult('read_file', { path: 'note.txt' }, 'fixed'));
    const { report } = await loopWith(provider);
    assert.equal(report.status, 'limit');
    assert.match(report.limitReason ?? '', /Stall|identical/);
  });

  it('stops at the iteration budget', async () => {
    const provider = new MockProvider().queue((req, call) => toolCallResult('list_directory', { path: '.' }, `c${call}`));
    const { report } = await loopWith(provider, { maxIterations: 2 });
    assert.equal(report.status, 'limit');
    assert.match(report.limitReason ?? '', /Iteration budget|Tool-call budget/);
  });

  it('stops after three denials instead of pushing against policy', async () => {
    const h = await makeHarness({ approvalMode: { kind: 'deny-all' }, workspaceFiles: { 'a.txt': 'x', 'b.txt': 'y', 'c.txt': 'z' } });
    const provider = new MockProvider().queue((req, call) => toolCallResult('delete_file', { path: ['a.txt', 'b.txt', 'c.txt'][call - 1] ?? 'a.txt' }, `d${call}`));
    const report = await runAgentLoop({
      provider,
      model: 'm',
      system: 's',
      userTask: 'delete everything',
      registry: h.registry,
      toolContext: h.toolContext,
      maxIterations: 10,
      maxToolCalls: 20,
      maxDurationMs: 60_000,
    });
    assert.equal(report.status, 'limit');
    assert.match(report.limitReason ?? '', /denied/i);
    assert.equal(report.deniedCount, 3);
  });

  it('cancels cleanly via AbortSignal', async () => {
    const controller = new AbortController();
    const provider = new MockProvider().queue(async () => {
      controller.abort();
      const { ProviderError } = await import('../../src/errors/errors.js');
      throw new ProviderError('aborted', 'Request cancelled by user.');
    });
    const { report } = await loopWith(provider, { signal: controller.signal });
    assert.equal(report.status, 'cancelled');
  });

  it('reports the final answer exactly once, even for streamed tokens', async () => {
    const h = await makeHarness();
    const chunks: string[] = [];
    const modelRequests: number[] = [];
    const provider = new MockProvider().queue((req) => {
      req.onToken?.('سلام');
      req.onToken?.(' دنیا');
      return { text: 'سلام دنیا', toolCalls: [], finishReason: 'stop' };
    });
    const report = await runAgentLoop({
      provider,
      model: 'mock-model',
      system: 's',
      userTask: 'say hi',
      registry: h.registry,
      toolContext: h.toolContext,
      maxIterations: 3,
      maxToolCalls: 5,
      maxDurationMs: 30_000,
      stream: true,
      onModelRequest: (iteration) => modelRequests.push(iteration),
      onText: (delta) => chunks.push(delta),
    });
    assert.deepEqual(modelRequests, [1], 'the caller is told when the model is working');
    assert.equal(report.status, 'completed');
    assert.equal(report.finalTextDelivered, true, 'streamed text must not be printed a second time');
    assert.deepEqual(chunks, ['سلام', ' دنیا'], 'tokens reach the UI once');
  });

  it('marks non-streamed answers as delivered too (single print path)', async () => {
    const h = await makeHarness();
    const printed: string[] = [];
    const provider = new MockProvider().queue(() => textResult('one answer only'));
    const report = await runAgentLoop({
      provider,
      model: 'mock-model',
      system: 's',
      userTask: 'task',
      registry: h.registry,
      toolContext: h.toolContext,
      maxIterations: 3,
      maxToolCalls: 5,
      maxDurationMs: 30_000,
      onText: (delta) => printed.push(delta),
    });
    assert.equal(report.finalText, 'one answer only');
    assert.equal(report.finalTextDelivered, true);
    assert.equal(printed.join(''), 'one answer only');
  });

  it('records steps with per-tool outcomes for the final report', async () => {
    const provider = new MockProvider()
      .queue(() => ({
        text: 'checking',
        toolCalls: [toolCallResult('list_directory', { path: '.' }).toolCalls[0]!, toolCallResult('read_file', { path: 'missing.txt' }).toolCalls[0]!],
        finishReason: 'tool_calls',
      }))
      .queue(() => textResult('done'));
    const { report } = await loopWith(provider);
    assert.equal(report.toolCallsTotal, 2);
    assert.equal(report.steps[0]!.toolCalls.length, 2);
    assert.equal(report.steps[0]!.toolCalls[0]!.ok, true);
    assert.equal(report.steps[0]!.toolCalls[1]!.ok, false, 'missing file must surface as a tool error result, not a crash');
  });
});
