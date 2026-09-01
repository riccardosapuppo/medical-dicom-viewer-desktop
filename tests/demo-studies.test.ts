/**
 * The demonstration folder holds these studies and nothing else.
 *
 * This exists because of a specific failure. The folder used to be written by
 * two different things — a downloader and a generator of synthetic studies —
 * and the application indexes everything it finds there and presents it as one
 * library. So a drawn patient sat beside the real ones, and what it looked like
 * was a viewer showing a phantom.
 *
 * Removing the stray entries was written once and never called, and nothing
 * noticed, because it lived inside a script and a script is not something a
 * test can reach. So it lives in a module now, and this exercises it against a
 * real folder on a real disc — what it does is delete things, and there is no
 * honest way to test that without doing it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// @ts-expect-error - plain JavaScript on purpose. The download it belongs to is
// run by somebody setting the project up, and one fewer build step is one fewer
// thing standing between them and the studies.
import { belongsHere, tidy } from '../tools/demo-folder.mjs';

const STUDIES = [
  {
    collection: 'LIDC-IDRI',
    series: [{ seriesInstanceUID: '1.2.840.1' }],
  },
  {
    collection: 'CMMD',
    series: [{ seriesInstanceUID: '1.2.840.2' }, { seriesInstanceUID: '1.2.840.3' }],
  },
];

/** A folder laid out the way the downloader lays one out. */
function folder(contents: Record<string, string[]>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-studies-'));

  for (const [where, files] of Object.entries(contents)) {
    const full = path.join(root, ...where.split('/'));
    fs.mkdirSync(full, { recursive: true });
    for (const name of files) {
      fs.writeFileSync(path.join(full, name), 'not really a study');
    }
  }
  return root;
}

function everything(root: string, prefix = ''): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const shown = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [shown, ...everything(path.join(root, entry.name), shown)] : [shown];
  });
}

test('what belongs is every series of every study, and the licence', () => {
  const wanted = belongsHere(STUDIES) as Map<string, Set<string>>;

  assert.deepEqual([...wanted.keys()].sort(), ['CMMD', 'LIDC-IDRI']);
  assert.deepEqual([...(wanted.get('CMMD') ?? [])].sort(), [
    '1.2.840.2',
    '1.2.840.3',
    'LICENSE',
  ]);

  // The archive ships the collection's licence inside the download and it is
  // kept beside the images it applies to, so it is not something to sweep away.
  assert.ok(wanted.get('LIDC-IDRI')?.has('LICENSE'));
});

test('an older set of studies left in the folder is removed', () => {
  const root = folder({
    'LIDC-IDRI/1.2.840.1': ['0001.dcm'],
    'bianchi-anna/20220118-ct-chest/series-02': ['image-0001.dcm'],
  });

  const removed = tidy(root, STUDIES) as string[];

  assert.deepEqual(removed, ['bianchi-anna']);
  assert.ok(fs.existsSync(path.join(root, 'LIDC-IDRI', '1.2.840.1', '0001.dcm')));
  assert.equal(fs.existsSync(path.join(root, 'bianchi-anna')), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('a series dropped from the list goes, and its neighbours stay', () => {
  const root = folder({
    'CMMD/1.2.840.2': ['0001.dcm'],
    'CMMD/1.2.840.3': ['0001.dcm'],
    'CMMD/1.2.840.999': ['0001.dcm'],
  });

  const removed = tidy(root, STUDIES) as string[];

  assert.deepEqual(removed, ['CMMD/1.2.840.999']);
  assert.deepEqual(everything(root).sort(), [
    'CMMD',
    'CMMD/1.2.840.2',
    'CMMD/1.2.840.2/0001.dcm',
    'CMMD/1.2.840.3',
    'CMMD/1.2.840.3/0001.dcm',
  ]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('a stray file at the top is removed too', () => {
  // The generator that used to write here left a readme behind, and it survived
  // every download after it.
  const root = folder({ 'LIDC-IDRI/1.2.840.1': ['0001.dcm'] });
  fs.writeFileSync(path.join(root, 'README.TXT'), 'from something else');

  const removed = tidy(root, STUDIES) as string[];

  assert.deepEqual(removed, ['README.TXT']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the licence beside the images is left alone', () => {
  const root = folder({ 'LIDC-IDRI/1.2.840.1': ['0001.dcm'] });
  fs.writeFileSync(path.join(root, 'LIDC-IDRI', 'LICENSE'), 'CC BY 3.0');

  assert.deepEqual(tidy(root, STUDIES) as string[], []);
  assert.ok(fs.existsSync(path.join(root, 'LIDC-IDRI', 'LICENSE')));

  fs.rmSync(root, { recursive: true, force: true });
});

test('a folder that holds exactly these studies is left untouched', () => {
  const root = folder({
    'LIDC-IDRI/1.2.840.1': ['0001.dcm'],
    'CMMD/1.2.840.2': ['0001.dcm'],
    'CMMD/1.2.840.3': ['0001.dcm'],
  });

  const before = everything(root).sort();
  assert.deepEqual(tidy(root, STUDIES) as string[], []);
  assert.deepEqual(everything(root).sort(), before);

  fs.rmSync(root, { recursive: true, force: true });
});

test('a folder that is not there is not an error', () => {
  const missing = path.join(os.tmpdir(), 'demo-studies-that-do-not-exist');
  assert.deepEqual(tidy(missing, STUDIES) as string[], []);
});
