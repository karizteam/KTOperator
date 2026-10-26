import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../src/sessions/store.js';
import { listResumable, matchSession } from '../../src/commands/console.js';

async function tempStore(): Promise<{ store: SessionStore; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ktoperator-resume-'));
  const store = new SessionStore(dir);
  return { store, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('/resume session selection', () => {
  it('offers every session except the one already open, newest first', async () => {
    const { store, cleanup } = await tempStore();
    try {
      const first = await store.create({ task: 'first task', provider: 'openrouter', model: 'gpt-4o' });
      await sleep(5);
      const second = await store.create({ task: 'second task', provider: 'anthropic', model: 'claude' });
      await sleep(5);
      const current = await store.create({ task: 'open now' });

      const candidates = await listResumable(store, current);
      assert.deepEqual(
        candidates.map((m) => m.id),
        [second, first],
        'newest first, current session excluded',
      );

      const all = await listResumable(store, undefined);
      assert.equal(all.length, 3, 'without a current session everything is resumable');
    } finally {
      await cleanup();
    }
  });

  it('picks the most recent session when no id is given', async () => {
    const { store, cleanup } = await tempStore();
    try {
      const older = await store.create({ task: 'older' });
      await sleep(5);
      const newer = await store.create({ task: 'newer' });
      const candidates = await listResumable(store, undefined);
      const pick = matchSession(candidates, '');
      assert.equal(pick.error, null);
      assert.equal(pick.target?.id, newer);
      assert.equal(older.length, 36, 'session ids are uuids');
    } finally {
      await cleanup();
    }
  });

  it('matches an id prefix and reports ambiguity', async () => {
    const { store, cleanup } = await tempStore();
    try {
      const id = await store.create({ task: 'target' });
      await store.create({ task: 'other' });
      const candidates = await listResumable(store, undefined);

      const exact = matchSession(candidates, id);
      assert.equal(exact.target?.id, id);
      assert.equal(exact.ambiguous, false);

      const prefix = matchSession(candidates, id.slice(0, 6));
      assert.equal(prefix.target?.id, id, 'a short prefix still identifies the session');

      const all = matchSession(candidates, '');
      assert.equal(all.ambiguous, false);
      const both = matchSession([...candidates, ...candidates], '');
      assert.equal(both.ambiguous, false, 'no-argument picks are never ambiguous');

      const none = matchSession(candidates, 'zzz-does-not-exist');
      assert.equal(none.target, null);
      assert.match(none.error ?? '', /no session matches/);
    } finally {
      await cleanup();
    }
  });

  it('reports an empty list instead of throwing', async () => {
    assert.equal(matchSession([], '').target, null);
    assert.match(matchSession([], '').error ?? '', /no previous session/);
    assert.match(matchSession([], 'abc').error ?? '', /no session matches/);

    const { store, cleanup } = await tempStore();
    try {
      const only = await store.create({ task: 'the open one' });
      assert.deepEqual(await listResumable(store, only), [], 'the open session is not a candidate');
    } finally {
      await cleanup();
    }
  });

  it('loads the transcript messages in order with their roles intact', async () => {
    const { store, cleanup } = await tempStore();
    try {
      const id = await store.create({ task: 'conversation', provider: 'openrouter', model: 'gpt-4o' });
      await store.appendMessage(id, { role: 'user', content: 'question one' });
      await store.appendMessage(id, { role: 'assistant', content: 'answer one' });
      await store.appendMessage(id, { role: 'user', content: 'question two' });
      await sleep(5);
      const open = await store.create({ task: 'open now' });

      const candidates = await listResumable(store, open);
      const target = matchSession(candidates, id).target!;
      const transcript = await store.transcript(target.id);
      assert.deepEqual(
        transcript.messages.map((m) => `${m.role}:${m.content}`),
        ['user:question one', 'assistant:answer one', 'user:question two'],
      );
      assert.equal(transcript.meta?.task, 'conversation');
      assert.equal(transcript.meta?.provider, 'openrouter');
    } finally {
      await cleanup();
    }
  });
});
