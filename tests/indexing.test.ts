/**
 * Reading folders in the background, without a background.
 *
 * Everything awkward about it — a second folder arriving before the first has
 * finished, a cancel that must stop work already in flight, eight readers that
 * each report one more file after nobody is listening — is exercised here with
 * a stand-in for the reading itself, so the timing is decided by the test
 * rather than by a disk.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { IndexOptions, IndexResult } from '../src/main/dicom/index-folder';
import { createIndexing, type Send } from '../src/main/library/indexing';
import type { FromIndexer } from '../src/main/library/messages';

const EMPTY_INDEX: IndexResult = {
  index: { patients: [], duplicates: 0 },
  found: 0,
  read: 0,
  skipped: 0,
  unreadable: [],
  elapsedMs: 1,
};

/** A reading that finishes when the test says so, and reports what the test says. */
function controllable() {
  const calls: Array<{
    folder: string;
    options: IndexOptions;
    finish: (result?: Partial<IndexResult>) => void;
    fail: (reason: string) => void;
  }> = [];

  const index = (folder: string, options: IndexOptions): Promise<IndexResult> =>
    new Promise<IndexResult>((resolve, reject) => {
      calls.push({
        folder,
        options,
        finish: (result = {}) => resolve({ ...EMPTY_INDEX, ...result }),
        fail: (reason: string) => reject(new Error(reason)),
      });
    });

  return { calls, index };
}

function collector(): { sent: FromIndexer[]; send: Send } {
  const sent: FromIndexer[] = [];
  return { sent, send: message => sent.push(message) };
}

/** Lets the promise callbacks queued by a finish or a fail actually run. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('progress carries the folder it belongs to', async () => {
  const { sent, send } = collector();
  const { calls, index } = controllable();
  createIndexing(send, index).handle({ type: 'index', folder: '/studies/a' });

  calls[0]?.options.onProgress?.(5, 10);

  assert.deepEqual(sent, [{ type: 'progress', folder: '/studies/a', done: 5, total: 10 }]);
});

test('progress is reported once per percent, not once per file', async () => {
  // A message per file costs more than the reading does on a fast disk.
  const { sent, send } = collector();
  const { calls, index } = controllable();
  createIndexing(send, index).handle({ type: 'index', folder: '/studies/a' });

  for (let done = 1; done <= 1000; done++) {
    calls[0]?.options.onProgress?.(done, 1000);
  }

  assert.ok(sent.length <= 101, `sent ${sent.length} messages for 1000 files`);
  assert.ok(sent.length >= 100);
});

test('a folder that was abandoned stops reporting', async () => {
  // The readers already in flight each finish their file and report it. Sending
  // those numbers moves the progress bar of whatever is being read now, and a
  // twelve-file folder appears to be twelve thousand files in.
  const { sent, send } = collector();
  const { calls, index } = controllable();
  const indexing = createIndexing(send, index);

  indexing.handle({ type: 'index', folder: '/studies/big' });
  indexing.handle({ type: 'index', folder: '/studies/small' });
  sent.length = 0;

  calls[0]?.options.onProgress?.(3000, 8000);

  assert.equal(sent.length, 0, 'the abandoned folder was still driving the bar');
});

test('a second folder aborts the first', async () => {
  const { send } = collector();
  const { calls, index } = controllable();
  const indexing = createIndexing(send, index);

  indexing.handle({ type: 'index', folder: '/studies/big' });
  indexing.handle({ type: 'index', folder: '/studies/small' });

  assert.equal(calls[0]?.options.signal?.aborted, true);
  assert.equal(calls[1]?.options.signal?.aborted, false);
});

test('the answer to an abandoned folder is never delivered', async () => {
  // It arrives after the user has moved on, and showing it would swap the list
  // back to the folder they left.
  const { sent, send } = collector();
  const { calls, index } = controllable();
  const indexing = createIndexing(send, index);

  indexing.handle({ type: 'index', folder: '/studies/big' });
  indexing.handle({ type: 'index', folder: '/studies/small' });
  sent.length = 0;

  calls[0]?.finish({ read: 8000 });
  await settle();

  assert.equal(sent.length, 0);

  calls[1]?.finish({ read: 12 });
  await settle();

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, 'done');
  assert.equal(sent[0]?.type === 'done' ? sent[0].folder : '', '/studies/small');
});

test('a cancel stops the reading and everything it would have said', async () => {
  const { sent, send } = collector();
  const { calls, index } = controllable();
  const indexing = createIndexing(send, index);

  indexing.handle({ type: 'index', folder: '/studies/a' });
  indexing.handle({ type: 'cancel' });

  assert.equal(calls[0]?.options.signal?.aborted, true);

  calls[0]?.options.onProgress?.(4, 10);
  calls[0]?.finish();
  await settle();

  assert.equal(sent.length, 0);
});

test('a folder that cannot be read is reported with the reason', async () => {
  const { sent, send } = collector();
  const { calls, index } = controllable();
  createIndexing(send, index).handle({ type: 'index', folder: '/studies/gone' });

  calls[0]?.fail('There is nothing at /studies/gone.');
  await settle();

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, 'failed');
  assert.match(sent[0]?.type === 'failed' ? sent[0].reason : '', /nothing at/);
});

test('a cancel before anything was started is not an error', async () => {
  const { sent, send } = collector();
  const { index } = controllable();

  createIndexing(send, index).handle({ type: 'cancel' });

  assert.equal(sent.length, 0);
});

test('everything the reading found is passed on', async () => {
  const { sent, send } = collector();
  const { calls, index } = controllable();
  createIndexing(send, index).handle({ type: 'index', folder: '/studies/a' });

  calls[0]?.finish({
    found: 140,
    read: 134,
    skipped: 5,
    unreadable: [{ filePath: '/studies/a/broken.dcm', reason: 'no DICM marker' }],
    elapsedMs: 62,
  });
  await settle();

  const done = sent[0];
  assert.equal(done?.type, 'done');
  if (done?.type === 'done') {
    assert.equal(done.found, 140);
    assert.equal(done.read, 134);
    assert.equal(done.skipped, 5);
    assert.equal(done.unreadable.length, 1);
    assert.equal(done.elapsedMs, 62);
  }
});
