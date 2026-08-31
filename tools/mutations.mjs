#!/usr/bin/env node
/**
 * Breaks the code on purpose and checks the tests notice.
 *
 * A green suite says the tests ran, not that they would catch anything. Each
 * entry below removes one thing the code is supposed to guarantee; if the suite
 * stays green afterwards, the test covering it is decoration, and the guarantee
 * is not guarded.
 *
 * This paid for itself the first time it ran: four of six mutations survived.
 * The desk fingerprint could lose pane size, scaling, and built-in-versus-
 * external without a single red line, and the test on screen labels was being
 * defeated by its own fixture, whose fake ids happened to be 1, 2 and 3 — the
 * very ordinals it was written to tell them apart from.
 *
 * Files are put back afterwards, including on the way out of a failure.
 *
 *   npm run mutations
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** [file, what to find, what to put there instead, what the change means] */
const MUTATIONS = [
  [
    'src/main/display-topology.ts',
    '    .sort((a, b) => a.x - b.x',
    '    .sort((a, b) => 0 * (a.x - b.x)',
    'desk: enumeration order leaks into the fingerprint',
  ],
  [
    'src/main/display-topology.ts',
    '      internal: pane.internal,\n',
    '',
    'desk: built-in and external glass become the same',
  ],
  ['src/main/display-topology.ts', '      scaleFactor: pane.scaleFactor,\n', '', 'desk: scaling drops out'],
  [
    'src/main/display-topology.ts',
    '        x: bounds.x - primary.bounds.x,',
    '        x: bounds.x,',
    'desk: positions stop being relative to the primary',
  ],
  [
    'src/main/display-topology.ts',
    'display.label || `Screen ${index + 1}`',
    'display.label || `Screen ${display.id}`',
    'desk: the unstable id comes back into the label',
  ],
  [
    'src/main/display-topology.ts',
    '      width: pane.physical.width,\n      height: pane.physical.height,',
    '      width: 0,\n      height: 0,',
    'desk: pane size drops out',
  ],
  [
    'src/main/dicom/read-header.ts',
    "{ untilTag: PIXEL_DATA }",
    '{}',
    'header: the reader walks into the pixel data',
  ],
  [
    'src/main/dicom/read-header.ts',
    '        length = Math.min(length * 2, size);',
    '        length = size + 1;',
    'header: a header bigger than the first read is given up on',
  ],
  [
    'src/main/dicom/read-header.ts',
    '  if (parts.length !== expected || parts.some(n => !Number.isFinite(n))) {',
    '  if (false) {',
    'header: a half-read position is passed on as if it were whole',
  ],
  [
    'src/main/dicom/build-index.ts',
    '      const byPosition = byOptionalNumber(a.slicePosition, b.slicePosition);',
    '      const byPosition = 0;',
    'index: geometry stops deciding the slice order',
  ],
  [
    'src/main/dicom/build-index.ts',
    '      return undefined;\n    }\n    positions.set(',
    '      continue;\n    }\n    positions.set(',
    'index: a series missing one position gets ordered by two keys at once',
  ],
  [
    'src/main/dicom/build-index.ts',
    '  if (a === undefined) {\n    return 1;\n  }\n  if (b === undefined) {\n    return -1;\n  }',
    '  if (a === undefined) {\n    return -1;\n  }\n  if (b === undefined) {\n    return 1;\n  }',
    'index: a slice with no number is treated as the smallest, not the last',
  ],
  [
    'src/main/dicom/index-folder.ts',
    "      } else if (entry.isFile() && entry.name !== DIRECTORY_RECORD) {",
    '      } else if (entry.isFile()) {',
    'walk: the directory record is indexed as though it were a study',
  ],
  [
    'src/main/dicom/index-folder.ts',
    "        if (error instanceof NotDicomError) {\n          skipped++;",
    "        if (false) {\n          skipped++;",
    'walk: an autorun file is reported as a broken image',
  ],
  [
    'src/main/dicom/index-folder.ts',
    '      options.onProgress?.(++done, files.length);',
    "      if (++done < files.length) {\n        options.onProgress?.(done, files.length);\n      }",
    'walk: progress stops one short of the end',
  ],
  [
    'src/main/dicom/read-header.ts',
    '        if (buffer.toString(',
    '        if (false && buffer.toString(',
    'header: a text file is treated as a corrupt image instead of skipped',
  ],
  [
    'src/main/dicom/build-index.ts',
    '    if (seen.has(header.sopInstanceUid)) {',
    '    if (false) {',
    'index: the same image listed twice appears twice',
  ],
];

const originals = new Map();
for (const [file] of MUTATIONS) {
  if (!originals.has(file)) {
    originals.set(file, fs.readFileSync(path.join(root, file), 'utf8'));
  }
}

// Code left broken because something blew up halfway is worse than the defect
// being hunted. Put everything back on every exit path.
const restore = () => {
  for (const [file, text] of originals) {
    fs.writeFileSync(path.join(root, file), text, 'utf8');
  }
};
process.on('exit', restore);

let survivors = 0;

for (const [file, from, to, meaning] of MUTATIONS) {
  const target = path.join(root, file);
  const original = originals.get(file);

  if (!original.includes(from)) {
    console.log(`  STALE      ${meaning}  <- the anchor no longer exists`);
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

  restore();

  console.log(`  ${failed ? 'caught  ' : 'SURVIVED'} ${String(failed).padStart(2)} red   ${meaning}`);
  if (!failed) {
    survivors++;
  }
}

console.log(
  `\n${survivors} of ${MUTATIONS.length} mutations survived` +
    (survivors ? '  <- a test that does not notice is not protecting anything' : '')
);
process.exitCode = survivors ? 1 : 0;
