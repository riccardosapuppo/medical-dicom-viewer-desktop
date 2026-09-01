/**
 * The small functions that turn stored values into readable ones.
 *
 * These are here because one of them shipped returning its own source code.
 * It was written through a script that mangled the escaping, and it type-checked
 * perfectly: the function had the right signature, returned a string, and the
 * string happened to be the text of the template literal rather than its
 * result. Nothing but calling it would have caught that.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  age,
  patientKey,
  patientLabel,
  readableDate,
  readableSize,
  readableTime,
  tailOfPath,
} from '../src/renderer/format';

test('a DICOM date reads as a date', () => {
  assert.equal(readableDate('20240412'), '12 Apr 2024');
  assert.equal(readableDate('20220118'), '18 Jan 2022');
  assert.equal(readableDate('19581231'), '31 Dec 1958');
});

test('anything that is not a date is left alone rather than invented', () => {
  assert.equal(readableDate(''), 'undated');
  assert.equal(readableDate('2024'), '2024');
  // Month 13 means the field is not what it claims. Naming it would hide that.
  assert.equal(readableDate('20241301'), '20241301');
});

test('a time reads as a time, and a non-time reads as nothing', () => {
  assert.equal(readableTime('093015'), '09:30');
  assert.equal(readableTime('1710'), '17:10');
  assert.equal(readableTime(''), '');
  assert.equal(readableTime('morning'), '');
});

test('age is years at the study, or blank when the numbers do not allow it', () => {
  assert.equal(age('19631104', '20240412'), '60y');
  assert.equal(age('19631104', '20231103'), '59y');
  assert.equal(age('', '20240412'), '');
  // A study dated before the birth date, and an age nobody has reached: both
  // mean the data is wrong, and a worklist that prints 140y is not trusted again.
  assert.equal(age('20240412', '19631104'), '');
  assert.equal(age('18700101', '20240412'), '');
});

test('a path shows its folder and its parent, with the separator it came with', () => {
  assert.equal(
    tailOfPath('C:' + String.fromCharCode(92) + 'archive' + String.fromCharCode(92) + 'bianchi' + String.fromCharCode(92) + 'ct-chest'),
    '...' + String.fromCharCode(92) + 'bianchi' + String.fromCharCode(92) + 'ct-chest'
  );
  assert.equal(tailOfPath('/mnt/archive/bianchi/ct-chest'), '.../bianchi/ct-chest');
});

test('a short path is shown whole', () => {
  assert.equal(tailOfPath('/studies'), '/studies');
  assert.equal(tailOfPath('demo-data'), 'demo-data');
});

test('the shortened path is a path, not the source of one', () => {
  // The exact failure this file exists for: a template literal that was escaped
  // one level too far came back as its own text.
  const shortened = tailOfPath('/a/b/c/d');

  assert.equal(shortened, '.../c/d');
  assert.ok(!shortened.includes('$'), 'an unexpanded placeholder means the literal was escaped');
  assert.ok(!shortened.includes('slice'));
});

test('sizes read the way a person says them', () => {
  assert.equal(readableSize(512 * 1024), '512 KB');
  assert.equal(readableSize(8.5 * 1024 * 1024), '8.5 MB');
  assert.equal(readableSize(2.5 * 1024 * 1024 * 1024), '2.5 GB');
  // Never zero: a file that exists is at least something.
  assert.equal(readableSize(10), '1 KB');
});

test('two patients with no identifier are listed under different keys', () => {
  // Anonymised exports have no PatientID. Two rows under one key render
  // correctly the first time and go wrong on the next update, when React
  // reconciles them as though they were the same row.
  //
  // Tested here rather than by rendering, because rendering says nothing about
  // it: server rendering does not warn on a duplicate key and the markup is
  // identical either way. The only way to check is to call the function.
  const one = patientKey({ patientId: '(unidentified)', name: 'Case One' });
  const two = patientKey({ patientId: '(unidentified)', name: 'Case Two' });

  assert.notEqual(one, two);
});

test('the same patient always gets the same key', () => {
  const patient = { patientId: 'DEMO-0001', name: 'Bianchi Anna' };

  assert.equal(patientKey(patient), patientKey({ ...patient }));
  assert.notEqual(patientKey(patient), patientKey({ ...patient, patientId: 'DEMO-0002' }));
});

test('a patient with no name is labelled by the identifier the file does carry', () => {
  // Public archives blank the name element and leave the identifier. Listing
  // every such row as "unidentified" reads as a fault in the reader rather than
  // as the anonymisation it is.
  assert.equal(
    patientLabel({ patientId: 'LIDC-IDRI-0001', name: '' }),
    'Anonymized — LIDC-IDRI-0001'
  );

  // A name, when there is one, is used as it is. Nothing is invented.
  assert.equal(patientLabel({ patientId: 'X1', name: 'Rossi^Mario' }), 'Rossi^Mario');

  // Neither: there is genuinely nothing to say.
  assert.equal(patientLabel({ patientId: '', name: '' }), 'Unidentified');
});
