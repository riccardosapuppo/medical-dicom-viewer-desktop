/**
 * The walk over a folder, with the folder a real archive actually hands you:
 * images in nested directories, the viewer software that came on the CD, a
 * directory record, and one image that is broken.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { indexFolder } from '../src/main/dicom/index-folder';
import { CT_IMAGE_STORAGE, writeDicomFile, type Element } from '../tools/synthetic/write-dicom';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dicom-workstation-walk-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const STUDY = '1.2.826.0.1.3680043.10.1337.9';

function slice(series: number, instance: number, z: number): Buffer {
  const sop = `${STUDY}.${series}.${instance}`;
  const elements: Element[] = [
    { group: 0x0008, element: 0x0016, vr: 'UI', value: CT_IMAGE_STORAGE },
    { group: 0x0008, element: 0x0018, vr: 'UI', value: sop },
    { group: 0x0008, element: 0x0020, vr: 'DA', value: '20240412' },
    { group: 0x0008, element: 0x0060, vr: 'CS', value: 'CT' },
    { group: 0x0010, element: 0x0010, vr: 'PN', value: 'Bianchi^Anna' },
    { group: 0x0010, element: 0x0020, vr: 'LO', value: 'DEMO-0001' },
    { group: 0x0020, element: 0x000d, vr: 'UI', value: STUDY },
    { group: 0x0020, element: 0x000e, vr: 'UI', value: `${STUDY}.${series}` },
    { group: 0x0020, element: 0x0011, vr: 'IS', value: series },
    { group: 0x0020, element: 0x0013, vr: 'IS', value: instance },
    { group: 0x0020, element: 0x0032, vr: 'DS', value: [-175, -175, z] },
    { group: 0x0020, element: 0x0037, vr: 'DS', value: [1, 0, 0, 0, 1, 0] },
    { group: 0x0028, element: 0x0010, vr: 'US', value: 64 },
    { group: 0x0028, element: 0x0011, vr: 'US', value: 64 },
    { group: 0x0028, element: 0x0100, vr: 'US', value: 16 },
    { group: 0x7fe0, element: 0x0010, vr: 'OW', value: new Uint8Array(64 * 64 * 2) },
  ];
  return writeDicomFile({ sopClassUid: CT_IMAGE_STORAGE, sopInstanceUid: sop }, elements);
}

function put(relative: string, bytes: Buffer): void {
  const target = path.join(scratch, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

// A folder as it comes off a CD: images two levels down, the disc's own
// paperwork at the top, and a directory record beside it.
put('study/series-1/image-0001.dcm', slice(1, 1, 0));
put('study/series-1/image-0002.dcm', slice(1, 2, 5));
put('study/series-2/image-0001.dcm', slice(2, 1, 0));
// Long enough to clear the 132 bytes a preamble needs: a shorter file is
// turned away on size alone and never reaches the check that matters.
put('README.TXT', Buffer.from("PATIENT IMAGING DISC\r\n\r\nThis disc contains diagnostic images in DICOM format together with a viewer\r\nfor Microsoft Windows. Insert the disc and run VIEWER.EXE, or open the\r\nDICOMDIR file with any DICOM application. Please give this disc to your\r\ndoctor at your next appointment.\r\n"));
put('AUTORUN.INF', Buffer.from('[autorun]\r\nopen=viewer.exe\r\n'));
put('DICOMDIR', slice(9, 1, 0));
put(
  'study/series-1/image-0003.dcm',
  Buffer.concat([Buffer.alloc(128), Buffer.from('DICM', 'latin1'), Buffer.alloc(400, 0xab)])
);

test('walks the whole tree and groups what it finds', async () => {
  const result = await indexFolder(scratch);

  assert.equal(result.read, 3);
  assert.equal(result.index.patients.length, 1);
  assert.deepEqual(
    result.index.patients[0]?.studies[0]?.series.map(s => s.instances.length),
    [2, 1]
  );
});

test('files that are not DICOM are counted, not reported', async () => {
  // Two here: the readme and the autorun file. Neither is anyone's problem.
  const result = await indexFolder(scratch);

  assert.equal(result.skipped, 2);
});

test('a broken image is reported by name, because a slice is missing', async () => {
  const result = await indexFolder(scratch);

  assert.equal(result.unreadable.length, 1);
  assert.match(result.unreadable[0]?.filePath ?? '', /image-0003\.dcm$/);
  assert.ok((result.unreadable[0]?.reason ?? '').length > 0);
});

test('the directory record is not indexed as a study', async () => {
  // DICOMDIR is a valid DICOM file describing the others. Indexing it adds a
  // study made of pointers, which is a study that cannot be opened.
  const result = await indexFolder(scratch);

  assert.equal(
    result.index.patients[0]?.studies[0]?.series.some(s => s.seriesNumber === 9),
    false
  );
});

test('progress is reported all the way to the end', async () => {
  // A long walk that says nothing looks hung. One that stops short of the total
  // leaves a progress bar frozen at ninety-something per cent forever.
  const seen: number[] = [];
  const result = await indexFolder(scratch, { onProgress: done => seen.push(done) });

  assert.equal(seen.length, 6, 'one call per file, DICOMDIR aside');
  assert.equal(Math.max(...seen), 6);
  assert.ok(result.elapsedMs >= 0);
});

test('a folder that is not there is explained in a sentence', async () => {
  // The message Node raises names a syscall and quotes the path twice. Someone
  // who dropped the wrong thing on the window needs to know which of three
  // things happened.
  const missing = path.join(scratch, 'no-such-folder');

  await assert.rejects(
    () => indexFolder(missing),
    (error: Error) => error.message === `There is nothing at ${missing}.`
  );
});

test('a file dropped instead of a folder says so', async () => {
  const file = path.join(scratch, 'README.TXT');

  await assert.rejects(
    () => indexFolder(file),
    (error: Error) => /is a file, not a folder/.test(error.message)
  );
});
