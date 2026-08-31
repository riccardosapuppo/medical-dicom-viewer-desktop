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
// Lowercase as well: a disc written on a system that does not care about case
// carries one of these, and Windows does not care either. A comparison that
// does care indexes it as a study made of pointers.
put('dicomdir', slice(8, 1, 0));
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

  const series = result.index.patients[0]?.studies[0]?.series ?? [];

  assert.equal(
    series.some(s => s.seriesNumber === 9),
    false,
    'DICOMDIR was indexed'
  );
  assert.equal(
    series.some(s => s.seriesNumber === 8),
    false,
    'dicomdir was indexed'
  );
});

test('progress is reported all the way to the end', async () => {
  // A long walk that says nothing looks hung. One that stops short of the total
  // leaves a progress bar frozen at ninety-something per cent forever.
  const seen: number[] = [];
  const result = await indexFolder(scratch, { onProgress: done => seen.push(done) });

  assert.equal(seen.length, 6, 'one call per file, the directory records aside');
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

test('the same folder gives the same index every time', () => {
  // Eight readers finish in the order the disk answers in, and the first header
  // of a series decides its description, its modality and the spelling of the
  // patient's name. Appending as they finish made two runs over one unchanged
  // folder produce two different indexes, which is the kind of difference that
  // gets blamed on the data.
  const many = path.join(scratch, 'many');
  fs.mkdirSync(many, { recursive: true });

  for (let i = 1; i <= 40; i++) {
    const sop = `${STUDY}.5.${i}`;
    const elements: Element[] = [
      { group: 0x0008, element: 0x0016, vr: 'UI', value: CT_IMAGE_STORAGE },
      { group: 0x0008, element: 0x0018, vr: 'UI', value: sop },
      { group: 0x0008, element: 0x0060, vr: 'CS', value: 'CT' },
      // Every file but the first says something else, so which one arrives
      // first is visible in the answer.
      { group: 0x0008, element: 0x103e, vr: 'LO', value: i === 1 ? 'AXIAL 1.0MM' : 'RECON B' },
      { group: 0x0010, element: 0x0010, vr: 'PN', value: i === 1 ? 'Bianchi^Anna' : 'BIANCHI^ANNA' },
      { group: 0x0010, element: 0x0020, vr: 'LO', value: 'DEMO-0001' },
      { group: 0x0020, element: 0x000d, vr: 'UI', value: STUDY },
      { group: 0x0020, element: 0x000e, vr: 'UI', value: `${STUDY}.5` },
      { group: 0x0020, element: 0x0011, vr: 'IS', value: 5 },
      { group: 0x0020, element: 0x0013, vr: 'IS', value: i },
      { group: 0x0028, element: 0x0010, vr: 'US', value: 64 },
      { group: 0x0028, element: 0x0011, vr: 'US', value: 64 },
      { group: 0x0028, element: 0x0100, vr: 'US', value: 16 },
      { group: 0x7fe0, element: 0x0010, vr: 'OW', value: new Uint8Array(64 * 64 * 2) },
    ];
    fs.writeFileSync(
      path.join(many, `img-${String(i).padStart(2, '0')}.dcm`),
      writeDicomFile({ sopClassUid: CT_IMAGE_STORAGE, sopInstanceUid: sop }, elements)
    );
  }

  return (async () => {
    const answers = [];
    for (let run = 0; run < 6; run++) {
      const result = await indexFolder(many);
      const patient = result.index.patients[0];
      answers.push(`${patient?.name}|${patient?.studies[0]?.series[0]?.description}`);
    }

    assert.equal(
      new Set(answers).size,
      1,
      `six runs over one folder gave ${new Set(answers).size} different answers: ${[...new Set(answers)].join(' / ')}`
    );
    assert.equal(answers[0], 'Bianchi Anna|AXIAL 1.0MM', 'the first file by name should decide');
  })();
});

test('a walk can be stopped before it has read anything', async () => {
  // Somebody who drops a drive root and presses Stop is waiting on a walk that
  // has not reached its first file. A cancel that only takes effect once the
  // walk finishes is not a cancel.
  const controller = new AbortController();
  controller.abort();

  const result = await indexFolder(scratch, { signal: controller.signal });

  assert.equal(result.read, 0);
  assert.equal(result.index.patients.length, 0);
  // The walk itself has to stop, not just the reading afterwards: a folder can
  // hold a million entries and finding them all is the slow part.
  assert.equal(result.found, 0, 'the directory was enumerated anyway');
});
