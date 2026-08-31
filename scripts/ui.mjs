#!/usr/bin/env node
/**
 * Drives the built application and looks at what it drew.
 *
 * Unit tests say the arithmetic is right. They cannot say that an image reached
 * the screen: a shader that fails to compile, a texture uploaded in the wrong
 * format, a canvas sized to nothing and a window that is entirely black all
 * pass every test in this repository. So this opens the real application on the
 * real demo folder, clicks a real series, and reads the pixels back off the
 * canvas.
 *
 * It connects to Electron's own Chromium over the debugging port, so nothing is
 * downloaded and nothing leaves the machine.
 *
 *   npm run demo-data
 *   npm run check:ui
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'demo-data');
const PORT = 9222;

if (!fs.existsSync(folder)) {
  console.error('There is no demo-data folder. Run: npm run demo-data');
  process.exit(1);
}

const electron = path.join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);

const child = spawn(electron, [root, '--open', folder, `--remote-debugging-port=${PORT}`], {
  cwd: root,
  stdio: 'ignore',
  // Electron obeys this from the surrounding shell and starts as plain Node.
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
});

let failures = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
  if (!ok) {
    failures++;
  }
}

/** Waits for the debugging port to answer, rather than sleeping and hoping. */
async function connect() {
  for (let i = 0; i < 60; i++) {
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
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));

  const problems = [];
  page.on('pageerror', error => problems.push(String(error.message).slice(0, 160)));
  page.on('console', message => {
    if (message.type() === 'error') {
      problems.push(`console: ${message.text().slice(0, 160)}`);
    }
  });

  await page.waitForSelector('.patient', { timeout: 60000 });
  check('the folder read into a worklist', true, `${await page.locator('.patient').count()} patients`);

  // The largest series, because a two-image scout proves nothing about scrolling.
  const rows = page.locator('.series');
  const counts = await rows.locator('.series__count').allInnerTexts();
  const biggest = counts.reduce((best, text, i) => (parseInt(text, 10) > parseInt(counts[best], 10) ? i : best), 0);

  await rows.nth(biggest).locator('.series__open').click();
  await page.waitForSelector('.viewport__canvas', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.viewport__loading'), undefined, {
    timeout: 30000,
  });

  check('a series opened', true, counts[biggest]);

  const noGraphics = await page.locator('.viewport__notice h2').count();
  check('the graphics context works', noGraphics === 0, noGraphics ? await page.locator('.viewport__notice h2').innerText() : '');

  /**
   * Reads back what the graphics card actually produced.
   *
   * A plain read, because the application keeps its drawing buffer. An earlier
   * version of this had to dispatch an event to force a redraw and read inside
   * the same frame, which worked until the redraw stopped being triggered from
   * the event handler and started following the render. A measurement that
   * depends on how the thing it measures is scheduled is a measurement that
   * will lie again.
   */
  /**
   * Waits until a reading stops changing before believing it.
   *
   * The drawing happens in an animation frame after the render that asked for
   * it, so a read taken straight after an interaction can catch the frame
   * before. A check that depends on how busy the machine is will pass and fail
   * for no reason, and an unstable check teaches you to ignore it.
   */
  async function settled(read, same) {
    let previous;
    for (let i = 0; i < 30; i++) {
      const now = await read();
      if (previous !== undefined && same(previous, now)) {
        return now;
      }
      previous = now;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return previous;
  }

  const sample = () => settled(sampleOnce, (a, b) => a.signature === b.signature);

  const sampleOnce = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('.viewport__canvas');
      const gl = canvas.getContext('webgl2');
      const width = canvas.width;
      const height = canvas.height;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      let lit = 0;
      let total = 0;
      let min = 255;
      let max = 0;
      // The mean over a whole canvas is too blunt to tell two slices apart: the
      // difference between neighbouring slices is a couple of per cent of a
      // couple of per cent of the frame, and it rounds away. A hash does not.
      let signature = 2166136261;

      for (let i = 0; i < pixels.length; i += 4) {
        const grey = pixels[i];
        total += grey;
        if (grey > 8) {
          lit++;
        }
        if (grey < min) {
          min = grey;
        }
        if (grey > max) {
          max = grey;
        }
        signature ^= grey;
        signature = Math.imul(signature, 16777619) >>> 0;
      }

      const count = pixels.length / 4;
      return { width, height, lit, pixels: count, mean: total / count, min, max, signature };
    });

  const drawn = await sample();
  check(
    'the canvas has the resolution of the panel',
    drawn.width > 600 && drawn.height > 400,
    `${drawn.width}x${drawn.height}`
  );
  check(
    'an image actually reached the screen',
    drawn.lit > drawn.pixels * 0.05,
    `${Math.round((drawn.lit / drawn.pixels) * 100)}% of the canvas is not black`
  );
  check(
    'the image has a range of greys, not one flat tone',
    drawn.max - drawn.min > 60,
    `${drawn.min} to ${drawn.max}`
  );

  // Scrolling must change the picture. A stack that draws the same slice for
  // every position is the failure that looks most like success.
  const before = await sample();
  await page.locator('.viewport__canvas').hover();
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 120);
  }
  await page.waitForFunction(() => !document.querySelector('.viewport__loading'), undefined, { timeout: 20000 });
  const after = await sample();
  const position = await page.locator('.overlay--bottom-right span').first().innerText();

  check('the wheel moved through the stack', position.trim().startsWith('9'), position.trim());
  // A stack that draws the same slice at every position is the failure that
  // looks most like success, and the only thing that catches it is comparing
  // the pixels themselves.
  check(
    'a different slice really is a different picture',
    after.signature !== before.signature,
    `${before.signature.toString(16)} then ${after.signature.toString(16)}`
  );

  // A window drag has to change the greys. This is the control a radiologist
  // uses most, and a shader uniform that never reaches the card looks exactly
  // like a viewer that works until somebody drags.
  const box = await page.locator('.viewport__canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 220, box.y + box.height / 2 - 60, { steps: 12 });
  await page.mouse.up();

  const windowed = await sample();
  const level = await page.locator('.overlay--bottom-left span').first().innerText();

  check('dragging changed the window', level.trim() !== 'W 400 L 40', level.trim());
  check(
    'dragging changed the picture',
    windowed.signature !== after.signature && Math.abs(windowed.mean - after.mean) > 1,
    `mean ${after.mean.toFixed(1)} then ${windowed.mean.toFixed(1)}`
  );

  // A preset must land on exactly the numbers it names.
  await page.getByRole('button', { name: 'Lung' }).click();
  const lung = (await page.locator('.overlay--bottom-left span').first().innerText()).trim();
  check('a preset sets the window it names', lung === 'W 1500 L -600', lung);

  // A window of its own, on a chosen pane of the desk. On a machine with one
  // screen this only exercises the path, not the placement - the placement is
  // covered by the tests against invented desks, which is the only way to test
  // a desk nobody owns.
  await page.getByRole('button', { name: 'Back to the list' }).click();
  await page.waitForSelector('.patient', { timeout: 20000 });

  const row = page.locator('.series').nth(biggest);
  await row.hover();

  // Taken here rather than by the application itself, because the screens a
  // series can be sent to only appear under the pointer, and a screenshot of
  // the feature has to have the pointer on it.
  await page.screenshot({ path: path.join(root, 'docs', 'library.png') });
  const second = context.waitForEvent('page', { timeout: 30000 });
  await row.locator('.screen').first().click();
  const reading = await second;

  await reading.waitForSelector('.viewport__canvas', { timeout: 30000 });
  await reading.waitForFunction(() => !document.querySelector('.viewport__loading'), undefined, {
    timeout: 30000,
  });

  const detached = await reading.evaluate(() => ({
    worklist: document.querySelectorAll('.patient').length,
    hint: document.querySelectorAll('.viewport__hint').length,
    canvas: document.querySelector('.viewport__canvas')?.width ?? 0,
    close: document.querySelector('.viewport__bar .button')?.textContent ?? '',
  }));

  check('a series opened in a window of its own', detached.canvas > 300, `canvas ${detached.canvas} wide`);
  check('that window carries no worklist', detached.worklist === 0);
  check('and it says Close, not Back to the list', detached.close === 'Close', detached.close);

  // The arrangement is remembered against the desk fingerprint, so closing the
  // window and asking for it back should bring it back.
  await reading.close();
  const third = context.waitForEvent('page', { timeout: 30000 });
  await page.getByRole('button', { name: 'Restore arrangement' }).click();
  const restored = await third;
  await restored.waitForSelector('.viewport__canvas', { timeout: 30000 });
  const said = await page.locator('.status__said').innerText();

  check('the desk remembered the arrangement', said.includes('1 window'), said.trim());
  await restored.close();

  // Back to the series in the main window for the rest of the checks.
  await page.locator('.series').nth(biggest).locator('.series__open').click();
  await page.waitForSelector('.viewport__canvas', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.viewport__loading'), undefined, {
    timeout: 30000,
  });
  // The keyboard is not a convenience here: somebody scrolling a stack with one
  // hand on the mouse and one on the keyboard is the normal posture, and a
  // viewer reachable only by dragging is one that some people cannot use.
  await page.keyboard.press('Home');
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('PageDown');
  }
  await page.waitForFunction(() => !document.querySelector('.viewport__loading'), undefined, {
    timeout: 20000,
  });
  const byKeyboard = (await page.locator('.overlay--bottom-right span').first().innerText()).trim();
  check('the keyboard moves through the stack', byKeyboard.startsWith('31'), byKeyboard);

  await page.getByRole('button', { name: 'Soft tissue' }).click();

  /**
   * How much of the annotation canvas has anything drawn on it, once it has
   * stopped changing.
   *
   * The drawing happens in an animation frame after the render that asked for
   * it, so a read taken straight after an interaction can catch the frame
   * before. That produced a check which reported a stale number and passed or
   * failed depending on how busy the machine was, which is worse than no check:
   * an unstable check teaches you to ignore it. So it reads until two readings
   * agree.
   */
  const inked = () => settled(inkedOnce, (a, b) => a === b);

  const inkedOnce = () =>
    page.evaluate(() => {
      const overlay = document.querySelector('.viewport__overlay');
      const context = overlay.getContext('2d');
      const { data } = context.getImageData(0, 0, overlay.width, overlay.height);
      let drawn = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 8) {
          drawn++;
        }
      }
      return drawn;
    });

  // The annotations are on a canvas of their own, so "a measurement appeared"
  // is a question about that canvas and not about the image underneath.
  check('the annotation layer starts empty', (await inked()) === 0);

  const bare = await sample();

  const stage = await page.locator('.viewport__canvas').boundingBox();
  const middle = { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 };

  await page.getByRole('button', { name: 'Length' }).click();
  await page.mouse.move(middle.x - 160, middle.y - 90);
  await page.mouse.down();
  await page.mouse.move(middle.x + 60, middle.y - 90, { steps: 10 });
  await page.mouse.up();

  const withLength = await inked();
  check('a length was drawn', withLength > 200, `${withLength} pixels of ink`);

  await page.getByRole('button', { name: 'Region' }).click();
  await page.mouse.move(middle.x - 40, middle.y + 20);
  await page.mouse.down();
  await page.mouse.move(middle.x + 60, middle.y + 100, { steps: 10 });
  await page.mouse.up();

  const withRegion = await inked();
  check('a region was drawn as well', withRegion > withLength, `${withRegion} pixels of ink`);

  // Drawing over the image must not become part of it. If the annotations were
  // rasterised into the same buffer, anything that reads the pixels back would
  // be reading them too - including this check, which would then be measuring
  // its own ink. The first version of this line compared nothing and could only
  // pass, which is the same as not checking.
  const beneath = await sample();
  check(
    'the annotations are not in the image buffer',
    beneath.signature === bare.signature,
    beneath.signature === bare.signature
      ? 'the image is byte for byte what it was'
      : `${bare.signature.toString(16)} became ${beneath.signature.toString(16)}`
  );

  // A click with no drag is a click, not a measurement of nothing.
  await page.getByRole('button', { name: 'Length' }).click();
  await page.mouse.click(middle.x + 200, middle.y + 150);
  const afterClick = await inked();
  const counted = await page.locator('.viewport__stage').getAttribute('data-measurements');
  check(
    'a click leaves no measurement',
    counted === '2' && afterClick === withRegion,
    `${counted} measurements, ${withRegion} pixels of ink before and ${afterClick} after`
  );
  await page.getByRole('button', { name: 'Window' }).click();
  await page.screenshot({ path: path.join(root, 'docs', 'viewer.png') });
  console.log(`\n  wrote docs/viewer.png`);

  check('nothing raised', problems.length === 0, problems.slice(0, 3).join(' | '));
} finally {
  await browser.close().catch(() => {});
  child.kill();
}

console.log(`\nChecks failed: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
