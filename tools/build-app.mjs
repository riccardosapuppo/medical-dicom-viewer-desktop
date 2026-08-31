#!/usr/bin/env node
/**
 * Builds the three halves of an Electron application.
 *
 * They are three because they run in three different places and can reach three
 * different things: the main process has the machine, the renderer has the
 * page and nothing else, and the preload sits between them holding the only
 * door. Building them together, with one set of options, is how that boundary
 * gets accidentally erased — a bundler that resolves `fs` for the renderer
 * because the main process needed it has already lost the argument.
 *
 *   npm run build
 *   npm run build -- --watch
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'app');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'warning',
  absWorkingDir: root,
};

/** The main process. Node is available; Electron itself is not bundled. */
const main = {
  ...shared,
  entryPoints: ['src/main/main.ts'],
  outfile: path.join(out, 'main.js'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
};

/**
 * The indexing process. Node with the disk and no window, forked by the main
 * process. Its own bundle because it is its own program.
 */
const indexer = {
  ...shared,
  entryPoints: ['src/main/library/indexer-process.ts'],
  outfile: path.join(out, 'indexer.js'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
};

/**
 * The preload. Same shape as the main process, different file, and deliberately
 * its own build: it must never accidentally pull in something from the main
 * process that would then be reachable from the page.
 */
const preload = {
  ...shared,
  entryPoints: ['src/preload/preload.ts'],
  outfile: path.join(out, 'preload.js'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
};

/**
 * The page. Browser platform, so a stray import of a Node module fails the
 * build instead of failing at run time inside a sandbox that was supposed to
 * make it impossible.
 */
const renderer = {
  ...shared,
  entryPoints: ['src/renderer/main.tsx'],
  outfile: path.join(out, 'renderer', 'renderer.js'),
  platform: 'browser',
  target: 'chrome128',
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  minify: !watch,
};

function copyStatic() {
  fs.mkdirSync(path.join(out, 'renderer'), { recursive: true });
  for (const name of ['index.html', 'index.css']) {
    fs.copyFileSync(path.join(root, 'src', 'renderer', name), path.join(out, 'renderer', name));
  }
}

copyStatic();

if (watch) {
  const contexts = await Promise.all([main, indexer, preload, renderer].map(esbuild.context));
  await Promise.all(contexts.map(c => c.watch()));
  fs.watch(path.join(root, 'src', 'renderer'), (_event, name) => {
    if (name === 'index.html' || name === 'index.css') {
      copyStatic();
    }
  });
  console.log('watching');
} else {
  await Promise.all([main, indexer, preload, renderer].map(esbuild.build));
  console.log(`built into ${path.relative(root, out)}`);
}
