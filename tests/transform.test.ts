/**
 * Where the image sits on the canvas.
 *
 * The reason this is one module with tests rather than arithmetic inlined twice
 * is that the image is placed by the graphics card and the measurements are
 * drawn over it by a 2D context. Two answers to the same question agree until
 * one of them is changed, and a measurement a few pixels off the thing it
 * measures is the kind of wrong that gets believed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canvasToImage,
  distanceInMillimetres,
  imageToCanvas,
  place,
  type ImageSize,
} from '../src/renderer/viewer/transform';

const SQUARE: ImageSize = { columns: 512, rows: 512, spacing: { x: 0.5, y: 0.5 } };
const WIDE: ImageSize = { columns: 512, rows: 512, spacing: { x: 1, y: 0.5 } };
const CANVAS = { width: 1000, height: 800 };
const STILL = { zoom: 1, panX: 0, panY: 0 };

test('at rest the image fits the canvas and is centred', () => {
  const placed = place(CANVAS, SQUARE, STILL);

  assert.equal(placed.height, 800, 'the short side of the canvas should be filled');
  assert.equal(placed.width, 800, 'a square image should stay square');
  assert.deepEqual({ x: placed.centreX, y: placed.centreY }, { x: 500, y: 400 });
});

test('non-square pixels make a non-square image', () => {
  // A scanner whose pixels are twice as wide as they are tall. Ignoring that
  // draws a circle as an ellipse, and measures it as one.
  const placed = place(CANVAS, WIDE, STILL);

  assert.equal(placed.width / placed.height, 2);
});

test('zoom and pan move the image, not the fit', () => {
  const placed = place(CANVAS, SQUARE, { zoom: 2, panX: 40, panY: -25 });

  assert.equal(placed.width, 1600);
  assert.equal(placed.centreX, 540);
  assert.equal(placed.centreY, 375);
});

test('the centre of the image is the centre of the canvas', () => {
  const middle = imageToCanvas({ x: 256, y: 256 }, CANVAS, SQUARE, STILL);

  assert.deepEqual(middle, { x: 500, y: 400 });
});

test('the corners of the image land on the corners of the drawn rectangle', () => {
  const topLeft = imageToCanvas({ x: 0, y: 0 }, CANVAS, SQUARE, STILL);
  const bottomRight = imageToCanvas({ x: 512, y: 512 }, CANVAS, SQUARE, STILL);

  assert.deepEqual(topLeft, { x: 100, y: 0 });
  assert.deepEqual(bottomRight, { x: 900, y: 800 });
});

test('a point survives the round trip, at any zoom and pan', () => {
  // This is the property the whole module exists for: the card and the overlay
  // must agree about where a pixel is.
  for (const view of [
    STILL,
    { zoom: 3.7, panX: 0, panY: 0 },
    { zoom: 0.4, panX: -180, panY: 95 },
    { zoom: 12, panX: 640, panY: -400 },
  ]) {
    for (const point of [
      { x: 0, y: 0 },
      { x: 511, y: 0 },
      { x: 137.25, y: 402.5 },
      { x: 512, y: 512 },
    ]) {
      const back = canvasToImage(imageToCanvas(point, CANVAS, SQUARE, view), CANVAS, SQUARE, view);

      assert.ok(
        Math.abs(back.x - point.x) < 1e-9 && Math.abs(back.y - point.y) < 1e-9,
        `${JSON.stringify(point)} came back as ${JSON.stringify(back)} at zoom ${view.zoom}`
      );
    }
  }
});

test('the round trip holds for non-square pixels too', () => {
  const point = { x: 300, y: 120 };
  const view = { zoom: 2.5, panX: 33, panY: -77 };

  const back = canvasToImage(imageToCanvas(point, CANVAS, WIDE, view), CANVAS, WIDE, view);

  assert.ok(Math.abs(back.x - point.x) < 1e-9 && Math.abs(back.y - point.y) < 1e-9);
});

test('a point outside the image is not clamped to its edge', () => {
  // A measurement dragged past the border should report where the pointer went.
  const outside = canvasToImage({ x: 0, y: 0 }, CANVAS, SQUARE, STILL);

  assert.ok(outside.x < 0, `got ${outside.x}`);
});

test('a distance is measured in millimetres, across and down separately', () => {
  // 100 pixels across at 1 mm and 100 down at 0.5 mm is not 100 root two
  // millimetres. Using one spacing for both is right on square pixels and
  // wrong by an amount too small to notice and too large to accept.
  assert.equal(distanceInMillimetres({ x: 0, y: 0 }, { x: 100, y: 0 }, WIDE), 100);
  assert.equal(distanceInMillimetres({ x: 0, y: 0 }, { x: 0, y: 100 }, WIDE), 50);
  assert.equal(
    distanceInMillimetres({ x: 0, y: 0 }, { x: 100, y: 100 }, WIDE),
    Math.hypot(100, 50)
  );
});

test('a distance does not depend on zoom, pan, or the size of the canvas', () => {
  // The measurement is of the patient, not of the screen.
  const a = { x: 100, y: 100 };
  const b = { x: 300, y: 220 };

  assert.equal(
    distanceInMillimetres(a, b, SQUARE),
    distanceInMillimetres(a, b, { ...SQUARE })
  );
  assert.equal(distanceInMillimetres(a, b, SQUARE), Math.hypot(200 * 0.5, 120 * 0.5));
});
