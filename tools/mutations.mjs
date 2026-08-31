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
    "src/main/layout/panes.ts",
    "    x: pane.workArea.x + 1,",
    "    x: pane.bounds.x + 1,",
    "panes: a window covers the taskbar when it is down the side",
  ],
  [
    "src/main/layout/panes.ts",
    "    y: pane.workArea.y + 1,",
    "    y: Math.max(0, pane.workArea.y + 1),",
    "panes: a screen above or left of the primary is clamped onto it",
  ],
  [
    "src/main/layout/panes.ts",
    "    width: Math.max(320, pane.workArea.width - 2),",
    "    width: pane.workArea.width - 2,",
    "panes: a tiny screen gets a window nobody can find",
  ],
  [
    "src/main/layout/store.ts",
    "  return pane !== undefined && pane < paneCount ? pane : undefined;",
    "  return pane;",
    "layout: a window is sent to a screen that is no longer there",
  ],
  [
    "src/main/layout/store.ts",
    "  const desk = layouts.desks[fingerprint] ?? { series: {} };",
    "  const desk = Object.values(layouts.desks)[0] ?? { series: {} };",
    "layout: every desk shares one arrangement",
  ],
  [
    "src/main/layout/store.ts",
    "        Number.isInteger(placement.pane) &&",
    "        true &&",
    "layout: a hand-edited entry sends a window to half a screen",
  ],
  [
    "src/main/layout/store.ts",
    "  return Object.fromEntries(sorted.slice(0, keep));",
    "  return Object.fromEntries(sorted);",
    "layout: the memory grows without limit",
  ],
  [
    "src/main/layout/store.ts",
    "    .filter(([, placement]) => placement.pane < paneCount)",
    "    .filter(() => true)",
    "layout: restoring reopens windows on screens that are gone",
  ],
  [
    "src/renderer/viewer/window-level.ts",
    "  return (value - (centre - 0.5)) / (usable - 1) + 0.5;",
    "  return (value - centre) / usable + 0.5;",
    "window: the half units the standard specifies are dropped",
  ],
  [
    "src/renderer/viewer/window-level.ts",
    "  const usable = Math.max(1, width);",
    "  const usable = width;",
    "window: a file with a width of zero divides by zero",
  ],
  [
    "src/renderer/viewer/window-level.ts",
    "    width: Math.max(1, from.width * Math.exp(dx / DRAG_SCALE)),",
    "    width: Math.max(1, from.width + dx),",
    "window: the drag stops scaling with the width it is on",
  ],
  [
    "src/renderer/viewer/window-level.ts",
    "  const lowValue = low * pixels.rescaleSlope + pixels.rescaleIntercept;",
    "  const lowValue = low;",
    "window: the fallback window ignores the rescale and sits a thousand units off",
  ],
  [
    "src/renderer/viewer/frames.ts",
    "      x: pixels.pixelSpacing?.[1] ?? 1,\n      y: pixels.pixelSpacing?.[0] ?? 1,",
    "      x: pixels.pixelSpacing?.[0] ?? 1,\n      y: pixels.pixelSpacing?.[1] ?? 1,",
    "frames: pixel spacing is read across-then-down and the image is transposed",
  ],
  [
    "src/renderer/viewer/frames.ts",
    "    invert: pixels.photometricInterpretation === 'MONOCHROME1',",
    "    invert: false,",
    "frames: MONOCHROME1 is shown as a negative",
  ],
  [
    "src/renderer/viewer/frames.ts",
    "    const already = this.#inFlight.get(at);",
    "    const already = undefined as undefined;",
    "frames: two requests for one slice become two reads of the file",
  ],
  [
    "src/renderer/viewer/frames.ts",
    "    while (this.#cache.size > this.#limit) {",
    "    while (false) {",
    "frames: the cache grows without limit",
  ],
  [
    "src/main/library/pixel-server.ts",
    "  return rows * columns * samplesPerPixel * Math.ceil(bitsAllocated / 8);",
    "  return rows * columns * Math.ceil(bitsAllocated / 8);",
    "pixels: a colour frame is a third of its real size",
  ],
  [
    "src/main/library/pixel-server.ts",
    "    const frameStart = pixels.dataOffset + (frame - 1) * frameBytes;",
    "    const frameStart = pixels.dataOffset;",
    "pixels: every frame of a cine loop is the first one",
  ],
  [
    "src/main/library/pixel-server.ts",
    "  if (start >= length || start > end) {",
    "  if (false) {",
    "pixels: a range past the end walks into the next frame",
  ],
  [
    "src/main/library/pixel-server.ts",
    "    this.#images = images;",
    "    for (const [key, value] of images) {\\n      this.#images.set(key, value);\\n    }",
    "pixels: a closed folder stays reachable",
  ],
  [
    'src/renderer/format.ts',
    '  return years >= 0 && years < 130 ?',
    '  return true ?',
    'format: an impossible age is printed rather than withheld',
  ],
  [
    'src/renderer/format.ts',
    '  return month ? ',
    '  return true ? ',
    'format: a month outside the calendar is given a name',
  ],
  [
    'src/renderer/format.ts',
    '  const separator = full.includes(BACKSLASH) ?',
    "  const separator = false ?",
    'format: a Windows path is shown with the wrong separator',
  ],
  [
    'src/main/dicom/index-folder.ts',
    "  if (code === 'ENOENT') {",
    '  if (false) {',
    'walk: a missing folder falls back to the raw syscall error',
  ],
  [
    'src/renderer/DeskMap.tsx',
    '  const left = Math.min(...panes.map(p => p.bounds.x));',
    '  const left = 0;',
    'map: a screen left of the primary is drawn off the canvas',
  ],
  [
    'src/renderer/DeskMap.tsx',
    '              height={pane.workArea.height}',
    '              height={pane.bounds.height}',
    'map: the work area is drawn as the full screen',
  ],
  [
    'src/renderer/DeskMap.tsx',
    "className={pane.isPrimary ? 'pane pane--primary' : 'pane'}",
    "className={'pane'}",
    'map: nothing marks which screen is primary',
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
