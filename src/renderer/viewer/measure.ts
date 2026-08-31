/**
 * Measuring things on an image.
 *
 * Two measurements, which between them are most of what gets drawn on a
 * diagnostic image: a distance, and a region with statistics. Both are reported
 * in the units the file measures in — millimetres and, on a CT, Hounsfield
 * units — because a length in pixels and a density in stored numbers are values
 * nobody can put in a report.
 *
 * All of it is arithmetic on numbers and a typed array. Nothing here knows what
 * a canvas is, which is what makes the statistics checkable against a phantom
 * whose answer is known rather than against a screenshot.
 */
import type { Frame } from './gl-image';
import { distanceInMillimetres, type ImageSize, type Point } from './transform';

export interface Length {
  kind: 'length';
  id: string;
  /** Which image of the stack it was drawn on. */
  at: number;
  from: Point;
  to: Point;
}

export interface Region {
  kind: 'region';
  id: string;
  at: number;
  /** Two opposite corners of the box the ellipse is inscribed in. */
  from: Point;
  to: Point;
}

export type Measurement = Length | Region;

/** What a region measurement says about the pixels inside it. */
export interface Statistics {
  count: number;
  mean: number;
  deviation: number;
  min: number;
  max: number;
  /** Square millimetres, when the file says how big a pixel is. */
  area: number;
}

/** The stored number at a pixel, as the thing it measures. */
function valueAt(frame: Frame, x: number, y: number): number {
  const raw = frame.pixels[y * frame.columns + x] ?? 0;

  // Two's complement, undone the same way the shader does it. The bits arrive
  // unsigned whatever the file meant by them, and a CT read as unsigned reports
  // air at sixty-four thousand rather than at minus one thousand.
  const span = frame.bitsAllocated <= 8 ? 256 : 65536;
  const stored = frame.signed && raw > span / 2 - 1 ? raw - span : raw;

  return stored * frame.rescaleSlope + frame.rescaleIntercept;
}

/** The length of a distance measurement, in millimetres. */
export function lengthOf(measurement: Length, image: ImageSize): number {
  return distanceInMillimetres(measurement.from, measurement.to, image);
}

/**
 * The pixels inside an elliptical region, described.
 *
 * The ellipse is inscribed in the box the pointer dragged, which is how every
 * workstation does it and what makes it possible to place one accurately. The
 * standard deviation is the population one over the pixels included, not a
 * sample estimate: this is every pixel in the region, not a sample of them.
 */
export function statisticsOf(measurement: Region, frame: Frame): Statistics {
  const left = Math.min(measurement.from.x, measurement.to.x);
  const right = Math.max(measurement.from.x, measurement.to.x);
  const top = Math.min(measurement.from.y, measurement.to.y);
  const bottom = Math.max(measurement.from.y, measurement.to.y);

  const centreX = (left + right) / 2;
  const centreY = (top + bottom) / 2;
  const radiusX = (right - left) / 2;
  const radiusY = (bottom - top) / 2;

  const empty: Statistics = { count: 0, mean: 0, deviation: 0, min: 0, max: 0, area: 0 };
  if (radiusX <= 0 || radiusY <= 0) {
    return empty;
  }

  // Clamped to the image: a region dragged off the edge measures the part of it
  // that is over pixels, rather than reading whatever is next in memory.
  const firstX = Math.max(0, Math.ceil(left));
  const lastX = Math.min(frame.columns - 1, Math.floor(right));
  const firstY = Math.max(0, Math.ceil(top));
  const lastY = Math.min(frame.rows - 1, Math.floor(bottom));

  let count = 0;
  let total = 0;
  let totalOfSquares = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let y = firstY; y <= lastY; y++) {
    for (let x = firstX; x <= lastX; x++) {
      // The centre of the pixel, not its corner: a pixel is a square, and
      // testing its corner shifts the whole region by half a pixel.
      const dx = (x + 0.5 - centreX) / radiusX;
      const dy = (y + 0.5 - centreY) / radiusY;
      if (dx * dx + dy * dy > 1) {
        continue;
      }

      const value = valueAt(frame, x, y);
      count++;
      total += value;
      totalOfSquares += value * value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }

  if (count === 0) {
    return empty;
  }

  const mean = total / count;
  // Guarded against a tiny negative from floating point when every value is the
  // same, which would otherwise come out as NaN.
  const variance = Math.max(0, totalOfSquares / count - mean * mean);

  return {
    count,
    mean,
    deviation: Math.sqrt(variance),
    min,
    max,
    area: count * frame.spacing.x * frame.spacing.y,
  };
}

/** A length as it would be written on the image. */
export function describeLength(millimetres: number): string {
  return millimetres >= 10
    ? `${(millimetres / 10).toFixed(1)} cm`
    : `${millimetres.toFixed(1)} mm`;
}

/** A region as it would be written on the image. */
export function describeStatistics(statistics: Statistics, unit: string): string[] {
  if (statistics.count === 0) {
    return ['no pixels'];
  }
  return [
    `${statistics.mean.toFixed(1)} ${String.fromCharCode(177)} ${statistics.deviation.toFixed(1)} ${unit}`,
    `${statistics.min.toFixed(0)} to ${statistics.max.toFixed(0)}`,
    `${(statistics.area / 100).toFixed(2)} cm2`,
  ];
}

/**
 * The unit a modality measures in.
 *
 * Only CT has one that means anything to everybody. An MR number is a signal
 * intensity whose scale depends on the sequence and the coil, and calling it
 * anything would be inventing a unit.
 */
export function unitFor(modality: string): string {
  return modality === 'CT' ? 'HU' : '';
}
