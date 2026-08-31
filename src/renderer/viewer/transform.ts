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
  /** Millimetres per pixel across and down. */
  spacing: { x: number; y: number };
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

/**
 * The distance between two points of the image, in millimetres.
 *
 * Across and down are scaled separately, because they are not always the same.
 * A length measured in pixels and multiplied by one spacing is right on square
 * pixels and wrong on everything else, and it is wrong by an amount too small
 * to notice and too large to accept.
 */
export function distanceInMillimetres(a: Point, b: Point, image: ImageSize): number {
  return Math.hypot((b.x - a.x) * image.spacing.x, (b.y - a.y) * image.spacing.y);
}
