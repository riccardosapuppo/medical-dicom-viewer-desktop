/**
 * The index has one job that is not obvious: putting a stack of slices back in
 * the order they sit in the body. Everything else here is grouping by UID,
 * which the standard decides. The ordering is decided by this file, and these
 * tests are the awkward series a real archive hands you, written down.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildIndex } from '../src/main/dicom/build-index';
import type { InstanceHeader } from '../src/main/dicom/read-header';

const AXIAL = [1, 0, 0, 0, 1, 0];

let counter = 0;

/** One image header, with everything a test does not care about filled in. */
function header(partial: Partial<InstanceHeader> = {}): InstanceHeader {
  counter++;
  return {
    filePath: `/studies/file-${counter}.dcm`,
    fileSize: 524288,

    patientId: 'PAT001',
    patientName: 'Rossi Mario',
    patientBirthDate: '19580312',
    patientSex: 'M',

    studyInstanceUid: '1.2.3.100',
    studyDate: '20240310',
    studyTime: '101500',
    studyDescription: 'CT CHEST',
    accessionNumber: 'ACC12345',

    seriesInstanceUid: '1.2.3.100.1',
    seriesNumber: 1,
    seriesDescription: 'AXIAL 1MM',
    modality: 'CT',

    sopInstanceUid: `1.2.3.100.1.${counter}`,
    sopClassUid: '1.2.840.10008.5.1.4.1.1.2',
    instanceNumber: counter,

    pixels: {
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
      pixelSpacing: [0.7, 0.7],
      spacingIsFromDetector: false,
      rescaleSlope: 1,
      rescaleIntercept: 0,
      windowCenter: 40,
      windowWidth: 400,
      transferSyntaxUid: '1.2.840.10008.1.2.1',
      encapsulated: false,
      dataOffset: 916,
      dataLength: 524288,
      complete: true,
    },

    imagePositionPatient: undefined,
    imageOrientationPatient: undefined,
    sliceThickness: 1,

    ...partial,
  };
}

/** A slice at a given height, numbered independently of where it sits. */
function slice(z: number, instanceNumber: number | undefined): InstanceHeader {
  return header({
    instanceNumber,
    imagePositionPatient: [-250, -250, z],
    imageOrientationPatient: AXIAL,
  });
}

test('geometry decides the order, not the instance number', () => {
  // A scanner that numbers a series against the direction of travel is normal.
  // Trusting the number would show the study upside down.
  const { patients } = buildIndex([slice(10, 3), slice(30, 1), slice(20, 2)]);
  const series = patients[0]?.studies[0]?.series[0];

  assert.equal(series?.orderedByGeometry, true);
  assert.deepEqual(
    series?.instances.map(i => i.slicePosition),
    [10, 20, 30]
  );
});

test('with no geometry the instance number decides', () => {
  const { patients } = buildIndex([
    header({ instanceNumber: 3 }),
    header({ instanceNumber: 1 }),
    header({ instanceNumber: 2 }),
  ]);
  const series = patients[0]?.studies[0]?.series[0];

  assert.equal(series?.orderedByGeometry, false);
  assert.deepEqual(
    series?.instances.map(i => i.instanceNumber),
    [1, 2, 3]
  );
});

test('one slice missing its position drops the whole series back to numbering', () => {
  // Half a stack ordered by geometry and half by number is not an order at all:
  // the two keys are on different scales and interleave into nonsense.
  const incomplete = header({ instanceNumber: 2, imageOrientationPatient: AXIAL });
  const { patients } = buildIndex([slice(30, 3), incomplete, slice(10, 1)]);
  const series = patients[0]?.studies[0]?.series[0];

  assert.equal(series?.orderedByGeometry, false);
  assert.deepEqual(
    series?.instances.map(i => i.instanceNumber),
    [1, 2, 3]
  );
});

test('an unnumbered slice sorts last rather than first', () => {
  // A missing number reads as zero if you are careless, which puts the slice
  // that says least at the top of the stack.
  // Enough slices that the answer cannot come out right by accident: with three
  // of them even a self-contradictory comparison happens to land in order, and
  // a broken version of this passed because of it.
  const numbers = [7, undefined, 3, undefined, 1, 9, undefined, 5];
  const { patients } = buildIndex(numbers.map(n => header({ instanceNumber: n })));

  assert.deepEqual(
    patients[0]?.studies[0]?.series[0]?.instances.map(i => i.instanceNumber),
    [1, 3, 5, 7, 9, undefined, undefined, undefined]
  );
});

test('the same image listed twice is counted once', () => {
  const one = header({ sopInstanceUid: '1.2.3.100.1.7', instanceNumber: 1 });
  const copy = header({ sopInstanceUid: '1.2.3.100.1.7', instanceNumber: 1 });

  const { patients, duplicates } = buildIndex([one, copy]);

  assert.equal(duplicates, 1);
  assert.equal(patients[0]?.studies[0]?.series[0]?.instances.length, 1);
});

test('series and studies group by their own UIDs, patients by id', () => {
  const chest = { studyInstanceUid: '1.2.3.100', studyDate: '20240310' };
  const older = { studyInstanceUid: '1.2.3.099', studyDate: '20220118' };

  const { patients } = buildIndex([
    header({ ...chest, seriesInstanceUid: 'S2', seriesNumber: 2, modality: 'CT' }),
    header({ ...chest, seriesInstanceUid: 'S1', seriesNumber: 1, modality: 'CT' }),
    header({ ...chest, seriesInstanceUid: 'S3', seriesNumber: 3, modality: 'SR' }),
    header({ ...older, seriesInstanceUid: 'S9', seriesNumber: 1, modality: 'MR' }),
    header({ patientId: 'PAT002', patientName: 'Bianchi Anna', seriesInstanceUid: 'S8' }),
  ]);

  assert.deepEqual(
    patients.map(p => p.patientId),
    ['PAT002', 'PAT001']
  );

  const mario = patients[1];
  // Most recent study first: that is the one being read.
  assert.deepEqual(
    mario?.studies.map(s => s.studyDate),
    ['20240310', '20220118']
  );
  assert.deepEqual(
    mario?.studies[0]?.series.map(s => s.seriesNumber),
    [1, 2, 3]
  );
  assert.deepEqual(mario?.studies[0]?.modalities, ['CT', 'SR']);
  assert.equal(mario?.studies[0]?.instanceCount, 3);
});

test('two spellings of a name under one id stay one patient', () => {
  // Registration desks retype names. Splitting the row would hide the priors
  // exactly when a radiologist is looking for them.
  const { patients } = buildIndex([
    header({ patientName: 'Rossi Mario' }),
    header({ patientName: 'ROSSI MARIO', studyInstanceUid: '1.2.3.101' }),
  ]);

  assert.equal(patients.length, 1);
  assert.equal(patients[0]?.studies.length, 2);
});

test('a file with no patient id at all still lands somewhere', () => {
  // Anonymised exports do this. Refusing to index them, or crashing, is worse
  // than a row that says it does not know who this is.
  const { patients } = buildIndex([header({ patientId: '', patientName: '' })]);

  assert.equal(patients.length, 1);
  assert.equal(patients[0]?.patientId, '(unidentified)');
});

test('images with no SOP Instance UID are not taken for copies of each other', () => {
  // Anonymisers blank the tag rather than removing it, and a header cut short
  // loses it the same way. Keying deduplication on the empty string collapsed
  // five different images into one and reported the other four as duplicates —
  // a false statement about four images that were simply gone.
  const anonymous = Array.from({ length: 5 }, (_, i) =>
    header({ sopInstanceUid: '', instanceNumber: i + 1 })
  );

  const { patients, duplicates } = buildIndex(anonymous);

  assert.equal(duplicates, 0);
  assert.equal(patients[0]?.studies[0]?.series[0]?.instances.length, 5);
  assert.equal(patients[0]?.studies[0]?.instanceCount, 5);
});

test('a real duplicate is still only counted once', () => {
  // The guard above must not turn deduplication off for everything else.
  const twice = [header({ sopInstanceUid: 'S.1' }), header({ sopInstanceUid: 'S.1' })];

  assert.equal(buildIndex(twice).duplicates, 1);
});
