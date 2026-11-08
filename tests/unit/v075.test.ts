import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCheckpoint, diffForEntries, diffLines, entriesAfter } from '../../src/core/agent/checkpoints.js';
import { deleteSkill, ensureOperatorDir, isValidDocName, listSkills, listWorkspaceChats, sanitizeDocName, writeChatMirror, writeSkill } from '../../src/core/agent/workspace-state.js';
import { BackupManager } from '../../src/recovery/backups.js';
import { parseCheckpointIndex, matchSession, filterSlashCommands, SLASH_COMMANDS } from '../../src/commands/console.js';
import type { SessionMeta } from '../../src/sessions/store.js';

describe('checkpoints & diff preview', () => {
  it('diffLines shows removals and additions', () => {
    const d = diffLines('a\nb\nc', 'a\nx\nc');
    assert.ok(d.lines.some((l) => l === '-b'));
    assert.ok(d.lines.some((l) => l === '+x'));
    assert.equal(d.added, 1);
    assert.equal(d.removed, 1);
  });
  it('diffLines is empty for identical text', () => {
    const d = diffLines('same\ntext', 'same\ntext');
    assert.equal(d.added, 0);
    assert.equal(d.removed, 0);
  });
  it('entriesAfter slices the manifest at the checkpoint', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-ckpt-'));
    const file = path.join(tmp, 'a.txt');
    await fs.writeFile(file, 'one');
    const config = { backups: { enabled: true, maxMb: 50 } } as never;
    const backups = new BackupManager(config, tmp);
    await backups.backup('s1', file, 'edit');
    await fs.writeFile(file, 'two');
    const cp = createCheckpoint('task', (await backups.list('s1')).length);
    await backups.backup('s1', file, 'edit');
    await fs.writeFile(file, 'three');
    const after = await entriesAfter(backups, 's1', cp);
    assert.equal(after.length, 1);
    const diffs = await diffForEntries(after);
    assert.equal(diffs.length, 1);
    assert.ok(diffs[0]!.lines.some((l) => l === '-two'));
    assert.ok(diffs[0]!.lines.some((l) => l === '+three'));
    await fs.rm(tmp, { recursive: true, force: true });
  });
  it('rollbackEntries restores only the checkpoint slice', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-ckpt-'));
    const file = path.join(tmp, 'a.txt');
    await fs.writeFile(file, 'original');
    const config = { backups: { enabled: true, maxMb: 50 } } as never;
    const backups = new BackupManager(config, tmp);
    const cp = createCheckpoint('before task', (await backups.list('s1')).length);
    await backups.backup('s1', file, 'edit');
    await fs.writeFile(file, 'changed by task');
    const result = await backups.rollbackEntries(await entriesAfter(backups, 's1', cp));
    assert.deepEqual(result.restored, [file]);
    assert.equal(await fs.readFile(file, 'utf8'), 'original');
    await fs.rm(tmp, { recursive: true, force: true });
  });
  it('parseCheckpointIndex defaults to latest, honors 1-based n', () => {
    assert.equal(parseCheckpointIndex('', 3), 2);
    assert.equal(parseCheckpointIndex('1', 3), 0);
    assert.equal(parseCheckpointIndex('2', 3), 1);
    assert.equal(parseCheckpointIndex('99', 3), 2);
    assert.equal(parseCheckpointIndex('', 0), -1);
  });
});

describe('.operator workspace home', () => {
  it('creates the folder layout and manages skills', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-ws-'));
    await ensureOperatorDir(tmp);
    const stat = await fs.stat(path.join(tmp, '.operator', 'skills'));
    assert.ok(stat.isDirectory());
    const name = await writeSkill(tmp, 'review-code', '# Review\nCheck tests first.');
    assert.equal(name, 'review-code');
    const skills = await listSkills(tmp);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.content, '# Review\nCheck tests first.\n');
    assert.equal(await deleteSkill(tmp, 'review-code'), true);
    assert.equal((await listSkills(tmp)).length, 0);
    await fs.rm(tmp, { recursive: true, force: true });
  });
  it('sanitizes doc names and rejects traversal', () => {
    assert.equal(sanitizeDocName('../evil'), 'evil');
    assert.equal(sanitizeDocName('My Skill!'), 'my-skill');
    assert.ok(isValidDocName('review-code'));
    assert.ok(!isValidDocName('../evil'));
    assert.ok(!isValidDocName('a/b'));
  });
  it('writes and lists chat mirrors for the path', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-ws-'));
    await ensureOperatorDir(tmp);
    await writeChatMirror(tmp, 'sess-1', [
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'done' },
    ], { provider: 'openai', model: 'gpt' });
    const chats = await listWorkspaceChats(tmp);
    assert.equal(chats.length, 1);
    assert.equal(chats[0]!.id, 'sess-1');
    assert.equal(chats[0]!.messages, 2);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('resume & new slash commands', () => {
  const metas: SessionMeta[] = [
    { id: '74c48d0d-392c-4c18-9173-d9acbb09111d', startedAt: '2026-11-08T00:00:00Z', task: 'a' },
    { id: 'aaaa-1', startedAt: '2026-11-07T00:00:00Z', task: 'b' },
  ];
  it('matchSession resolves a full uuid and a prefix', () => {
    assert.equal(matchSession(metas, '74c48d0d-392c-4c18-9173-d9acbb09111d').target?.id, metas[0]!.id);
    assert.equal(matchSession(metas, '74c4').target?.id, metas[0]!.id);
    assert.equal(matchSession(metas, 'nope').target, null);
  });
  it('new commands are listed with submenus', () => {
    for (const name of ['skill', 'prompt', 'checkpoint', 'undo', 'diff']) {
      assert.ok(SLASH_COMMANDS.some((c) => c.name === name), name);
    }
    assert.ok(filterSlashCommands('/skill ').some((i) => i.command === '/skill use'));
    assert.ok(filterSlashCommands('/skill a').some((i) => i.command === '/skill add'));
    assert.ok(filterSlashCommands('/prompt ').some((i) => i.command === '/prompt use'));
    assert.ok(filterSlashCommands('/checkpoint ').some((i) => i.command === '/checkpoint list'));
  });
});
