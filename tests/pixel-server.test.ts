/**
 * Serving pixels to the page.
 *
 * Two properties are worth pinning down. The page can only ask for images in
 * the folder that is open — it cannot express a path at all, and a UID it was
 * never given is indistinguishable from one that does not exist. And a partial
 * request gets a partial answer at the right offset: a Range that is silently
 * given the whole body is worse than one that fails, because the caller draws
 * noise and believes it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { buildIndex } from '../src/main/dicom/build-index';
import { readHeader, type PixelLayout } from '../src/main/dicom/read-header';
import { frameSize, parseRange, PixelServer } from '../src/main/library/pixel-server';
import {
  CT_IMAGE_STORAGE,
  encapsulatedPixelData,
  writeDicomFile,
  type Element,
} from '../tools/synthetic/write-dicom';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dicom-workstation-pixels-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const UID = '1.2.826.0.1.3680043.10.1337.5.1.1';
const ROWS = 8;
const COLUMNS = 8;
const FRAME_BYTES = ROWS * COLUMNS * 2;
const JPEG_2000 = '1.2.840.10008.1.2.4.90';

/** Pixels that can be checked byte by byte. */
function pattern(frames: number): Uint8Array {
  const bytes = new Uint8Array(FRAME_BYTES * frames);
  bytes.forEach((_, i) => {
    bytes[i] = (i * 7 + 3) % 256;
  });
  return bytes;
}

function slice(sop: string, frames: number, extra: Element[] = []): Buffer {
  const elements: Element[] = [
    { group: 0x0008, element: 0x0016, vr: 'UI', value: CT_IMAGE_STORAGE },
    { group: 0x0008, element: 0x0018, vr: 'UI', value: sop },
    { group: 0x0008, element: 0x0060, vr: 'CS', value: 'CT' },
    { group: 0x0010, element: 0x0020, vr: 'LO', value: 'DEMO-0001' },
    { group: 0x0020, element: 0x000d, vr: 'UI', value: '1.2.826.0.1.3680043.10.1337.5' },
    { group: 0x0020, element: 0x000e, vr: 'UI', value: '1.2.826.0.1.3680043.10.1337.5.1' },
    { group: 0x0028, element: 0x0008, vr: 'IS', value: frames },
    { group: 0x0028, element: 0x0010, vr: 'US', value: ROWS },
    { group: 0x0028, element: 0x0011, vr: 'US', value: COLUMNS },
    { group: 0x0028, element: 0x0100, vr: 'US', value: 16 },
    { group: 0x7fe0, element: 0x0010, vr: 'OW', value: pattern(frames) },
    ...extra,
  ];
  return writeDicomFile({ sopClassUid: CT_IMAGE_STORAGE, sopInstanceUid: sop }, elements);
}

function put(name: string, bytes: Buffer): string {
  const target = path.join(scratch, name);
  fs.writeFileSync(target, bytes);
  return target;
}

async function serverFor(files: string[]): Promise<PixelServer> {
  const headers = await Promise.all(files.map(readHeader));
  const server = new PixelServer();
  server.remember(buildIndex(headers));
  return server;
}

const ask = (server: PixelServer, url: string, headers?: HeadersInit): Promise<Response> =>
  server.handle(new Request(url, headers ? { headers } : undefined));

/** A layout with only the fields frameSize cares about. */
function layout(partial: Partial<PixelLayout>): PixelLayout {
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

test('a frame is rows by columns by samples by bytes per sample', () => {
  assert.equal(frameSize(layout({})), 512 * 512 * 2);
  assert.equal(frameSize(layout({ bitsAllocated: 8 })), 512 * 512);
  // Three samples per pixel for colour. Ignoring that gives a third of the
  // frame and an image that looks like a venetian blind.
  assert.equal(frameSize(layout({ bitsAllocated: 8, samplesPerPixel: 3 })), 512 * 512 * 3);
  // 12 bits allocated is stored in two bytes, not one and a half.
  assert.equal(frameSize(layout({ bitsAllocated: 12 })), 512 * 512 * 2);
});

test('a frame size cannot be guessed from a header that does not say', () => {
  assert.equal(frameSize(layout({ rows: undefined })), undefined);
  assert.equal(frameSize(layout({ columns: 0 })), undefined);
  assert.equal(frameSize(layout({ bitsAllocated: undefined })), undefined);
});

test('a range is read the way the specification writes it', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  // The last 200 bytes, not a range starting at nothing.
  assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999 });
  // An end past the last byte is clamped rather than refused; browsers rely on it.
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
});

test('a range that cannot be satisfied is said so, and nonsense is ignored', () => {
  assert.equal(parseRange('bytes=1000-1200', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=700-300', 1000), 'unsatisfiable');
  assert.equal(parseRange(null, 1000), undefined);
  // A multipart range is legal and nobody sends it. Answering one badly would
  // be worse than treating the request as having no range at all.
  assert.equal(parseRange('bytes=0-99, 200-299', 1000), undefined);
  assert.equal(parseRange('items=0-99', 1000), undefined);
  assert.equal(parseRange('bytes=-', 1000), undefined);
});

test('a frame comes back whole, and it is the right frame', async () => {
  const server = await serverFor([put('multi.dcm', slice(UID, 3))]);
  const expected = pattern(3);

  for (const frame of [1, 2, 3]) {
    const response = await ask(server, `dicom://instance/${UID}/frames/${frame}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(FRAME_BYTES));

    const body = new Uint8Array(await response.arrayBuffer());
    assert.equal(body.length, FRAME_BYTES);
    assert.deepEqual(
      body,
      expected.slice((frame - 1) * FRAME_BYTES, frame * FRAME_BYTES),
      `frame ${frame} came back with another frame's bytes`
    );
  }
});

test('a partial request gets bytes from the right offset', async () => {
  // The failure this guards against is silent: a caller that asked for the
  // middle of a frame and was handed the beginning draws noise and believes it.
  const server = await serverFor([put('ranged.dcm', slice(UID, 2))]);
  const whole = pattern(2).slice(FRAME_BYTES, FRAME_BYTES * 2);

  const response = await ask(server, `dicom://instance/${UID}/frames/2`, { range: 'bytes=10-29' });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 10-29/${FRAME_BYTES}`);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), whole.slice(10, 30));
});

test('a range beyond the frame is refused, not clamped to another frame', async () => {
  // Frame 1 of a three-frame file is followed on disk by frame 2. A range past
  // the end of frame 1 must not walk into it.
  const server = await serverFor([put('beyond.dcm', slice(UID, 3))]);

  const response = await ask(server, `dicom://instance/${UID}/frames/1`, {
    range: `bytes=${FRAME_BYTES}-${FRAME_BYTES + 10}`,
  });

  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), `bytes */${FRAME_BYTES}`);
});

test('an image outside the open folder is a 404, not a refusal', async () => {
  // Saying "forbidden" would tell the page that the image exists somewhere,
  // which is more than it is entitled to know.
  const server = await serverFor([put('one.dcm', slice(UID, 1))]);

  const response = await ask(server, 'dicom://instance/1.2.3.999/frames/1');
  assert.equal(response.status, 404);
});

test('closing a folder makes its images unreachable', async () => {
  const server = await serverFor([put('closing.dcm', slice(UID, 1))]);
  assert.equal((await ask(server, `dicom://instance/${UID}/frames/1`)).status, 200);

  server.forget();

  assert.equal((await ask(server, `dicom://instance/${UID}/frames/1`)).status, 404);
  assert.equal(server.size, 0);
});

test('opening another folder replaces what can be asked for', async () => {
  const first = put('first.dcm', slice(UID, 1));
  const other = '1.2.826.0.1.3680043.10.1337.5.1.2';
  const second = put('second.dcm', slice(other, 1));

  const server = await serverFor([first]);
  server.remember(buildIndex([await readHeader(second)]));

  assert.equal((await ask(server, `dicom://instance/${other}/frames/1`)).status, 200);
  assert.equal(
    (await ask(server, `dicom://instance/${UID}/frames/1`)).status,
    404,
    'an image from the folder that was closed is still reachable'
  );
});

test('a frame number outside the file is refused', async () => {
  const server = await serverFor([put('three.dcm', slice(UID, 3))]);

  for (const frame of ['0', '4', '-1', 'two', '1.5']) {
    const response = await ask(server, `dicom://instance/${UID}/frames/${frame}`);
    assert.equal(response.status, 416, `frame "${frame}" was accepted`);
  }
});

test('a malformed url says what was expected', async () => {
  const server = await serverFor([put('shape.dcm', slice(UID, 1))]);

  assert.equal((await ask(server, `dicom://instance/${UID}`)).status, 400);
  assert.equal((await ask(server, `dicom://instance/${UID}/pages/1`)).status, 400);
  assert.equal((await ask(server, `dicom://elsewhere/${UID}/frames/1`)).status, 404);
});

test('compressed pixels are refused, and the refusal names the syntax', async () => {
  // Nothing decodes them yet, and a viewer that hands the page 200 KB of JPEG
  // bytes labelled as raw pixels draws static.
  //
  // The fixture really is compressed - undefined length, an offset table, a
  // fragment, a delimiter - because the first version of this test used a file
  // with no pixel data at all. That fails for a different reason, and would
  // have let a refusal that never fires pass.
  const bytes = writeDicomFile(
    {
      sopClassUid: CT_IMAGE_STORAGE,
      sopInstanceUid: UID,
      transferSyntaxUid: JPEG_2000,
    },
    [
      { group: 0x0008, element: 0x0018, vr: 'UI', value: UID },
      { group: 0x0010, element: 0x0020, vr: 'LO', value: 'DEMO-0001' },
      { group: 0x0020, element: 0x000d, vr: 'UI', value: '1.2.826.0.1.3680043.10.1337.6' },
      { group: 0x0020, element: 0x000e, vr: 'UI', value: '1.2.826.0.1.3680043.10.1337.6.1' },
      { group: 0x0028, element: 0x0010, vr: 'US', value: ROWS },
      { group: 0x0028, element: 0x0011, vr: 'US', value: COLUMNS },
      { group: 0x0028, element: 0x0100, vr: 'US', value: 16 },
      encapsulatedPixelData([new Uint8Array([0xff, 0x4f, 0xff, 0x51, 0x00, 0x29])]),
    ]
  );

  const file = put('compressed.dcm', bytes);
  const header = await readHeader(file);
  assert.equal(header.pixels.encapsulated, true, 'the fixture is not actually compressed');
  assert.equal(header.pixels.transferSyntaxUid, JPEG_2000);

  const server = await serverFor([file]);
  const response = await ask(server, `dicom://instance/${UID}/frames/1`);

  assert.equal(response.status, 415);
  assert.ok(
    (await response.text()).includes(JPEG_2000),
    'the refusal should name the syntax that was found, so the reason is not a guess'
  );
});

test('a file that stops before its pixels is refused rather than half served', async () => {
  const whole = slice(UID, 2);
  const cut = whole.subarray(0, whole.length - FRAME_BYTES);

  const server = await serverFor([put('short.dcm', cut)]);
  const response = await ask(server, `dicom://instance/${UID}/frames/1`);

  assert.equal(response.status, 409);
});
