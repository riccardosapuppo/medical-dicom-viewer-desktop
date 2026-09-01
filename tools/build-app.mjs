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

// The version comes from package.json and is put into the preload when it is
// built. A number somebody has to keep in step by hand is a number that will be
// wrong.
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');

/**
 * Source maps while developing, and not in what gets installed.
 *
 * A map carries the TypeScript it was built from, and everything in dist/app is
 * packaged — so an installer built with them shipped this repository's sources
 * inside it. They are what makes a stack trace readable while working, and
 * there is nobody reading stack traces on a reading station.
 */
const shared = {
  bundle: true,
  sourcemap: watch,
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
  define: { __APP_VERSION__: JSON.stringify(version) },
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
  // The icon travels with the built main process: run from source, the window
  // otherwise shows Electron's own, which is how most people first see it.
  fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(out, 'icon.png'));

  for (const name of ['index.html', 'index.css']) {
    fs.copyFileSync(path.join(root, 'src', 'renderer', name), path.join(out, 'renderer', name));
  }

  copyViewer();
  removeWhatIsNoLongerBuilt();
}

/**
 * Removes what an earlier version of this build put here.
 *
 * Everything in dist/app is packaged, so anything left behind is shipped. The
 * drawn sample study was built here until it was replaced by the downloaded
 * ones, and twenty-four images of it sat in every installer made afterwards —
 * because a build writes what it writes and never looks at what is already
 * there.
 */
function removeWhatIsNoLongerBuilt() {
  const produced = new Set(['main.js', 'indexer.js', 'preload.js', 'icon.png', 'renderer', 'viewer']);

  // Maps are written while developing and not otherwise, so a build that is not
  // watching removes the ones a watching build left — which is what would
  // otherwise be packaged.
  if (watch) {
    for (const name of ['main.js.map', 'indexer.js.map', 'preload.js.map']) {
      produced.add(name);
    }
  }

  for (const entry of fs.readdirSync(out)) {
    if (!produced.has(entry)) {
      fs.rmSync(path.join(out, entry), { recursive: true, force: true });
      console.log(`removed ${entry}: not built any more`);
    }
  }
}

/**
 * Puts the viewer where the built main process expects it.
 *
 * It is fetched and built by `npm run viewer`, not kept in this repository, so
 * it may not be here at all. An application without it still starts and says
 * what is missing, which is better than a window that goes blank.
 *
 * Copied only when it changed. It is thousands of files, and copying them on
 * every rebuild would turn a two-second build into a slow one for no reason.
 */
function copyViewer() {
  const source = path.join(root, 'viewer-dist');
  const target = path.join(out, 'viewer');

  if (!fs.existsSync(path.join(source, 'index.html'))) {
    console.log('no viewer: run `npm run viewer` to fetch and build it');
    return;
  }

  const stamp = path.join(target, '.copied-from');
  const from = String(fs.statSync(path.join(source, 'index.html')).mtimeMs);

  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === from) {
    return;
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  fs.writeFileSync(stamp, from);
  console.log(`viewer: copied from ${path.relative(root, source)}`);
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
