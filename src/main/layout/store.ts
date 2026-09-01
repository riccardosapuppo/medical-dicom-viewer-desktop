/**
 * Remembering which screen a series was sent to.
 *
 * Keyed on the desk fingerprint rather than on anything the operating system
 * hands out, for the reason the fingerprint exists at all: screen ids do not
 * survive a reboot or a cable being moved, and a layout keyed on them comes
 * back attached to the wrong glass. A radiologist who docks their laptop in the
 * morning gets the arrangement they left; the same person working from the
 * laptop alone gets a different desk and a different arrangement, which is
 * correct rather than a failure to remember.
 *
 * Series are keyed by their UID, so the arrangement follows the study rather
 * than the folder it happened to be copied into.
 *
 * The file is small, written whole, and read defensively: it is on someone's
 * disk between sessions, and a truncated or hand-edited one must lose the
 * memory, never the application.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** Where a series was put, on one particular desk. */
export interface Placement {
  /** The pane's position in the normalised desk, not any id the system gave it. */
  pane: number;
  /** When it was last put there, so the oldest can be dropped first. */
  at: number;
}

export interface DeskLayout {
  /** Series UID to placement. */
  series: Record<string, Placement>;
}

export interface Layouts {
  /** Desk fingerprint to what was arranged on it. */
  desks: Record<string, DeskLayout>;

  /**
   * Folders opened before, newest first.
   *
   * Because a reading room opens the same folder every morning, and browsing
   * for it by hand every morning is the kind of small daily friction that makes
   * somebody keep using the old software instead.
   */
  recent?: string[];
}

/** Desks worth remembering. Beyond this the least recently touched are dropped. */
const MAX_DESKS = 24;
/** Series remembered per desk. A radiologist does not arrange a thousand of them. */
const MAX_SERIES = 200;

/** How many folders are worth offering. More than this is an archive, not a list. */
const MAX_RECENT = 8;

export const EMPTY: Layouts = { desks: {} };

/**
 * Reads the file, or gives back an empty memory.
 *
 * Anything unreadable, unparseable or the wrong shape becomes empty rather than
 * an error. The worst outcome of a bad layouts file should be that the windows
 * open where they would have opened the first time.
 */
export function load(file: string): Layouts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { desks: {} };
  }

  if (typeof parsed !== 'object' || parsed === null || !('desks' in parsed)) {
    return { desks: {} };
  }

  const desks: Record<string, DeskLayout> = {};

  for (const [fingerprint, value] of Object.entries((parsed as Layouts).desks ?? {})) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }

    const series: Record<string, Placement> = {};
    for (const [uid, placement] of Object.entries(value.series ?? {})) {
      // A pane index that is not a whole number, or is negative, would send a
      // window to a screen that cannot exist.
      if (
        typeof placement?.pane === 'number' &&
        Number.isInteger(placement.pane) &&
        placement.pane >= 0 &&
        typeof placement.at === 'number' &&
        Number.isFinite(placement.at)
      ) {
        series[uid] = { pane: placement.pane, at: placement.at };
      }
    }

    desks[fingerprint] = { series };
  }

  const raw = (parsed as Layouts).recent;
  const recent = Array.isArray(raw)
    ? raw.filter((folder): folder is string => typeof folder === 'string' && folder.length > 0)
    : [];

  return { desks, ...(recent.length ? { recent: recent.slice(0, MAX_RECENT) } : {}) };
}

export function save(file: string, layouts: Layouts): void {
  writeFileSync(file, `${JSON.stringify(layouts, null, 2)}\n`, 'utf8');
}

/** Keeps the newest entries of a record, by their `at`. */
function newest<T extends { at: number }>(entries: Record<string, T>, keep: number): Record<string, T> {
  const sorted = Object.entries(entries).sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(sorted.slice(0, keep));
}

/**
 * Records that a series was put on a pane.
 *
 * Returns a new object rather than mutating: the caller holds the memory and
 * decides when it reaches the disk, and a half-applied change that was never
 * written is a memory that disagrees with the file.
 */
export function remember(
  layouts: Layouts,
  fingerprint: string,
  seriesInstanceUid: string,
  pane: number,
  now: number
): Layouts {
  const desk = layouts.desks[fingerprint] ?? { series: {} };
  const series = newest(
    { ...desk.series, [seriesInstanceUid]: { pane, at: now } },
    MAX_SERIES
  );

  const desks = { ...layouts.desks, [fingerprint]: { series } };

  // Desks accumulate: a laptop that visits three sites is three desks a week.
  // The oldest go, judged by the most recent thing arranged on each.
  if (Object.keys(desks).length > MAX_DESKS) {
    const withAge = Object.entries(desks).map(([key, value]) => [
      key,
      { ...value, at: Math.max(0, ...Object.values(value.series).map(p => p.at)) },
    ]) as Array<[string, DeskLayout & { at: number }]>;

    const kept = newest(Object.fromEntries(withAge), MAX_DESKS);
    return {
      desks: Object.fromEntries(
        Object.entries(kept).map(([key, value]) => [key, { series: value.series }])
      ),
    };
  }

  return { desks };
}

/**
 * Which pane a series was last on, if this desk remembers it.
 *
 * A pane index from a desk with fewer panes than it had is not returned: the
 * arrangement was made on a bigger desk, and opening a window on a screen that
 * is no longer there puts it somewhere nobody can see.
 */
export function recall(
  layouts: Layouts,
  fingerprint: string,
  seriesInstanceUid: string,
  paneCount: number
): number | undefined {
  const pane = layouts.desks[fingerprint]?.series[seriesInstanceUid]?.pane;
  return pane !== undefined && pane < paneCount ? pane : undefined;
}

/** Everything arranged on this desk, newest first. */
export function arrangement(
  layouts: Layouts,
  fingerprint: string,
  paneCount: number
): Array<{ seriesInstanceUid: string; pane: number }> {
  return Object.entries(layouts.desks[fingerprint]?.series ?? {})
    .filter(([, placement]) => placement.pane < paneCount)
    .sort((a, b) => b[1].at - a[1].at)
    .map(([seriesInstanceUid, placement]) => ({ seriesInstanceUid, pane: placement.pane }));
}

/**
 * Puts a folder at the top of the list of the ones opened before.
 *
 * Moved rather than added when it is already there: a list that shows the same
 * folder four times is a list nobody uses twice.
 */
export function rememberFolder(layouts: Layouts, folder: string): Layouts {
  if (!folder) {
    return layouts;
  }
  const rest = (layouts.recent ?? []).filter(other => other !== folder);
  return { ...layouts, recent: [folder, ...rest].slice(0, MAX_RECENT) };
}
