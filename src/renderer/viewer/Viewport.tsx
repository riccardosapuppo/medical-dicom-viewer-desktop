/**
 * One image on screen, and the four things a radiologist does to it.
 *
 * Scroll the stack, set the window, zoom, pan. The button mapping is the one
 * every reporting workstation uses — left drags the window, the wheel moves
 * through the stack, middle pans, right zooms — and matching it is not
 * imitation: somebody who reads all day has it in their hands, and a viewer
 * that puts zoom on the left button gets the window changed by accident on the
 * first study.
 *
 * The canvas is drawn from a request frame, never straight from an event. A
 * mouse produces far more moves than a screen has frames, and drawing on each
 * one queues work that arrives after the pointer has moved on.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Patient, Series, Study } from '../../main/dicom/build-index';
import { readableDate } from '../format';

import { drawMeasurements } from './draw-measurements';
import { FrameSource, slidesOf } from './frames';
import { unitFor, type Measurement } from './measure';
import { canvasToImage } from './transform';
import { createImageRenderer, type Frame, type ImageRenderer, type View } from './gl-image';
import { defaultWindow, describeWindow, dragWindow, PRESETS, presetName, type Window as Voi } from './window-level';

export interface Opened {
  patient: Patient;
  study: Study;
  series: Series;
}

/** Which button is doing what. Nothing here is configurable yet, and it is written down so it can be. */
const TOOLS = { window: 0, pan: 1, zoom: 2 } as const;

/** What the left button draws. The middle and right buttons never change. */
type Tool = 'window' | 'length' | 'region';

const TOOL_NAMES: ReadonlyArray<{ tool: Tool; name: string }> = [
  { tool: 'window', name: 'Window' },
  { tool: 'length', name: 'Length' },
  { tool: 'region', name: 'Region' },
];

let nextMeasurementId = 0;

export function Viewport({
  opened,
  onClose,
  detached = false,
}: {
  opened: Opened;
  onClose: () => void;
  /** True in a window that shows nothing but this series, on a reading monitor. */
  detached?: boolean;
}): React.ReactElement {
  const { patient, study, series } = opened;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ImageRenderer | undefined>(undefined);
  const sourceRef = useRef<FrameSource | undefined>(undefined);
  const frameRef = useRef<Frame | undefined>(undefined);
  const viewRef = useRef<View>({ windowCentre: 0, windowWidth: 1, zoom: 1, panX: 0, panY: 0 });
  const pendingDraw = useRef(0);

  const [at, setAt] = useState(0);
  const [voi, setVoi] = useState<Voi>(() => defaultWindow(series.instances[0]?.pixels ?? ({} as never)));
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [noGraphics, setNoGraphics] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tool, setTool] = useState<Tool>('window');
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const slides = useRef(slidesOf(series));
  const count = slides.current.length;

  // Kept in a ref as well as in state: the draw loop reads them without being
  // re-created, and re-creating it on every window drag would rebuild the
  // WebGL program sixty times a second.
  viewRef.current = { windowCentre: voi.centre, windowWidth: voi.width, zoom, panX: pan.x, panY: pan.y };

  // Kept in a ref for the same reason the view is: the draw loop reads them
  // without being rebuilt every time one is added.
  const measurementsRef = useRef<Measurement[]>([]);
  measurementsRef.current = measurements;
  const atRef = useRef(0);
  const unit = unitFor(series.modality);

  const paint = useCallback(() => {
    if (pendingDraw.current) {
      return;
    }
    pendingDraw.current = requestAnimationFrame(() => {
      pendingDraw.current = 0;
      const frame = frameRef.current;
      if (!frame) {
        return;
      }

      rendererRef.current?.draw(frame, viewRef.current);

      // The annotations are on a canvas of their own, over the image. Drawing
      // them into the same buffer would mean re-rasterising vector work on
      // every window drag, and would put them in front of anything that reads
      // the pixels back - including this project's own interface check, which
      // would then be measuring its own annotations.
      const overlay = overlayRef.current?.getContext('2d');
      if (overlay) {
        drawMeasurements(overlay, {
          measurements: measurementsRef.current,
          at: atRef.current,
          frame,
          view: viewRef.current,
          ratio: window.devicePixelRatio || 1,
          unit,
        });
      }
    });
  }, [unit]);

  // The canvas has to be sized in device pixels, not CSS pixels: on a screen at
  // 125 per cent a canvas sized in CSS pixels is drawn at four fifths of the
  // resolution the panel has, which on a diagnostic image is the whole point of
  // the panel thrown away.
  const fitCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    const overlay = overlayRef.current;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      if (overlay) {
        overlay.width = width;
        overlay.height = height;
      }
      paint();
    }
  }, [paint]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const renderer = createImageRenderer(canvas);
    if (!renderer) {
      setNoGraphics(true);
      return;
    }
    rendererRef.current = renderer;
    fitCanvas();

    const observer = new ResizeObserver(fitCanvas);
    observer.observe(canvas);

    return () => {
      observer.disconnect();
      renderer.destroy();
      rendererRef.current = undefined;
    };
  }, [fitCanvas]);

  useEffect(() => {
    const source = new FrameSource(slides.current);
    sourceRef.current = source;
    return () => {
      source.dispose();
      sourceRef.current = undefined;
      frameRef.current = undefined;
    };
  }, [series.seriesInstanceUid]);

  const direction = useRef(1);

  useEffect(() => {
    const source = sourceRef.current;
    if (!source) {
      return;
    }

    const ready = source.ready(at);
    if (ready) {
      frameRef.current = ready;
      setLoading(false);
      setFailure(undefined);
      paint();
      source.prefetch(at, direction.current);
      return;
    }

    let current = true;
    setLoading(true);
    source
      .get(at)
      .then(frame => {
        // Scrolling past a slow slice must not paint it when it finally
        // arrives: by then the reader is somewhere else.
        if (!current) {
          return;
        }
        frameRef.current = frame;
        setFailure(undefined);
        setLoading(false);
        paint();
        source.prefetch(at, direction.current);
      })
      .catch((error: unknown) => {
        if (current) {
          setFailure(error instanceof Error ? error.message : String(error));
          setLoading(false);
        }
      });

    return () => {
      current = false;
    };
  }, [at, paint]);

  atRef.current = at;

  /**
   * Redraws after the render that changed something, not during the event that
   * asked for it.
   *
   * Calling paint from a handler schedules a frame that reads the refs, and the
   * refs are only brought up to date by the render React has not done yet. The
   * result is a canvas that lags one interaction behind — which nobody notices
   * while dragging, because the next move corrects it, and which shows up on
   * the last action of a gesture: a measurement removed from the list stayed on
   * screen, with a label reading nothing, until something else was touched.
   *
   * A layout effect runs after the commit and before the browser paints, so the
   * refs are current and the drawing is not a frame late.
   */
  useLayoutEffect(() => {
    paint();
  }, [paint, measurements, voi, zoom, pan]);

  const step = useCallback(
    (by: number) => {
      direction.current = by >= 0 ? 1 : -1;
      setAt(current => Math.min(count - 1, Math.max(0, current + by)));
    },
    [count]
  );

  // Keyboard, because a reader scrolling a stack with one hand on the mouse and
  // one on the keyboard is the normal posture, and because a viewer reachable
  // only by dragging is a viewer some people cannot use at all.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const keys: Record<string, () => void> = {
        ArrowDown: () => step(1),
        ArrowRight: () => step(1),
        PageDown: () => step(10),
        ArrowUp: () => step(-1),
        ArrowLeft: () => step(-1),
        PageUp: () => step(-10),
        Home: () => setAt(0),
        End: () => setAt(count - 1),
        Escape: () => (tool === 'window' ? onClose() : setTool('window')),
        Delete: () => {
          setMeasurements(current => current.filter(m => m.at !== at));
        },
      };
      const action = keys[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at, count, onClose, step, tool]);

  const dragging = useRef<{ button: number; x: number; y: number; from: Voi; zoom: number; pan: { x: number; y: number } } | undefined>(undefined);

  /** Where the pointer is, in the pixels of the image under it. */
  const inImage = (event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = event.currentTarget;
    const box = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const frame = frameRef.current;

    return canvasToImage(
      { x: (event.clientX - box.left) * ratio, y: (event.clientY - box.top) * ratio },
      { width: canvas.width, height: canvas.height },
      {
        columns: frame?.columns ?? 1,
        rows: frame?.rows ?? 1,
        spacing: frame?.spacing ?? { x: 1, y: 1 },
      },
      viewRef.current
    );
  };

  /** The measurement being dragged out right now, if there is one. */
  const drawingId = useRef<string | undefined>(undefined);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);

    if (event.button === TOOLS.window && tool !== 'window' && frameRef.current) {
      const point = inImage(event);
      const id = `m${nextMeasurementId++}`;
      drawingId.current = id;
      setMeasurements(current => [
        ...current,
        { kind: tool === 'length' ? 'length' : 'region', id, at, from: point, to: point },
      ]);
      return;
    }

    dragging.current = { button: event.button, x: event.clientX, y: event.clientY, from: voi, zoom, pan };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const drawing = drawingId.current;
    if (drawing) {
      const point = inImage(event);
      setMeasurements(current =>
        current.map(m => (m.id === drawing ? { ...m, to: point } : m))
      );
      return;
    }

    const drag = dragging.current;
    if (!drag) {
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;

    if (drag.button === TOOLS.window) {
      setVoi(dragWindow(drag.from, dx, dy));
    } else if (drag.button === TOOLS.pan) {
      // The pan is in canvas pixels and the pointer moves in CSS pixels. On a
      // screen at 150 per cent the image was following two thirds of the drag,
      // which reads as a heavy, laggy viewer rather than as a bug.
      const ratio = window.devicePixelRatio || 1;
      setPan({ x: drag.pan.x + dx * ratio, y: drag.pan.y + dy * ratio });
    } else if (drag.button === TOOLS.zoom) {
      // Down zooms in, which is the way a magnifier feels when you pull it
      // towards you, and the way every workstation does it.
      setZoom(Math.min(20, Math.max(0.1, drag.zoom * Math.exp(dy / 200))));
    }
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const drawing = drawingId.current;
    if (drawing) {
      drawingId.current = undefined;
      // A click without a drag is a click, not a measurement of nothing. Left
      // in, it becomes a label reading 0.0 mm that has to be found and removed.
      setMeasurements(current =>
        current.filter(
          m =>
            m.id !== drawing ||
            Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y) > 2
        )
      );
    }

    dragging.current = undefined;
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    if (event.ctrlKey) {
      setZoom(z => Math.min(20, Math.max(0.1, z * Math.exp(-event.deltaY / 400))));
      return;
    }
    step(event.deltaY > 0 ? 1 : -1);
  };

  const reset = (): void => {
    setVoi(defaultWindow(slides.current[at]?.pixels ?? ({} as never)));
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const slide = slides.current[at];
  const onThisImage = measurements.filter(m => m.at === at);
  const named = presetName(voi);

  return (
    <section className="viewport">
      <header className="viewport__bar">
        <button type="button" className="button" onClick={onClose}>
          {detached ? 'Close' : 'Back to the list'}
        </button>
        <span className="viewport__title">
          {series.description || 'unnamed series'}
          <span className="viewport__series">series {series.seriesNumber ?? '--'}</span>
        </span>
        <span className="viewport__tools">
          {TOOL_NAMES.map(({ tool: which, name }) => (
            <button
              type="button"
              key={which}
              className={tool === which ? 'chip chip--on' : 'chip'}
              onClick={() => setTool(which)}
            >
              {name}
            </button>
          ))}
          {onThisImage.length > 0 ? (
            <button
              type="button"
              className="chip"
              onClick={() => {
                setMeasurements(current => current.filter(m => m.at !== at));
              }}
            >
              Clear
            </button>
          ) : null}
        </span>

        <span className="viewport__presets">
          {PRESETS.map(preset => (
            <button
              type="button"
              key={preset.name}
              className={named === preset.name ? 'chip chip--on' : 'chip'}
              onClick={() => {
                setVoi(preset.window);
              }}
            >
              {preset.name}
            </button>
          ))}
          <button type="button" className="chip" onClick={reset}>
            Reset
          </button>
        </span>
      </header>

      {/* The count is on the element rather than only inside a canvas, so that
          what is measured on this image can be asked about rather than
          inferred from how many pixels of ink appeared. */}
      <div className="viewport__stage" data-measurements={onThisImage.length}>
        <canvas
          ref={canvasRef}
          className="viewport__canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={onWheel}
          onDoubleClick={reset}
          onContextMenu={event => event.preventDefault()}
        />

        {/* Over the image, and never taking a click: every gesture belongs to
            the canvas underneath, which is where the tools live. */}
        <canvas ref={overlayRef} className="viewport__overlay" />

        {/* The four corners, where a reading workstation has always put them. */}
        <div className="overlay overlay--top-left">
          <strong>{patient.name || 'unidentified'}</strong>
          <span>{patient.patientId}</span>
          <span>{patient.sex}</span>
        </div>
        <div className="overlay overlay--top-right">
          <strong>{study.description || 'no description'}</strong>
          <span>{readableDate(study.studyDate)}</span>
          <span>{study.accessionNumber}</span>
        </div>
        <div className="overlay overlay--bottom-left">
          <span>{describeWindow(voi)}</span>
          <span>{Math.round(zoom * 100)}%</span>
          {slide?.pixels.rescaleSlope !== 1 || slide?.pixels.rescaleIntercept !== 0 ? (
            <span className="overlay__quiet">
              rescale {slide?.pixels.rescaleSlope} / {slide?.pixels.rescaleIntercept}
            </span>
          ) : null}
        </div>
        <div className="overlay overlay--bottom-right">
          <span>
            {at + 1} / {count}
          </span>
          <span className="overlay__quiet">
            {series.orderedByGeometry ? 'ordered by position' : 'ordered by number'}
          </span>
        </div>

        {noGraphics ? (
          <div className="viewport__notice">
            <h2>This machine has no usable graphics context</h2>
            <p>
              The images are drawn with WebGL2, and it is not available here — a remote desktop
              session, a virtual machine, or a driver that gave up. The folder still reads and the
              worklist is still correct; only the pictures are missing.
            </p>
          </div>
        ) : failure ? (
          <div className="viewport__notice">
            <h2>Image {at + 1} could not be read</h2>
            <p className="viewport__reason">{failure}</p>
          </div>
        ) : loading ? (
          <div className="viewport__loading">reading image {at + 1}</div>
        ) : null}
      </div>

      <footer className="viewport__hint">
        <span>
          drag to {tool === 'window' ? 'window' : tool === 'length' ? 'measure' : 'draw a region'}
        </span>
        <span>wheel to scroll the stack</span>
        <span>middle to pan</span>
        <span>right to zoom</span>
        <span>double click to reset</span>
      </footer>
    </section>
  );
}
