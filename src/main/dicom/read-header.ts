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
const FIRST_READ = 16 * 1024;

/** DICOM Part 10 puts 128 bytes of nothing, then these four characters. */
const PREAMBLE_LENGTH = 128;
const MAGIC = 'DICM';

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

  rows: number | undefined;
  columns: number | undefined;
  bitsAllocated: number | undefined;
  numberOfFrames: number;

  /** Where this slice sits in the patient, when the file says. */
  imagePositionPatient: number[] | undefined;
  imageOrientationPatient: number[] | undefined;
  pixelSpacing: number[] | undefined;
  sliceThickness: number | undefined;

  transferSyntaxUid: string;
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

/** DICOM writes names with carets between the components. */
function readableName(raw: string): string {
  return raw
    .split('^')
    .map(part => part.trim())
    .filter(Boolean)
    .join(' ');
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

    rows: dataSet.uint16('x00280010'),
    columns: dataSet.uint16('x00280011'),
    bitsAllocated: dataSet.uint16('x00280100'),
    // Absent means one. A viewer that treats absent as zero shows nothing.
    numberOfFrames: integer(dataSet, 'x00280008') ?? 1,

    imagePositionPatient: decimals(dataSet, 'x00200032', 3),
    imageOrientationPatient: decimals(dataSet, 'x00200037', 6),
    pixelSpacing: decimals(dataSet, 'x00280030', 2),
    sliceThickness: decimal(dataSet, 'x00180050'),

    transferSyntaxUid: text(dataSet, 'x00020010'),
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
