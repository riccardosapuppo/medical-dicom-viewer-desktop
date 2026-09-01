/**
 * The archive, exercised the way the viewer uses it: over a real socket,
 * against a real folder of files, reading the answers as they arrive on the
 * wire.
 *
 * Mocking the socket here would test the wrong half. What can go wrong is the
 * shape of a multipart body, a header the browser needs and did not get, or a
 * frame served at the wrong offset — none of which a fake HTTP layer would
 * notice.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { indexFolder } from '../src/main/dicom/index-folder';
import type { Index } from '../src/main/dicom/build-index';
import { startArchive } from '../src/main/dicomweb/server';
import type { Archive } from '../src/main/dicomweb/server';
import { generate } from '../tools/demo-study';

let archive: Archive;
let index: Index;
/** Set when this file made its own studies and therefore has to clear them up. */
let temporary: string | undefined;

/**
 * Studies to serve: the ones already on this machine, or a fresh set.
 *
 * The demo folder is not committed, so a run that finds it missing used to skip
 * every test in this file — fourteen skips read as fourteen passes, and the
 * archive would have gone unexercised on every machine but this one. Making the
 * studies when they are absent is a second or two, and it costs nothing on a
 * machine that already has them.
 */
function studies(): string {
  const existing = path.resolve(process.cwd(), 'demo-data');
  if (fs.existsSync(existing)) {
    return existing;
  }
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dicom-archive-'));
  generate(temporary);
  return temporary;
}

before(async () => {
  index = (await indexFolder(studies())).index;
  archive = await startArchive(index);
});

after(async () => {
  if (archive) {
    await archive.close();
  }
  if (temporary) {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

/** The first study, series and image in the folder, whatever they are called. */
function anything(): { study: string; series: string; instance: string } {
  const study = index.patients[0]?.studies[0];
  const series = study?.series[0];
  const instance = series?.instances[0];
  assert.ok(study && series && instance, 'the demo folder holds at least one image');
  return {
    study: study.studyInstanceUid,
    series: series.seriesInstanceUid,
    instance: instance.sopInstanceUid,
  };
}

test('the study list is answered as DICOM JSON', { timeout: 20000 }, async () => {
  const response = await fetch(`${archive.root}/studies`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/dicom+json');

  const studies = (await response.json()) as Array<Record<string, { Value?: unknown[] }>>;
  assert.ok(studies.length > 0);
  assert.ok(studies[0]?.['0020000D']?.Value?.[0]);
});

test('a browser is told it may read the answer', { timeout: 20000 }, async () => {
  // The window is served from a different scheme than this socket, so without
  // this header every request the viewer makes fails before it is read.
  const response = await fetch(`${archive.root}/studies`);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');

  const preflight = await fetch(`${archive.root}/studies`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /GET/);
});

test('guessing the port is not enough to read a study', { timeout: 20000 }, async () => {
  const withoutSecret = archive.root.replace(/\/[0-9a-f]{32}\//, '/');
  const response = await fetch(`${withoutSecret}/studies`);
  assert.equal(response.status, 404);

  const wrongSecret = archive.root.replace(/\/[0-9a-f]{32}\//, `/${'0'.repeat(32)}/`);
  assert.equal((await fetch(`${wrongSecret}/studies`)).status, 404);
});

test('the archive refuses to be written to', { timeout: 20000 }, async () => {
  const response = await fetch(`${archive.root}/studies`, { method: 'POST' });
  assert.equal(response.status, 405);
});

test('a series describes every image in it', { timeout: 20000 }, async () => {
  const { study, series } = anything();
  const response = await fetch(`${archive.root}/studies/${study}/series/${series}/metadata`);

  assert.equal(response.status, 200);
  const instances = (await response.json()) as Array<Record<string, unknown>>;

  const expected = index.patients[0]?.studies[0]?.series[0]?.instances.length;
  assert.equal(instances.length, expected);
  assert.ok(instances[0]?.['00080018'], 'each carries its own name');
});

test('the pixels are a reference, never the bytes', { timeout: 20000 }, async () => {
  const { study, series } = anything();
  const response = await fetch(`${archive.root}/studies/${study}/series/${series}/metadata`);
  const [first] = (await response.json()) as Array<
    Record<string, { Value?: unknown[]; BulkDataURI?: string }>
  >;

  const pixels = first?.['7FE00010'];
  assert.ok(pixels?.BulkDataURI, 'the image is referred to');
  assert.equal(pixels?.Value, undefined, 'and not carried inline');
  assert.match(pixels?.BulkDataURI ?? '', /\/frames\/1$/);
});

test('nothing private to the parser is sent', { timeout: 20000 }, async () => {
  const { study, series } = anything();
  const response = await fetch(`${archive.root}/studies/${study}/series/${series}/metadata`);
  const body = await response.text();

  // These are the reading library's own bookkeeping. They are not part of the
  // format, the viewer ignores them, and they roughly double the size of every
  // answer — which on a 300-slice series is the difference the person waiting
  // would feel.
  assert.equal(body.includes('_rawValue'), false);
  assert.equal(body.includes('_vrMap'), false);
});

test('a frame arrives as a multipart part that says what it is', { timeout: 20000 }, async () => {
  const { study, series, instance } = anything();
  const response = await fetch(
    `${archive.root}/studies/${study}/series/${series}/instances/${instance}/frames/1`
  );

  assert.equal(response.status, 200);
  const type = response.headers.get('content-type') ?? '';
  assert.match(type, /^multipart\/related/);
  assert.match(type, /boundary=/);

  const body = Buffer.from(await response.arrayBuffer());
  const pixels = index.patients[0]?.studies[0]?.series[0]?.instances[0]?.pixels;
  assert.ok(pixels?.rows && pixels.columns && pixels.bitsAllocated);

  const frameBytes = Math.ceil(
    (pixels.rows * pixels.columns * pixels.samplesPerPixel * pixels.bitsAllocated) / 8
  );
  // The part carries the whole frame and only the frame: headers and boundary
  // account for the rest, and a body shorter than the image means a slice
  // drawn with rubbish along the bottom.
  assert.ok(body.length > frameBytes, 'the frame is there in full');
  assert.ok(body.length < frameBytes + 512, 'and nothing much else is');
});

test('frames are counted from one, as the standard counts them', { timeout: 20000 }, async () => {
  const { study, series, instance } = anything();
  const at = `${archive.root}/studies/${study}/series/${series}/instances/${instance}/frames`;

  // Frame 0 does not exist. Answered as frame 1 it would show every study
  // shifted by a slice, which nobody notices until a measurement is taken.
  assert.equal((await fetch(`${at}/0`)).status, 404);
  assert.equal((await fetch(`${at}/9999`)).status, 404);
  assert.equal((await fetch(`${at}/1`)).status, 200);
});

test('a request for several frames is refused, not half-answered', { timeout: 20000 }, async () => {
  const { study, series, instance } = anything();
  const response = await fetch(
    `${archive.root}/studies/${study}/series/${series}/instances/${instance}/frames/1,2`
  );

  assert.equal(response.status, 400);
});

test('an image outside the open folder cannot be reached', { timeout: 20000 }, async () => {
  const { study, series } = anything();
  const response = await fetch(
    `${archive.root}/studies/${study}/series/${series}/instances/9.9.9.9/frames/1`
  );

  assert.equal(response.status, 404);
});

test('a study that is not here is answered empty, not refused', { timeout: 20000 }, async () => {
  const response = await fetch(`${archive.root}/studies?PatientName=NobodyAtAll`);

  // An empty list is the right answer to a search that matched nobody. A 404
  // would make the viewer report the archive as broken.
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});

test('closing the archive stops it answering', { timeout: 20000 }, async () => {
  const own = await startArchive(index);
  assert.equal((await fetch(`${own.root}/studies`)).status, 200);

  await own.close();
  await assert.rejects(fetch(`${own.root}/studies`));
});

test('opening another folder replaces what is served', { timeout: 20000 }, async () => {
  const own = await startArchive(index);
  const before = ((await (await fetch(`${own.root}/studies`)).json()) as unknown[]).length;
  assert.ok(before > 0);

  own.serve({ patients: [], duplicates: 0 });
  assert.deepEqual(await (await fetch(`${own.root}/studies`)).json(), []);

  await own.close();
});

test('the patient name survives the trip', { timeout: 20000 }, async () => {
  const { study, series } = anything();
  const response = await fetch(`${archive.root}/studies/${study}/series/${series}/metadata`);
  const [first] = (await response.json()) as Array<Record<string, { Value?: unknown[] }>>;

  // A name arrives inside a value as an object with named fields, which is not
  // a nested dataset however much it looks like one. Cleaned as though it were,
  // it comes back empty and every study shows a blank where the patient goes.
  const name = first?.['00100010']?.Value?.[0] as { Alphabetic?: string } | undefined;
  assert.ok(name?.Alphabetic, 'the study says who it belongs to');
});
