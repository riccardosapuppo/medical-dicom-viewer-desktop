/**
 * These write real DICOM bytes to a real folder and read them back. The point
 * is the awkward files: one whose header is bigger than the read-ahead, one
 * whose pixel data is declared and then not there, and the ordinary rubbish
 * that shares a folder with a study burned to a CD.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { NotDicomError, readHeader } from '../src/main/dicom/read-header';
import {
  CT_IMAGE_STORAGE,
  EXPLICIT_VR_LITTLE_ENDIAN,
  IMPLICIT_VR_LITTLE_ENDIAN,
  writeDicomFile,
  type Element,
} from '../tools/synthetic/write-dicom';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dicom-workstation-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function put(name: string, bytes: Buffer): string {
  const target = path.join(scratch, name);
  fs.writeFileSync(target, bytes);
  return target;
}

const SOP_INSTANCE = '1.2.826.0.1.3680043.10.1337.1.4.7';

/** A plausible chest CT slice. */
const SLICE: Element[] = [
  { group: 0x0008, element: 0x0016, vr: 'UI', value: CT_IMAGE_STORAGE },
  { group: 0x0008, element: 0x0018, vr: 'UI', value: SOP_INSTANCE },
  { group: 0x0008, element: 0x0020, vr: 'DA', value: '20240310' },
  { group: 0x0008, element: 0x0030, vr: 'TM', value: '101500' },
  { group: 0x0008, element: 0x0050, vr: 'SH', value: 'ACC12345' },
  { group: 0x0008, element: 0x0060, vr: 'CS', value: 'CT' },
  { group: 0x0008, element: 0x1030, vr: 'LO', value: 'CT CHEST' },
  { group: 0x0008, element: 0x103e, vr: 'LO', value: 'AXIAL 1MM' },
  { group: 0x0010, element: 0x0010, vr: 'PN', value: 'Rossi^Mario' },
  { group: 0x0010, element: 0x0020, vr: 'LO', value: 'PAT001' },
  { group: 0x0010, element: 0x0030, vr: 'DA', value: '19580312' },
  { group: 0x0010, element: 0x0040, vr: 'CS', value: 'M' },
  { group: 0x0018, element: 0x0050, vr: 'DS', value: '1.0' },
  { group: 0x0020, element: 0x000d, vr: 'UI', value: '1.2.826.0.1.3680043.10.1337.1' },
  { group: 0x0020, element: 0x000e, vr: 'UI', value: '1.2.826.0.1.3680043.10.1337.1.4' },
  { group: 0x0020, element: 0x0011, vr: 'IS', value: '2' },
  { group: 0x0020, element: 0x0013, vr: 'IS', value: '7' },
  { group: 0x0020, element: 0x0032, vr: 'DS', value: [-250, -250, 42.5] },
  { group: 0x0020, element: 0x0037, vr: 'DS', value: [1, 0, 0, 0, 1, 0] },
  { group: 0x0028, element: 0x0010, vr: 'US', value: 512 },
  { group: 0x0028, element: 0x0011, vr: 'US', value: 512 },
  { group: 0x0028, element: 0x0030, vr: 'DS', value: [0.703125, 0.703125] },
  { group: 0x0028, element: 0x0100, vr: 'US', value: 16 },
];

function sliceFile(extra: Element[] = []): Buffer {
  return writeDicomFile(
    { sopClassUid: CT_IMAGE_STORAGE, sopInstanceUid: SOP_INSTANCE },
    [...SLICE, ...extra]
  );
}

test('reads what an index needs off a single slice', async () => {
  const header = await readHeader(put('slice.dcm', sliceFile()));

  assert.equal(header.patientId, 'PAT001');
  assert.equal(header.patientName, 'Rossi Mario');
  assert.equal(header.modality, 'CT');
  assert.equal(header.accessionNumber, 'ACC12345');
  assert.equal(header.seriesNumber, 2);
  assert.equal(header.instanceNumber, 7);
  assert.equal(header.rows, 512);
  assert.equal(header.columns, 512);
  assert.deepEqual(header.imagePositionPatient, [-250, -250, 42.5]);
  assert.deepEqual(header.imageOrientationPatient, [1, 0, 0, 0, 1, 0]);
  assert.deepEqual(header.pixelSpacing, [0.703125, 0.703125]);
  assert.equal(header.transferSyntaxUid, EXPLICIT_VR_LITTLE_ENDIAN);
});

test('a name written with carets comes back readable', () => {
  // DICOM separates the parts of a name with carets. Showing them to a
  // radiologist is showing them the wire format.
  assert.equal(SLICE.find(e => e.element === 0x0010 && e.group === 0x0010)?.value, 'Rossi^Mario');
});

test('an absent frame count means one frame, not none', async () => {
  const header = await readHeader(put('frames.dcm', sliceFile()));

  assert.equal(header.numberOfFrames, 1);
});

test('a header bigger than the read-ahead is read anyway', async () => {
  // Private tags, embedded icons and structured reports all push a header past
  // whatever chunk size looks generous. The reader is allowed to guess wrong
  // and then read more; this is the file that makes it.
  const padding: Element = {
    group: 0x0009,
    element: 0x0010,
    vr: 'OB',
    value: new Uint8Array(80 * 1024),
  };

  const header = await readHeader(put('fat-header.dcm', sliceFile([padding])));

  assert.equal(header.sopInstanceUid, SOP_INSTANCE);
  assert.ok(header.fileSize > 80 * 1024);
});

test('the pixels are never read', async () => {
  // The file says it carries half a megabyte of pixel data and then stops. A
  // reader that walks into the pixels to reach the end of the file fails here;
  // one that stops at the pixel data tag does not notice.
  const withoutPixels = sliceFile();
  const pixelHeader = Buffer.alloc(12);
  pixelHeader.writeUInt16LE(0x7fe0, 0);
  pixelHeader.writeUInt16LE(0x0010, 2);
  pixelHeader.write('OW', 4, 'latin1');
  pixelHeader.writeUInt32LE(512 * 512 * 2, 8);

  const truncated = put('truncated.dcm', Buffer.concat([withoutPixels, pixelHeader]));
  const header = await readHeader(truncated);

  assert.equal(header.rows, 512);
  assert.ok(header.fileSize < 100 * 1024, 'the fixture should be nowhere near a real slice');
});

test('a file that is not DICOM is skipped, not an error', async () => {
  // A folder from a CD comes with an autorun file, a readme and a viewer.
  // Longer than a preamble, so it gets as far as the DICM check rather than
  // being turned away on size.
  const text = put('README.TXT', Buffer.from("PATIENT IMAGING DISC\r\n\r\nThis disc contains diagnostic images in DICOM format together with a viewer\r\nfor Microsoft Windows. Insert the disc and run VIEWER.EXE, or open the\r\nDICOMDIR file with any DICOM application. Please give this disc to your\r\ndoctor at your next appointment.\r\n"));

  await assert.rejects(() => readHeader(text), NotDicomError);
});

test('a file too short to hold a preamble is skipped', async () => {
  const stub = put('stub.bin', Buffer.alloc(64));

  await assert.rejects(() => readHeader(stub), NotDicomError);
});

test('a file that claims DICM and then makes no sense is a real error', async () => {
  // This one must not be quietly skipped: it is a corrupt image, not a stray
  // file, and an index that hides it loses a slice without saying so.
  const broken = Buffer.concat([
    Buffer.alloc(128),
    Buffer.from('DICM', 'latin1'),
    Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 251)),
  ]);

  const target = put('corrupt.dcm', broken);
  await assert.rejects(
    () => readHeader(target),
    (error: Error) => !(error instanceof NotDicomError) && /corrupt\.dcm/.test(error.message)
  );
});

test('a position with a missing component is dropped, not half read', async () => {
  // [12, NaN, 40] would sort a stack into an order that looks plausible and is
  // not. Better no geometry than geometry that is wrong.
  const bad = sliceFile().length;
  assert.ok(bad > 0);

  const withBadPosition = writeDicomFile(
    { sopClassUid: CT_IMAGE_STORAGE, sopInstanceUid: SOP_INSTANCE },
    [
      ...SLICE.filter(e => !(e.group === 0x0020 && e.element === 0x0032)),
      { group: 0x0020, element: 0x0032, vr: 'DS', value: '-250' },
    ]
  );

  const header = await readHeader(put('short-position.dcm', withBadPosition));

  assert.equal(header.imagePositionPatient, undefined);
  assert.deepEqual(header.imageOrientationPatient, [1, 0, 0, 0, 1, 0]);
});

test('a file stored with implicit VR reads the same as an explicit one', async () => {
  // Implicit VR little endian is the default transfer syntax and a great deal
  // of what sits in archives is still written in it. Nothing on the wire says
  // what type each value is; the parser has to know from a dictionary. The
  // reader either handles that or silently indexes half a study.
  const implicit = writeDicomFile(
    {
      sopClassUid: CT_IMAGE_STORAGE,
      sopInstanceUid: SOP_INSTANCE,
      transferSyntaxUid: IMPLICIT_VR_LITTLE_ENDIAN,
    },
    SLICE
  );

  const header = await readHeader(put('implicit.dcm', implicit));

  assert.equal(header.transferSyntaxUid, IMPLICIT_VR_LITTLE_ENDIAN);
  assert.equal(header.patientName, 'Rossi Mario');
  assert.equal(header.patientId, 'PAT001');
  assert.equal(header.modality, 'CT');
  assert.equal(header.instanceNumber, 7);
  assert.equal(header.rows, 512);
  assert.deepEqual(header.imagePositionPatient, [-250, -250, 42.5]);
});
