/**
 * The arithmetic that turns a stored number into a grey.
 *
 * Worth checking against the standard rather than against a screenshot: the
 * linear VOI function in PS3.3 C.11.2.1.2 has half-unit offsets in it that look
 * like rounding noise and are not. On a bone window fifteen hundred units wide
 * dropping them is invisible; on a brain window eighty units wide it is most of
 * a grey level.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PixelLayout } from '../src/main/dicom/read-header';
import {
  defaultWindow,
  describeWindow,
  dragWindow,
  presetName,
  toGrey,
  toValue,
} from '../src/renderer/viewer/window-level';

function layout(partial: Partial<PixelLayout> = {}): PixelLayout {
  return {
    rows: 512,
    columns: 512,
    numberOfFrames: 1,
    bitsAllocated: 16,
    bitsStored: 16,
    highBit: 15,
    signed: true,
    samplesPerPixel: 1,
    photometricInterpretation: 'MONOCHROME2',
    planarConfiguration: undefined,
    pixelSpacing: undefined,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    windowCenter: undefined,
    windowWidth: undefined,
    transferSyntaxUid: '1.2.840.10008.1.2.1',
    encapsulated: false,
    dataOffset: 100,
    dataLength: 524288,
    complete: true,
    ...partial,
  };
}

test('the formula is the one in the standard, to the digit', () => {
  // Written as an exact expectation rather than "about a half", because about
  // a half is exactly what a version with the half units dropped also gives.
  // The offsets in PS3.3 C.11.2.1.2 move the centre by 1/798 on a 400 wide
  // window, which no sensible tolerance would notice — and by a hundredth on a
  // brain window, which a radiologist would.
  assert.equal(toGrey(40, { centre: 40, width: 400 }), 0.5 + 0.5 / 399);
  assert.equal(toGrey(0, { centre: 40, width: 400 }), (0 - 39.5) / 399 + 0.5);
  assert.equal(toGrey(40, { centre: 40, width: 80 }), 0.5 + 0.5 / 79);
});

test('the centre of the window is close enough to mid grey to look right', () => {
  assert.ok(Math.abs(toGrey(40, { centre: 40, width: 400 }) - 0.5) < 0.01);
});

test('everything below the window is black and everything above is white', () => {
  const w = { centre: 40, width: 400 };

  assert.equal(toGrey(-1000, w), 0);
  assert.equal(toGrey(-160, w), 0, 'the bottom edge of a 400 wide window centred on 40');
  assert.equal(toGrey(3000, w), 1);
  assert.equal(toGrey(240, w), 1, 'the top edge');
});

test('the grey rises steadily across the window', () => {
  const w = { centre: 0, width: 100 };
  const greys = [-40, -20, 0, 20, 40].map(v => toGrey(v, w));

  for (let i = 1; i < greys.length; i++) {
    assert.ok((greys[i] as number) > (greys[i - 1] as number), 'grey went backwards');
  }
  assert.ok(Math.abs((greys[1] as number) - 0.3) < 0.02);
  assert.ok(Math.abs((greys[3] as number) - 0.7) < 0.02);
});

test('a width of zero behaves exactly like a width of one', () => {
  // Files with Window Width 0 exist, and the formula divides by width - 1.
  // Checking only that the result is finite is not enough: a version with no
  // floor at all returns finite numbers too, from a divisor of minus one, and
  // puts the step in the wrong place. The floor has to make zero mean one.
  for (const value of [39, 39.5, 39.8, 40, 40.5, 41]) {
    assert.equal(
      toGrey(value, { centre: 40, width: 0 }),
      toGrey(value, { centre: 40, width: 1 }),
      `a width of zero and a width of one disagreed at ${value}`
    );
  }

  assert.ok(Number.isFinite(toGrey(40, { centre: 40, width: 0 })));
});

test("the file's own window is used when it has one", () => {
  const window = defaultWindow(layout({ windowCenter: -600, windowWidth: 1500 }));

  assert.deepEqual(window, { centre: -600, width: 1500 });
});

test('a file with no window gets one that shows everything', () => {
  // An image that comes up black because the default window missed it looks
  // like a broken viewer, so the fallback covers the whole stored range.
  const window = defaultWindow(layout({ bitsStored: 16, signed: true }));

  assert.equal(window.centre, -0.5);
  assert.equal(window.width, 65535);
  // And the extremes of that range are not clipped away.
  assert.ok(toGrey(-32768, window) < 0.01);
  assert.ok(toGrey(32767, window) > 0.99);
});

test('the fallback window follows the rescale, not the raw bits', () => {
  // A file storing 0..4095 with an intercept of -1024 measures -1024..3071.
  // A window computed on the stored numbers would sit a thousand units off.
  const window = defaultWindow(
    layout({ bitsStored: 12, signed: false, rescaleIntercept: -1024, rescaleSlope: 1 })
  );

  assert.equal(window.centre, (-1024 + 3071) / 2);
  assert.equal(window.width, 4095);
});

test('a window width of zero in the file is not trusted', () => {
  const window = defaultWindow(layout({ windowCenter: 40, windowWidth: 0 }));

  assert.ok(window.width > 1, 'a width of zero would make every pixel the same grey');
});

test('stored numbers become the thing they measure', () => {
  const pixels = layout({ rescaleSlope: 2, rescaleIntercept: -1024 });

  assert.equal(toValue(0, pixels), -1024);
  assert.equal(toValue(512, pixels), 0);
});

test('dragging widens sideways and brightens upwards', () => {
  const from = { centre: 40, width: 400 };

  assert.ok(dragWindow(from, 50, 0).width > from.width, 'right should widen');
  assert.ok(dragWindow(from, -50, 0).width < from.width, 'left should narrow');
  assert.ok(dragWindow(from, 0, -50).centre > from.centre, 'up should raise the level');
  assert.ok(dragWindow(from, 0, 50).centre < from.centre, 'down should lower it');
});

test('the drag has the same feel on a narrow window as on a wide one', () => {
  // A fixed step would move a brain window eighty units across from one end to
  // the other in a few pixels, and barely touch a bone window.
  const narrow = dragWindow({ centre: 40, width: 80 }, 100, 0);
  const wide = dragWindow({ centre: 300, width: 1500 }, 100, 0);

  assert.ok(Math.abs(narrow.width / 80 - wide.width / 1500) < 0.05, 'the two drags scaled differently');
});

test('a drag can never produce a window narrower than one unit', () => {
  const collapsed = dragWindow({ centre: 40, width: 10 }, -100000, 0);

  assert.ok(collapsed.width >= 1);
  assert.ok(Number.isFinite(toGrey(40, collapsed)));
});

test('a window is written the way a radiologist writes it', () => {
  assert.equal(describeWindow({ centre: 40, width: 400 }), 'W 400 L 40');
  assert.equal(describeWindow({ centre: -600.4, width: 1500.2 }), 'W 1500 L -600');
});

test('a window that is a preset is named, and one that is not is not', () => {
  assert.equal(presetName({ centre: -600, width: 1500 }), 'Lung');
  assert.equal(presetName({ centre: 40, width: 400 }), 'Soft tissue');
  assert.equal(presetName({ centre: 41, width: 400 }), undefined);
});
