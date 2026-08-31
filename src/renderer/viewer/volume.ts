/**
 * Reformatting a stack into the other two planes.
 *
 * A CT is acquired one axial slice at a time and stored that way, but a
 * radiologist wants to look along the body as well as across it. Coronal and
 * sagittal views are not stored anywhere: they are cut out of the stack,
 * treating it as the solid it came from.
 *
 * Which is only legitimate when the stack really is a solid. Slices have to be
 * parallel, the same size, and evenly spaced — and plenty of series are none of
 * those things. A scout view is two projections. A study reconstructed at two
 * thicknesses has gaps. A localiser is three orthogonal images in one series.
 * Reformatting any of them produces a picture that looks like anatomy and is
 * not, which is worse than refusing, so most of this file is about refusing
 * with a reason.
 *
 * Everything here is arithmetic on typed arrays. It never touches a canvas, so
 * a reformat can be checked against a volume whose answer is known.
 */
import type { Frame } from './gl-image';
import type { Slide } from './frames';

export type Plane = 'axial' | 'coronal' | 'sagittal';

export const PLANES: ReadonlyArray<{ plane: Plane; name: string }> = [
  { plane: 'axial', name: 'Axial' },
  { plane: 'coronal', name: 'Coronal' },
  { plane: 'sagittal', name: 'Sagittal' },
];

/** The shape of the solid a series makes, once it is known to make one. */
export interface VolumeShape {
  columns: number;
  rows: number;
  depth: number;
  /** Millimetres per voxel across, down, and along the stack. */
  spacing: { x: number; y: number; z: number };
  signed: boolean;
  bitsAllocated: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  invert: boolean;
}

export interface Volume extends VolumeShape {
  /** Every slice, end to end, in the order they sit in the body. */
  voxels: Uint8Array | Uint16Array;
}

export type Reformattable =
  | { ok: true; shape: VolumeShape }
  | { ok: false; reason: string };

/** Three slices is the fewest that makes a solid worth cutting. */
const MIN_SLICES = 3;

/**
 * How far the gaps between slices may vary before the stack is not evenly
 * spaced.
 *
 * Not zero: positions are decimal strings in the file and the arithmetic that
 * projects them onto the normal is floating point, so exactly equal gaps come
 * out very slightly unequal. Two per cent is far below anything that would
 * distort a reformat and far above the noise.
 */
const SPACING_TOLERANCE = 0.02;

/** Beyond this a volume is refused rather than allocated. */
const MAX_BYTES = 512 * 1024 * 1024;

/** The gap that best describes a stack: the middle one, not the average. */
function medianGap(positions: number[]): number {
  const gaps = positions.slice(1).map((p, i) => p - (positions[i] as number));
  const sorted = [...gaps].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/**
 * Whether this series can be cut, and the solid it would make.
 *
 * The slides are expected in the order the index put them, which is the order
 * they sit in the body whenever the files carried the geometry to say so.
 */
export function reformattable(slides: Slide[]): Reformattable {
  if (slides.length < MIN_SLICES) {
    return { ok: false, reason: `${slides.length} images is not a stack to cut through.` };
  }

  const first = slides[0]?.pixels;
  const columns = first?.columns;
  const rows = first?.rows;

  if (!first || !columns || !rows || !first.bitsAllocated) {
    return { ok: false, reason: 'These images do not say how big they are.' };
  }

  for (const slide of slides) {
    const { pixels } = slide;
    if (pixels.columns !== columns || pixels.rows !== rows) {
      // A localiser holds three orthogonal images in one series, and a study
      // reconstructed twice can hold two matrix sizes.
      return { ok: false, reason: 'The images in this series are not all the same size.' };
    }
    if (pixels.bitsAllocated !== first.bitsAllocated || pixels.signed !== first.signed) {
      return { ok: false, reason: 'The images in this series are not all stored the same way.' };
    }
    if (pixels.numberOfFrames > 1) {
      return { ok: false, reason: 'Multi-frame images are not reformatted yet.' };
    }
  }

  const positions = slides.map(slide => slide.position);
  if (positions.some(p => p === undefined)) {
    // Without a position per slice there is no way to know how far apart they
    // are, and stacking them at an invented spacing would show a body the
    // wrong length.
    return { ok: false, reason: 'These images do not say where they sit in the patient.' };
  }

  const along = positions as number[];
  const gap = medianGap(along);

  if (Math.abs(gap) < 1e-6) {
    return { ok: false, reason: 'Every image in this series is at the same position.' };
  }

  for (let i = 1; i < along.length; i++) {
    const step = (along[i] as number) - (along[i - 1] as number);
    if (Math.abs(step - gap) > Math.abs(gap) * SPACING_TOLERANCE) {
      return {
        ok: false,
        reason: 'The images in this series are not evenly spaced, so a reformat would stretch it.',
      };
    }
  }

  const bytesPerVoxel = first.bitsAllocated <= 8 ? 1 : 2;
  const bytes = columns * rows * slides.length * bytesPerVoxel;
  if (bytes > MAX_BYTES) {
    return {
      ok: false,
      reason: `This series would need ${Math.round(bytes / (1024 * 1024))} MB of memory to reformat.`,
    };
  }

  return {
    ok: true,
    shape: {
      columns,
      rows,
      depth: slides.length,
      spacing: {
        x: first.pixelSpacing?.[1] ?? 1,
        y: first.pixelSpacing?.[0] ?? 1,
        z: Math.abs(gap),
      },
      signed: first.signed,
      bitsAllocated: first.bitsAllocated,
      rescaleSlope: first.rescaleSlope,
      rescaleIntercept: first.rescaleIntercept,
      invert: first.photometricInterpretation === 'MONOCHROME1',
    },
  };
}

/**
 * Packs the slices into one block of memory.
 *
 * In the order the index put them, which is the order they sit in the body:
 * the first is the most inferior, the last the most superior. Everything below
 * depends on that, and it is the index that earns it, by sorting on geometry
 * rather than on the number written in the file.
 */
export function buildVolume(shape: VolumeShape, frames: Frame[]): Volume {
  const perSlice = shape.columns * shape.rows;
  const voxels =
    shape.bitsAllocated <= 8
      ? new Uint8Array(perSlice * shape.depth)
      : new Uint16Array(perSlice * shape.depth);

  frames.forEach((frame, z) => {
    voxels.set(frame.pixels.subarray(0, perSlice), z * perSlice);
  });

  return { ...shape, voxels };
}

/** How many images a plane can be cut into. */
export function planeDepth(volume: VolumeShape, plane: Plane): number {
  if (plane === 'axial') {
    return volume.depth;
  }
  return plane === 'coronal' ? volume.rows : volume.columns;
}

/**
 * One cut through the volume, as something the renderer can draw.
 *
 * The two reformatted planes run along the stack, so their vertical spacing is
 * the distance between slices — usually several times the spacing within a
 * slice. A viewer that assumed square pixels here would show a body stretched
 * or squashed by that ratio, which on a five millimetre study is a factor of
 * seven and looks like a different person.
 *
 * The stack is walked from the top down, so that the most superior slice ends
 * up at the top of the picture. Anatomy is read that way and a reformat that
 * comes out upside down is not a reformat anybody trusts.
 */
export function sliceFrom(volume: Volume, plane: Plane, index: number): Frame {
  const { columns, rows, depth, voxels } = volume;
  const perSlice = columns * rows;

  const common = {
    signed: volume.signed,
    bitsAllocated: volume.bitsAllocated,
    rescaleSlope: volume.rescaleSlope,
    rescaleIntercept: volume.rescaleIntercept,
    invert: volume.invert,
  };

  if (plane === 'axial') {
    const at = Math.min(depth - 1, Math.max(0, index));
    return {
      ...common,
      pixels: voxels.subarray(at * perSlice, (at + 1) * perSlice),
      columns,
      rows,
      spacing: { x: volume.spacing.x, y: volume.spacing.y },
    };
  }

  if (plane === 'coronal') {
    // One row of every slice, stacked. Wide as the image, tall as the stack.
    const y = Math.min(rows - 1, Math.max(0, index));
    const out = voxels instanceof Uint8Array ? new Uint8Array(columns * depth) : new Uint16Array(columns * depth);

    for (let z = 0; z < depth; z++) {
      const from = (depth - 1 - z) * perSlice + y * columns;
      out.set(voxels.subarray(from, from + columns), z * columns);
    }

    return {
      ...common,
      pixels: out,
      columns,
      rows: depth,
      spacing: { x: volume.spacing.x, y: volume.spacing.z },
    };
  }

  // Sagittal: one column of every slice. Wide as the image is tall, tall as the
  // stack. Copied a voxel at a time, because a column is not contiguous.
  const x = Math.min(columns - 1, Math.max(0, index));
  const out = voxels instanceof Uint8Array ? new Uint8Array(rows * depth) : new Uint16Array(rows * depth);

  for (let z = 0; z < depth; z++) {
    const slice = (depth - 1 - z) * perSlice;
    for (let y = 0; y < rows; y++) {
      out[z * rows + y] = voxels[slice + y * columns + x] as number;
    }
  }

  return {
    ...common,
    pixels: out,
    columns: rows,
    rows: depth,
    spacing: { x: volume.spacing.y, y: volume.spacing.z },
  };
}
