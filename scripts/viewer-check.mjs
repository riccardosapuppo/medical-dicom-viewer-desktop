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
import os from 'node:os';
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

// A second folder, made from one collection of the first, so reading it is
// quick and the index it produces is genuinely different.
const elsewhere = path.join(os.tmpdir(), 'dicom-workstation-second-folder');

fs.rmSync(elsewhere, { recursive: true, force: true });
for (const collection of fs.readdirSync(folder).slice(0, 1)) {
  fs.cpSync(path.join(folder, collection), path.join(elsewhere, collection), { recursive: true });
}

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

  // The worklist is the way in: the folder is read, the studies in it are
  // listed, and clicking one hands the window to the viewer. Driving it this way
  // exercises the path a person takes rather than a shortcut written for the
  // check — and clicking the STUDY is the path, not clicking a series inside it.
  await page.waitForSelector('.study__head', { timeout: 120000 });
  check('the folder was read into a worklist', true);

  const patients = await page.$$eval('.patient', nodes => nodes.length);
  const drawn = await page.$$eval('.patient', nodes =>
    nodes.some(node => /bianchi|ferrari|rossi/i.test(node.textContent ?? ''))
  );
  // The studies are the ones downloaded from the archive. A folder that also
  // holds an older synthetic set shows a patient who is not part of the
  // demonstration, which is what happened.
  check('the studies are the demonstration ones', !drawn, `${patients} patients`);

  await page.click('.study__head');

  await page.waitForURL(url => url.protocol === 'viewer:', { timeout: 120000 }).catch(() => {});
  page = context.pages().find(one => one.url().startsWith('viewer:')) ?? page;
  watch(page);

  check('opening a study hands the window to the viewer', page.url().startsWith('viewer:'), page.url());

  // The reading surface is a web page carrying a title of its own, and a window
  // takes its title from the page it shows. Left alone it writes the sibling
  // project's name, and the word "Web", across a desktop window. The document's
  // title is not the window's, so it has to be asked for.
  const bar = await page.evaluate(() =>
    window.workstation ? window.workstation.windowTitle() : '<no bridge on this page>'
  );
  const document_ = await page.evaluate(() => document.title);
  check(
    'the title bar is the application, not the page',
    typeof bar === 'string' && bar.length > 0 && !bar.toLowerCase().includes('web'),
    `bar "${bar}", document "${document_}"`
  );

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

  // The page moving itself, which is what a link inside the viewer does. The
  // window used to refuse every navigation on the grounds that nothing here
  // navigated — true until the reading surface became a page with routing of
  // its own, after which the viewer could not move between its own screens and
  // looked frozen.
  await page.evaluate(() => {
    window.location.href = '/';
  });

  const rows = await page
    .waitForFunction(
      () => {
        const found = document.querySelectorAll('tr[data-cy="studyRow"], tr.cursor-pointer');
        return found.length > 0 ? found.length : false;
      },
      { timeout: 120000 }
    )
    .then(handle => handle.jsonValue())
    .catch(() => 0);

  check('the viewer can move between its own screens', rows > 0, `${rows} studies listed`);

  // Back to the worklist, which loads this application's own page again from
  // nothing. The folder is still open and the archive is still serving it, so
  // the worklist has to come back showing it — it used to come back to the
  // opening screen, which looks like the study you were reading was lost.
  // Not awaited inside the page: the call navigates the window, which destroys
  // the context the promise is waiting in. What is being checked is what comes
  // back, not what this call returns.
  await page
    .evaluate(() => {
      void window.workstation.leaveViewer();
    })
    .catch(() => {});
  await page.waitForURL(url => url.protocol !== 'viewer:', { timeout: 60000 }).catch(() => {});

  const listed = await page
    .waitForSelector('.study__head', { timeout: 60000 })
    .then(() => page.$$eval('.study__head', nodes => nodes.length))
    .catch(() => 0);

  check('coming back shows the folder that is still open', listed > 0, `${listed} studies`);

  // Reading a different folder while a study is open. The archive answers for
  // one folder, so this pulls the study on screen out from under the viewer,
  // which then fails to fetch a frame and puts up a full-screen "session
  // expired" — a sentence about a session this application does not have, over
  // a study that was fine a moment ago. It is what somebody hits the first time
  // they open a second folder, and it took a person to find it.
  await page.click('.study__head');
  await page.waitForURL(url => url.protocol === 'viewer:', { timeout: 120000 }).catch(() => {});
  page = context.pages().find(one => one.url().startsWith('viewer:')) ?? page;

  await page
    .waitForFunction(
      () => {
        const canvas = document.querySelector('canvas');
        return canvas instanceof HTMLCanvasElement && canvas.width > 0;
      },
      { timeout: 180000 }
    )
    .catch(() => {});

  await page.evaluate(where => window.workstation.readFolder(where), elsewhere);
  await page.waitForTimeout(6000);

  const overlay = await page.evaluate(() => {
    const found = document.getElementById('error-overlay');
    return found ? (found.textContent ?? '').trim() : '';
  });

  check('a second folder does not strand the viewer', overlay === '', overlay);
} finally {
  await browser.close().catch(() => {});
  child.kill();
  fs.rmSync(elsewhere, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
