#!/usr/bin/env node
/**
 * Drives the application until the viewer is showing a real study.
 *
 * This is the check that matters most for what this application is: the reading
 * surface is the web viewer, and it reads from an archive this process serves
 * over a folder on a disc. Every piece of that can be right on its own and still
 * not meet in the middle — a scheme registered without the privileges the viewer
 * needs, a configuration pointed at the wrong address, a frame served in a shape
 * the decoder does not accept. None of it shows up in a unit test, and all of it
 * shows up as a black rectangle.
 *
 *   node scripts/viewer-check.mjs <folder of studies>
 *   node scripts/viewer-check.mjs <folder> --packaged
 *
 * With --packaged it drives the application electron-builder produced, which is
 * where packaging mistakes live and nowhere else: the viewer left out of the
 * archive, a path that worked relative to the project and does not relative to
 * an installed application, a file the configuration quietly excluded. All of
 * them look perfect in development and give a blank window to whoever installs
 * it.
 *
 * It reports what the viewer actually did: whether the study list filled, what
 * the archive was asked for, and anything the page complained about.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9333;

const packaged = process.argv.includes('--packaged');
const folder =
  process.argv.slice(2).find(argument => !argument.startsWith('--')) ??
  path.join(root, 'demo-data');

if (!fs.existsSync(folder)) {
  console.error(`No studies at ${folder}. Run: npm run demo-data`);
  process.exit(1);
}

if (!packaged && !fs.existsSync(path.join(root, 'dist', 'app', 'viewer', 'index.html'))) {
  console.error('No viewer in the build. Run: npm run viewer, then npm run build');
  process.exit(1);
}

const unpacked = path.join(root, 'release', 'win-unpacked', 'DICOM Workstation.exe');

if (packaged && !fs.existsSync(unpacked)) {
  console.error('There is no packaged build. Run: npm run package:dir');
  process.exit(1);
}

const executable = packaged
  ? unpacked
  : path.join(
      root,
      'node_modules',
      'electron',
      'dist',
      process.platform === 'win32' ? 'electron.exe' : 'electron'
    );

// An installed application is given no project directory: it is the project.
const args = packaged
  ? ['--open', folder, `--remote-debugging-port=${PORT}`]
  : [root, '--open', folder, `--remote-debugging-port=${PORT}`];

console.log(`  driving the ${packaged ? 'packaged build' : 'development build'}`);

const child = spawn(executable, args, {
  cwd: root,
  stdio: 'ignore',
  // Obeyed from the surrounding shell, and Electron then starts as plain Node
  // with no `app` at all.
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
});

let failures = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
  if (!ok) {
    failures++;
  }
}

async function connect() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error('the application never opened its debugging port');
}

const browser = await connect();

try {
  const context = browser.contexts()[0];
  let page = context.pages()[0] ?? (await context.waitForEvent('page'));

  const complaints = [];
  const asked = [];

  const watch = target => {
    target.on('pageerror', error => complaints.push(String(error.message).slice(0, 200)));
    target.on('console', message => {
      if (message.type() === 'error') {
        complaints.push(`console: ${message.text().slice(0, 200)}`);
      }
    });
    target.on('request', request => asked.push(request.url()));
  };

  watch(page);

  // The worklist is the way in: the folder is read, its series are listed, and
  // opening one hands the window to the viewer. Driving it this way exercises
  // the path a person takes rather than a shortcut written for the check.
  await page.waitForSelector('.series__open', { timeout: 120000 });
  check('the folder was read into a worklist', true);

  await page.click('.series__open');

  await page.waitForURL(url => url.protocol === 'viewer:', { timeout: 120000 }).catch(() => {});
  page = context.pages().find(one => one.url().startsWith('viewer:')) ?? page;
  watch(page);

  check('opening a series hands the window to the viewer', page.url().startsWith('viewer:'), page.url());

  // The viewport, drawn by the viewer from what the archive served it.
  const drew = await page
    .waitForFunction(
      () => {
        const canvas = document.querySelector('canvas');
        return canvas instanceof HTMLCanvasElement && canvas.width > 0 ? canvas.width : false;
      },
      { timeout: 180000 }
    )
    .then(handle => handle.jsonValue())
    .catch(() => 0);

  check('the viewer drew the study', drew > 0, `${drew}px wide`);

  const queried = asked.filter(url => url.includes('/dicom-web/'));
  check('the viewer queried the archive', queried.length > 0, `${queried.length} requests`);

  const outward = asked.filter(
    url => !/^(viewer:|dicom:|data:|blob:|devtools:|file:|http:\/\/127\.0\.0\.1|http:\/\/localhost)/.test(url)
  );
  check('nothing was asked for off this machine', outward.length === 0, outward.slice(0, 3).join(' '));

  const real = complaints.filter(text => !/favicon|service ?worker|Manifest/i.test(text));
  check('the page reported nothing broken', real.length === 0, real.slice(0, 3).join(' | '));

  const frames = asked.filter(url => url.includes('/frames/'));
  check('the viewer asked the archive for pixels', frames.length > 0, `${frames.length} frames`);
} finally {
  await browser.close().catch(() => {});
  child.kill();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
