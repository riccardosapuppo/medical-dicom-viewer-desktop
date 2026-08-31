/**
 * Measuring on an image, checked against phantoms whose answer is known.
 *
 * A measurement that is plausible and wrong is worse than one that is obviously
 * broken, because it gets written into a report. So the fixtures here are
 * shapes with arithmetic answers: a disc of known density on a known
 * background, a gradient whose mean is calculable, a signed image whose air is
 * at minus a thousand.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Frame } from '../src/renderer/viewer/gl-image';
import {
  describeLength,
  describeStatistics,
  lengthOf,
  statisticsOf,
  unitFor,
  type Length,
  type Region,
} from '../src/renderer/viewer/measure';

const SIZE = 64;

function frame(fill: (x: number, y: number) => number, partial: Partial<Frame> = {}): Frame {
  const pixels = new Uint16Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Written as sixteen unsigned bits, which is how they arrive off the disk
      // whatever the file meant by them.
      pixels[y * SIZE + x] = fill(x, y) & 0xffff;
    }
  }

  return {
    pixels,
    columns: SIZE,
    rows: SIZE,
    signed: true,
    bitsAllocated: 16,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    invert: false,
    spacing: { x: 0.5, y: 0.5 },
    ...partial,
  };
}

const region = (from: { x: number; y: number }, to: { x: number; y: number }): Region => ({
  kind: 'region',
  id: 'r',
  at: 0,
  from,
  to,
});

const length = (from: { x: number; y: number }, to: { x: number; y: number }): Length => ({
  kind: 'length',
  id: 'l',
  at: 0,
  from,
  to,
});

test('a length is in millimetres, not in pixels', () => {
  const image = { columns: SIZE, rows: SIZE, spacing: { x: 0.5, y: 0.5 } };

  assert.equal(lengthOf(length({ x: 0, y: 0 }, { x: 40, y: 0 }), image), 20);
  assert.equal(lengthOf(length({ x: 10, y: 10 }, { x: 10, y: 30 }), image), 10);
});

test('a length uses the spacing of the direction it runs in', () => {
  const image = { columns: SIZE, rows: SIZE, spacing: { x: 1, y: 0.25 } };

  assert.equal(lengthOf(length({ x: 0, y: 0 }, { x: 20, y: 0 }), image), 20);
  assert.equal(lengthOf(length({ x: 0, y: 0 }, { x: 0, y: 20 }), image), 5);
});

test('a region of one value reports that value and no spread', () => {
  const flat = frame(() => 200);
  const stats = statisticsOf(region({ x: 10, y: 10 }, { x: 30, y: 30 }), flat);

  assert.ok(stats.count > 0);
  assert.equal(stats.mean, 200);
  assert.equal(stats.deviation, 0);
  assert.equal(stats.min, 200);
  assert.equal(stats.max, 200);
});

test('a flat region does not report a spread of not-a-number', () => {
  // The deviation is worked out as the mean of the squares minus the square of
  // the mean, which for a region where every pixel is the same should be zero
  // and in floating point is sometimes a hair below it. A square root of a
  // negative is NaN, and NaN on an image is a measurement nobody can explain.
  //
  // These are the values that actually do it: a rescale slope of a tenth, which
  // every scanner that stores tenths of a unit uses.
  for (const [slope, intercept] of [
    [0.1, 0],
    [0.1, -1024],
    [1 / 3, 0],
  ]) {
    const awkward = frame(() => 1, { rescaleSlope: slope, rescaleIntercept: intercept });
    const stats = statisticsOf(region({ x: 12, y: 12 }, { x: 32, y: 32 }), awkward);

    assert.ok(
      Number.isFinite(stats.deviation),
      `slope ${slope} intercept ${intercept} gave ${stats.deviation}`
    );
    // Not exactly zero: the guard stops a negative variance, and a tiny
    // positive one stays positive. What matters is that it is not NaN and not
    // a spread anybody would read as one.
    assert.ok(stats.deviation < 1e-6, `deviation ${stats.deviation}`);
  }
});

test('the rescale is applied, so a CT reports Hounsfield units', () => {
  // Stored 0 with an intercept of -1024 is air, not zero.
  const ct = frame(() => 0, { rescaleIntercept: -1024, rescaleSlope: 1 });
  const stats = statisticsOf(region({ x: 8, y: 8 }, { x: 24, y: 24 }), ct);

  assert.equal(stats.mean, -1024);
  assert.equal(stats.min, -1024);
});

test('a signed image is read as signed', () => {
  // Minus a thousand stored as two's complement in sixteen bits. Read as
  // unsigned it comes back as sixty-four and a half thousand, which is a
  // number no tissue has.
  const air = frame(() => -1000);
  const stats = statisticsOf(region({ x: 8, y: 8 }, { x: 24, y: 24 }), air);

  assert.equal(stats.mean, -1000);
});

test('an unsigned image is not turned negative', () => {
  const bright = frame(() => 60000, { signed: false });
  const stats = statisticsOf(region({ x: 8, y: 8 }, { x: 24, y: 24 }), bright);

  assert.equal(stats.mean, 60000);
});

test('the region is an ellipse, not the box it was dragged in', () => {
  // A disc of 300 in a sea of zero, and a region placed exactly on it. A
  // rectangular region would take in the corners and report far less.
  const centre = 32;
  const radius = 12;
  const disc = frame((x, y) => (Math.hypot(x + 0.5 - centre, y + 0.5 - centre) <= radius ? 300 : 0));

  const stats = statisticsOf(
    region({ x: centre - radius, y: centre - radius }, { x: centre + radius, y: centre + radius }),
    disc
  );

  assert.equal(stats.mean, 300, `the corners of the box leaked in: mean ${stats.mean}`);
  assert.equal(stats.min, 300);
});

test('the area is in square millimetres, from the pixels counted', () => {
  const flat = frame(() => 100);
  const stats = statisticsOf(region({ x: 12, y: 12 }, { x: 32, y: 32 }), flat);

  // A 20 by 20 pixel ellipse holds about pi/4 of 400 pixels, each 0.25 mm2.
  assert.ok(Math.abs(stats.count - (Math.PI / 4) * 400) < 20, `counted ${stats.count}`);
  assert.equal(stats.area, stats.count * 0.25);
});

test('the deviation is right on a known spread', () => {
  // Half the pixels at 100 and half at 200, so the mean is 150 and the
  // population deviation is 50.
  const striped = frame((_x, y) => (y % 2 === 0 ? 100 : 200));
  const stats = statisticsOf(region({ x: 8, y: 8 }, { x: 40, y: 40 }), striped);

  assert.ok(Math.abs(stats.mean - 150) < 2, `mean ${stats.mean}`);
  assert.ok(Math.abs(stats.deviation - 50) < 2, `deviation ${stats.deviation}`);
});

test('a region dragged off the edge measures the part that is over pixels', () => {
  // Rather than reading whatever is next in memory, which on a typed array is
  // zero and on a report is a density.
  const flat = frame(() => 500);
  const stats = statisticsOf(region({ x: -40, y: -40 }, { x: 20, y: 20 }), flat);

  assert.ok(stats.count > 0);
  assert.equal(stats.mean, 500);
  assert.equal(stats.min, 500);
});

test('a region of no size says so instead of dividing by zero', () => {
  const flat = frame(() => 100);

  for (const empty of [
    region({ x: 10, y: 10 }, { x: 10, y: 10 }),
    region({ x: 10, y: 10 }, { x: 30, y: 10 }),
    region({ x: 200, y: 200 }, { x: 220, y: 220 }),
  ]) {
    const stats = statisticsOf(empty, flat);
    assert.equal(stats.count, 0);
    assert.ok(Number.isFinite(stats.mean));
  }
});

test('a region drawn from the bottom right is the same region', () => {
  const flat = frame(() => 100);

  assert.deepEqual(
    statisticsOf(region({ x: 30, y: 30 }, { x: 10, y: 10 }), flat),
    statisticsOf(region({ x: 10, y: 10 }, { x: 30, y: 30 }), flat)
  );
});

test('lengths and regions are written the way they are read out', () => {
  assert.equal(describeLength(7.25), '7.3 mm');
  assert.equal(describeLength(43.6), '4.4 cm');

  const said = describeStatistics(
    { count: 100, mean: 45.2, deviation: 12.7, min: -30, max: 210, area: 314 },
    'HU'
  );
  assert.ok(said[0]?.includes('45.2'));
  assert.ok(said[0]?.includes('12.7'));
  assert.ok(said[0]?.endsWith('HU'));
  assert.equal(said[2], '3.14 cm2');
});

test('only a CT number has a unit everybody reads the same way', () => {
  // An MR number is a signal intensity whose scale depends on the sequence and
  // the coil. Calling it anything would be inventing a unit.
  assert.equal(unitFor('CT'), 'HU');
  assert.equal(unitFor('MR'), '');
  assert.equal(unitFor('US'), '');
});
