/**
 * Whether an image can be drawn at all, and why not.
 *
 * In a module of its own because both sides need it: the process that refuses
 * to serve the pixels, and the page that greys out the row and says why. Two
 * copies of this rule would eventually disagree, and the disagreement would
 * show as a row that can be clicked and then fails.
 *
 * It imports nothing. read-header, where this used to live, opens files — and
 * pulling that into the renderer pulls Node into a browser bundle.
 */
import type { PixelLayout } from './read-header';
/** Why an image cannot be drawn, and which kind of "cannot" it is. */
export interface Undrawable {
  reason: string;
  /** Undecodable: this viewer has no code for it. Incomplete: the file is short. */
  kind: 'undecodable' | 'incomplete';
}

/**
 * Why this image cannot be drawn, or undefined when it can.
 *
 * One function, used by the server that refuses to serve it and by the worklist
 * that greys out its row, so the two can never disagree — and so the row can say
 * which of the reasons it is instead of "cannot be displayed yet", which tells
 * nobody anything.
 */
export function undrawable(pixels: PixelLayout): Undrawable | undefined {
  // Compression is checked before completeness: encapsulated pixel data has no
  // declared length, so it is never "complete", and reporting a JPEG 2000 study
  // as a truncated file sends whoever reads that looking for a bad copy.
  if (pixels.encapsulated) {
    return {
      reason: `compressed (${pixels.transferSyntaxUid || 'unknown syntax'}), not decoded`,
      kind: 'undecodable',
    };
  }
  if (!pixels.complete) {
    return { reason: 'a file that stops before its pixel data', kind: 'incomplete' };
  }
  // A greyscale renderer given colour draws one of the three samples across the
  // whole image: a grey smear that looks like a broken image rather than like a
  // refusal, and says nothing at all.
  if (pixels.samplesPerPixel > 1) {
    return {
      reason: `colour (${pixels.samplesPerPixel} samples per pixel), not drawn`,
      kind: 'undecodable',
    };
  }
  const photometric = pixels.photometricInterpretation.toUpperCase();
  if (photometric.startsWith('PALETTE')) {
    // The stored values are indexes into a colour table, not brightnesses.
    // Drawn as brightnesses they produce a picture that is wrong everywhere and
    // looks plausible in places.
    return { reason: 'a colour palette, not brightness values', kind: 'undecodable' };
  }
  if (photometric.startsWith('YBR')) {
    return { reason: `${pixels.photometricInterpretation}, not drawn`, kind: 'undecodable' };
  }
  return undefined;
}
