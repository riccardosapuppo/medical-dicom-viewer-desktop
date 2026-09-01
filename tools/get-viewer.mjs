#!/usr/bin/env node
/**
 * Fetches and builds the viewer this application ships.
 *
 *   npm run viewer            fetch, build, install into the app
 *   npm run viewer -- --keep  leave the checkout in place for a second build
 *
 * The reading surface here is the web viewer, taken from its own repository at
 * a fixed commit and used unchanged. It is not copied into this repository:
 * vendoring a monorepo means it is never updated again, and the two projects
 * would drift into being two different products with one name.
 *
 * Which commit is in `viewer.json`, next to this script's output. Changing it is
 * a commit here, so it is visible which viewer a given build shipped.
 *
 * This is slow — a full install of a large monorepo, then a production build.
 * Ten to twenty minutes on a first run, and several gigabytes in `viewer/`
 * while it happens. The result is about 38 MB in `viewer-dist/`, and that is
 * what gets packaged. The real figure is printed when it finishes.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkout = path.join(root, 'viewer');
const output = path.join(root, 'viewer-dist');
const built = path.join(checkout, 'platform', 'app', 'dist');

const keep = process.argv.includes('--keep');

const pinned = JSON.parse(fs.readFileSync(path.join(root, 'viewer.json'), 'utf8'));

/** Runs a command, and stops the script if it fails. */
function run(command, args, options = {}) {
  const shown = [command, ...args].join(' ');
  process.stdout.write(`\n> ${shown}\n`);

  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });

  if (result.status !== 0) {
    process.stderr.write(`\n${shown} failed.\n`);
    process.exit(result.status ?? 1);
  }
}

function has(command) {
  const probe = spawnSync(command, ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return probe.status === 0;
}

if (!has('git')) {
  process.stderr.write('git is needed to fetch the viewer.\n');
  process.exit(1);
}

// The viewer's own repository uses yarn workspaces. Installing it with npm
// produces a tree that builds and then fails at run time in ways that take a
// day to trace back to here.
if (!has('yarn')) {
  process.stderr.write(
    'yarn is needed to build the viewer, which uses yarn workspaces.\n' +
      'Install it with:  npm install --global yarn\n'
  );
  process.exit(1);
}

if (!fs.existsSync(path.join(checkout, '.git'))) {
  fs.rmSync(checkout, { recursive: true, force: true });

  // Fetched at one commit rather than cloned whole: the history is large and
  // none of it is wanted here.
  fs.mkdirSync(checkout, { recursive: true });
  run('git', ['init', '-q'], { cwd: checkout });
  run('git', ['remote', 'add', 'origin', pinned.repository], { cwd: checkout });
  run('git', ['fetch', '-q', '--depth', '1', 'origin', pinned.commit], { cwd: checkout });
  run('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: checkout });
} else {
  process.stdout.write(`Using the checkout already in ${path.relative(root, checkout)}.\n`);
}

run('yarn', ['install', '--frozen-lockfile'], { cwd: checkout });

// Built the way this application serves it: from the root of its own scheme,
// for production, with nothing left in for a developer to look at.
run(
  'yarn',
  ['run', 'build'],
  {
    cwd: path.join(checkout, 'platform', 'app'),
    env: { ...process.env, NODE_ENV: 'production', PUBLIC_URL: '/', QUICK_BUILD: 'false' },
  }
);

if (!fs.existsSync(path.join(built, 'index.html'))) {
  process.stderr.write('The viewer built without producing a page. Nothing was installed.\n');
  process.exit(1);
}

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(built, output, { recursive: true });

// Source maps are the whole point of a debug build and are dead weight in a
// packaged application: they roughly double it, and there is nobody to read
// them on a reading station.
let dropped = 0;
for (const entry of fs.readdirSync(output, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.map')) {
    fs.rmSync(path.join(output, entry.name));
    dropped++;
  }
}

/**
 * Brings the page's outside references inside.
 *
 * The viewer's page loads a script or two from a public network. In a browser
 * that is ordinary; here it is not. This application reads a person's studies
 * from a disc that may never be connected to anything, and it refuses to make
 * requests off the machine at all — so a reference left pointing outward is a
 * feature that quietly does not work, on the machines where it matters most.
 *
 * They are fetched once, here, where there is a connection by definition, and
 * the page is pointed at the copies.
 */
const page = path.join(output, 'index.html');
let html = fs.readFileSync(page, 'utf8');

const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(match => match[1]);
const unique = [...new Set(external)];

if (unique.length > 0) {
  const vendor = path.join(output, 'vendor');
  fs.mkdirSync(vendor, { recursive: true });

  for (const address of unique) {
    const name = path.basename(new URL(address).pathname) || 'script.js';
    process.stdout.write(`Fetching ${name} so the application does not have to ask for it.\n`);

    const answer = await fetch(address);
    if (!answer.ok) {
      process.stderr.write(`${address} answered ${answer.status}. Nothing was installed.\n`);
      process.exit(1);
    }

    fs.writeFileSync(path.join(vendor, name), Buffer.from(await answer.arrayBuffer()));
    html = html.split(address).join(`/vendor/${name}`);
  }

  fs.writeFileSync(page, html);
}

if (!keep) {
  // Several gigabytes of dependencies that have already done their job.
  fs.rmSync(checkout, { recursive: true, force: true });
}

const size = (directory) => {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    total += entry.isDirectory() ? size(full) : fs.statSync(full).size;
  }
  return total;
};

process.stdout.write(
  `\nViewer ${pinned.commit.slice(0, 7)} installed in ${path.relative(root, output)}: ` +
    `${(size(output) / (1024 * 1024)).toFixed(0)} MB` +
    (dropped ? `, ${dropped} source maps removed` : '') +
    `.\n`
);
