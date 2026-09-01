#!/usr/bin/env node
/**
 * Draws the application icon.
 *
 * By hand, into a PNG, with nothing but zlib — which is less eccentric than it
 * sounds. The alternative is checking a binary into the repository that nobody
 * can see the provenance of, or adding an image library to a project that has
 * no other use for one. This is fifty lines and the icon is described by the
 * code that draws it.
 *
 * The design has one job, and it is a job most application icons fail at: to be
 * recognisable at sixteen pixels, in a taskbar, next to twenty others. What was
 * here before was a greyscale ramp with a corner marker — a fair description of
 * what the program does, and at sixteen pixels an unreadable grey smudge that
 * represented nothing.
 *
 * So it is a shape instead: a body in cross-section, light on the reading-room
 * dark, with the two lungs cut out of it. That silhouette survives being made
 * small, because it is one bright form on a dark ground, and it says what kind
 * of program this is without a word.
 *
 *   npm run icon
 */
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A PNG chunk: length, type, data, and the CRC of the last two. */
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** The colour at a pixel, as red, green, blue, alpha. */
function paint(x, y) {
  const u = x / (SIZE - 1);
  const v = y / (SIZE - 1);

  // A rounded square, so the icon does not fight the shapes around it.
  const inset = SIZE * 0.06;
  const radius = SIZE * 0.18;
  const dx = Math.max(inset - x, x - (SIZE - 1 - inset), 0);
  const dy = Math.max(inset - y, y - (SIZE - 1 - inset), 0);
  if (Math.hypot(dx, dy) > 0) {
    return [0, 0, 0, 0];
  }
  const cx = Math.min(x - inset, SIZE - 1 - inset - x);
  const cy = Math.min(y - inset, SIZE - 1 - inset - y);
  if (cx < radius && cy < radius && Math.hypot(radius - cx, radius - cy) > radius) {
    return [0, 0, 0, 0];
  }

  // A viewport with an image in it. Two shapes, both big: a light frame, and a
  // bright disc inside it. At sixteen pixels that is a square outline with a dot
  // in the middle, which is legible, and which says "something is being looked
  // at" — where a cross-section of a chest, tried first, read as a face.
  const frameInset = 0.24;
  const frameThick = 0.055;

  const insideFrame =
    u > frameInset && u < 1 - frameInset && v > frameInset && v < 1 - frameInset;
  const insideHole =
    u > frameInset + frameThick &&
    u < 1 - frameInset - frameThick &&
    v > frameInset + frameThick &&
    v < 1 - frameInset - frameThick;

  if (insideFrame && !insideHole) {
    // The top edge is amber: the colour this application uses for what is live,
    // and on a frame it reads as the edge that is selected. It is a detail, and
    // at sixteen pixels it becomes a single warm pixel row rather than
    // disappearing into something that looks like a mistake.
    const onTop = v < frameInset + frameThick;
    return onTop ? [240, 169, 46, 255] : [216, 222, 233, 255];
  }

  if (insideHole) {
    // The image: a disc, brighter at its centre, the way a window on soft
    // tissue looks.
    const dx2 = (u - 0.5) / 0.135;
    const dy2 = (v - 0.5) / 0.135;
    const r = Math.hypot(dx2, dy2);

    if (r <= 1) {
      const grey = Math.round(236 - 90 * Math.min(1, r));
      return [grey, grey, grey, 255];
    }

    // Inside the frame but outside the image: the black a viewport sits on.
    return [0, 0, 0, 255];
  }

  return [13, 17, 23, 255];
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let at = 0;
for (let y = 0; y < SIZE; y++) {
  raw[at++] = 0; // no filter: the image is tiny and clarity beats a few kilobytes
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = paint(x, y);
    raw[at++] = r;
    raw[at++] = g;
    raw[at++] = b;
    raw[at++] = a;
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bits per channel
header[9] = 6; // colour type: truecolour with alpha
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = path.join(root, 'build', 'icon.png');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, png);
console.log(`${path.relative(root, target)}  ${SIZE}x${SIZE}  ${(png.length / 1024).toFixed(1)} KB`);
