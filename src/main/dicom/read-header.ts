/**
 * Reads the header of one DICOM file, and stops before the pixels.
 *
 * A chest CT is a few hundred files of half a megabyte each. Indexing a folder
 * of them means opening every one, and reading every one whole would move
 * hundreds of megabytes to learn a few hundred bytes of patient, study and
 * series. So: read a chunk off the front, parse until the pixel data element,
 * and never touch the rest.
 *
 * The chunk size is a guess, and a guess about DICOM headers is always wrong
 * somewhere — private tags, embedded icons, and structured reports all push the
 * header past any figure you pick. So the guess is allowed to be wrong: if the
 * parser runs off the end, read more and try again, up to the whole file. A
 * failure at full size is a real failure.
 */
import { open } from 'node:fs/promises';
import path from 'node:path';

import dicomParser from 'dicom-parser';

/** Where the pixels start. Everything this module wants is before it. */
const PIXEL_DATA = 'x7fe00010';

/** Big enough for almost every header, small enough to be free. */
export const FIRST_READ = 16 * 1024;

/**
 * Where growing stops.
 *
 * A file with no pixel data at all is legal — a structured report, a
 * presentation state — and for those the loop below has no way to know it has
 * seen the whole header except by reading the whole file. Those files are
 * small. This is the guard against the one that is not, and against a file
 * crafted to make the reader allocate.
 */
const MAX_HEADER = 16 * 1024 * 1024;

/** DICOM Part 10 puts 128 bytes of nothing, then these four characters. */
const PREAMBLE_LENGTH = 128;
const MAGIC = 'DICM';

/**
 * Everything about the image itself, kept together.
 *
 * These are the fields that decide what a pixel means: how wide it is, whether
 * it is signed, what to add and multiply to turn it into Hounsfield units, and
 * where the bytes are in the file. Split across an index and a viewer they
 * drift apart; a viewer that reads the width from one place and the sign from
 * another eventually draws a study inside out.
 */
export interface PixelLayout {
  rows: number | undefined;
  columns: number | undefined;
  /** Absent means one frame. A viewer that reads absent as zero shows nothing. */
  numberOfFrames: number;

  bitsAllocated: number | undefined;
  bitsStored: number | undefined;
  highBit: number | undefined;
  /** Pixel Representation 1. CT numbers go below zero, so this is usually true. */
  signed: boolean;
  samplesPerPixel: number;
  photometricInterpretation: string;
  planarConfiguration: number | undefined;

  /**
   * Millimetres per pixel, across and down.
   *
   * Not always equal, and not always present. A viewer that assumes square
   * pixels draws an ultrasound sector as an oval and measures a circle as an
   * ellipse, which is a measurement someone might report.
   */
  pixelSpacing: number[] | undefined;

  /** stored value * slope + intercept = the real measurement. */
  rescaleSlope: number;
  rescaleIntercept: number;

  /** The window the scanner suggested, if it suggested one. */
  windowCenter: number | undefined;
  windowWidth: number | undefined;

  transferSyntaxUid: string;
  /** True when the pixels are compressed and arrive as fragments rather than a block. */
  encapsulated: boolean;

  /** Where the pixel data starts in the file, and how long it says it is. */
  dataOffset: number | undefined;
  dataLength: number | undefined;
  /** False when the declared pixel data runs past the end of the file. */
  complete: boolean;
}

/** One image, as far as an index needs to care. */
export interface InstanceHeader {
  filePath: string;
  fileSize: number;

  patientId: string;
  patientName: string;
  patientBirthDate: string;
  patientSex: string;

  studyInstanceUid: string;
  studyDate: string;
  studyTime: string;
  studyDescription: string;
  accessionNumber: string;

  seriesInstanceUid: string;
  seriesNumber: number | undefined;
  seriesDescription: string;
  modality: string;

  sopInstanceUid: string;
  sopClassUid: string;
  instanceNumber: number | undefined;

  pixels: PixelLayout;

  /** Where this slice sits in the patient, when the file says. */
  imagePositionPatient: number[] | undefined;
  imageOrientationPatient: number[] | undefined;
  sliceThickness: number | undefined;
}

/** A file that could not be read, and why — never thrown away silently. */
export interface UnreadableFile {
  filePath: string;
  reason: string;
}

export class NotDicomError extends Error {}

function text(dataSet: dicomParser.DataSet, tag: string): string {
  return dataSet.string(tag)?.trim() ?? '';
}

function integer(dataSet: dicomParser.DataSet, tag: string): number | undefined {
  const raw = dataSet.string(tag);
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function decimal(dataSet: dicomParser.DataSet, tag: string): number | undefined {
  const raw = dataSet.string(tag);
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * A multi-valued decimal string, like a position or an orientation.
 *
 * Returns undefined rather than a half-filled array when any part is missing:
 * a position of [12, NaN, 40] would sort slices into an order that looks
 * plausible and is not.
 */
function decimals(dataSet: dicomParser.DataSet, tag: string, expected: number): number[] | undefined {
  const raw = dataSet.string(tag);
  if (raw === undefined) {
    return undefined;
  }
  const parts = raw.split(String.fromCharCode(92)).map(p => Number.parseFloat(p));
  if (parts.length !== expected || parts.some(n => !Number.isFinite(n))) {
    return undefined;
  }
  return parts;
}

/** The first value of a decimal string that may carry several. */
function firstDecimal(dataSet: dicomParser.DataSet, tag: string): number | undefined {
  const raw = dataSet.string(tag);
  if (raw === undefined) {
    return undefined;
  }
  const first = Number.parseFloat(raw.split(String.fromCharCode(92))[0] ?? '');
  return Number.isFinite(first) ? first : undefined;
}

/** DICOM writes names with carets between the components. */
function readableName(raw: string): string {
  return raw
    .split('^')
    .map(part => part.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * The image layout, with the defaults the standard allows a file to leave out.
 *
 * Every fallback here is a real file somewhere: an MR that omits the rescale
 * pair, an anonymiser that drops the suggested window, a secondary capture with
 * no photometric interpretation. A viewer that treats a missing slope as zero
 * shows a black rectangle and blames the data.
 */
function extractPixels(
  dataSet: dicomParser.DataSet,
  fileSize: number
): PixelLayout {
  const element = dataSet.elements[PIXEL_DATA];
  const dataOffset = element?.dataOffset;
  const dataLength = element?.length;

  return {
    rows: dataSet.uint16('x00280010'),
    columns: dataSet.uint16('x00280011'),
    numberOfFrames: integer(dataSet, 'x00280008') ?? 1,

    bitsAllocated: dataSet.uint16('x00280100'),
    bitsStored: dataSet.uint16('x00280101'),
    highBit: dataSet.uint16('x00280102'),
    signed: dataSet.uint16('x00280103') === 1,
    samplesPerPixel: dataSet.uint16('x00280002') ?? 1,
    photometricInterpretation: text(dataSet, 'x00280004') || 'MONOCHROME2',
    planarConfiguration: dataSet.uint16('x00280006'),

    pixelSpacing: decimals(dataSet, 'x00280030', 2),

    rescaleSlope: decimal(dataSet, 'x00281053') ?? 1,
    rescaleIntercept: decimal(dataSet, 'x00281052') ?? 0,

    // Both can carry several values - a soft tissue window and a bone window in
    // one file. The first is the one the scanner put first, and choosing among
    // them is the viewer's business, not the index's.
    windowCenter: firstDecimal(dataSet, 'x00281050'),
    windowWidth: firstDecimal(dataSet, 'x00281051'),

    transferSyntaxUid: text(dataSet, 'x00020010'),
    encapsulated: element?.encapsulatedPixelData === true || element?.hadUndefinedLength === true,

    dataOffset,
    dataLength,
    // A file that stops before the pixel data it promised is a partial copy or
    // an interrupted transfer. It still belongs in the list; it just cannot be
    // drawn, and saying so here is cheaper than finding out at display time.
    complete:
      dataOffset === undefined || dataLength === undefined
        ? false
        : dataOffset + dataLength <= fileSize,
  };
}

function extract(dataSet: dicomParser.DataSet, filePath: string, fileSize: number): InstanceHeader {
  return {
    filePath,
    fileSize,

    patientId: text(dataSet, 'x00100020'),
    patientName: readableName(text(dataSet, 'x00100010')),
    patientBirthDate: text(dataSet, 'x00100030'),
    patientSex: text(dataSet, 'x00100040'),

    studyInstanceUid: text(dataSet, 'x0020000d'),
    studyDate: text(dataSet, 'x00080020'),
    studyTime: text(dataSet, 'x00080030'),
    studyDescription: text(dataSet, 'x00081030'),
    accessionNumber: text(dataSet, 'x00080050'),

    seriesInstanceUid: text(dataSet, 'x0020000e'),
    seriesNumber: integer(dataSet, 'x00200011'),
    seriesDescription: text(dataSet, 'x0008103e'),
    modality: text(dataSet, 'x00080060'),

    sopInstanceUid: text(dataSet, 'x00080018'),
    sopClassUid: text(dataSet, 'x00080016'),
    instanceNumber: integer(dataSet, 'x00200013'),

    pixels: extractPixels(dataSet, fileSize),

    imagePositionPatient: decimals(dataSet, 'x00200032', 3),
    imageOrientationPatient: decimals(dataSet, 'x00200037', 6),
    sliceThickness: decimal(dataSet, 'x00180050'),
  };
}

/**
 * Reads one file's header.
 *
 * Throws `NotDicomError` for anything that is not a Part 10 file — a JPEG, a
 * text file, a directory entry that happened to match. That is an ordinary
 * event when indexing a folder someone dragged in, not an error worth stopping
 * for, so it is a distinct type the caller can count rather than report.
 */
export async function readHeader(filePath: string): Promise<InstanceHeader> {
  const handle = await open(filePath, 'r');

  try {
    const { size } = await handle.stat();

    if (size < PREAMBLE_LENGTH + MAGIC.length) {
      throw new NotDicomError(`${path.basename(filePath)}: too short to be a DICOM file`);
    }

    let length = Math.min(FIRST_READ, size);
    let checkedMagic = false;

    // Grow until the header fits or the file runs out. Doubling means a header
    // three times the guess costs two extra reads, not thirty.
    for (;;) {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);

      if (!checkedMagic) {
        if (buffer.toString('latin1', PREAMBLE_LENGTH, PREAMBLE_LENGTH + MAGIC.length) !== MAGIC) {
          throw new NotDicomError(`${path.basename(filePath)}: no DICM marker`);
        }
        checkedMagic = true;
      }

      try {
        const dataSet = dicomParser.parseDicom(buffer, { untilTag: PIXEL_DATA });

        // A parse that did not throw is not the same as a parse that finished.
        //
        // The parser walks elements until the buffer runs out, and when the
        // buffer happens to run out exactly on an element boundary it stops
        // cleanly and hands back everything it read. Nothing raises. The header
        // is simply short a few tags, and the ones most likely to be missing
        // are the last ones — which is where the pixel data is. The image then
        // lists correctly and can never be opened, and nothing anywhere says
        // why.
        //
        // Reaching the pixel data is the only proof there was nothing after it.
        if (dataSet.elements[PIXEL_DATA] === undefined && length < size && length < MAX_HEADER) {
          length = Math.min(length * 2, size);
          continue;
        }

        return extract(dataSet, filePath, size);
      } catch (error) {
        if (length >= size) {
          throw new Error(
            `${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        length = Math.min(length * 2, size);
      }
    }
  } finally {
    await handle.close();
  }
}
