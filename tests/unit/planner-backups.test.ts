import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePlan, buildPlan } from '../../src/core/planner/planner.js';
import { MockProvider, textResult } from '../helpers.js';
import { BackupManager } from '../../src/recovery/backups.js';
import { defaultConfig } from '../../src/config/schema.js';

describe('planner', () => {
  it('parses structured JSON plans', () => {
    const plan = parsePlan('{"steps":[{"title":"Inspect project"},{"title":"Run tests","tools":["run_tests"]}]}');
    assert.equal(plan.parsedFromJson, true);
    assert.deepEqual(plan.steps.map((s) => s.title), ['Inspect project', 'Run tests']);
    assert.deepEqual(plan.steps[1]!.tools, ['run_tests']);
  });

  it('parses plans wrapped in code fences or prose', () => {
    const plan = parsePlan('Here you go:\n```json\n{"steps":[{"title":"Do X"}]}\n```\nDone.');
    assert.equal(plan.parsedFromJson, true);
    assert.equal(plan.steps[0]!.title, 'Do X');
  });

  it('falls back to numbered-list parsing', () => {
    const plan = parsePlan('1. Read the README\n2. Detect project type\n3. Summarize');
    assert.equal(plan.parsedFromJson, false);
    assert.equal(plan.steps.length, 3);
  });

  it('buildPlan talks to the provider and never executes tools', async () => {
    const provider = new MockProvider().queue(() => textResult('{"steps":[{"title":"step one"}]}'));
    const plan = await buildPlan({ provider, model: 'm', system: 's', task: 't' });
    assert.equal(plan.steps[0]!.title, 'step one');
    assert.equal(provider.calls, 1);
  });
});

describe('backup & rollback', () => {
  it('snapshots before edits and restores them', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-backup-'));
    try {
      const mgr = new BackupManager(defaultConfig(), path.join(tmp, 'backups'));
      const file = path.join(tmp, 'data.txt');
      await fs.writeFile(file, 'original');
      await mgr.backup('s1', file, 'edit');
      await fs.writeFile(file, 'modified');
      const result = await mgr.rollback('s1');
      assert.deepEqual(result.failed, []);
      assert.equal(await fs.readFile(file, 'utf8'), 'original');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rollback of agent-created files deletes them', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-backup2-'));
    try {
      const mgr = new BackupManager(defaultConfig(), path.join(tmp, 'backups'));
      const created = path.join(tmp, 'created-by-agent.txt');
      await fs.writeFile(created, 'agent output');
      // Create-op backup of an existing path here models the tool flow:
      await mgr.backup('s2', created, 'edit');
      await fs.writeFile(created, 'changed');
      const manifest = await mgr.list('s2');
      assert.equal(manifest.length, 1);
      const result = await mgr.rollback('s2');
      assert.equal(result.restored.length, 1);
      assert.equal(await fs.readFile(created, 'utf8'), 'agent output');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('moves restore both ends', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-backup3-'));
    try {
      const mgr = new BackupManager(defaultConfig(), path.join(tmp, 'backups'));
      const src = path.join(tmp, 'before.txt');
      const dst = path.join(tmp, 'after.txt');
      await fs.writeFile(src, 'payload');
      await mgr.backup('s3', src, 'move', { movedTo: dst });
      await fs.rename(src, dst);
      const result = await mgr.rollback('s3');
      assert.equal(result.restored.length, 1);
      assert.equal(await fs.readFile(src, 'utf8'), 'payload');
      await assert.rejects(() => fs.access(dst));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('reports failures honestly when the snapshot is gone', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-backup4-'));
    try {
      const mgr = new BackupManager(defaultConfig(), path.join(tmp, 'backups'));
      const file = path.join(tmp, 'victim.txt');
      await fs.writeFile(file, 'v1');
      const entry = await mgr.backup('s4', file, 'edit');
      await fs.rm(entry.backupPath!, { force: true }); // simulate lost snapshot
      await fs.writeFile(file, 'v2');
      const result = await mgr.rollback('s4');
      assert.equal(result.failed.length, 1);
      assert.equal(result.restored.length, 0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
