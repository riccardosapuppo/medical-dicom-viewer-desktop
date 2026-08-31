/**
 * The desk: which panes of glass are attached, and how to recognise it again.
 *
 * Two notes that cost time if you learn them later.
 *
 * Electron's `screen` module can only be asked after `app.whenReady()`. Called
 * before that it throws, and the message does not say why.
 *
 * And the key for remembering an arrangement is never `display.id`. Those ids
 * are handed out by the operating system and do not survive a reboot, a cable
 * being moved, or a monitor waking in a different order — a layout saved
 * against them comes back attached to the wrong glass, or to none. What does
 * survive is the shape of the desk itself: how many panes, how big in real
 * pixels, at what scaling and rotation, and where each sits relative to the
 * primary. That is what gets hashed.
 */
import { createHash } from 'node:crypto';

/** A rectangle as Electron reports it, in device-independent pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One pane of glass, with everything worth knowing about it. */
export interface Pane {
  id: number;
  label: string;
  bounds: Rect;
  /** The bounds minus whatever the system reserves — taskbar, dock, menu bar. */
  workArea: Rect;
  scaleFactor: number;
  rotation: number;
  internal: boolean;
  colorDepth: number;
  displayFrequency: number;
  /** Real pixels, which is what a radiologist means by "four megapixel". */
  physical: { width: number; height: number };
  /** Where this pane sits relative to the primary one. */
  offsetFromPrimary: { x: number; y: number };
  isPrimary: boolean;
}

export interface Topology {
  panes: Pane[];
  primaryId: number;
}

/**
 * Reads the desk. Must be called after the application is ready.
 *
 * Takes the `screen` module as an argument rather than importing it, so the
 * pure functions below can be exercised without an Electron process at all —
 * and so a desk nobody owns can still be described in a test.
 */
export function readTopology(screen: Electron.Screen): Topology {
  const primary = screen.getPrimaryDisplay();

  const panes = screen.getAllDisplays().map((display, index): Pane => {
    const { bounds, workArea, scaleFactor, rotation, internal, colorDepth, displayFrequency } =
      display;

    return {
      id: display.id,
      // Windows usually reports no label at all. Falling back to the id would
      // print, in the one line a person actually reads, the very number the
      // comment at the top of this file says not to trust. An ordinal is
      // honest: it names where the pane sits in this reading, and nothing more.
      label: display.label || `Screen ${index + 1}`,
      bounds: { ...bounds },
      workArea: { ...workArea },
      scaleFactor,
      rotation,
      internal,
      colorDepth,
      displayFrequency,
      physical: {
        width: Math.round(bounds.width * scaleFactor),
        height: Math.round(bounds.height * scaleFactor),
      },
      offsetFromPrimary: {
        x: bounds.x - primary.bounds.x,
        y: bounds.y - primary.bounds.y,
      },
      isPrimary: display.id === primary.id,
    };
  });

  return { panes, primaryId: primary.id };
}

/** A reading of the desk together with the name for it. */
export interface Desk extends Topology {
  fingerprint: string;
}

/**
 * The desk and its fingerprint in one object.
 *
 * Anything outside this module that needs both should ask for both here rather
 * than hashing the topology again: two places computing the same digest are two
 * places that can come to disagree, and the one that decides where windows go
 * has to win.
 */
export function readDesk(screen: Electron.Screen): Desk {
  const topology = readTopology(screen);
  return { ...topology, fingerprint: fingerprint(topology) };
}

/** What a pane looks like once identity is thrown away. */
interface NormalisedPane {
  width: number;
  height: number;
  scaleFactor: number;
  rotation: number;
  internal: boolean;
  x: number;
  y: number;
}

/**
 * The desk with the names filed off, in an order that does not depend on the
 * order the system happened to enumerate them in.
 *
 * Ids and labels are dropped on purpose: the same physical desk must normalise
 * to the same value tomorrow morning. Sorting is explicit for the same reason —
 * `getAllDisplays()` gives no ordering guarantee, and an arrangement that only
 * matched when the panes came back in the same sequence would be a coin toss.
 */
export function normalise(topology: Topology): NormalisedPane[] {
  return topology.panes
    .map(pane => ({
      width: pane.physical.width,
      height: pane.physical.height,
      scaleFactor: pane.scaleFactor,
      rotation: pane.rotation,
      internal: pane.internal,
      x: pane.offsetFromPrimary.x,
      y: pane.offsetFromPrimary.y,
    }))
    .sort((a, b) => a.x - b.x || a.y - b.y || a.width - b.width || a.height - b.height);
}

/**
 * A short, stable name for this desk.
 *
 * Twelve hex characters: enough that two different desks will not collide in
 * any collection a person owns, short enough to read out over the phone and to
 * put in a file name.
 */
export function fingerprint(topology: Topology): string {
  return createHash('sha256').update(JSON.stringify(normalise(topology))).digest('hex').slice(0, 12);
}

/** The desk in words, for the console. */
export function describe(topology: Topology): string {
  const lines: string[] = [];

  for (const pane of topology.panes) {
    const role = [pane.isPrimary ? 'primary' : null, pane.internal ? 'built-in' : null]
      .filter(Boolean)
      .join(', ');

    lines.push(`${pane.label}${role ? `  (${role})` : ''}`);
    lines.push(
      `  ${pane.physical.width}x${pane.physical.height} real pixels` +
        `   scale ${pane.scaleFactor}x` +
        `   ${pane.bounds.width}x${pane.bounds.height} points`
    );
    lines.push(
      `  at ${pane.offsetFromPrimary.x},${pane.offsetFromPrimary.y} from the primary` +
        `   rotation ${pane.rotation}deg` +
        (pane.displayFrequency ? `   ${pane.displayFrequency} Hz` : '') +
        (pane.colorDepth ? `   ${pane.colorDepth} bit` : '')
    );

    const reserved =
      pane.bounds.width - pane.workArea.width || pane.bounds.height - pane.workArea.height;
    if (reserved) {
      lines.push(
        `  usable ${pane.workArea.width}x${pane.workArea.height} at ` +
          `${pane.workArea.x},${pane.workArea.y}  (the system keeps the rest)`
      );
    }
    lines.push('');
  }

  lines.push(`Desk fingerprint: ${fingerprint(topology)}`);
  lines.push(
    `${topology.panes.length} ${topology.panes.length === 1 ? 'screen' : 'screens'}. ` +
      'The same desk always gives the same fingerprint; unplugging or rescaling one changes it.'
  );

  return lines.join('\n');
}
