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
    '        if (length >= size) {',
    '        if (true) {',
    'header: the reader gives up instead of reading more',
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
    "      } else if (entry.isFile() && entry.name.toLowerCase() !== DIRECTORY_RECORD) {",
    "      } else if (entry.isFile() && entry.name !== DIRECTORY_RECORD) {",
    'walk: a lowercase directory record is indexed as a phantom study',
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
    "src/main/dicom/read-header.ts",
    "        if (dataSet.elements[PIXEL_DATA] === undefined && length < size && length < MAX_HEADER) {",
    "        if (false) {",
    "header: a header cut on an element boundary is read short in silence",
  ],
  [
    "src/renderer/viewer/transform.ts",
    "  const fit = Math.min(canvas.width / millimetresAcross, canvas.height / millimetresDown);",
    "  const fit = Math.max(canvas.width / millimetresAcross, canvas.height / millimetresDown);",
    "transform: the image overflows the canvas instead of fitting it",
  ],
  [
    "src/renderer/viewer/transform.ts",
    "  const millimetresAcross = image.columns * image.spacing.x;",
    "  const millimetresAcross = image.columns;",
    "transform: non-square pixels are drawn as square",
  ],
  [
    "src/renderer/viewer/transform.ts",
    "    x: ((point.x - placed.centreX) / placed.width + 0.5) * image.columns,",
    "    x: (point.x - placed.centreX) / placed.width * image.columns,",
    "transform: canvas to image is off by half the image",
  ],
  [
    "src/renderer/viewer/transform.ts",
    "  return Math.hypot((b.x - a.x) * image.spacing.x, (b.y - a.y) * image.spacing.y);",
    "  return Math.hypot(b.x - a.x, b.y - a.y) * image.spacing.x;",
    "transform: one spacing is used for both directions",
  ],
  [
    "src/renderer/viewer/measure.ts",
    "      if (dx * dx + dy * dy > 1) {",
    "      if (false) {",
    "measure: the region is the box, not the ellipse in it",
  ],
  [
    "src/renderer/viewer/measure.ts",
    "      const dx = (x + 0.5 - centreX) / radiusX;",
    "      const dx = (x - centreX) / radiusX;",
    "measure: the region is shifted by half a pixel",
  ],
  [
    "src/renderer/viewer/measure.ts",
    "  const stored = frame.signed && raw > span / 2 - 1 ? raw - span : raw;",
    "  const stored = raw;",
    "measure: a CT reports air at sixty-four thousand",
  ],
  [
    "src/renderer/viewer/measure.ts",
    "  return stored * frame.rescaleSlope + frame.rescaleIntercept;",
    "  return stored;",
    "measure: the rescale is skipped and the numbers are not Hounsfield units",
  ],
  [
    "src/renderer/viewer/measure.ts",
    "  const variance = Math.max(0, totalOfSquares / count - mean * mean);",
    "  const variance = totalOfSquares / count - mean * mean;",
    "measure: a flat region reports a deviation of NaN",
  ],
  [
    "src/renderer/viewer/measure.ts",
    "    area: count * frame.spacing.x * frame.spacing.y,",
    "    area: count,",
    "measure: the area is in pixels rather than square millimetres",
  ],
  [
    "src/main/dicom/build-index.ts",
    "    if (!header.sopInstanceUid) {",
    "    if (false) {",
    "index: images with no UID are all counted as copies of one another",
  ],
  [
    "src/main/dicom/index-folder.ts",
    "        inOrder[i] = await readHeader(filePath);",
    "        inOrder[inOrder.length] = await readHeader(filePath);",
    "walk: the index depends on which reader finishes first",
  ],
  [
    "src/main/dicom/index-folder.ts",
    "      if (signal?.aborted) {\n        return;\n      }",
    "      if (false) {\n        return;\n      }",
    "walk: a cancel cannot stop the directory walk",
  ],
  [
    "src/main/library/pixel-server.ts",
    "    const usable = Math.min(pixels.numberOfFrames, available);",
    "    const usable = pixels.numberOfFrames;",
    "pixels: a frame past the data that is there is answered with a body that cannot fill",
  ],
  [
    "src/main/library/pixel-server.ts",
    "    if (!frameBytes) {",
    "    if (frameBytes === undefined) {",
    "pixels: a frame of no size is served for ever",
  ],
  [
    "src/main/library/pixel-server.ts",
    "      name = decodeURIComponent(uid);",
    "      name = decodeURIComponent(uid) + String(0);",
    "pixels: a mangled UID is looked up as something else",
  ],
  [
    "src/main/library/indexing.ts",
    "          if (controller.signal.aborted) {\n            return;\n          }",
    "          if (false) {\n            return;\n          }",
    "indexer: progress from an abandoned folder is sent anyway",
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
    "    for (const [key, value] of images) {\n      this.#images.set(key, value);\n    }",
    "pixels: a closed folder stays reachable",
  ],
  [
    "src/renderer/Library.tsx",
    "    if (reading.unreadable.length > 0) {",
    "    if (false) {",
    "worklist: a folder of broken images reports that it was empty",
  ],
  [
    "src/renderer/format.ts",
    "  return `${patient.patientId}|${patient.name}`;",
    "  return patient.patientId;",
    "worklist: two unidentified patients are listed under one key",
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
// 'exit' does not run for a signal, so Ctrl-C in the middle of a run would
// otherwise leave a mutated file in the working tree for somebody to find
// later and puzzle over.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

/**
 * Runs the suite and says what happened.
 *
 * "broken" is not the same as "failed": a build that will not compile produces
 * no count at all, and treating that as a failing test is how a mutation that
 * never ran gets recorded as caught.
 */
function runTests() {
  let out;
  try {
    out = execSync('npm test', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }

  const counted = /^\S* fail (\d+)$/m.exec(out);
  return counted ? { failed: Number(counted[1]), broken: false } : { failed: 0, broken: true };
}

// A suite that is already failing makes every mutation look caught, and the
// report comes out perfect while proving nothing at all.
const baseline = runTests();
if (baseline.broken) {
  console.error('The tests do not build. Fix that first: nothing below would mean anything.');
  process.exit(2);
}
if (baseline.failed > 0) {
  console.error(
    `${baseline.failed} test${baseline.failed === 1 ? '' : 's'} already failing. ` +
      'Fix them first: against a red suite every mutation looks caught.'
  );
  process.exit(2);
}

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

  const outcome = runTests();
  restore();

  // A mutation that stops the code compiling proves nothing: the suite never
  // ran, and counting it as caught is how a harness comes out perfect while
  // testing nothing. One of these entries really did inject a stray escape
  // into the source and score itself a pass.
  if (outcome.broken) {
    console.log(`  BROKEN     ${meaning}  <- the mutation does not compile`);
    survivors++;
    continue;
  }

  console.log(
    `  ${outcome.failed ? 'caught  ' : 'SURVIVED'} ${String(outcome.failed).padStart(2)} red   ${meaning}`
  );
  if (!outcome.failed) {
    survivors++;
  }
}

console.log(
  `\n${survivors} of ${MUTATIONS.length} mutations survived` +
    (survivors ? '  <- a test that does not notice is not protecting anything' : '')
);
process.exitCode = survivors ? 1 : 0;
