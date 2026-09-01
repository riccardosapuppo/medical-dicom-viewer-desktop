/**
 * A study is not only pictures.
 *
 * Beside the images an archive stores objects that say how a picture should be
 * shown, what was found in it, or what was measured. They are DICOM, they sit in
 * series of their own, and they hold no pixels.
 *
 * Read as images that failed, they turned a perfectly good elbow MR into a study
 * reporting three broken series — including one called "DEFAULT PS SERIES",
 * which says what it is in its name.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { carriesPixels, kindOf } from '../src/main/dicom/object-kind';

test('the objects that sit beside images are named', () => {
  // Grayscale softcopy presentation state: what "DEFAULT PS SERIES" was.
  assert.equal(kindOf('1.2.840.10008.5.1.4.1.1.11.1'), 'presentation state');
  assert.equal(kindOf('1.2.840.10008.5.1.4.1.1.11.4'), 'presentation state');

  assert.equal(kindOf('1.2.840.10008.5.1.4.1.1.88.11'), 'report');
  assert.equal(kindOf('1.2.840.10008.5.1.4.1.1.88.59'), 'report');
  assert.equal(kindOf('1.2.840.10008.5.1.4.1.1.104.1'), 'encapsulated document');
  assert.equal(kindOf('1.2.840.10008.5.1.4.1.1.66.1'), 'registration');
  assert.equal(kindOf('1.2.840.10008.5.1.4.1.1.9.1.1'), 'waveform');
});

test('an image is not given a name it does not need', () => {
  // CT, MR, mammography, ultrasound. These are pictures.
  assert.equal(kindOf('1.2.840.10008.5.1.4.1.1.2'), undefined);
  assert.equal(kindOf('1.2.840.10008.5.1.4.1.1.4'), undefined);
  assert.equal(kindOf('1.2.840.10008.5.1.4.1.1.1.2'), undefined);
  assert.equal(kindOf('1.2.840.10008.5.1.4.1.1.6.1'), undefined);
});

test('something nobody recognises is left alone', () => {
  // A private SOP class with pixels in it is an image, which is the safe way
  // round: naming it would hide a picture, and not naming it shows one.
  assert.equal(kindOf('1.3.46.670589.11.0.0.51.4.57.0'), undefined);
  assert.equal(kindOf(''), undefined);
});

test('the file has the last word about whether it holds an image', () => {
  // Pixel data present, wherever it is.
  assert.equal(carriesPixels({ dataOffset: 916 }), true);
  assert.equal(carriesPixels({ dataOffset: 0 }), true);

  // None at all: not an image, whatever its class says.
  assert.equal(carriesPixels({ dataOffset: undefined }), false);
});
