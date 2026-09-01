/**
 * The bytes of one frame, and what they are.
 *
 * WADO-RS hands a frame over as it is stored, and says what it is in the part's
 * content type. The viewer decides from that whether it can draw the bytes
 * directly or has to decompress them first — which is why this application can
 * now open compressed archives at all. The desktop viewer it replaced drew
 * pixels itself and simply refused anything it could not read raw; the web
 * viewer carries decoders for JPEG, JPEG-LS, JPEG 2000 and RLE, so the honest
 * thing to do is pass the stored bytes through and let it work.
 *
 * Two ways in, chosen by how the file stores its pixels:
 *
 *   - uncompressed, where a frame is a fixed number of bytes at a computable
 *     offset, and can be lifted off the disc without parsing anything;
 *   - encapsulated, where frames are fragments of varying length and the file
 *     has to be walked to find the one asked for.
 *
 * The first is the common case for the large studies and stays cheap on
 * purpose: a 400-slice CT is read four hundred times, and re-parsing the header
 * each time would be four hundred times a cost already paid at indexing.
 */
import fs from 'node:fs';
import dicomParser from 'dicom-parser';

import type { PixelLayout } from '../dicom/read-header';

/** The bytes of a frame, and the media type that says what they are. */
export interface Frame {
  bytes: Buffer;
  mediaType: string;
}

/** Why a frame could not be produced — said out loud rather than served empty. */
export interface FrameProblem {
  reason: string;
  status: 404 | 500;
}

/**
 * What a transfer syntax's stored bytes are, as a media type.
 *
 * Uncompressed pixels are octets; everything else names its compression, and
 * the viewer picks a decoder by that name. An unknown syntax is reported as
 * octets, which is wrong but visible — the viewer says it cannot decode, rather
 * than drawing noise.
 */
export function mediaTypeOf(transferSyntaxUid: string): string {
  switch (transferSyntaxUid) {
    case '1.2.840.10008.1.2.4.50':
    case '1.2.840.10008.1.2.4.51':
    case '1.2.840.10008.1.2.4.57':
    case '1.2.840.10008.1.2.4.70':
      return 'image/jpeg';
    case '1.2.840.10008.1.2.4.80':
    case '1.2.840.10008.1.2.4.81':
      return 'image/jls';
    case '1.2.840.10008.1.2.4.90':
    case '1.2.840.10008.1.2.4.91':
      return 'image/jp2';
    case '1.2.840.10008.1.2.4.92':
    case '1.2.840.10008.1.2.4.93':
      return 'image/jphc';
    case '1.2.840.10008.1.2.5':
      return 'image/dicom-rle';
    default:
      return 'application/octet-stream';
  }
}

/** How many bytes one uncompressed frame occupies, when the header said enough. */
export function frameSize(pixels: PixelLayout): number | undefined {
  const { rows, columns, bitsAllocated, samplesPerPixel } = pixels;
  if (!rows || !columns || !bitsAllocated) {
    return undefined;
  }
  return Math.ceil((rows * columns * samplesPerPixel * bitsAllocated) / 8);
}

/**
 * A frame lifted straight off the disc.
 *
 * Only the frame is read. The alternative — read the file, slice the buffer —
 * pulls a whole 200 MB series through memory to hand back 500 KB of it.
 */
function uncompressed(
  filePath: string,
  pixels: PixelLayout,
  frameIndex: number
): Frame | FrameProblem {
  const size = frameSize(pixels);
  if (size === undefined || pixels.dataOffset === undefined) {
    return { reason: 'the file does not say how its pixels are laid out', status: 500 };
  }
  if (frameIndex >= pixels.numberOfFrames) {
    return { reason: `this image has ${pixels.numberOfFrames} frame(s)`, status: 404 };
  }

  const start = pixels.dataOffset + frameIndex * size;
  const bytes = Buffer.alloc(size);

  let handle;
  try {
    handle = fs.openSync(filePath, 'r');
    const read = fs.readSync(handle, bytes, 0, size, start);
    if (read < size) {
      // A study copied off a disc half-way is a real thing to meet, and a short
      // frame drawn as if it were whole is a picture with rubbish along
      // the bottom.
      return { reason: 'the file ends before this frame does', status: 500 };
    }
  } catch {
    return { reason: 'the file could not be read', status: 500 };
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle);
    }
  }

  return { bytes, mediaType: 'application/octet-stream' };
}

/**
 * A frame pulled out of encapsulated pixel data.
 *
 * Compressed frames are stored as fragments of unpredictable length, so there is
 * no offset to compute: the file is parsed and the fragment table walked. That
 * costs a parse per frame, which is the price of compression and is paid on
 * exactly the studies where each frame is small.
 */
function encapsulated(
  filePath: string,
  pixels: PixelLayout,
  frameIndex: number
): Frame | FrameProblem {
  let bytes: Buffer;
  try {
    const file = fs.readFileSync(filePath);
    const dataSet = dicomParser.parseDicom(new Uint8Array(file));
    const element = dataSet.elements['x7fe00010'];
    if (!element) {
      return { reason: 'this image carries no pixel data', status: 404 };
    }
    bytes = Buffer.from(dicomParser.readEncapsulatedImageFrame(dataSet, element, frameIndex));
  } catch (problem) {
    const detail = problem instanceof Error ? problem.message : 'unknown';
    return { reason: `the compressed pixel data could not be read: ${detail}`, status: 500 };
  }

  return { bytes, mediaType: mediaTypeOf(pixels.transferSyntaxUid) };
}

/** Tells a produced frame from a refusal, without either pretending to be the other. */
export function isProblem(result: Frame | FrameProblem): result is FrameProblem {
  return 'reason' in result;
}

/**
 * The frame at `frameNumber`, counted from one as the standard counts it.
 *
 * Off-by-one here is the mistake that shows a study shifted by a slice, which
 * nobody notices until a measurement is taken on the wrong one.
 */
export function readFrame(
  filePath: string,
  pixels: PixelLayout,
  frameNumber: number
): Frame | FrameProblem {
  if (!Number.isInteger(frameNumber) || frameNumber < 1) {
    return { reason: 'frames are numbered from 1', status: 404 };
  }

  const frameIndex = frameNumber - 1;
  return pixels.encapsulated
    ? encapsulated(filePath, pixels, frameIndex)
    : uncompressed(filePath, pixels, frameIndex);
}
