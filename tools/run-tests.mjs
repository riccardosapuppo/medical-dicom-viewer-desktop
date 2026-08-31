#!/usr/bin/env node
/**
 * Builds the tests and runs them.
 *
 * The tests are TypeScript and the sources they exercise are too, so something
 * has to compile before Node can run anything. This does it in one step and
 * finds the files itself: naming every entry point in package.json meant a new
 * test file silently never ran, which is the worst way for a test to fail.
 *
 *   npm test
 *   npm test -- --only build-index      (substring match on the file name)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'tests');
const output = path.join(root, 'dist', 'tests');

const onlyAt = process.argv.indexOf('--only');
const only = onlyAt === -1 ? undefined : process.argv[onlyAt + 1];

const entries = fs
  .readdirSync(source)
  .filter(name => name.endsWith('.test.ts') || name.endsWith('.test.tsx'))
  .filter(name => !only || name.includes(only))
  .map(name => path.join(source, name));

if (entries.length === 0) {
  console.error(only ? `No test file matches "${only}".` : 'No test files found.');
  process.exit(1);
}

// A stale bundle from a test file that has since been deleted or renamed would
// keep passing forever, and nobody would notice it was testing nothing.
fs.rmSync(output, { recursive: true, force: true });

await esbuild.build({
  entryPoints: entries,
  outdir: output,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  jsx: 'automatic',
  sourcemap: 'inline',
  // Native and optional bits of the DICOM parser are better required at run
  // time than bundled: esbuild resolves them differently than Node does.
  external: ['electron'],
});

const { status } = spawnSync(process.execPath, ['--test', `${output}/*.test.js`], {
  stdio: 'inherit',
  cwd: root,
});

process.exit(status ?? 1);
