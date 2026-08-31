/**
 * Turns a pile of file headers into the four levels a reading list is made of:
 * patient, study, series, instance.
 *
 * The grouping is dictated by the standard — the UIDs say what belongs
 * together, and nothing else does. The ordering is not, and it is where the
 * work is. Slices must come back in the order they sit in the body, and the
 * obvious key, InstanceNumber, is only a label: plenty of scanners number a
 * series backwards relative to the patient, some do not number it at all, and
 * a series merged from two acquisitions can repeat numbers outright.
 *
 * What is reliable is geometry. Each slice carries its own corner in patient
 * coordinates, and the series carries the plane it was cut on; projecting one
 * onto the normal of the other gives a real distance along the stack. That is
 * the sort key whenever the files provide it, with InstanceNumber kept as the
 * fallback for the files that do not.
 *
 * Everything here is pure, and takes headers rather than paths, so the awkward
 * arrangements can be written down in a test instead of waited for.
 */
import type { InstanceHeader, PixelLayout } from './read-header';

export interface Instance {
  sopInstanceUid: string;
  instanceNumber: number | undefined;
  filePath: string;
  fileSize: number;
  /** Everything needed to draw the image, carried whole rather than picked apart. */
  pixels: PixelLayout;
  /** Distance along the stack, when the geometry was there to compute it. */
  slicePosition: number | undefined;
}

export interface Series {
  seriesInstanceUid: string;
  seriesNumber: number | undefined;
  description: string;
  modality: string;
  instances: Instance[];
  /** True when every slice carried a position and the stack could be ordered by it. */
  orderedByGeometry: boolean;
}

export interface Study {
  studyInstanceUid: string;
  studyDate: string;
  studyTime: string;
  description: string;
  accessionNumber: string;
  series: Series[];
  /** The modalities present, listed once each. */
  modalities: string[];
  instanceCount: number;
}

export interface Patient {
  patientId: string;
  name: string;
  birthDate: string;
  sex: string;
  studies: Study[];
}

export interface Index {
  patients: Patient[];
  /** Images listed twice — counted, not repeated. */
  duplicates: number;
}

function cross(a: number[], b: number[]): [number, number, number] {
  const [ax = 0, ay = 0, az = 0] = a;
  const [bx = 0, by = 0, bz = 0] = b;
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
}

/**
 * How far along the stack each slice sits, or undefined if the series does not
 * say.
 *
 * The normal comes from the first slice that carries an orientation and is used
 * for the whole series: a stack is one plane swept along its normal, and taking
 * each slice's own normal would let a single mislabelled file rotate the axis
 * under everything else.
 */
function slicePositions(headers: InstanceHeader[]): Map<string, number> | undefined {
  const orientation = headers.find(h => h.imageOrientationPatient)?.imageOrientationPatient;
  if (!orientation) {
    return undefined;
  }

  const normal = cross(orientation.slice(0, 3), orientation.slice(3, 6));
  const positions = new Map<string, number>();

  for (const header of headers) {
    if (!header.imagePositionPatient) {
      // One slice without a position makes the whole ordering a guess. Better
      // to fall back to numbering for the series than to interleave the two.
      return undefined;
    }
    positions.set(header.sopInstanceUid, dot(header.imagePositionPatient, normal));
  }

  return positions;
}

/** Compares values that may be missing, keeping the ones that have it first. */
function byOptionalNumber(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) {
    return 0;
  }
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  return a - b;
}

function buildSeries(headers: InstanceHeader[]): Series {
  const first = headers[0] as InstanceHeader;
  const positions = slicePositions(headers);

  const instances: Instance[] = headers.map(header => ({
    sopInstanceUid: header.sopInstanceUid,
    instanceNumber: header.instanceNumber,
    filePath: header.filePath,
    fileSize: header.fileSize,
    pixels: header.pixels,
    slicePosition: positions?.get(header.sopInstanceUid),
  }));

  instances.sort((a, b) => {
    if (positions) {
      const byPosition = byOptionalNumber(a.slicePosition, b.slicePosition);
      if (byPosition !== 0) {
        return byPosition;
      }
    }
    const byNumber = byOptionalNumber(a.instanceNumber, b.instanceNumber);
    // The path is the last resort, and it is here so two runs over the same
    // folder produce the same order rather than the file system's.
    return byNumber !== 0 ? byNumber : a.filePath.localeCompare(b.filePath);
  });

  return {
    seriesInstanceUid: first.seriesInstanceUid,
    seriesNumber: first.seriesNumber,
    description: first.seriesDescription,
    modality: first.modality,
    instances,
    orderedByGeometry: positions !== undefined,
  };
}

/** Groups by a key, keeping first-seen order. */
function groupBy<T>(items: T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) {
      group.push(item);
    } else {
      groups.set(k, [item]);
    }
  }
  return [...groups.values()];
}

function buildStudy(headers: InstanceHeader[]): Study {
  const first = headers[0] as InstanceHeader;

  const series = groupBy(headers, h => h.seriesInstanceUid).map(buildSeries);
  series.sort(
    (a, b) =>
      byOptionalNumber(a.seriesNumber, b.seriesNumber) ||
      a.seriesInstanceUid.localeCompare(b.seriesInstanceUid)
  );

  return {
    studyInstanceUid: first.studyInstanceUid,
    studyDate: first.studyDate,
    studyTime: first.studyTime,
    description: first.studyDescription,
    accessionNumber: first.accessionNumber,
    series,
    modalities: [...new Set(series.map(s => s.modality).filter(Boolean))].sort(),
    instanceCount: headers.length,
  };
}

function buildPatient(headers: InstanceHeader[], key: string): Patient {
  const first = headers[0] as InstanceHeader;

  const studies = groupBy(headers, h => h.studyInstanceUid).map(buildStudy);
  // Most recent first: that is the one being read.
  studies.sort(
    (a, b) =>
      `${b.studyDate}${b.studyTime}`.localeCompare(`${a.studyDate}${a.studyTime}`) ||
      a.studyInstanceUid.localeCompare(b.studyInstanceUid)
  );

  return {
    patientId: first.patientId || key,
    name: first.patientName,
    birthDate: first.patientBirthDate,
    sex: first.patientSex,
    studies,
  };
}

/**
 * Groups headers into the index.
 *
 * Two files claiming the same SOP Instance UID are the same image — a study
 * copied into two folders, or one folder indexed twice. The second is counted
 * and dropped: a series that shows every slice twice is worse than one that
 * quietly deduplicates, and a count that says so is better than silence.
 */
export function buildIndex(headers: InstanceHeader[]): Index {
  const seen = new Set<string>();
  const unique: InstanceHeader[] = [];
  let duplicates = 0;

  for (const header of headers) {
    // An image with no UID at all is not a copy of the last image with no UID.
    // Anonymisers blank the tag rather than replacing it, and a header cut
    // short loses it the same way; keying on the empty string collapsed every
    // one of them into a single instance and reported the rest as duplicates,
    // which is a false statement about several different images.
    if (!header.sopInstanceUid) {
      unique.push(header);
      continue;
    }

    if (seen.has(header.sopInstanceUid)) {
      duplicates++;
      continue;
    }
    seen.add(header.sopInstanceUid);
    unique.push(header);
  }

  // Patients are keyed by id. Two spellings of one name under the same id are a
  // data entry difference, not two people; the first spelling wins and the
  // reading list stays one row.
  const patients = groupBy(unique, h => h.patientId || h.patientName || '(unidentified)').map(
    group => buildPatient(group, group[0]?.patientId || '(unidentified)')
  );

  patients.sort((a, b) => a.name.localeCompare(b.name) || a.patientId.localeCompare(b.patientId));

  return { patients, duplicates };
}
