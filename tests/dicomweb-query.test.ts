/**
 * The desktop side answers DICOMweb so the web viewer can be the viewer here
 * too. These tests are about the two things a query layer actually gets wrong:
 * counting, and matching what someone typed.
 *
 * The index is built by `buildIndex` from real headers rather than assembled by
 * hand, so a change to how studies are grouped is felt here as well.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildIndex } from '../src/main/dicom/build-index';
import type { InstanceHeader } from '../src/main/dicom/read-header';
import {
  allSeriesQuery,
  applyFilters,
  instanceQuery,
  matches,
  readFilters,
  seriesQuery,
  studyQuery,
} from '../src/main/dicomweb/qido';
import type { QueryResult } from '../src/main/dicomweb/qido';

const WADO = 'http://127.0.0.1:7654/dicom-web';

let counter = 0;

function header(partial: Partial<InstanceHeader> = {}): InstanceHeader {
  counter++;
  return {
    filePath: `/studies/file-${counter}.dcm`,
    fileSize: 524288,

    patientId: 'PAT001',
    patientName: 'Rossi^Mario',
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

function valueOf(result: QueryResult | undefined, tag: string): unknown {
  return result?.[tag]?.Value?.[0];
}

test('a study reports how many series and how many images it holds', () => {
  const index = buildIndex([
    header({ seriesInstanceUid: '1.2.3.100.1' }),
    header({ seriesInstanceUid: '1.2.3.100.1' }),
    header({ seriesInstanceUid: '1.2.3.100.2', seriesNumber: 2 }),
  ]);

  const [study] = studyQuery(index, WADO);

  // Three images across two series. Counting instances as series is the classic
  // slip, and it shows up in the viewer as a study list that reads "3 series".
  assert.equal(valueOf(study, '00201206'), 2);
  assert.equal(valueOf(study, '00201208'), 3);
});

test('a name is sent as an object, because that is what the viewer reads', () => {
  const index = buildIndex([header({ patientName: 'Rossi^Mario' })]);
  const [study] = studyQuery(index, WADO);

  // A bare string here leaves the study list showing a blank name: the viewer
  // looks for `Alphabetic` and finds nothing to look inside.
  assert.deepEqual(valueOf(study, '00100010'), { Alphabetic: 'Rossi^Mario' });
});

test('the modalities of a study are listed once each', () => {
  const index = buildIndex([
    header({ modality: 'CT', seriesInstanceUid: '1.2.3.100.1' }),
    header({ modality: 'CT', seriesInstanceUid: '1.2.3.100.2' }),
    header({ modality: 'SEG', seriesInstanceUid: '1.2.3.100.3' }),
  ]);

  const [study] = studyQuery(index, WADO);
  assert.deepEqual(study?.['00080061']?.Value, ['CT', 'SEG']);
});

test('an empty element is present without a value, never absent', () => {
  const index = buildIndex([header({ accessionNumber: '', studyDescription: '' })]);
  const [study] = studyQuery(index, WADO);

  // The tag has to be there so the viewer knows the archive answered the
  // question; it just has nothing to say.
  assert.ok(study && '00080050' in study);
  assert.equal(study['00080050']?.Value, undefined);
});

test('series and instances answer at their own addresses', () => {
  const index = buildIndex([
    header({ seriesInstanceUid: '1.2.3.100.1', seriesDescription: 'AXIAL 1MM' }),
    header({ seriesInstanceUid: '1.2.3.100.2', seriesNumber: 2, seriesDescription: 'SCOUT' }),
  ]);

  const series = seriesQuery(index, '1.2.3.100', WADO);
  assert.equal(series.length, 2);
  assert.equal(valueOf(series[1], '0008103E'), 'SCOUT');
  assert.equal(valueOf(series[0], '00201209'), 1);

  const instances = instanceQuery(index, '1.2.3.100', '1.2.3.100.1', WADO);
  assert.equal(instances.length, 1);
  assert.equal(valueOf(instances[0], '00280010'), 512);
  assert.equal(valueOf(instances[0], '00280008'), 1);
});

test('asking about a study that is not here is an empty answer, not a crash', () => {
  const index = buildIndex([header()]);

  assert.equal(seriesQuery(index, '9.9.9', WADO).length, 0);
  assert.equal(instanceQuery(index, '1.2.3.100', '9.9.9', WADO).length, 0);
  assert.equal(instanceQuery(index, '9.9.9', '1.2.3.100.1', WADO).length, 0);
});

test('every series in the folder can be asked for at once', () => {
  const index = buildIndex([
    header({ studyInstanceUid: '1.2.3.100', seriesInstanceUid: '1.2.3.100.1' }),
    header({ studyInstanceUid: '1.2.3.200', seriesInstanceUid: '1.2.3.200.1' }),
  ]);

  assert.equal(allSeriesQuery(index, WADO).length, 2);
});

test('a retrieve address points at the study it belongs to', () => {
  const index = buildIndex([header()]);
  const [study] = studyQuery(index, WADO);

  assert.equal(valueOf(study, '00081190'), `${WADO}/studies/1.2.3.100`);
});

test('wildcards match the way the standard says', () => {
  assert.ok(matches('Rossi^Mario', 'Ros*'));
  assert.ok(matches('Rossi^Mario', '*Mario'));
  assert.ok(matches('Rossi^Mario', '*ssi*'));
  assert.ok(matches('Rossi^Mario', 'Rossi^Mari?'));
  assert.ok(matches('Rossi^Mario', '*'));
  assert.ok(!matches('Rossi^Mario', 'Bianchi*'));
  assert.ok(!matches('Rossi^Mario', 'Rossi'));
  assert.ok(!matches('Rossi', 'Rossi^Mario'));

  // Case is not significant in a name query.
  assert.ok(matches('Rossi^Mario', 'rossi*'));

  // Several wildcards in a row, and one that has to give ground before the rest
  // fits — the case a single forward pass gets wrong.
  assert.ok(matches('aaab', '*a*b'));
  assert.ok(matches('abcabc', '*abc'));
  assert.ok(!matches('abcabd', '*abc'));
});

test('a name that looks like a pattern is matched as a name', () => {
  // Names carry brackets and full stops. Built into a regular expression by
  // hand, these stop meaning themselves.
  assert.ok(matches('O.Brien^S.', 'O.Brien*'));
  assert.ok(!matches('OXBrien^S.', 'O.Brien*'));
  assert.ok(matches('Smith (jr)^A', 'Smith (jr)*'));
});

test('a search narrows the list instead of quietly ignoring what was typed', () => {
  const index = buildIndex([
    header({ studyInstanceUid: '1.2.3.100', patientName: 'Rossi^Mario', studyDate: '20240310' }),
    header({
      studyInstanceUid: '1.2.3.200',
      patientId: 'PAT002',
      patientName: 'Bianchi^Anna',
      studyDate: '20230101',
      modality: 'MR',
      seriesInstanceUid: '1.2.3.200.1',
    }),
  ]);
  const all = studyQuery(index, WADO);
  assert.equal(all.length, 2);

  const byName = applyFilters(all, { patientName: 'Bianchi*' });
  assert.equal(byName.length, 1);
  assert.equal(valueOf(byName[0], '0020000D'), '1.2.3.200');

  const byModality = applyFilters(all, { modality: 'mr' });
  assert.equal(byModality.length, 1);

  const inRange = applyFilters(all, { studyDateFrom: '20240101', studyDateTo: '20241231' });
  assert.equal(inRange.length, 1);
  assert.equal(valueOf(inRange[0], '0020000D'), '1.2.3.100');

  // A filter that matches nobody returns nobody. Falling back to the whole list
  // would look like a working search that ignores its own box.
  assert.equal(applyFilters(all, { patientName: 'Verdi*' }).length, 0);
});

test('a date range with one open end is a real query', () => {
  const onlyFrom = readFilters(new URLSearchParams('StudyDate=20240101-'));
  assert.equal(onlyFrom.studyDateFrom, '20240101');
  assert.equal(onlyFrom.studyDateTo, undefined);

  const onlyTo = readFilters(new URLSearchParams('StudyDate=-20241231'));
  assert.equal(onlyTo.studyDateFrom, undefined);
  assert.equal(onlyTo.studyDateTo, '20241231');

  const single = readFilters(new URLSearchParams('StudyDate=20240310'));
  assert.equal(single.studyDateFrom, '20240310');
  assert.equal(single.studyDateTo, '20240310');
});

test('parameters are read by name or by tag, as either may arrive', () => {
  const byName = readFilters(new URLSearchParams('PatientName=Rossi*&limit=25&offset=50'));
  assert.equal(byName.patientName, 'Rossi*');
  assert.equal(byName.limit, 25);
  assert.equal(byName.offset, 50);

  const byTag = readFilters(new URLSearchParams('00100010=Rossi*'));
  assert.equal(byTag.patientName, 'Rossi*');
});

test('an absent parameter leaves no filter behind', () => {
  const empty = readFilters(new URLSearchParams('PatientName=&limit=0'));

  // An empty box means "show me everything". Recorded as a filter it would mean
  // "show me the patients with no name", which is nobody.
  assert.equal('patientName' in empty, false);
  assert.equal(empty.limit, undefined);
});

test('a page of results starts where it was asked to', () => {
  const index = buildIndex(
    Array.from({ length: 5 }, (unused, at) =>
      header({
        studyInstanceUid: `1.2.3.${at}`,
        patientId: `PAT00${at}`,
        seriesInstanceUid: `1.2.3.${at}.1`,
      })
    )
  );
  const all = studyQuery(index, WADO);
  assert.equal(all.length, 5);

  const page = applyFilters(all, { offset: 2, limit: 2 });
  assert.equal(page.length, 2);
  assert.equal(valueOf(page[0], '0020000D'), '1.2.3.2');

  // Past the end is an empty page, not the last one over again.
  assert.equal(applyFilters(all, { offset: 99, limit: 2 }).length, 0);
});
