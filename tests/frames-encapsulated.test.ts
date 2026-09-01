/**
 * Finding one frame inside compressed pixel data.
 *
 * This is the code that failed on the first real folder anybody tried, while
 * every check written before it passed — because every study they drove came
 * from one public archive and all of them are stored uncompressed. The
 * application had been checked against the data it was built with, which is not
 * a check.
 *
 * Compressed frames are stored as fragments of unpredictable length, so a reader
 * has to be told where each frame begins. The Basic Offset Table is where a file
 * says that, and the standard allows it to be empty — which most equipment
 * leaves it. The first attempt here used the reader that requires one, so it
 * threw, the archive answered 500, and the viewer put "these images could not be
 * read" over a study that is perfectly readable.
 *
 * The files below are built byte by byte, with fragments whose contents are
 * arbitrary. That is deliberate: nothing here decodes an image, and the only
 * question is whether the right bytes come back. A real JPEG would test a
 * library that is not ours.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { isProblem, readFrame } from '../src/main/dicomweb/frames';
import { readHeader } from '../src/main/dicom/read-header';
import type { InstanceHeader } from '../src/main/dicom/read-header';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dicom-encapsulated-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const JPEG_LOSSLESS = '1.2.840.10008.1.2.4.70';
const RLE = '1.2.840.10008.1.2.5';

/** An even-length buffer, as every DICOM value has to be. */
function padded(value: string): Buffer {
  const bytes = Buffer.from(value, 'latin1');
  return bytes.length % 2 === 0 ? bytes : Buffer.concat([bytes, Buffer.from([0])]);
}

/** One element, explicit VR little endian, short form. */
function element(group: number, tag: number, vr: string, value: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(group, 0);
  head.writeUInt16LE(tag, 2);
  head.write(vr, 4, 'latin1');
  head.writeUInt16LE(value.length, 6);
  return Buffer.concat([head, value]);
}

function text(group: number, tag: number, vr: string, value: string): Buffer {
  return element(group, tag, vr, padded(value));
}

function short(group: number, tag: number, value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value, 0);
  return element(group, tag, 'US', bytes);
}

/** An item: a tag and a length, and never a value representation. */
function item(tag: number, value: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0xfffe, 0);
  head.writeUInt16LE(tag, 2);
  head.writeUInt32LE(value.length, 4);
  return Buffer.concat([head, value]);
}

interface Shape {
  transferSyntax: string;
  frames: number;
  /** The fragments, in order. Their contents are arbitrary. */
  fragments: Buffer[];
  /** Where each frame begins, as offsets into the fragments. Empty is allowed. */
  offsets?: number[];
}

/** A Part 10 file whose pixel data is encapsulated. */
function file(name: string, shape: Shape): string {
  const meta = Buffer.concat([
    text(0x0002, 0x0002, 'UI', '1.2.840.10008.5.1.4.1.1.4'),
    text(0x0002, 0x0003, 'UI', '1.2.3.4.5'),
    text(0x0002, 0x0010, 'UI', shape.transferSyntax),
  ]);

  const groupLength = Buffer.alloc(4);
  groupLength.writeUInt32LE(meta.length, 0);

  const offsets = shape.offsets ?? [];
  const table = Buffer.alloc(offsets.length * 4);
  offsets.forEach((at, index) => table.writeUInt32LE(at, index * 4));

  // Pixel data with no declared length: the items that follow are the frames.
  const pixelHead = Buffer.alloc(12);
  pixelHead.writeUInt16LE(0x7fe0, 0);
  pixelHead.writeUInt16LE(0x0010, 2);
  pixelHead.write('OB', 4, 'latin1');
  pixelHead.writeUInt32LE(0xffffffff, 8);

  const bytes = Buffer.concat([
    Buffer.alloc(128),
    Buffer.from('DICM', 'latin1'),
    element(0x0002, 0x0000, 'UL', groupLength),
    meta,

    text(0x0008, 0x0016, 'UI', '1.2.840.10008.5.1.4.1.1.4'),
    text(0x0008, 0x0018, 'UI', `1.2.3.4.5.${name}`),
    text(0x0020, 0x000d, 'UI', '1.2.3'),
    text(0x0020, 0x000e, 'UI', '1.2.3.1'),

    short(0x0028, 0x0002, 1),
    text(0x0028, 0x0004, 'CS', 'MONOCHROME2'),
    ...(shape.frames > 1 ? [text(0x0028, 0x0008, 'IS', String(shape.frames))] : []),
    short(0x0028, 0x0010, 8),
    short(0x0028, 0x0011, 8),
    short(0x0028, 0x0100, 8),
    short(0x0028, 0x0101, 8),
    short(0x0028, 0x0102, 7),
    short(0x0028, 0x0103, 0),

    pixelHead,
    item(0xe000, table),
    ...shape.fragments.map(fragment => item(0xe000, fragment)),
    item(0xe0dd, Buffer.alloc(0)),
  ]);

  const full = path.join(scratch, `${name}.dcm`);
  fs.writeFileSync(full, bytes);
  return full;
}

/** The header, read the way the index reads it. */
async function pixelsOf(full: string): Promise<InstanceHeader> {
  return readHeader(full);
}

async function frameOf(full: string, number_: number): Promise<Buffer> {
  const header = await pixelsOf(full);
  const frame = readFrame(full, header.pixels, number_);

  assert.ok(!isProblem(frame), isProblem(frame) ? frame.reason : '');
  return frame.bytes;
}

test('the pixel data is seen as encapsulated at all', async () => {
  const full = file('one', {
    transferSyntax: JPEG_LOSSLESS,
    frames: 1,
    fragments: [Buffer.from([1, 2, 3, 4])],
  });

  const header = await pixelsOf(full);
  assert.equal(header.pixels.encapsulated, true);
  assert.equal(header.pixels.transferSyntaxUid, JPEG_LOSSLESS);
});

test('one frame with an empty offset table, which is what most equipment writes', async () => {
  // The case that failed. The reader that needs a table threw, and every
  // compressed study opened onto "these images could not be read".
  const full = file('empty-table', {
    transferSyntax: JPEG_LOSSLESS,
    frames: 1,
    fragments: [Buffer.from([9, 8, 7, 6, 5, 4])],
  });

  assert.deepEqual([...await frameOf(full, 1)], [9, 8, 7, 6, 5, 4]);
});

test('one frame split across several fragments comes back whole', async () => {
  // A large compressed image is often written in pieces. They are one frame,
  // and handing back only the first is an image with its bottom missing.
  const full = file('split', {
    transferSyntax: JPEG_LOSSLESS,
    frames: 1,
    fragments: [Buffer.from([1, 2]), Buffer.from([3, 4]), Buffer.from([5, 6])],
  });

  assert.deepEqual([...await frameOf(full, 1)], [1, 2, 3, 4, 5, 6]);
});

test('several frames with no table, one fragment each', async () => {
  const full = file('per-frame', {
    transferSyntax: RLE,
    frames: 3,
    fragments: [Buffer.from([10, 11]), Buffer.from([20, 21]), Buffer.from([30, 31])],
  });

  assert.deepEqual([...await frameOf(full, 1)], [10, 11]);
  assert.deepEqual([...await frameOf(full, 2)], [20, 21]);
  assert.deepEqual([...await frameOf(full, 3)], [30, 31]);
});

test('several frames with a table that says where each begins', async () => {
  const full = file('with-table', {
    transferSyntax: RLE,
    frames: 2,
    // Offsets are counted from the first fragment's item header.
    offsets: [0, 8 + 4],
    fragments: [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7, 8])],
  });

  assert.deepEqual([...await frameOf(full, 1)], [1, 2, 3, 4]);
  assert.deepEqual([...await frameOf(full, 2)], [5, 6, 7, 8]);
});

test('a frame past the end is refused, with the count in the reason', async () => {
  const full = file('past-the-end', {
    transferSyntax: RLE,
    frames: 2,
    fragments: [Buffer.from([1, 2]), Buffer.from([3, 4])],
  });

  const header = await pixelsOf(full);

  const frame = readFrame(full, header.pixels, 5);
  assert.ok(isProblem(frame));
});

test('what cannot be worked out says so, rather than answering wrong bytes', async () => {
  // Three frames in two fragments, no table, and a compression whose frames do
  // not begin with a marker anything here can find. There is no honest answer,
  // and the reason names all three facts.
  const full = file('unknowable', {
    transferSyntax: RLE,
    frames: 3,
    fragments: [Buffer.from([1, 2]), Buffer.from([3, 4])],
  });

  const header = await pixelsOf(full);

  const frame = readFrame(full, header.pixels, 2);
  assert.ok(isProblem(frame));
  assert.match(frame.reason, /3 frames in 2 fragments/);
  assert.match(frame.reason, /offset table/);
});

test('the media type says what the bytes are, so the viewer can decode them', async () => {
  const jpeg = file('jpeg', {
    transferSyntax: JPEG_LOSSLESS,
    frames: 1,
    fragments: [Buffer.from([1, 2])],
  });
  const rle = file('rle', { transferSyntax: RLE, frames: 1, fragments: [Buffer.from([1, 2])] });

  const jpegHeader = await pixelsOf(jpeg);
  const rleHeader = await pixelsOf(rle);

  const first = readFrame(jpeg, jpegHeader.pixels, 1);
  const second = readFrame(rle, rleHeader.pixels, 1);
  assert.ok(!isProblem(first) && !isProblem(second));

  assert.equal(first.mediaType, 'image/jpeg');
  assert.equal(second.mediaType, 'image/dicom-rle');
});

test('one frame in several fragments, in a compression with no marker to find', async () => {
  // Only the single-frame path can answer this. The offsets are not there, the
  // compression has no marker a table can be built from, and there are three
  // fragments for one frame — so counting fragments as frames says nothing
  // either. It is the case that proves the branch is load-bearing.
  const full = file('rle-split', {
    transferSyntax: RLE,
    frames: 1,
    fragments: [Buffer.from([7, 7]), Buffer.from([8, 8]), Buffer.from([9, 9])],
  });

  assert.deepEqual([...await frameOf(full, 1)], [7, 7, 8, 8, 9, 9]);
});
