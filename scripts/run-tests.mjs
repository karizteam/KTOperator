#!/usr/bin/env node
/**
 * Cross-platform test runner: collects *.test.ts recursively and runs them
 * with node's built-in test runner through the tsx loader.
 * Usage: node scripts/run-tests.mjs [dir ...]   (default: tests)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dirs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['tests'];

function collect(dir) {
  const abs = path.resolve(root, dir);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return abs.endsWith('.test.ts') ? [abs] : [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, entry.name);
    if (entry.isDirectory()) out.push(...collect(path.relative(root, p)));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const files = dirs.flatMap(collect).sort();
if (files.length === 0) {
  console.error('No test files found.');
  process.exit(1);
}
console.log(`Running ${files.length} test file(s)…`);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_NO_WARNINGS: '1' },
});
process.exit(result.status ?? 1);
