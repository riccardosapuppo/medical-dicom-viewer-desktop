/**
 * Cutting a stack along the other two planes.
 *
 * The volume in most of these is a solid whose every voxel says where it came
 * from: the value at (x, y, z) is x + 100y + 10000z. A reformat that takes the
 * wrong voxel is then obvious rather than plausible, which matters because a
 * reformat that is subtly wrong looks exactly like anatomy.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PixelLayout } from '../src/main/dicom/read-header';
import type { Slide } from '../src/renderer/viewer/frames';
import type { Frame } from '../src/renderer/viewer/gl-image';
import { buildVolume, planeDepth, reformattable, sliceFrom } from '../src/renderer/viewer/volume';

const COLUMNS = 4;
const ROWS = 3;
const DEPTH = 5;

function layout(partial: Partial<PixelLayout> = {}): PixelLayout {
  return {
    rows: ROWS,
    columns: COLUMNS,
    numberOfFrames: 1,
    bitsAllocated: 16,
    bitsStored: 16,
    highBit: 15,
    signed: false,
    samplesPerPixel: 1,
    photometricInterpretation: 'MONOCHROME2',
    planarConfiguration: undefined,
    pixelSpacing: [0.5, 0.75],
    rescaleSlope: 1,
    rescaleIntercept: -1024,
    windowCenter: 40,
    windowWidth: 400,
    transferSyntaxUid: '1.2.840.10008.1.2.1',
    encapsulated: false,
    dataOffset: 100,
    dataLength: ROWS * COLUMNS * 2,
    complete: true,
    ...partial,
  };
}

/** A stack of `count` slices, `gap` millimetres apart. */
function slides(count = DEPTH, gap = 2, partial: Partial<PixelLayout> = {}): Slide[] {
  return Array.from({ length: count }, (_, i) => ({
    sopInstanceUid: `1.2.3.${i + 1}`,
    frame: 1,
    pixels: layout(partial),
    position: i * gap,
  }));
}

/** Slice z of the marked volume: every voxel says where it came from. */
function marked(z: number): Frame {
  const pixels = new Uint16Array(ROWS * COLUMNS);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLUMNS; x++) {
      pixels[y * COLUMNS + x] = x + 100 * y + 10000 * z;
    }
  }
  return {
    pixels,
    columns: COLUMNS,
    rows: ROWS,
    signed: false,
    bitsAllocated: 16,
    rescaleSlope: 1,
    rescaleIntercept: -1024,
    invert: false,
    spacing: { x: 0.75, y: 0.5 },
  };
}

function markedVolume() {
  const answer = reformattable(slides());
  // Not assert.equal first: node:assert/strict narrows on the way through, and
  // the branch that reads the reason becomes unreachable to the type checker.
  if (!answer.ok) {
    throw new Error(answer.reason);
  }
  return buildVolume(answer.shape, Array.from({ length: DEPTH }, (_, z) => marked(z)));
}

test('a stack of parallel, evenly spaced images can be cut', () => {
  const answer = reformattable(slides());

  assert.equal(answer.ok, true);
  if (answer.ok) {
    assert.equal(answer.shape.depth, DEPTH);
    // Down first, across second in the file; the gap between slices is the
    // third and it cannot be taken from SliceThickness.
    assert.deepEqual(answer.shape.spacing, { x: 0.75, y: 0.5, z: 2 });
  }
});

test('two images are not a stack', () => {
  const answer = reformattable(slides(2));

  assert.equal(answer.ok, false);
  assert.match(answer.ok ? '' : answer.reason, /not a stack/);
});

test('a series of mixed sizes is refused, not stretched', () => {
  // A localiser holds three orthogonal images in one series, and a study
  // reconstructed twice can hold two matrix sizes.
  const mixed = slides();
  mixed[2] = { ...(mixed[2] as Slide), pixels: layout({ columns: 8 }) };

  const answer = reformattable(mixed);

  assert.equal(answer.ok, false);
  assert.match(answer.ok ? '' : answer.reason, /not all the same size/);
});

test('a series with no positions is refused rather than stacked at a guess', () => {
  // Without a position per slice there is no way to know how far apart they
  // are, and an invented spacing shows a body the wrong length.
  const unpositioned = slides().map(s => ({ ...s, position: undefined }));

  const answer = reformattable(unpositioned);

  assert.equal(answer.ok, false);
  assert.match(answer.ok ? '' : answer.reason, /where they sit/);
});

test('an unevenly spaced series is refused', () => {
  // A study reconstructed in two blocks, with a gap in the middle. Reformatted
  // as though it were even, the gap disappears and the body comes out short.
  const uneven = slides();
  uneven[3] = { ...(uneven[3] as Slide), position: 20 };
  uneven[4] = { ...(uneven[4] as Slide), position: 22 };

  const answer = reformattable(uneven);

  assert.equal(answer.ok, false);
  assert.match(answer.ok ? '' : answer.reason, /not evenly spaced/);
});

test('spacing that varies by a hair is still even', () => {
  // Positions are decimal strings in the file and the projection onto the
  // normal is floating point, so exactly equal gaps come out slightly unequal.
  const jittered = slides().map((s, i) => ({ ...s, position: i * 2 + (i % 2) * 0.001 }));

  assert.equal(reformattable(jittered).ok, true);
});

test('a stack where every image is at the same place is refused', () => {
  const flat = slides().map(s => ({ ...s, position: 0 }));

  const answer = reformattable(flat);

  assert.equal(answer.ok, false);
  assert.match(answer.ok ? '' : answer.reason, /same position/);
});

test('a series too large to hold in memory is refused with the size', () => {
  const huge = slides(3000, 1, { rows: 512, columns: 512 });

  const answer = reformattable(huge);

  assert.equal(answer.ok, false);
  assert.match(answer.ok ? '' : answer.reason, /MB of memory/);
});

test('an axial cut is the slice that was put in, untouched', () => {
  const volume = markedVolume();

  for (const z of [0, 2, DEPTH - 1]) {
    const cut = sliceFrom(volume, 'axial', z);
    assert.equal(cut.columns, COLUMNS);
    assert.equal(cut.rows, ROWS);
    assert.deepEqual([...cut.pixels], [...marked(z).pixels]);
  }
});

test('a coronal cut takes one row from every slice', () => {
  // Wide as the image, tall as the stack. Every voxel of the fixture says where
  // it came from, so taking the wrong one is obvious rather than plausible.
  const volume = markedVolume();
  const y = 1;
  const cut = sliceFrom(volume, 'coronal', y);

  assert.equal(cut.columns, COLUMNS);
  assert.equal(cut.rows, DEPTH);

  for (let row = 0; row < DEPTH; row++) {
    for (let x = 0; x < COLUMNS; x++) {
      // Read from the top down, so the most superior slice is at the top.
      const z = DEPTH - 1 - row;
      assert.equal(
        cut.pixels[row * COLUMNS + x],
        x + 100 * y + 10000 * z,
        `coronal (${x}, ${row}) came from the wrong voxel`
      );
    }
  }
});

test('a sagittal cut takes one column from every slice', () => {
  const volume = markedVolume();
  const x = 2;
  const cut = sliceFrom(volume, 'sagittal', x);

  assert.equal(cut.columns, ROWS);
  assert.equal(cut.rows, DEPTH);

  for (let row = 0; row < DEPTH; row++) {
    for (let y = 0; y < ROWS; y++) {
      const z = DEPTH - 1 - row;
      assert.equal(
        cut.pixels[row * ROWS + y],
        x + 100 * y + 10000 * z,
        `sagittal (${y}, ${row}) came from the wrong voxel`
      );
    }
  }
});

test('a reformatted cut carries the spacing of the two axes it runs along', () => {
  // The vertical axis of both reformats is the distance between slices, which
  // is usually several times the spacing inside a slice. Assuming square pixels
  // here shows a body stretched by that ratio — on a five millimetre study, a
  // factor of seven.
  const volume = markedVolume();

  assert.deepEqual(sliceFrom(volume, 'axial', 0).spacing, { x: 0.75, y: 0.5 });
  assert.deepEqual(sliceFrom(volume, 'coronal', 0).spacing, { x: 0.75, y: 2 });
  assert.deepEqual(sliceFrom(volume, 'sagittal', 0).spacing, { x: 0.5, y: 2 });
});

test('every plane can be cut as many times as it has voxels across it', () => {
  const volume = markedVolume();

  assert.equal(planeDepth(volume, 'axial'), DEPTH);
  assert.equal(planeDepth(volume, 'coronal'), ROWS);
  assert.equal(planeDepth(volume, 'sagittal'), COLUMNS);
});

test('a cut outside the volume is clamped rather than reading past the end', () => {
  const volume = markedVolume();

  for (const plane of ['axial', 'coronal', 'sagittal'] as const) {
    for (const index of [-5, 9999]) {
      const cut = sliceFrom(volume, plane, index);
      assert.equal(cut.pixels.length, cut.columns * cut.rows);
      assert.ok([...cut.pixels].every(v => Number.isFinite(v)));
    }
  }
});

test('what a stored number means travels with every cut', () => {
  // The rescale and the sign belong to the values, not to the plane they are
  // read out along. A coronal cut that lost the intercept would report air at
  // zero instead of at minus a thousand.
  const volume = markedVolume();

  for (const plane of ['axial', 'coronal', 'sagittal'] as const) {
    const cut = sliceFrom(volume, plane, 1);
    assert.equal(cut.rescaleIntercept, -1024);
    assert.equal(cut.rescaleSlope, 1);
    assert.equal(cut.signed, false);
    assert.equal(cut.bitsAllocated, 16);
  }
});
