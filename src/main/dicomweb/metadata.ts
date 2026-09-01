/**
 * A file on a disc, described the way DICOMweb describes it.
 *
 * The viewer this application ships is the web one, and it reads from a
 * DICOMweb archive. So the desktop side does not reimplement a viewer: it
 * becomes the archive. A folder goes in, and QIDO-RS and WADO-RS come out,
 * in-process, with nothing to install and nothing leaving the machine.
 *
 * The conversion to the JSON form is dcmjs's, which is the same library the
 * viewer uses to read it back. Both ends therefore agree about names, about
 * sequences, and about which values are numbers, by construction rather than by
 * luck. Two things still have to be corrected on the way out:
 *
 *   - dcmjs keeps `_rawValue` and `_vrMap` alongside the real values for its own
 *     purposes. They are not part of the standard, they roughly double the size
 *     of a response, and the viewer ignores them. They go.
 *   - pixel data is never sent inline. The standard says a metadata response
 *     carries a reference instead, and that reference is why a study can open
 *     before it has finished loading.
 */
import fs from 'node:fs';
import dcmjs from 'dcmjs';

/** One element in the JSON form: a value representation and its values. */
export interface JsonElement {
  vr: string;
  Value?: unknown[];
  BulkDataURI?: string;
  InlineBinary?: string;
}

export type JsonDataset = Record<string, JsonElement>;

export const PIXEL_DATA = '7FE00010';
const TRANSFER_SYNTAX = '00020010';

/** dcmjs's own bookkeeping, which is not part of the format. */
const PRIVATE_TO_DCMJS = ['_rawValue', '_vrMap'];

/** Bytes, in whichever shape the parser hands them back. */
function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

/** An eight-digit hexadecimal tag, which is what a dataset's keys are. */
function isTag(key: string): boolean {
  if (key.length !== 8) {
    return false;
  }
  for (const character of key) {
    const code = character.charCodeAt(0);
    const digit = code >= 48 && code <= 57;
    const upper = code >= 65 && code <= 70;
    const lower = code >= 97 && code <= 102;
    if (!digit && !upper && !lower) {
      return false;
    }
  }
  return true;
}

/**
 * Tells a sequence item from every other object that appears inside a value.
 *
 * Both are plain objects, and treating the second as the first destroys it. The
 * one that matters is a person's name, which arrives as `{ Alphabetic: ... }`:
 * cleaned as though it were a dataset it comes back empty, and every study then
 * shows a blank where the patient should be. A dataset is recognised by its
 * keys — they are tags, and nothing else is.
 */
function looksLikeDataset(value: object): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every(isTag);
}

/**
 * Anything longer than this is described but not carried.
 *
 * The colour and intensity tables a viewer needs are a few kilobytes. Something
 * a megabyte long is not one of those, and inlining it would weigh down every
 * answer for no one's benefit.
 */
const LARGEST_INLINE = 1024 * 1024;

/**
 * Removes dcmjs's bookkeeping, following sequences down.
 *
 * A sequence holds whole datasets inside its values, and each of those carries
 * the same two extra keys. Missing the nested ones leaves most of the weight
 * behind, because sequences are where the bulk of a real header lives.
 *
 * Two shapes here are not what they look like, and both were found by a request
 * that never came back rather than by reading:
 *
 *   - a run of bytes is, to a naive walk, an object with numbered keys. Walking
 *     into one turns a lookup table into a hundred thousand objects. Bytes are
 *     carried as base64, which is how the standard carries them.
 *   - told to stop before the pixels, the parser leaves a plain number behind
 *     where the image would be. It is an offset into the file, not a value.
 *     Read as a list it throws; copied through it would put a byte offset in the
 *     answer where an image belongs.
 */
export function stripPrivate(dataset: JsonDataset): JsonDataset {
  const out: JsonDataset = {};

  for (const [tag, element] of Object.entries(dataset)) {
    if (element === null || typeof element !== 'object') {
      continue;
    }
    const clean: JsonElement = { vr: element.vr };

    if (element.BulkDataURI !== undefined) {
      clean.BulkDataURI = element.BulkDataURI;
    }
    if (element.InlineBinary !== undefined) {
      clean.InlineBinary = element.InlineBinary;
    }

    const whole = bytesOf(element.Value);
    if (whole) {
      if (whole.byteLength <= LARGEST_INLINE) {
        clean.InlineBinary = Buffer.from(whole).toString('base64');
      }
    } else if (Array.isArray(element.Value)) {
      clean.Value = element.Value.map(value => {
        const inner = bytesOf(value);
        if (inner) {
          return inner.byteLength <= LARGEST_INLINE
            ? { InlineBinary: Buffer.from(inner).toString('base64') }
            : null;
        }
        return value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          looksLikeDataset(value)
          ? stripPrivate(value as JsonDataset)
          : value;
      });
    }

    // A nested dataset has no `vr`; leaving an undefined one in changes the
    // shape of every item in every sequence.
    if (clean.vr === undefined) {
      delete (clean as { vr?: string }).vr;
    }
    out[tag] = clean;
  }

  for (const key of PRIVATE_TO_DCMJS) {
    delete (out as Record<string, unknown>)[key];
  }
  return out;
}

/** What a study, series and instance are called, taken from the header itself. */
export interface Identity {
  study: string;
  series: string;
  instance: string;
}

function firstString(dataset: JsonDataset, tag: string): string {
  const value = dataset[tag]?.Value?.[0];
  return typeof value === 'string' ? value : '';
}

export interface InstanceMetadata {
  identity: Identity;
  transferSyntax: string;
  dataset: JsonDataset;
}

/**
 * Reads one file's header, and nothing more.
 *
 * `untilTag` stops at the pixels, so a series of three hundred slices is
 * described without ever holding three hundred images in memory. On the sample
 * study this is a handful of milliseconds a file.
 */
export function readInstance(file: string, wadoRoot: string): InstanceMetadata | undefined {
  let parsed;
  try {
    const buffer = fs.readFileSync(file);
    const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    parsed = dcmjs.data.DicomMessage.readFile(bytes, {
      untilTag: PIXEL_DATA,
      ignoreErrors: true,
    });
  } catch {
    // A folder chosen off a disc holds whatever it holds. One unreadable file
    // is not a reason to refuse the other three hundred.
    return undefined;
  }

  const dataset = stripPrivate(parsed.dict as JsonDataset);
  const meta = stripPrivate((parsed.meta ?? {}) as JsonDataset);

  const identity: Identity = {
    study: firstString(dataset, '0020000D'),
    series: firstString(dataset, '0020000E'),
    instance: firstString(dataset, '00080018'),
  };

  if (!identity.study || !identity.series || !identity.instance) {
    // Without the three names there is no address to serve it at.
    return undefined;
  }

  // The reference that replaces the image, as the standard asks.
  dataset[PIXEL_DATA] = {
    vr: dataset[PIXEL_DATA]?.vr ?? 'OW',
    BulkDataURI:
      `${wadoRoot}/studies/${identity.study}` +
      `/series/${identity.series}/instances/${identity.instance}/frames/1`,
  };

  return {
    identity,
    transferSyntax: firstString(meta, TRANSFER_SYNTAX) || '1.2.840.10008.1.2.1',
    dataset,
  };
}
