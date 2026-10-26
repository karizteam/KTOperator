import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff } from '../../src/util/diff.js';

describe('unified diff', () => {
  it('returns empty string for identical content', () => {
    assert.equal(unifiedDiff('a\nb\nc', 'a\nb\nc'), '');
  });

  it('produces +- markers and hunks for changes', () => {
    const diff = unifiedDiff('line1\nline2\nline3\nline4', 'line1\nCHANGED\nline3\nline4');
    assert.match(diff, /--- a\/file/);
    assert.match(diff, /\+\+\+ b\/file/);
    assert.match(diff, /@@ /);
    assert.match(diff, /-line2/);
    assert.match(diff, /\+CHANGED/);
    assert.match(diff, / line3/);
  });

  it('handles full file creation (empty old)', () => {
    const diff = unifiedDiff('', 'new\ncontent');
    assert.match(diff, /\+new/);
    assert.match(diff, /\+content/);
  });

  it('handles deletions at end', () => {
    const diff = unifiedDiff('keep\nremove1\nremove2', 'keep');
    assert.match(diff, /-remove1/);
    assert.match(diff, /-remove2/);
  });

  it('creates separate hunks for distant changes', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const changed = [...lines];
    changed[2] = 'X';
    changed[25] = 'Y';
    const diff = unifiedDiff(lines.join('\n'), changed.join('\n'));
    const hunks = diff.match(/@@ /g);
    assert.equal(hunks?.length, 2);
  });
});
