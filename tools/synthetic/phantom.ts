/**
 * Draws the slices the demo studies are made of.
 *
 * Nothing here is a real patient, and nothing here is noise either. The volume
 * is a sphere inside a cylinder with a few inclusions, in Hounsfield units, so
 * that scrolling through a series actually shows something changing, window and
 * level have a range to work on, and a reformatted plane comes out of the
 * volume looking like a plane through a sphere rather than a smear.
 *
 * It is deterministic on purpose: the same call gives the same bytes, so two
 * runs of the generator produce an identical folder and a test can rely on it.
 */

/** Hounsfield units, the scale CT numbers live on. */
const AIR = -1000;
const FAT = -90;
const WATER = 0;
const SOFT_TISSUE = 45;
const BONE = 900;

export interface SliceShape {
  rows: number;
  columns: number;
  /** Millimetres per pixel. */
  spacing: number;
  /** Where this slice sits along the axis, in millimetres. */
  z: number;
  /** Half the extent of the volume along the axis, in millimetres. */
  halfDepth: number;
}

/**
 * One axial slice as signed 16-bit Hounsfield units.
 *
 * The stored values are the real thing rather than something rescaled to fit,
 * which is why the files carry a rescale intercept of zero and a slope of one:
 * a viewer that ignores them still reads correct numbers.
 */
export function axialSlice({ rows, columns, spacing, z, halfDepth }: SliceShape): Int16Array {
  const pixels = new Int16Array(rows * columns);

  const centreX = (columns - 1) / 2;
  const centreY = (rows - 1) / 2;

  const bodyRadius = Math.min(rows, columns) * 0.42;
  const skinThickness = 6 / spacing;

  // The sphere shrinks towards the ends of the stack, which is what makes
  // scrolling look like travelling through something.
  const sphereRadiusMm = 60;
  const offAxis = Math.min(Math.abs(z) / halfDepth, 1);
  const sphereRadius =
    (sphereRadiusMm / spacing) * Math.sqrt(Math.max(0, 1 - offAxis * offAxis * 1.6));

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const dx = x - centreX;
      const dy = y - centreY;
      const fromCentre = Math.hypot(dx, dy);

      let value = AIR;

      if (fromCentre <= bodyRadius) {
        value = SOFT_TISSUE;

        // A rind of fat under the skin, and the skin itself.
        if (fromCentre > bodyRadius - skinThickness) {
          value = FAT;
        }

        // Two ribs, as arcs rather than dots, so a reformatted plane cuts
        // through something with a shape.
        const angle = Math.atan2(dy, dx);
        const onRibRing = Math.abs(fromCentre - bodyRadius * 0.86) < 3 / spacing;
        const inRibArc = Math.abs(Math.sin(angle * 6)) > 0.75;
        if (onRibRing && inRibArc) {
          value = BONE;
        }

        // The sphere in the middle: water, so it stands out from soft tissue
        // at any sensible window.
        if (sphereRadius > 0 && fromCentre <= sphereRadius) {
          value = WATER;

          // A denser inclusion off to one side, present only in the middle of
          // the stack. Something to find, and something to measure.
          const nodule = Math.hypot(dx - sphereRadius * 0.4, dy + sphereRadius * 0.25);
          if (Math.abs(z) < halfDepth * 0.25 && nodule < 9 / spacing) {
            value = SOFT_TISSUE + 60;
          }
        }
      }

      pixels[y * columns + x] = value;
    }
  }

  return pixels;
}

/** A flat projection, the way a scout view looks. */
export function scoutImage(rows: number, columns: number): Int16Array {
  const pixels = new Int16Array(rows * columns);

  for (let y = 0; y < rows; y++) {
    const alongBody = Math.abs(y - (rows - 1) / 2) / (rows / 2);
    for (let x = 0; x < columns; x++) {
      const across = Math.abs(x - (columns - 1) / 2) / (columns * 0.42);
      const inside = across <= 1 && alongBody <= 1;
      const thickness = inside ? Math.sqrt(1 - across * across) : 0;
      pixels[y * columns + x] = Math.round(AIR + (SOFT_TISSUE - AIR) * thickness);
    }
  }

  return pixels;
}
