import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, emptyTotals, formatCost, formatTokens, usageLabel } from '../../src/util/usage.js';
import { chatBoxHeader } from '../../src/cli/ui.js';

/**
 * The cost label lives in the top border of the chat box, so two things must
 * be true: the number is honest about what the provider reported, and the
 * label never pushes the box past the terminal.
 */

describe('usage accounting', () => {
  it('accumulates tokens and provider-reported cost across turns', () => {
    const total = emptyTotals();
    addUsage(total, { promptTokens: 1200, completionTokens: 300, costUsd: 0.0021 });
    addUsage(total, { promptTokens: 800, completionTokens: 200 });
    addUsage(total, undefined);
    assert.deepEqual(total, { promptTokens: 2000, completionTokens: 500, costUsd: 0.0021 });
  });

  it('keeps small amounts precise instead of rounding them to zero', () => {
    assert.equal(formatCost(0), '$0.00');
    assert.equal(formatCost(0.0042), '$0.0042');
    assert.equal(formatCost(0.42), '$0.420');
    assert.equal(formatCost(12.345), '$12.35');
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1234), '1.2k');
    assert.equal(formatTokens(45_600), '46k');
    assert.equal(formatTokens(2_400_000), '2.4M');
  });

  it('shows cost when it is known and tokens when it is not', () => {
    assert.equal(usageLabel(emptyTotals()), '');
    assert.equal(usageLabel({ promptTokens: 1500, completionTokens: 500, costUsd: 0 }), '2.0k tok');
    assert.equal(usageLabel({ promptTokens: 1500, completionTokens: 500, costUsd: 0.031 }), '$0.031');
  });
});

describe('chat box top border', () => {
  it('puts the running cost at the right end of the header', () => {
    const header = chatBoxHeader({ titleLen: 3, width: 80, subtitle: 'openrouter · gpt-4o', corner: '$0.031' });
    assert.equal(header?.subtitle, 'openrouter · gpt-4o');
    assert.equal(header?.corner, '$0.031');
    // width − title − subtitle − " · " − corner − border framing (7 columns).
    assert.equal(header!.dashes, 80 - 3 - (19 + 3 + 6) - 7);
  });

  it('drops the model label before the cost on a narrow terminal', () => {
    const header = chatBoxHeader({ titleLen: 3, width: 44, subtitle: 'a-very-long-provider · a-very-long-model', corner: '$0.031' });
    assert.equal(header?.corner, '$0.031');
    assert.equal(header?.subtitle, '');
  });

  it('draws a plain border rather than overflow when nothing fits', () => {
    assert.equal(chatBoxHeader({ titleLen: 10, width: 18, subtitle: 'provider · model', corner: '$12.00' }), null);
  });
});
