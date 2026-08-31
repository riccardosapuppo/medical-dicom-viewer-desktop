/**
 * Turning what DICOM stores into what a person reads.
 *
 * Small, dull, and pure — which is the point. Every one of these has an
 * awkward case that only shows up on a real archive: a date that is not a
 * date, a birth date that makes the patient a hundred and forty, a path with
 * one segment. Kept out of the components so they can be checked by argument
 * rather than by looking at a screenshot and hoping.
 */

const BACKSLASH = String.fromCharCode(92);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 20240412 -> "12 Apr 2024". Anything that is not a DICOM date is left alone. */
export function readableDate(raw: string): string {
  if (!/^\d{8}$/.test(raw)) {
    return raw || 'undated';
  }
  const month = MONTHS[Number(raw.slice(4, 6)) - 1];
  // A month outside 1-12 means the field is not what it claims to be, and
  // inventing a name for it would hide that.
  return month ? `${Number(raw.slice(6))} ${month} ${raw.slice(0, 4)}` : raw;
}

/** 093015 -> "09:30". Blank if the field is not a time. */
export function readableTime(raw: string): string {
  return /^\d{4}/.test(raw) ? `${raw.slice(0, 2)}:${raw.slice(2, 4)}` : '';
}

/**
 * Age in years at the time of the study.
 *
 * Blank rather than wrong when the numbers do not support it: a missing birth
 * date, a study dated before it, or an age no person has reached. A worklist
 * that says 140y is a worklist nobody trusts again.
 */
export function age(birthDate: string, studyDate: string): string {
  if (!/^\d{8}$/.test(birthDate) || !/^\d{8}$/.test(studyDate)) {
    return '';
  }
  const years = Math.floor((Number(studyDate) - Number(birthDate)) / 10000);
  return years >= 0 && years < 130 ? `${years}y` : '';
}

/**
 * The tail of a path: the folder and its parent.
 *
 * Which folder is open is the question; which drive it is on is not.
 * Truncating with CSS cuts the wrong end, and the trick for cutting the other
 * end — reversing the text direction — reverses the punctuation with it, so a
 * folder given as ./demo-data appeared on screen as demo-data/. The whole path
 * is still there to hover.
 */
export function tailOfPath(full: string): string {
  const parts = full.split(BACKSLASH).join('/').split('/').filter(Boolean);
  if (parts.length <= 2) {
    return full;
  }
  const separator = full.includes(BACKSLASH) ? BACKSLASH : '/';
  return `...${separator}${parts.slice(-2).join(separator)}`;
}

/** Bytes as something a person would say out loud. */
export function readableSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}
