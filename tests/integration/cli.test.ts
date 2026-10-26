/**
 * End-to-end CLI tests: real subprocesses, hermetic OPERATOR_HOME, and a
 * local mock server speaking the OpenAI chat-completions protocol — proving
 * the whole chain (CLI → config → provider → agent loop → tools → approval
 * → file change → session/audit records) works without any real AI service.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 90_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(projectRoot, 'src', 'cli.ts'), ...args], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Mock OpenAI-compatible endpoint with scripted behavior. */
function startMockServer(): Promise<{ baseUrl: string; close: () => Promise<void>; setMode: (m: string) => void; requests: { body: unknown }[] }> {
  const requests: { body: unknown }[] = [];
  let mode = 'tool-then-text';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body !== '' ? (JSON.parse(body) as Record<string, unknown>) : {};
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'mock-model-1' }, { id: 'mock-model-2' }] }));
        return;
      }
      if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
        requests.push({ body: parsed });
        res.setHeader('content-type', 'application/json');
        const messages = parsed['messages'] as { role: string }[];
        const alreadyCalledTool = messages.some((m) => m.role === 'tool');
        const wantsJson = (parsed['response_format'] as { type?: string } | undefined)?.type === 'json_object';
        if (mode === 'tool-then-text' && !alreadyCalledTool && !wantsJson) {
          res.end(
            JSON.stringify({
              model: 'mock',
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: null,
                    tool_calls: [
                      { id: 'call_1', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ path: 'agent-created.txt', content: 'created by the operator agent\n' }) } },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 },
            }),
          );
          return;
        }
        if (mode === 'plan' || wantsJson) {
          res.end(
            JSON.stringify({
              model: 'mock',
              choices: [
                {
                  finish_reason: 'stop',
                  message: { content: '{"steps":[{"title":"Inspect the project"},{"title":"Propose changes"},{"title":"Apply after approval"}]}' },
                },
              ],
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            model: 'mock',
            choices: [{ finish_reason: 'stop', message: { content: 'I created agent-created.txt as requested.' } }],
            usage: { prompt_tokens: 60, completion_tokens: 9, total_tokens: 69 },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        requests,
        setMode: (m: string) => (mode = m),
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

let home: string;
let workspaceDir: string;
let env: NodeJS.ProcessEnv;
let mock: Awaited<ReturnType<typeof startMockServer>>;

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'op-e2e-home-'));
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'op-e2e-ws-'));
  await fs.writeFile(path.join(workspaceDir, 'README.md'), '# fixture project\n');
  await fs.writeFile(path.join(workspaceDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.1' }));
  mock = await startMockServer();
  env = {
    ...process.env,
    OPERATOR_HOME: home,
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
    // Deliberately poison-looking var that must never leak into output:
    OPENAI_COMPATIBLE_API_KEY: 'sk-testkey-must-never-appear-555',
  };
});

after(async () => {
  await mock.close();
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe('CLI basics', () => {
  it('doctor runs and reports structured checks', async () => {
    const r = await runCli(['doctor', '--json'], env);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { healthy: boolean; checks: { name: string }[] };
    assert.ok(Array.isArray(out.checks));
    assert.ok(out.checks.some((c) => c.name === 'node-runtime'));
    assert.ok(!r.stdout.includes('sk-testkey-must-never-appear-555'));
  });

  it('init + workspace select authorize a workspace explicitly', async () => {
    const init = await runCli(['init', '--json'], env);
    assert.equal(init.status, 0, init.stderr);
    const sel = await runCli(['workspace', 'select', workspaceDir, '--json'], env);
    assert.equal(sel.status, 0, sel.stderr);
    const show = await runCli(['workspace', 'show', '--json'], env);
    const parsed = JSON.parse(show.stdout) as { workspace: { path: string }; validNow: boolean };
    assert.equal(parsed.validNow, true);
    assert.equal(parsed.workspace.path, await fs.realpath(workspaceDir));
  });

  it('config show redacts anything resembling a secret', async () => {
    const add = await runCli(
      ['provider', 'add', '--id', 'mock', '--type', 'openai-compatible', '--base-url', mock.baseUrl, '--model', 'mock-model-1', '--trusted-local', '--key', 'sk-testkey-must-never-appear-555', '--skip-test', '--default', '--json'],
      env,
    );
    assert.equal(add.status, 0, add.stderr);
    const show = await runCli(['config', 'show', '--json'], env);
    assert.ok(!show.stdout.includes('sk-testkey-must-never-appear-555'), 'config show leaked a key');
  });

  it('provider list/test work against the mock server without printing keys', async () => {
    const list = await runCli(['provider', 'list', '--json'], env);
    const providers = (JSON.parse(list.stdout) as { providers: { id: string }[] }).providers;
    assert.ok(providers.some((p) => p.id === 'mock'));
    const test = await runCli(['provider', 'test', 'mock', '--json'], env);
    assert.equal(test.status, 0, test.stderr);
    const result = JSON.parse(test.stdout) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.ok(!test.stdout.includes('sk-testkey'));
  });

  it('model list fetches ids from the server', async () => {
    const r = await runCli(['model', 'list', '--provider', 'mock', '--json'], env);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout) as { models: { id: string }[] };
    assert.deepEqual(parsed.models.map((m) => m.id), ['mock-model-1', 'mock-model-2']);
  });
});

describe('end-to-end agent runs', () => {
  it('plan produces a plan and changes nothing', async () => {
    mock.setMode('plan');
    const r = await runCli(['plan', 'propose how to organize this project', '--json'], env);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { steps: { title: string }[] };
    assert.equal(out.steps.length, 3);
    assert.equal(await exists(path.join(workspaceDir, 'agent-created.txt')), false, 'plan must not execute anything');
  });

  it('run executes an approved tool call end-to-end and records everything', async () => {
    mock.setMode('tool-then-text');
    const r = await runCli(['run', 'create a file for me', '--yes', 'all', '--json'], env);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout) as { status: string; toolCalls: number; sessionId: string };
    assert.equal(out.status, 'completed');
    assert.equal(out.toolCalls, 1);
    assert.equal(await fs.readFile(path.join(workspaceDir, 'agent-created.txt'), 'utf8'), 'created by the operator agent\n');

    // Session history persisted.
    const history = await runCli(['history', out.sessionId, '--json'], env);
    assert.equal(history.status, 0, history.stderr);
    const transcript = JSON.parse(history.stdout) as { messages: unknown[]; report: { status: string } | null };
    assert.ok(transcript.messages.length >= 3, 'transcript should contain system/user/assistant/tool messages');
    assert.equal(transcript.report?.status, 'completed');

    // Audit trail contains the tool call AND its approval decision.
    const auditDir = path.join(home, 'audit');
    const files = await fs.readdir(auditDir);
    assert.ok(files.length >= 1);
    const auditText = await fs.readFile(path.join(auditDir, files[0]!), 'utf8');
    assert.match(auditText, /tool\.request/);
    assert.match(auditText, /approval/);
    assert.ok(!auditText.includes('sk-testkey-must-never-appear-555'));
  });

  it('run without a provider fails with an actionable hint, not a crash', async () => {
    const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'op-e2e-empty-'));
    try {
      const r = await runCli(['run', 'hello', '--json'], { ...env, OPERATOR_HOME: emptyHome });
      assert.notEqual(r.status, 0);
      const out = JSON.parse(r.stdout) as { error: { code: string; hint?: string } };
      assert.equal(out.error.code, 'CONFIG');
      assert.match(out.error.hint ?? '', /setup|provider/i);
    } finally {
      await fs.rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('blocks path escape even when the mock model asks for it', async () => {
    // Point the mock at an evil response: create_file ../../escape.txt
    const evil = await startEvilServer();
    try {
      const add = await runCli(
        ['provider', 'add', '--id', 'evil', '--type', 'openai-compatible', '--base-url', evil.baseUrl, '--model', 'x', '--trusted-local', '--key', 'k-123456789', '--skip-test', '--default', '--json'],
        env,
      );
      assert.equal(add.status, 0, add.stderr);
      const r = await runCli(['run', 'please create the file', '--yes', 'all', '--json'], env);
      const out = JSON.parse(r.stdout) as { status: string };
      assert.ok(['limit', 'completed'].includes(out.status), `unexpected status ${out.status}`);
      assert.equal(await exists(path.join(os.tmpdir(), 'escape-hack.txt')), false, 'escape file must never exist outside the workspace');
    } finally {
      await evil.close();
    }
  });
});

async function startEvilServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body !== '' ? (JSON.parse(body) as { messages?: { role: string }[] }) : {};
      res.setHeader('content-type', 'application/json');
      const msgs = parsed.messages ?? [];
      if (msgs.some((m) => m.role === 'tool')) {
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'done (attempted)' } }] }));
        return;
      }
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [
                  { id: 'evil1', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ path: '../escape-hack.txt', content: 'owned' }) } },
                ],
              },
            },
          ],
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
