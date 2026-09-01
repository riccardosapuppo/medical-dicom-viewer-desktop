/**
 * The index, answered as a DICOMweb query.
 *
 * QIDO-RS is three questions — which studies, which series in one, which images
 * in one — and each answer is a list of small datasets in the JSON form. None of
 * this touches a disc: the index was built when the folder was opened, and every
 * answer here is a reshaping of what it already holds.
 *
 * Keeping it pure has a point beyond tidiness. The interesting mistakes in a
 * query layer are about counting and matching, not about sockets, and those can
 * all be provoked here with an index built by hand.
 */
import type { Index, Patient, Series, Study } from '../dicom/build-index';

export interface JsonElement {
  vr: string;
  Value?: unknown[];
}

export type QueryResult = Record<string, JsonElement>;

/** An element, left empty rather than absent when there is nothing to say. */
function text(vr: string, value: string | undefined): JsonElement {
  return value ? { vr, Value: [value] } : { vr };
}

function number(vr: string, value: number | undefined): JsonElement {
  return value === undefined ? { vr } : { vr, Value: [value] };
}

function personName(value: string | undefined): JsonElement {
  return value ? { vr: 'PN', Value: [{ Alphabetic: value }] } : { vr: 'PN' };
}

/** Every study in the index, with the patient it belongs to carried along. */
function studies(index: Index): Array<{ patient: Patient; study: Study }> {
  return index.patients.flatMap(patient => patient.studies.map(study => ({ patient, study })));
}

export function studyQuery(index: Index, wadoRoot: string): QueryResult[] {
  return studies(index).map(({ patient, study }) => ({
    '00080005': { vr: 'CS', Value: ['ISO_IR 192'] },
    '00080020': text('DA', study.studyDate),
    '00080030': text('TM', study.studyTime),
    '00080050': text('SH', study.accessionNumber),
    // Read straight off a disc: there is no archive to name, and nothing is
    // fetched any later than now.
    '00080056': { vr: 'CS', Value: ['ONLINE'] },
    '00080061': study.modalities.length ? { vr: 'CS', Value: study.modalities } : { vr: 'CS' },
    '00081030': text('LO', study.description),
    '00081190': { vr: 'UR', Value: [`${wadoRoot}/studies/${study.studyInstanceUid}`] },
    '00100010': personName(patient.name),
    '00100020': text('LO', patient.patientId),
    '00100030': text('DA', patient.birthDate),
    '00100040': text('CS', patient.sex),
    '0020000D': text('UI', study.studyInstanceUid),
    '00200010': { vr: 'SH' },
    '00201206': { vr: 'IS', Value: [study.series.length] },
    '00201208': { vr: 'IS', Value: [study.instanceCount] },
  }));
}

function seriesResult(study: Study, series: Series, wadoRoot: string): QueryResult {
  return {
    '00080005': { vr: 'CS', Value: ['ISO_IR 192'] },
    '00080060': text('CS', series.modality),
    '0008103E': text('LO', series.description),
    '00081190': {
      vr: 'UR',
      Value: [`${wadoRoot}/studies/${study.studyInstanceUid}/series/${series.seriesInstanceUid}`],
    },
    '0020000D': text('UI', study.studyInstanceUid),
    '0020000E': text('UI', series.seriesInstanceUid),
    '00200011': number('IS', series.seriesNumber),
    '00201209': { vr: 'IS', Value: [series.instances.length] },
  };
}

export function seriesQuery(index: Index, studyUid: string, wadoRoot: string): QueryResult[] {
  const found = studies(index).find(({ study }) => study.studyInstanceUid === studyUid);
  if (!found) {
    return [];
  }
  return found.study.series.map(series => seriesResult(found.study, series, wadoRoot));
}

/** Every series in the index, whichever study it sits in. */
export function allSeriesQuery(index: Index, wadoRoot: string): QueryResult[] {
  return studies(index).flatMap(({ study }) =>
    study.series.map(series => seriesResult(study, series, wadoRoot))
  );
}

export function instanceQuery(
  index: Index,
  studyUid: string,
  seriesUid: string,
  wadoRoot: string
): QueryResult[] {
  const found = studies(index).find(({ study }) => study.studyInstanceUid === studyUid);
  const series = found?.study.series.find(one => one.seriesInstanceUid === seriesUid);
  if (!series) {
    return [];
  }

  return series.instances.map(instance => ({
    '00080005': { vr: 'CS', Value: ['ISO_IR 192'] },
    '00080018': text('UI', instance.sopInstanceUid),
    '00080060': text('CS', series.modality),
    '00081190': {
      vr: 'UR',
      Value: [
        `${wadoRoot}/studies/${studyUid}/series/${seriesUid}/instances/${instance.sopInstanceUid}`,
      ],
    },
    '0020000D': text('UI', studyUid),
    '0020000E': text('UI', seriesUid),
    '00200013': number('IS', instance.instanceNumber),
    '00280008': { vr: 'IS', Value: [instance.pixels.numberOfFrames] },
    '00280010': number('US', instance.pixels.rows),
    '00280011': number('US', instance.pixels.columns),
    '00280100': number('US', instance.pixels.bitsAllocated),
  }));
}

/**
 * Narrows a list of studies the way the query parameters ask.
 *
 * The viewer's study list sends a name and a date range and expects matching to
 * behave as the standard describes it. Answering the whole list regardless would
 * look like it works — the viewer would show something — while quietly ignoring
 * what was typed.
 */
export interface Filters {
  patientName?: string;
  patientId?: string;
  accessionNumber?: string;
  studyDescription?: string;
  modality?: string;
  studyDateFrom?: string;
  studyDateTo?: string;
  limit?: number;
  offset?: number;
}

function valueOf(result: QueryResult, tag: string): string {
  const first = result[tag]?.Value?.[0];
  if (typeof first === 'string') {
    return first;
  }
  if (first !== null && typeof first === 'object' && 'Alphabetic' in first) {
    return String((first as { Alphabetic?: string }).Alphabetic ?? '');
  }
  return '';
}

/**
 * Wildcard matching, as the standard means it: `*` for any run, `?` for one.
 *
 * Written out rather than handed to a regular expression on purpose. A patient
 * name is user input, it routinely contains characters a regular expression
 * treats as syntax, and building a pattern by hand out of a name is how a search
 * box becomes either wrong or dangerous.
 */
export function matches(value: string, pattern: string): boolean {
  const text = value.toLowerCase();
  const wanted = pattern.toLowerCase();

  // Walked with two cursors and one remembered branch point, so a trailing
  // wildcard never needs to backtrack more than once.
  let at = 0;
  let against = 0;
  let star = -1;
  let resumeAt = 0;

  while (at < text.length) {
    const symbol = wanted[against];

    if (against < wanted.length && (symbol === '?' || symbol === text[at])) {
      at++;
      against++;
    } else if (against < wanted.length && symbol === '*') {
      star = against;
      resumeAt = at;
      against++;
    } else if (star !== -1) {
      against = star + 1;
      resumeAt++;
      at = resumeAt;
    } else {
      return false;
    }
  }

  while (wanted[against] === '*') {
    against++;
  }
  return against === wanted.length;
}

export function applyFilters(results: QueryResult[], filters: Filters): QueryResult[] {
  let kept = results;

  if (filters.patientName) {
    const wanted = filters.patientName;
    kept = kept.filter(one => matches(valueOf(one, '00100010'), wanted));
  }
  if (filters.patientId) {
    const wanted = filters.patientId;
    kept = kept.filter(one => matches(valueOf(one, '00100020'), wanted));
  }
  if (filters.accessionNumber) {
    const wanted = filters.accessionNumber;
    kept = kept.filter(one => matches(valueOf(one, '00080050'), wanted));
  }
  if (filters.studyDescription) {
    const wanted = filters.studyDescription;
    kept = kept.filter(one => matches(valueOf(one, '00081030'), wanted));
  }
  if (filters.modality) {
    const wanted = filters.modality.toUpperCase();
    kept = kept.filter(one => {
      const present = (one['00080061']?.Value ?? []) as string[];
      return present.some(value => String(value).toUpperCase() === wanted);
    });
  }
  if (filters.studyDateFrom) {
    const from = filters.studyDateFrom;
    kept = kept.filter(one => valueOf(one, '00080020') >= from);
  }
  if (filters.studyDateTo) {
    const to = filters.studyDateTo;
    kept = kept.filter(one => valueOf(one, '00080020') <= to);
  }

  const offset = filters.offset ?? 0;
  const limit = filters.limit;
  return limit === undefined ? kept.slice(offset) : kept.slice(offset, offset + limit);
}

/**
 * Reads the query parameters the viewer sends.
 *
 * Dates arrive as one string with a dash in the middle, and either end may be
 * missing. An open end is a real query, not a malformed one.
 */
export function readFilters(parameters: URLSearchParams): Filters {
  const filters: Filters = {};
  const take = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = parameters.get(name);
      if (value) {
        return value;
      }
    }
    return undefined;
  };

  // Set only when present. An absent parameter and an empty one both mean "do
  // not narrow by this", and writing the key with nothing in it would turn the
  // second into a filter that matches nobody.
  const set = (key: keyof Filters, value: string | undefined): void => {
    if (value) {
      (filters as Record<string, unknown>)[key] = value;
    }
  };

  set('patientName', take('PatientName', '00100010'));
  set('patientId', take('PatientID', '00100020'));
  set('accessionNumber', take('AccessionNumber', '00080050'));
  set('studyDescription', take('StudyDescription', '00081030'));
  set('modality', take('ModalitiesInStudy', '00080061', 'Modality', '00080060'));

  const dates = take('StudyDate', '00080020');
  if (dates) {
    const [from, to] = dates.includes('-') ? dates.split('-') : [dates, dates];
    if (from) {
      filters.studyDateFrom = from;
    }
    if (to) {
      filters.studyDateTo = to;
    }
  }

  const limit = Number(parameters.get('limit'));
  if (Number.isFinite(limit) && limit > 0) {
    filters.limit = limit;
  }
  const offset = Number(parameters.get('offset'));
  if (Number.isFinite(offset) && offset > 0) {
    filters.offset = offset;
  }

  return filters;
}
