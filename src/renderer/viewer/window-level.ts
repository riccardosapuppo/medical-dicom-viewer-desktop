/**
 * Turning stored numbers into grey.
 *
 * A CT stores Hounsfield units, roughly -1000 to 3000. A screen has 256 greys.
 * The window is the slice of that range being looked at, and picking it is the
 * single most consequential thing a radiologist does to an image: lung, soft
 * tissue and bone are the same pixels seen through three different windows.
 *
 * The arithmetic is the linear VOI transformation from the standard, and it is
 * written here rather than inline in a shader so it can be checked against the
 * numbers in the standard rather than by squinting at a screenshot.
 */
import type { PixelLayout } from '../../main/dicom/read-header';

export interface Window {
  centre: number;
  width: number;
}

/** The windows a radiologist reaches for, by the names they use. */
export const PRESETS: ReadonlyArray<{ name: string; window: Window }> = [
  { name: 'Soft tissue', window: { centre: 40, width: 400 } },
  { name: 'Lung', window: { centre: -600, width: 1500 } },
  { name: 'Bone', window: { centre: 300, width: 1500 } },
  { name: 'Brain', window: { centre: 40, width: 80 } },
  { name: 'Liver', window: { centre: 60, width: 160 } },
];

/**
 * The window to open an image with.
 *
 * The file's own suggestion first — a scanner that says how it should be looked
 * at is usually right, and an operator may have set it deliberately. Failing
 * that, the full range the stored bits can express, which shows everything
 * badly rather than nothing well: an image that comes up black because the
 * default window missed it looks like a broken viewer.
 */
export function defaultWindow(pixels: PixelLayout): Window {
  if (pixels.windowWidth !== undefined && pixels.windowWidth > 0) {
    return { centre: pixels.windowCenter ?? 0, width: pixels.windowWidth };
  }

  const bits = pixels.bitsStored ?? pixels.bitsAllocated ?? 16;
  const span = 2 ** bits;
  const low = pixels.signed ? -(span / 2) : 0;
  const high = pixels.signed ? span / 2 - 1 : span - 1;

  const lowValue = low * pixels.rescaleSlope + pixels.rescaleIntercept;
  const highValue = high * pixels.rescaleSlope + pixels.rescaleIntercept;

  return {
    centre: (lowValue + highValue) / 2,
    width: Math.max(1, Math.abs(highValue - lowValue)),
  };
}

/**
 * A value in the units the file measures in, as a grey between 0 and 1.
 *
 * This is the linear VOI LUT function from PS3.3 C.11.2.1.2: the half-unit
 * offsets are in the standard and are not a rounding accident. Dropping them
 * shifts every pixel by half a window step, which is invisible on a wide window
 * and obvious on a narrow one — a brain window is eighty units across, and half
 * a step is most of a grey level.
 */
export function toGrey(value: number, { centre, width }: Window): number {
  const usable = Math.max(1, width);

  if (value <= centre - 0.5 - (usable - 1) / 2) {
    return 0;
  }
  if (value > centre - 0.5 + (usable - 1) / 2) {
    return 1;
  }
  return (value - (centre - 0.5)) / (usable - 1) + 0.5;
}

/** The stored number as the thing it measures. */
export function toValue(stored: number, pixels: PixelLayout): number {
  return stored * pixels.rescaleSlope + pixels.rescaleIntercept;
}

/** Pixels of drag that multiply the window width by e. */
const DRAG_SCALE = 200;

/**
 * The window after a drag.
 *
 * Horizontal widens, vertical brightens, which is the way every workstation
 * does it and therefore the only way that will not feel broken.
 *
 * The width changes by a factor, not by an amount. An additive step has to be
 * scaled by the current width to be usable at all, and the moment that scaled
 * step needs a floor to keep a very narrow window moving, the floor is what
 * dominates exactly where precision matters most — a brain window is eighty
 * units across, and a step of one is over a per cent of it per pixel. A factor
 * has the identical feel at every width and can never reach zero.
 *
 * The level still moves by an amount, because a centre can legitimately be
 * zero, but that amount is a fraction of the window: moving the level by a
 * fifth of the window should look the same whatever the window is.
 */
export function dragWindow(from: Window, dx: number, dy: number): Window {
  return {
    width: Math.max(1, from.width * Math.exp(dx / DRAG_SCALE)),
    centre: from.centre - (dy * from.width) / DRAG_SCALE,
  };
}

/** The window as a radiologist writes it. */
export function describeWindow({ centre, width }: Window): string {
  return `W ${Math.round(width)} L ${Math.round(centre)}`;
}

/** The name of the preset this window is, if it is one. */
export function presetName(window: Window): string | undefined {
  return PRESETS.find(
    p => Math.abs(p.window.centre - window.centre) < 0.5 && Math.abs(p.window.width - window.width) < 0.5
  )?.name;
}
