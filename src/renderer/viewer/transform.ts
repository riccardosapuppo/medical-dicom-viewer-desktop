/**
 * Where the image sits on the canvas, and back again.
 *
 * One module because there must be exactly one answer. The image is drawn by
 * the graphics card from a transform in clip space, and measurements are drawn
 * over it by a 2D context in canvas pixels. If those two work the placement out
 * separately they will agree until the day somebody changes one of them, and
 * then a measurement will sit a few pixels off the thing it measures — which is
 * the kind of wrong that gets believed.
 *
 * Everything here is arithmetic on numbers. No canvas, no context, no image.
 */

export interface CanvasSize {
  width: number;
  height: number;
}

export interface ImageSize {
  columns: number;
  rows: number;
  /**
   * Millimetres per pixel across and down.
   *
   * One when the file did not say, so the image is drawn square — but a
   * distance measured against a made-up spacing is not a distance, which is
   * what `spacingKnown` is for.
   */
  spacing: { x: number; y: number };
  /** False when the file carried no pixel spacing at all. */
  spacingKnown: boolean;
}

export interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

export interface Point {
  x: number;
  y: number;
}

/** How large the image is drawn, in canvas pixels, and where its centre is. */
export interface Placement {
  width: number;
  height: number;
  centreX: number;
  centreY: number;
}

/**
 * The image placed on the canvas.
 *
 * At zoom 1 it fits: as large as it goes without either dimension overflowing.
 * Pixel spacing is part of that, because a scanner with non-square pixels means
 * the image is not as wide as its column count — ignore it and a circle is
 * drawn as an ellipse and measured as one.
 */
export function place(canvas: CanvasSize, image: ImageSize, view: ViewTransform): Placement {
  const millimetresAcross = image.columns * image.spacing.x;
  const millimetresDown = image.rows * image.spacing.y;

  const fit = Math.min(canvas.width / millimetresAcross, canvas.height / millimetresDown);

  return {
    width: millimetresAcross * fit * view.zoom,
    height: millimetresDown * fit * view.zoom,
    centreX: canvas.width / 2 + view.panX,
    centreY: canvas.height / 2 + view.panY,
  };
}

/** A point in image pixels, as a point on the canvas. */
export function imageToCanvas(
  point: Point,
  canvas: CanvasSize,
  image: ImageSize,
  view: ViewTransform
): Point {
  const placed = place(canvas, image, view);

  return {
    x: placed.centreX + (point.x / image.columns - 0.5) * placed.width,
    y: placed.centreY + (point.y / image.rows - 0.5) * placed.height,
  };
}

/**
 * A point on the canvas, as a point in image pixels.
 *
 * Not clamped to the image: a measurement dragged past the edge should report
 * where the pointer went rather than quietly stopping at the border, and the
 * caller decides what to do about it.
 */
export function canvasToImage(
  point: Point,
  canvas: CanvasSize,
  image: ImageSize,
  view: ViewTransform
): Point {
  const placed = place(canvas, image, view);

  return {
    x: ((point.x - placed.centreX) / placed.width + 0.5) * image.columns,
    y: ((point.y - placed.centreY) / placed.height + 0.5) * image.rows,
  };
}

/** A measured distance, and what it is a distance in. */
export interface Distance {
  value: number;
  unit: 'mm' | 'px';
}

/**
 * The distance between two points of the image.
 *
 * In millimetres when the file said how big a pixel is, and in pixels when it
 * did not. Not in millimetres either way: a mammogram carries no pixel spacing
 * in the tag most viewers read, and reporting its diagonal as "13.8 cm" when
 * the number is really a count of pixels is a measurement somebody could put in
 * a report. Pixels are not useful, but they are honest, and the difference is
 * visible at a glance because the unit is written next to the number.
 *
 * Across and down are scaled separately, because they are not always the same.
 */
export function distanceBetween(a: Point, b: Point, image: ImageSize): Distance {
  const across = b.x - a.x;
  const down = b.y - a.y;

  if (!image.spacingKnown) {
    return { value: Math.hypot(across, down), unit: 'px' };
  }

  return {
    value: Math.hypot(across * image.spacing.x, down * image.spacing.y),
    unit: 'mm',
  };
}
