import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolArguments, validateAgainstSchema, type JSONSchema } from '../../src/tools/json-schema.js';

const schema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 10 },
    count: { type: 'integer', minimum: 1, maximum: 100 },
    flag: { type: 'boolean' },
    mode: { type: 'string', enum: ['a', 'b'] },
    items: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    nested: {
      type: 'object',
      additionalProperties: false,
      required: ['x'],
      properties: { x: { type: 'number' } },
    },
  },
};

describe('json-schema validator', () => {
  it('accepts valid objects', () => {
    assert.equal(validateAgainstSchema({ path: 'a', count: 5, flag: true, mode: 'b', items: ['x'], nested: { x: 2 } }, schema).ok, true);
  });

  it('rejects missing required properties', () => {
    const res = validateAgainstSchema({}, schema);
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /missing required property/);
  });

  it('rejects unknown properties when additionalProperties=false', () => {
    const res = validateAgainstSchema({ path: 'a', evil: true }, schema);
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /unknown property/);
  });

  it('enforces string length, enums, integer ranges', () => {
    assert.equal(validateAgainstSchema({ path: 'this-is-way-too-long' }, schema).ok, false);
    assert.equal(validateAgainstSchema({ path: 'a', mode: 'c' }, schema).ok, false);
    assert.equal(validateAgainstSchema({ path: 'a', count: 1.5 }, schema).ok, false);
    assert.equal(validateAgainstSchema({ path: 'a', count: 0 }, schema).ok, false);
    assert.equal(validateAgainstSchema({ path: 'a', count: 101 }, schema).ok, false);
  });

  it('validates arrays and nesting with depth limits', () => {
    assert.equal(validateAgainstSchema({ path: 'a', items: ['1', '2', '3', '4'] }, schema).ok, false);
    assert.equal(validateAgainstSchema({ path: 'a', nested: { x: 'no' } }, schema).ok, false);
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = { x: deep };
    assert.equal(validateAgainstSchema(deep, { type: 'object', properties: { x: { type: 'number' } } } as JSONSchema).ok, false);
  });

  it('parseToolArguments returns structured errors', () => {
    const bad = parseToolArguments('{not json', schema);
    assert.equal(bad.ok, false);
    const wrong = parseToolArguments('{"path": 1}', schema);
    assert.equal(wrong.ok, false);
    const good = parseToolArguments('{"path":"x"}', schema);
    assert.equal(good.ok, true);
    if (good.ok) assert.equal(good.value['path'], 'x');
  });
});
