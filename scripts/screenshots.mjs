#!/usr/bin/env node
/**
 * Takes the pictures the README uses.
 *
 *   node scripts/screenshots.mjs <folder of studies>
 *
 * Written down as a script rather than done by hand for one reason: a README
 * whose pictures are of a version that no longer exists is worse than one with
 * no pictures at all. This one had three of a viewer that has since been
 * replaced, and one pointing at a file that was never there.
 *
 * It drives the real application, so what comes out is what somebody who runs
 * it would see.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const PORT = 9334;

const folder =
  process.argv.slice(2).find(argument => !argument.startsWith('--')) ??
  path.join(root, 'demo-data');

if (!fs.existsSync(folder)) {
  console.error(`No studies at ${folder}. Run: npm run demo-data`);
  process.exit(1);
}

const electron = path.join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);

/** Starts the application, with a folder or without one. */
function start(open) {
  // The language is forced. The viewer formats the overlay date with the
  // system locale, so a picture taken on this machine had an Italian month
  // abbreviation in it — the capture machine showing through the product, in
  // the one image every reader looks at.
  const args = open
    ? [root, '--open', open, '--lang=en-GB', `--remote-debugging-port=${PORT}`]
    : [root, '--lang=en-GB', `--remote-debugging-port=${PORT}`];

  return spawn(electron, args, {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, LANG: 'en_GB.UTF-8' },
  });
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

async function shoot(page, name) {
  const file = path.join(docs, `${name}.png`);
  await page.screenshot({ path: file });
  const size = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`  ${name}.png   ${size} KB`);
}

fs.mkdirSync(docs, { recursive: true });

// First pass: nothing open.
let child = start();
let browser = await connect();

try {
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));

  await page.waitForSelector('.start', { timeout: 60000 });
  await page.waitForTimeout(1200);
  await shoot(page, 'start');

  // The desk map is what the window shows when it is standing on several
  // screens and holding nothing. On a machine with one screen there is nothing
  // to draw, and a picture of it would say the opposite of what it means.
  const desk = await page.$('.desk-map, .desk');
  if (desk) {
    await shoot(page, 'desk');
  } else {
    console.log('  desk.png    skipped: one screen, nothing to draw');
  }
} finally {
  await browser.close().catch(() => {});
  child.kill();
}

// Second pass: the folder open from the start, which is how the application is
// asked to read one from outside itself.
child = start(folder);
browser = await connect();

try {
  const context = browser.contexts()[0];
  let page = context.pages()[0] ?? (await context.waitForEvent('page'));

  await page.waitForSelector('.study__head', { timeout: 180000 });
  await page.waitForTimeout(1500);
  await shoot(page, 'library');

  await page.click('.study__head');
  await page.waitForURL(url => url.protocol === 'viewer:', { timeout: 120000 }).catch(() => {});
  page = context.pages().find(one => one.url().startsWith('viewer:')) ?? page;

  // Waiting for the canvas is not enough: it exists before anything is drawn on
  // it, and a picture taken then is of a black rectangle.
  await page
    .waitForFunction(
      () => {
        const canvas = document.querySelector('canvas');
        if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0) {
          return false;
        }
        const context2d = canvas.getContext('2d');
        return context2d ? true : canvas.width > 0;
      },
      { timeout: 180000 }
    )
    .catch(() => {});

  await page.waitForTimeout(6000);
  await shoot(page, 'viewer');
} finally {
  await browser.close().catch(() => {});
  child.kill();
}
