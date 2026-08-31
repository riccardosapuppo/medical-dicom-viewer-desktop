#!/usr/bin/env node
/**
 * Breaks the topology module on purpose and checks the tests notice.
 *
 * A green suite says the tests ran, not that they would catch anything. Each
 * entry below removes one thing the fingerprint is supposed to depend on; if
 * the suite stays green afterwards, that test is decoration, and the guarantee
 * it claims to protect is not protected.
 *
 * This paid for itself the first time it ran: four of six mutations survived.
 * The fingerprint could lose pane size, scale, and built-in-versus-external
 * without a single red line, and the label test was defeated by its own
 * fixture, whose fake ids happened to be 1, 2 and 3 — the very ordinals it
 * meant to tell them apart from.
 *
 * The file is put back afterwards, including on the way out of a failure.
 *
 *   npm run mutations
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src', 'main', 'display-topology.ts');
const original = fs.readFileSync(target, 'utf8');

/** [what to find, what to put there instead, what the change means] */
const MUTATIONS = [
  [
    '    .sort((a, b) => a.x - b.x',
    '    .sort((a, b) => 0 * (a.x - b.x)',
    'enumeration order leaks into the fingerprint',
  ],
  ['      internal: pane.internal,\n', '', 'built-in and external glass become the same'],
  ['      scaleFactor: pane.scaleFactor,\n', '', 'scaling drops out'],
  ['        x: bounds.x - primary.bounds.x,', '        x: bounds.x,', 'positions stop being relative to the primary'],
  [
    'display.label || `Screen ${index + 1}`',
    'display.label || `Screen ${display.id}`',
    'the unstable id comes back into the label',
  ],
  [
    '      width: pane.physical.width,\n      height: pane.physical.height,',
    '      width: 0,\n      height: 0,',
    'pane size drops out',
  ],
];

// A module left broken because something blew up halfway is worse than the
// defect being hunted. Put it back on every exit path.
process.on('exit', () => fs.writeFileSync(target, original, 'utf8'));

let survivors = 0;

for (const [from, to, meaning] of MUTATIONS) {
  if (!original.includes(from)) {
    console.log(`  STALE     ${meaning}  <- the anchor no longer exists in the module`);
    survivors++;
    continue;
  }

  fs.writeFileSync(target, original.replace(from, to), 'utf8');

  let failed = 0;
  try {
    const out = execSync('npm test', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    failed = Number(/^\S* fail (\d+)$/m.exec(out)?.[1] ?? 0);
  } catch (e) {
    failed = Number(/^\S* fail (\d+)$/m.exec(String(e.stdout ?? ''))?.[1] ?? 1);
  }

  console.log(
    `  ${failed ? 'caught ' : 'SURVIVED'} ${String(failed).padStart(2)} red   ${meaning}`
  );
  if (!failed) {
    survivors++;
  }
}

fs.writeFileSync(target, original, 'utf8');
console.log(
  `\n${survivors} of ${MUTATIONS.length} mutations survived` +
    (survivors ? '  <- a test that does not notice is not protecting anything' : '')
);
process.exitCode = survivors ? 1 : 0;
