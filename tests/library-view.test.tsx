/**
 * The worklist, rendered.
 *
 * Two of these exist because of things that are invisible on a normal folder
 * and wrong on an awkward one: a folder whose every DICOM file is broken, and
 * two patients who both have no identifier. Neither shows up on the demo data,
 * and both are ordinary in an archive.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Index, Patient } from '../src/main/dicom/build-index';
import { Library } from '../src/renderer/Library';
import type { LibraryReading } from '../src/renderer/useLibrary';

function patient(partial: Partial<Patient> = {}): Patient {
  return {
    patientId: 'DEMO-0001',
    name: 'Bianchi Anna',
    birthDate: '19631104',
    sex: 'F',
    studies: [
      {
        studyInstanceUid: `1.2.3.${partial.patientId ?? 'x'}`,
        studyDate: '20240412',
        studyTime: '093015',
        description: 'CT CHEST',
        accessionNumber: 'A-1',
        modalities: ['CT'],
        instanceCount: 1,
        series: [],
      },
    ],
    ...partial,
  };
}

function reading(index: Index, partial: Partial<LibraryReading> = {}): LibraryReading {
  return {
    folder: '/studies',
    index,
    found: 1,
    read: 1,
    skipped: 0,
    unreadable: [],
    elapsedMs: 10,
    ...partial,
  };
}

/**
 * Renders, and keeps whatever React complained about while doing it.
 *
 * The complaint is the point for one of these: two rows given the same key
 * render fine the first time and go wrong on the next update, when React
 * reconciles them as though they were the same row. Nothing about the markup
 * shows it, and the warning is the only signal there is.
 */
function renderWithWarnings(r: LibraryReading): { markup: string; warnings: string[] } {
  const warnings: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

  try {
    return {
      markup: renderToStaticMarkup(<Library reading={r} onOpen={() => {}} screens={1} />),
      warnings,
    };
  } finally {
    console.error = real;
  }
}

const render = (r: LibraryReading): string => renderWithWarnings(r).markup;

test('a folder of nothing but broken images does not say there was nothing', () => {
  // "No DICOM files in this folder" is the wrong sentence when there were
  // plenty and none of them would parse. That is a folder of broken images,
  // which is somebody's problem, and the list of what failed is the useful part.
  const markup = render(
    reading(
      { patients: [], duplicates: 0 },
      {
        found: 3,
        read: 0,
        unreadable: [
          { filePath: '/studies/a.dcm', reason: 'buffer overrun' },
          { filePath: '/studies/b.dcm', reason: 'buffer overrun' },
          { filePath: '/studies/c.dcm', reason: 'no DICM marker' },
        ],
      }
    )
  );

  assert.ok(!markup.includes('No DICOM files in this folder'), 'it claimed the folder was empty');
  assert.ok(markup.includes('Nothing in this folder could be read'));
  assert.ok(markup.includes('a.dcm') && markup.includes('c.dcm'), 'the failures were hidden');
});

test('a folder with nothing in it still says so', () => {
  const markup = render(reading({ patients: [], duplicates: 0 }, { skipped: 4 }));

  assert.ok(markup.includes('No DICOM files in this folder'));
});

test('two patients with no identifier get keys of their own', () => {
  // Anonymised exports have no PatientID. Two rows under one key render fine
  // the first time and go wrong on the next update, when React treats them as
  // the same row — a patient who changes into another patient, with nothing
  // anywhere saying why.
  const { markup, warnings } = renderWithWarnings(
    reading({
      patients: [
        patient({ patientId: '(unidentified)', name: 'Case One' }),
        patient({ patientId: '(unidentified)', name: 'Case Two' }),
      ],
      duplicates: 0,
    })
  );

  assert.ok(markup.includes('Case One'));
  assert.ok(markup.includes('Case Two'));
  assert.deepEqual(
    warnings.filter(w => /key/i.test(w)),
    [],
    'React was given the same key twice'
  );
});

test('a study with nothing filled in still renders a row', () => {
  // Every one of these fields is optional in a real file, and a worklist that
  // throws on a blank description is a worklist that cannot open the folder.
  const bare = patient({
    patientId: '',
    name: '',
    birthDate: '',
    sex: '',
    studies: [
      {
        studyInstanceUid: '1.2.3.9',
        studyDate: '',
        studyTime: '',
        description: '',
        accessionNumber: '',
        modalities: [],
        instanceCount: 0,
        series: [],
      },
    ],
  });

  const markup = render(reading({ patients: [bare], duplicates: 0 }));

  assert.ok(markup.includes('unidentified'));
  assert.ok(markup.includes('undated'));
  assert.ok(markup.includes('no description'));
});
