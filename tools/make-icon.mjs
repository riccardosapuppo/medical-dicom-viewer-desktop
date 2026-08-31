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
 * The design is the application's own: the reading-room dark, one amber corner
 * marker of the kind that sits at the edge of a viewport, and a greyscale ramp
 * across the middle, because a greyscale ramp is what this whole program is
 * about.
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

  // The greyscale ramp across the middle: the thing the program does.
  const band = Math.abs(v - 0.5) < 0.17;
  if (band) {
    const grey = Math.round(24 + 210 * Math.min(1, Math.max(0, (u - 0.14) / 0.72)));
    return [grey, grey, grey, 255];
  }

  // One corner marker, amber, of the kind that sits at the edge of a viewport.
  const arm = SIZE * 0.13;
  const thick = SIZE * 0.035;
  const nearLeft = x > inset + SIZE * 0.07 && x < inset + SIZE * 0.07 + arm;
  const nearTop = y > inset + SIZE * 0.07 && y < inset + SIZE * 0.07 + arm;
  const onArm =
    (nearTop && y < inset + SIZE * 0.07 + thick && nearLeft) ||
    (nearLeft && x < inset + SIZE * 0.07 + thick && nearTop);
  if (onArm) {
    return [240, 169, 46, 255];
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
