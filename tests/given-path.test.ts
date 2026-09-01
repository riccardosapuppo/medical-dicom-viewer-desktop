/**
 * A folder name with a caret in it, typed on a Windows command line.
 *
 * DICOM separates the parts of a name with a caret, so a folder written by an
 * archive is very often called something like `DOE^JANE-1.2.826.0.1…`. Handed
 * to a tool through `npm run`, that path passes through cmd twice and the caret
 * comes out doubled — so the tool reports there is nothing there, on the exact
 * kind of folder it was written to look at.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { givenPath } from '../tools/given-path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dicom-given-path-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** A folder whose name carries a caret, as an archive would write it. */
const real = path.join(scratch, 'DOE^JANE-1.2.826.0.1.3680043');
fs.mkdirSync(real, { recursive: true });

test('a path that is there is used as it is', () => {
  const given = givenPath(real);

  assert.equal(given.folder, real);
  assert.equal(given.corrected, undefined);
});

test('a doubled caret is undone when that is what is on the disc', () => {
  const doubled = real.split('^').join('^^');
  const given = givenPath(doubled);

  assert.equal(given.folder, real);
  // Said rather than silently fixed: the same doubling happens to every other
  // command given the same folder.
  assert.equal(given.corrected, doubled);
});

test('nothing is guessed: a path that is not there either way is left alone', () => {
  const nowhere = path.join(scratch, 'NOBODY^^HERE');
  const given = givenPath(nowhere);

  assert.equal(given.folder, nowhere);
  assert.equal(given.corrected, undefined);
});

test('a real folder whose name genuinely holds two carets is not touched', () => {
  // The correction only ever applies when the path as given is absent. A folder
  // that really is called this one keeps its name.
  const twice = path.join(scratch, 'TWO^^CARETS');
  fs.mkdirSync(twice, { recursive: true });

  const given = givenPath(twice);
  assert.equal(given.folder, twice);
  assert.equal(given.corrected, undefined);
});

test('an empty argument is left to whoever asked for it', () => {
  assert.equal(givenPath('').folder, '');
});
