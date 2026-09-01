/**
 * The memory of which screen a series was sent to.
 *
 * This file sits on someone's disk between sessions, which means it will be
 * truncated by a crash, hand-edited by somebody curious, and carried to a
 * machine with fewer monitors. The worst any of that should cause is that the
 * windows open where they would have opened the first time.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  arrangement,
  EMPTY,
  load,
  recall,
  remember,
  rememberFolder,
  save,
} from '../src/main/layout/store';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dicom-workstation-layout-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const DESK = 'b60acb6761b2';
const OTHER_DESK = '77a1cc00ff31';

function file(name: string, contents: string): string {
  const target = path.join(scratch, name);
  fs.writeFileSync(target, contents);
  return target;
}

test('a series comes back on the screen it was sent to', () => {
  const layouts = remember(EMPTY, DESK, 'S1', 2, 1000);

  assert.equal(recall(layouts, DESK, 'S1', 3), 2);
});

test('another desk is another arrangement, not a failure to remember', () => {
  // The same person at the laptop alone should not get the windows they left on
  // a three-monitor desk.
  const layouts = remember(EMPTY, DESK, 'S1', 2, 1000);

  assert.equal(recall(layouts, OTHER_DESK, 'S1', 3), undefined);
});

test('a screen that is no longer there is not used', () => {
  // Arranged on three monitors, opened on one. A window sent to pane 2 would
  // land somewhere nobody can see.
  const layouts = remember(EMPTY, DESK, 'S1', 2, 1000);

  assert.equal(recall(layouts, DESK, 'S1', 1), undefined);
  assert.deepEqual(arrangement(layouts, DESK, 1), []);
});

test('the last place a series was put is the one remembered', () => {
  let layouts = remember(EMPTY, DESK, 'S1', 2, 1000);
  layouts = remember(layouts, DESK, 'S1', 0, 2000);

  assert.equal(recall(layouts, DESK, 'S1', 3), 0);
});

test('the whole arrangement comes back, newest first', () => {
  let layouts = remember(EMPTY, DESK, 'S1', 1, 1000);
  layouts = remember(layouts, DESK, 'S2', 2, 3000);
  layouts = remember(layouts, DESK, 'S3', 0, 2000);

  assert.deepEqual(arrangement(layouts, DESK, 3), [
    { studyInstanceUid: 'S2', pane: 2 },
    { studyInstanceUid: 'S3', pane: 0 },
    { studyInstanceUid: 'S1', pane: 1 },
  ]);
});

test('remembering does not change the memory it was given', () => {
  // The caller holds the memory and decides when it reaches the disk. A
  // half-applied change that was never written is a memory that disagrees with
  // the file.
  const before = remember(EMPTY, DESK, 'S1', 1, 1000);
  const snapshot = JSON.stringify(before);

  remember(before, DESK, 'S2', 2, 2000);

  assert.equal(JSON.stringify(before), snapshot);
});

test('a memory survives a trip through the file', () => {
  const target = path.join(scratch, 'layouts.json');
  const layouts = remember(remember(EMPTY, DESK, 'S1', 1, 1000), OTHER_DESK, 'S9', 0, 2000);

  save(target, layouts);

  assert.deepEqual(load(target), layouts);
});

test('a file that is not there is an empty memory, not an error', () => {
  assert.deepEqual(load(path.join(scratch, 'never-written.json')), EMPTY);
});

test('a truncated file loses the memory and nothing else', () => {
  // What a crash during a write leaves behind.
  const target = file('truncated.json', '{"desks":{"b60acb6761b2":{"ser');

  assert.deepEqual(load(target), EMPTY);
});

test('a file of the wrong shape is ignored rather than trusted', () => {
  assert.deepEqual(load(file('array.json', '[1, 2, 3]')), EMPTY);
  assert.deepEqual(load(file('null.json', 'null')), EMPTY);
  assert.deepEqual(load(file('text.json', 'not json at all')), EMPTY);
  assert.deepEqual(load(file('empty-object.json', '{}')), EMPTY);
});

test('an entry that would send a window nowhere is dropped, and the rest kept', () => {
  // Hand-edited, or written by a version that meant something else by "pane".
  const target = file(
    'mixed.json',
    JSON.stringify({
      desks: {
        [DESK]: {
          studies: {
            good: { pane: 1, at: 1000 },
            negative: { pane: -1, at: 1000 },
            fractional: { pane: 1.5, at: 1000 },
            text: { pane: 'second', at: 1000 },
            undated: { pane: 1 },
          },
        },
      },
    })
  );

  const layouts = load(target);

  assert.deepEqual(Object.keys(layouts.desks[DESK]?.studies ?? {}), ['good']);
  assert.equal(recall(layouts, DESK, 'good', 3), 1);
});

test('a desk keeps a bounded number of series, dropping the oldest', () => {
  // A busy day is a lot of series, and this file is read at every launch.
  let layouts = EMPTY;
  for (let i = 0; i < 300; i++) {
    layouts = remember(layouts, DESK, `S${i}`, i % 3, 1000 + i);
  }

  const kept = Object.keys(layouts.desks[DESK]?.studies ?? {}).length;
  assert.ok(kept <= 200, `kept ${kept} series`);
  assert.equal(recall(layouts, DESK, 'S299', 3), 299 % 3, 'the newest should survive');
  assert.equal(recall(layouts, DESK, 'S0', 3), undefined, 'the oldest should not');
});

test('desks are bounded too, and the one in front of you is the one kept', () => {
  // A laptop that visits three sites is three desks a week. Which desk to drop
  // is decided by the most recent thing arranged on it, so the desk being used
  // right now survives however many were seen before it.
  let layouts = EMPTY;
  for (let i = 0; i < 40; i++) {
    layouts = remember(layouts, `desk-${i}`, 'S1', 0, 1000 + i);
  }
  layouts = remember(layouts, DESK, 'S1', 1, 9000);

  assert.ok(Object.keys(layouts.desks).length <= 24, 'desks grew without limit');
  assert.equal(recall(layouts, DESK, 'S1', 3), 1, 'the current desk was dropped');
  assert.equal(recall(layouts, 'desk-0', 'S1', 3), undefined, 'the oldest desk was kept');
  assert.equal(recall(layouts, 'desk-39', 'S1', 3), 0, 'a recent desk was dropped');
});

test('arranging on one desk does not copy the other desk onto it', () => {
  // The earlier test for this started from an empty memory, where a version
  // that read the wrong desk had nothing to read and looked correct. Two desks
  // that both hold something is the case that tells them apart.
  let layouts = remember(EMPTY, DESK, 'S1', 2, 1000);
  layouts = remember(layouts, OTHER_DESK, 'S2', 0, 2000);

  assert.deepEqual(arrangement(layouts, OTHER_DESK, 3), [{ studyInstanceUid: 'S2', pane: 0 }]);
  assert.equal(recall(layouts, OTHER_DESK, 'S1', 3), undefined);
  // And the first desk keeps what it had.
  assert.deepEqual(arrangement(layouts, DESK, 3), [{ studyInstanceUid: 'S1', pane: 2 }]);
});

test('a folder opened again moves to the top rather than appearing twice', () => {
  // A list that shows the same folder four times is a list nobody uses twice.
  let layouts = rememberFolder(EMPTY, '/studies/a');
  layouts = rememberFolder(layouts, '/studies/b');
  layouts = rememberFolder(layouts, '/studies/a');

  assert.deepEqual(layouts.recent, ['/studies/a', '/studies/b']);
});

test('the list of folders is bounded', () => {
  let layouts = EMPTY;
  for (let i = 0; i < 30; i++) {
    layouts = rememberFolder(layouts, `/studies/${i}`);
  }

  assert.ok((layouts.recent ?? []).length <= 8, `kept ${(layouts.recent ?? []).length}`);
  assert.equal(layouts.recent?.[0], '/studies/29', 'the newest should be first');
});

test('the folders survive a trip through the file', () => {
  const target = path.join(scratch, 'with-recent.json');
  const layouts = rememberFolder(remember(EMPTY, DESK, 'S1', 1, 1000), '/studies/a');

  save(target, layouts);

  assert.deepEqual(load(target).recent, ['/studies/a']);
});

test('a folder list of the wrong shape is ignored rather than trusted', () => {
  const target = file(
    'bad-recent.json',
    JSON.stringify({ desks: {}, recent: ['/studies/a', 42, null, '', '/studies/b'] })
  );

  assert.deepEqual(load(target).recent, ['/studies/a', '/studies/b']);
});

test('placements written by the version that keyed them by series are let go', () => {
  // They were keyed by series UID; they are keyed by study UID now, because a
  // study is what gets sent to a screen. A series UID will never match a study
  // UID, so keeping them would leave entries that can never be used — and a
  // file from an older version has to load rather than throw.
  const target = file(
    'older.json',
    JSON.stringify({
      desks: { [DESK]: { series: { 'a.series.uid': { pane: 1, at: 1000 } } } },
      recent: ['C:/studies'],
    })
  );

  const layouts = load(target);

  assert.deepEqual(Object.keys(layouts.desks[DESK]?.studies ?? {}), []);
  // What is not about placement survives.
  assert.deepEqual(layouts.recent, ['C:/studies']);
});

test('arranging a window does not throw away the folders opened before', () => {
  // Both returns from remember() used to build a fresh object holding only the
  // desks, so the list of recent folders was wiped from the file the next time
  // it was saved — which is to say, every time a study was sent to a screen.
  const withFolders = rememberFolder({ desks: {}, recent: [] }, 'C:/studies/april');

  const after = remember(withFolders, DESK, '1.2.3', 1, 1000);
  assert.deepEqual(after.recent, ['C:/studies/april']);

  // And through the overflow, where the oldest desks are dropped.
  let many = withFolders;
  for (let desk = 0; desk < 40; desk++) {
    many = remember(many, `desk-${desk}`, '1.2.3', 0, desk);
  }
  assert.deepEqual(many.recent, ['C:/studies/april']);
});
