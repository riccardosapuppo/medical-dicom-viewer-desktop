/**
 * Turning a file's header into the JSON form DICOMweb speaks.
 *
 * Most of this is the reading library's work. What is tested here is the part
 * that is not: what gets removed on the way out, and two value shapes that are
 * not what a first reading assumes. Both were found by a request that never came
 * back rather than by a crash, which is why they are written down.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { readInstance, stripPrivate } from '../src/main/dicomweb/metadata';
import type { JsonDataset } from '../src/main/dicomweb/metadata';
import { generate } from '../tools/demo-study';

const WADO = 'http://127.0.0.1:7654/dicom-web';

let anImage: string;
let temporary: string | undefined;

before(() => {
  let folder = path.resolve(process.cwd(), 'demo-data');
  if (!fs.existsSync(folder)) {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dicom-metadata-'));
    generate(temporary);
    folder = temporary;
  }

  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.dcm')) {
        found.push(full);
      }
    }
  };
  walk(folder);

  assert.ok(found[0], 'there is an image to read');
  anImage = found[0];
});

after(() => {
  if (temporary) {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('a header is read without its image', () => {
  const read = readInstance(anImage, WADO);
  assert.ok(read);

  assert.ok(read.identity.study);
  assert.ok(read.identity.series);
  assert.ok(read.identity.instance);
  assert.equal(read.transferSyntax, '1.2.840.10008.1.2.1');

  // The image is referred to, not carried. This is what lets a study open
  // before it has been read.
  const pixels = read.dataset['7FE00010'];
  assert.ok(pixels?.BulkDataURI);
  assert.equal(pixels?.Value, undefined);
});

test('a byte offset never reaches the answer as if it were a value', () => {
  // Told to stop before the pixels, the reading library leaves a plain number
  // behind where the image would be — an offset into the file. Read as a list
  // it throws, and the request it was serving is then never answered at all.
  const marked = stripPrivate({
    '7FE00010': { vr: 'OW', Value: 1234 as unknown as unknown[] },
  } as unknown as JsonDataset);

  assert.deepEqual(marked['7FE00010'], { vr: 'OW' });
});

test('bytes are carried as base64, not walked into', () => {
  // A run of bytes looks like an object with numbered keys. Descending into one
  // turns a lookup table into a hundred thousand objects and a request that
  // never comes back.
  const bytes = new Uint8Array([1, 2, 3, 250]);
  const carried = stripPrivate({
    '00281201': { vr: 'OW', Value: [bytes] as unknown[] },
  } as unknown as JsonDataset);

  const [first] = carried['00281201']?.Value ?? [];
  assert.deepEqual(first, { InlineBinary: Buffer.from(bytes).toString('base64') });
});

test('a whole element that is bytes is carried too', () => {
  const carried = stripPrivate({
    '00020001': { vr: 'OB', Value: new Uint8Array([0, 1]).buffer as unknown as unknown[] },
  } as unknown as JsonDataset);

  assert.equal(carried['00020001']?.InlineBinary, Buffer.from([0, 1]).toString('base64'));
});

test('the parser own bookkeeping is not sent', () => {
  const cleaned = stripPrivate({
    '00100010': {
      vr: 'PN',
      Value: [{ Alphabetic: 'Rossi^Mario' }],
      _rawValue: 'Rossi^Mario',
    },
    _vrMap: {},
  } as unknown as JsonDataset);

  assert.equal('_vrMap' in cleaned, false);
  assert.equal('_rawValue' in (cleaned['00100010'] ?? {}), false);
  assert.deepEqual(cleaned['00100010']?.Value, [{ Alphabetic: 'Rossi^Mario' }]);
});

test('sequences are cleaned all the way down', () => {
  const cleaned = stripPrivate({
    '00081110': {
      vr: 'SQ',
      Value: [
        {
          '00081150': { vr: 'UI', Value: ['1.2.3'], _rawValue: ['1.2.3'] },
        },
      ],
      _rawValue: [],
    },
  } as unknown as JsonDataset);

  const [item] = (cleaned['00081110']?.Value ?? []) as Array<Record<string, unknown>>;
  // Sequences are where most of a real header's weight lives, so a clean that
  // stops at the top level leaves nearly all of it behind.
  assert.equal('_rawValue' in ((item?.['00081150'] ?? {}) as object), false);
});

test('a nested dataset is not given a value representation it does not have', () => {
  const cleaned = stripPrivate({
    '00081110': { vr: 'SQ', Value: [{ '00081150': { vr: 'UI', Value: ['1.2.3'] } }] },
  } as unknown as JsonDataset);

  const [item] = (cleaned['00081110']?.Value ?? []) as Array<Record<string, unknown>>;
  assert.equal('vr' in (item ?? {}), false);
});

test('a file that is not readable is reported as absent, not thrown', () => {
  // A folder chosen off a disc holds whatever it holds. One unreadable file is
  // not a reason to refuse the other three hundred.
  assert.equal(readInstance(path.join(os.tmpdir(), 'not-a-file-at-all.dcm'), WADO), undefined);
});
