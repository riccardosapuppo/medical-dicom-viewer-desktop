/**
 * Getting frames to the screen without stuttering.
 *
 * The bookkeeping here — do not fetch the same slice twice, keep a bounded
 * number, ask ahead in the direction of travel, stop everything when the series
 * closes — is invisible when it works and shows up as a viewer that stalls,
 * grows without limit, or keeps reading a folder the user has closed.
 *
 * `fetch` is replaced so the counting is exact.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { Series } from '../src/main/dicom/build-index';
import type { PixelLayout } from '../src/main/dicom/read-header';
import { FrameSource, slidesOf } from '../src/renderer/viewer/frames';

const ROWS = 4;
const COLUMNS = 4;

function layout(partial: Partial<PixelLayout> = {}): PixelLayout {
  return {
    rows: ROWS,
    columns: COLUMNS,
    numberOfFrames: 1,
    bitsAllocated: 16,
    bitsStored: 16,
    highBit: 15,
    signed: true,
    samplesPerPixel: 1,
    photometricInterpretation: 'MONOCHROME2',
    planarConfiguration: undefined,
    pixelSpacing: [0.5, 0.75],
    spacingIsFromDetector: false,
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

function series(count: number, frames = 1, pixels = layout()): Series {
  return {
    seriesInstanceUid: 'S1',
    seriesNumber: 1,
    description: 'AXIAL',
    modality: 'CT',
    orderedByGeometry: true,
    instances: Array.from({ length: count }, (_, i) => ({
      sopInstanceUid: `1.2.3.${i + 1}`,
      instanceNumber: i + 1,
      filePath: `/studies/image-${i + 1}.dcm`,
      fileSize: 1000,
      slicePosition: i,
      pixels: { ...pixels, numberOfFrames: frames },
    })),
  };
}

let asked: string[] = [];
let realFetch: typeof globalThis.fetch;
/** Set to make every request hang, so an abort has something to abort. */
let hang = false;

beforeEach(() => {
  asked = [];
  hang = false;
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(String(input));
    if (hang) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return Promise.resolve(new Response(new Uint8Array(ROWS * COLUMNS * 2)));
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('a multi-frame instance becomes as many images as it holds', () => {
  // A cine loop is one file and forty images. Scrolling is over images, so the
  // two are flattened and nothing downstream has to know the difference.
  const slides = slidesOf(series(2, 3));

  assert.equal(slides.length, 6);
  assert.deepEqual(
    slides.map(s => `${s.sopInstanceUid}#${s.frame}`),
    ['1.2.3.1#1', '1.2.3.1#2', '1.2.3.1#3', '1.2.3.2#1', '1.2.3.2#2', '1.2.3.2#3']
  );
});

test('an instance that says it has no frames still counts as one image', () => {
  assert.equal(slidesOf(series(2, 0)).length, 2);
});

test('the same slice is never fetched twice at once', async () => {
  const source = new FrameSource(slidesOf(series(4)));

  const [a, b] = await Promise.all([source.get(0), source.get(0)]);

  assert.equal(asked.length, 1, 'the scroll and the prefetch behind it read the file twice');
  assert.equal(a, b);
});

test('a slice already read is not read again', async () => {
  const source = new FrameSource(slidesOf(series(4)));

  await source.get(2);
  await source.get(2);

  assert.equal(asked.length, 1);
});

test('the header travels with the pixels', async () => {
  const source = new FrameSource(
    slidesOf(series(1, 1, layout({ photometricInterpretation: 'MONOCHROME1' })))
  );

  const frame = await source.get(0);

  assert.equal(frame.rows, ROWS);
  assert.equal(frame.columns, COLUMNS);
  assert.equal(frame.rescaleIntercept, -1024);
  assert.equal(frame.signed, true);
  assert.equal(frame.invert, true, 'MONOCHROME1 shows a negative unless it is inverted');
  // Pixel spacing is [down, across]. Reading it the other way round draws the
  // image transposed, and does it plausibly enough that nobody notices.
  assert.deepEqual(frame.spacing, { x: 0.75, y: 0.5 });
  assert.equal(frame.pixels.length, ROWS * COLUMNS, 'sixteen-bit pixels came back as bytes');
});

test('an eight-bit image comes back as bytes, not as half as many shorts', async () => {
  const source = new FrameSource(slidesOf(series(1, 1, layout({ bitsAllocated: 8 }))));

  assert.ok((await source.get(0)).pixels instanceof Uint8Array);
});

test('only a bounded number of frames is kept', async () => {
  // Unbounded is a study that grows until the page is killed.
  const source = new FrameSource(slidesOf(series(20)), 5);

  for (let i = 0; i < 20; i++) {
    await source.get(i);
  }

  assert.ok(source.ready(19) !== undefined, 'the newest should still be there');
  assert.equal(source.ready(0), undefined, 'the oldest should have gone');

  await source.get(0);
  assert.equal(asked.length, 21, 'the evicted slice was not refetched');
});

test('the frame being looked at survives an eviction sweep', async () => {
  // Scrolling down and back up must not evict the image on screen. Reading a
  // frame moves it to the back of the queue.
  const source = new FrameSource(slidesOf(series(20)), 4);

  await source.get(0);
  for (let i = 1; i <= 3; i++) {
    source.ready(0);
    await source.get(i);
  }

  // One more than the cache holds, so something has to go. Without this the
  // cache was never full and the test passed with the recency bookkeeping
  // deleted - which is the whole of what it claims to check.
  source.ready(0);
  await source.get(4);

  assert.ok(source.ready(0) !== undefined, 'the frame in use was evicted while in use');
  assert.equal(source.ready(1), undefined, 'nothing was evicted, so nothing was proved');
});

test('prefetching asks ahead, in the direction of travel', async () => {
  const source = new FrameSource(slidesOf(series(40)));

  await source.get(20);
  asked.length = 0;
  source.prefetch(20, 1, 4);
  await new Promise(resolve => setImmediate(resolve));

  const positions = asked.map(url => Number(/\.(\d+)\/frames/.exec(url)?.[1]) - 1);
  const forwards = positions.filter(p => p > 20).length;
  const backwards = positions.filter(p => p < 20).length;

  assert.ok(forwards >= 4, `asked for only ${forwards} ahead`);
  assert.ok(forwards > backwards, 'a symmetric prefetch spends half its work behind the reader');
});

test('prefetching does not run off either end of the series', async () => {
  const source = new FrameSource(slidesOf(series(3)));

  source.prefetch(0, -1, 6);
  source.prefetch(2, 1, 6);
  await new Promise(resolve => setImmediate(resolve));

  const positions = asked.map(url => Number(/\.(\d+)\/frames/.exec(url)?.[1]));
  assert.ok(
    positions.every(p => p >= 1 && p <= 3),
    `asked for ${positions.join(', ')}`
  );
});

test('a refused frame is reported with what the server said', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response('The pixels are compressed (1.2.840.10008.1.2.4.90).', { status: 415 })
    )) as typeof globalThis.fetch;

  const source = new FrameSource(slidesOf(series(1)));

  await assert.rejects(
    () => source.get(0),
    (error: Error) => /415/.test(error.message) && /compressed/.test(error.message)
  );
});

test('a failed prefetch is not an unhandled rejection', async () => {
  // Nobody asked about it, and the same failure will be reported properly if
  // the reader ever reaches that slice.
  globalThis.fetch = (() =>
    Promise.resolve(new Response('gone', { status: 404 }))) as typeof globalThis.fetch;

  const source = new FrameSource(slidesOf(series(10)));
  source.prefetch(5, 1, 3);

  await new Promise(resolve => setTimeout(resolve, 20));
});

test('closing a series stops what is still in flight', async () => {
  // Forty outstanding prefetches into a cache nobody will read is forty frames
  // of pixels held until the collector gets to them.
  hang = true;
  const source = new FrameSource(slidesOf(series(10)));

  const pending = source.get(0);
  source.dispose();

  await assert.rejects(() => pending);
});

test('asking for an image the series does not have says so', async () => {
  const source = new FrameSource(slidesOf(series(3)));

  await assert.rejects(() => source.get(7), /no image 8 in this series/);
});
