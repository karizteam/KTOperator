import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTier, isHardDenied, TOOL_BASE_TIER } from '../../src/security/policy.js';
import { defaultConfig } from '../../src/config/schema.js';
import { ALL_TOOLS } from '../../src/tools/index.js';

describe('policy engine', () => {
  const config = defaultConfig();

  it('allows read-only operations by policy', () => {
    const v = evaluateTier(0, config);
    assert.equal(v.decision, 'allow');
  });

  it('requires approval for modification/destruction/privileged tiers', () => {
    for (const tier of [1, 2, 3] as const) {
      assert.equal(evaluateTier(tier, config).decision, 'requires-approval');
    }
  });

  it('hard-denies anything outside the workspace or as root', () => {
    assert.match(isHardDenied({ kind: 'fs', targetInsideWorkspace: false }) ?? '', /outside the authorized workspace/);
    assert.match(isHardDenied({ kind: 'exec', targetInsideWorkspace: true, runsAsRoot: true }) ?? '', /root/);
    assert.equal(isHardDenied({ kind: 'fs', targetInsideWorkspace: true }), null);
  });

  it('every registered tool has a base tier and valid metadata', () => {
    for (const tool of ALL_TOOLS) {
      assert.ok(tool.name in TOOL_BASE_TIER, `missing base tier for ${tool.name}`);
      assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
      assert.equal(tool.schema.type, 'object', `${tool.name} schema must be an object`);
    }
  });

  it('classifies the expected tiers for key tools', () => {
    assert.equal(TOOL_BASE_TIER['read_file'], 0);
    assert.equal(TOOL_BASE_TIER['edit_file'], 1);
    assert.equal(TOOL_BASE_TIER['delete_file'], 2);
    assert.equal(TOOL_BASE_TIER['execute_approved_command'], 3);
    assert.equal(TOOL_BASE_TIER['run_build'], 3);
  });
});
