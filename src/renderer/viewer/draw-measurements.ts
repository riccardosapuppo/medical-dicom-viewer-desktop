/**
 * Drawing measurements over the image.
 *
 * On a separate canvas from the picture, in a 2D context, for two reasons. The
 * image is redrawn on every window drag and the annotations are not, so keeping
 * them apart avoids re-rasterising vector work sixty times a second. And a
 * measurement drawn into the same buffer as the image would be read back by
 * anything that samples the pixels — including this project's own interface
 * check, which would then be measuring its own annotations.
 *
 * The placement comes from the shared transform, so what is drawn here sits
 * exactly where the graphics card put the pixels underneath.
 */
import { describeLength, describeStatistics, lengthOf, statisticsOf, type Measurement } from './measure';
import type { Frame } from './gl-image';
import { imageToCanvas, type CanvasSize, type ImageSize, type ViewTransform } from './transform';

/** Instrument amber, the one accent this interface spends. */
const LIVE = '#f0a92e';
const SHADOW = 'rgba(0, 0, 0, 0.8)';

/** The size of the marks at the ends of a length, in canvas pixels. */
const HANDLE = 4;

function label(
  context: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  ratio: number
): void {
  context.font = `${12 * ratio}px 'Cascadia Mono', ui-monospace, monospace`;
  context.textBaseline = 'top';

  lines.forEach((line, i) => {
    const at = y + i * 15 * ratio;
    // Drawn twice: once in black underneath, so the text stays readable over
    // bone and over air alike. A measurement nobody can read is not a
    // measurement.
    context.lineWidth = 3 * ratio;
    context.strokeStyle = SHADOW;
    context.strokeText(line, x, at);
    context.fillStyle = LIVE;
    context.fillText(line, x, at);
  });
}

export interface DrawOptions {
  measurements: Measurement[];
  /** Which image is on screen — plane and index — so only its measurements are drawn. */
  at: string;
  frame: Frame;
  view: ViewTransform;
  /** Device pixels per CSS pixel, so lines and text keep their apparent size. */
  ratio: number;
  /** What a number on this image means: HU on a CT, nothing anywhere else. */
  unit: string;
}

export function drawMeasurements(
  context: CanvasRenderingContext2D,
  { measurements, at, frame, view, ratio, unit }: DrawOptions
): void {
  const canvas: CanvasSize = { width: context.canvas.width, height: context.canvas.height };
  const image: ImageSize = { columns: frame.columns, rows: frame.rows, spacing: frame.spacing };

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.lineJoin = 'round';

  for (const measurement of measurements) {
    if (measurement.at !== at) {
      continue;
    }

    const from = imageToCanvas(measurement.from, canvas, image, view);
    const to = imageToCanvas(measurement.to, canvas, image, view);

    context.lineWidth = 1.5 * ratio;
    context.strokeStyle = LIVE;

    if (measurement.kind === 'length') {
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();

      for (const end of [from, to]) {
        context.beginPath();
        context.moveTo(end.x - HANDLE * ratio, end.y);
        context.lineTo(end.x + HANDLE * ratio, end.y);
        context.moveTo(end.x, end.y - HANDLE * ratio);
        context.lineTo(end.x, end.y + HANDLE * ratio);
        context.stroke();
      }

      label(context, [describeLength(lengthOf(measurement, image))], to.x + 8 * ratio, to.y, ratio);
      continue;
    }

    context.beginPath();
    context.ellipse(
      (from.x + to.x) / 2,
      (from.y + to.y) / 2,
      Math.abs(to.x - from.x) / 2,
      Math.abs(to.y - from.y) / 2,
      0,
      0,
      Math.PI * 2
    );
    context.stroke();

    label(
      context,
      describeStatistics(statisticsOf(measurement, frame), unit),
      Math.max(from.x, to.x) + 8 * ratio,
      Math.min(from.y, to.y),
      ratio
    );
  }
}
