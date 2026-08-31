/**
 * Serves pixel data to the page over a `dicom:` URL.
 *
 * The page needs the bytes of a frame and must not be given the disk to find
 * them with. So it asks for an image by its SOP Instance UID — the name the
 * standard already gives it — and this answers only for images that are in the
 * folder currently open. A UID that was never indexed is a 404, and a path is
 * not something the page can express at all.
 *
 * It reads the frame it was asked for and nothing else. A 400-slice study is
 * 200 MB of pixels; a viewer that fetches a series fetches four hundred small
 * responses, not one enormous one, and the operating system's page cache does
 * the rest.
 *
 * Range is answered properly because a partial request that is silently given
 * the whole body is worse than one that fails: the caller gets bytes at the
 * wrong offset and draws noise.
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import type { Index } from '../dicom/build-index';
import type { PixelLayout } from '../dicom/read-header';

export const SCHEME = 'dicom';

/** What is needed to answer for one image, and nothing more. */
interface Located {
  filePath: string;
  pixels: PixelLayout;
  /** Bytes in one frame, or undefined when the file does not say enough to know. */
  frameBytes: number | undefined;
}

/** How many bytes one frame occupies, when the header said enough to work it out. */
export function frameSize(pixels: PixelLayout): number | undefined {
  const { rows, columns, bitsAllocated, samplesPerPixel } = pixels;
  if (!rows || !columns || !bitsAllocated) {
    return undefined;
  }
  // Bits allocated is per sample, and a colour image has three of them per
  // pixel. Ignoring that gives a third of the frame and an image that looks
  // like a venetian blind.
  return rows * columns * samplesPerPixel * Math.ceil(bitsAllocated / 8);
}

function text(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * A Range header, as a start and end within a known length.
 *
 * Only the single `bytes=a-b` form, which is what a fetch asks for. A multipart
 * range is legal and nobody sends it; answering one badly would be worse than
 * refusing.
 */
export function parseRange(
  header: string | null,
  length: number
): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return undefined;
  }

  const [, rawStart = '', rawEnd = ''] = match;

  // "bytes=-500" is the last 500 bytes, not a range starting at nothing.
  if (rawStart === '') {
    if (rawEnd === '') {
      return undefined;
    }
    const suffix = Number(rawEnd);
    return suffix <= 0 ? 'unsatisfiable' : { start: Math.max(0, length - suffix), end: length - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? length - 1 : Number(rawEnd);

  if (start >= length || start > end) {
    return 'unsatisfiable';
  }
  // An end past the last byte is clamped rather than refused: that is what the
  // specification asks for, and browsers rely on it.
  return { start, end: Math.min(end, length - 1) };
}

export class PixelServer {
  #images = new Map<string, Located>();

  /**
   * Replaces what can be asked for.
   *
   * Replaces rather than adds: when a different folder is opened, the images in
   * the old one stop being reachable. A viewer that can still fetch from a
   * folder the user closed is a viewer holding a handle nobody granted.
   */
  remember(index: Index): void {
    const images = new Map<string, Located>();

    for (const patient of index.patients) {
      for (const study of patient.studies) {
        for (const series of study.series) {
          for (const instance of series.instances) {
            images.set(instance.sopInstanceUid, {
              filePath: instance.filePath,
              pixels: instance.pixels,
              frameBytes: frameSize(instance.pixels),
            });
          }
        }
      }
    }

    this.#images = images;
  }

  forget(): void {
    this.#images = new Map();
  }

  get size(): number {
    return this.#images.size;
  }

  /**
   * dicom://instance/<sop-instance-uid>/frames/<n>
   *
   * The frame number is one-based, the way DICOM counts frames everywhere else.
   */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.host !== 'instance') {
      return text(404, `Unknown ${SCHEME}: host "${url.host}".`);
    }

    const parts = url.pathname.split('/').filter(Boolean);
    const [uid, frames, rawFrame] = parts;

    if (!uid || frames !== 'frames' || !rawFrame) {
      return text(400, `Expected ${SCHEME}://instance/<sop-instance-uid>/frames/<n>.`);
    }

    // The page controls this text, and decodeURIComponent throws on a stray
    // percent sign. An exception here reaches protocol.handle as a rejected
    // promise instead of the answer the code below is careful to give.
    let name: string;
    try {
      name = decodeURIComponent(uid);
    } catch {
      return text(400, 'That is not a readable instance UID.');
    }

    const found = this.#images.get(name);
    if (!found) {
      // Not "forbidden": from the page's side an image outside the open folder
      // and an image that does not exist are the same thing, and saying which
      // would leak what else is on the disk.
      return text(404, 'No such image in the folder that is open.');
    }

    const { filePath, pixels, frameBytes } = found;

    if (pixels.encapsulated) {
      return text(
        415,
        `The pixels are compressed (${pixels.transferSyntaxUid}) and nothing here decodes them yet.`
      );
    }
    if (!pixels.complete || pixels.dataOffset === undefined) {
      return text(409, 'The file stops before the pixel data it declares.');
    }
    // Zero as well as absent: a file declaring SamplesPerPixel 0, or zero rows,
    // gets past the nullish default and would make every frame start where the
    // last one did.
    if (!frameBytes) {
      return text(409, 'The header does not say how big a frame is.');
    }

    // Bounded by the pixel data that is actually there, not only by the frame
    // count the header claims. A file that says four frames and carries one is
    // an interrupted copy, and answering 200 with a Content-Length the body
    // cannot fill leaves the caller waiting on bytes that never come.
    const available = Math.floor((pixels.dataLength ?? 0) / frameBytes);
    const usable = Math.min(pixels.numberOfFrames, available);

    const frame = Number(rawFrame);
    if (!Number.isInteger(frame) || frame < 1 || frame > usable) {
      return text(
        416,
        `Frame ${rawFrame} is outside 1..${usable}` +
          (usable < pixels.numberOfFrames
            ? ` (the header claims ${pixels.numberOfFrames}, the file carries ${usable}).`
            : '.')
      );
    }

    const frameStart = pixels.dataOffset + (frame - 1) * frameBytes;
    const range = parseRange(request.headers.get('range'), frameBytes);

    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${frameBytes}` },
      });
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : frameBytes - 1;
    const length = end - start + 1;

    const stream = createReadStream(filePath, {
      start: frameStart + start,
      end: frameStart + end,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(length),
      'accept-ranges': 'bytes',
      // The bytes for a given UID and frame never change while a folder is
      // open, and the map is thrown away when it closes.
      'cache-control': 'private, max-age=31536000, immutable',
    };

    if (range) {
      headers['content-range'] = `bytes ${start}-${end}/${frameBytes}`;
    }

    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: range ? 206 : 200,
      headers,
    });
  }
}
