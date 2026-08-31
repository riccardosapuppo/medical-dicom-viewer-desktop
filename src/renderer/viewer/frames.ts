/**
 * Getting frames from the disk to the graphics card, and keeping the ones worth
 * keeping.
 *
 * Scrolling a stack is the thing a radiologist does most and the thing that
 * must never stutter. Three rules come out of that.
 *
 * Fetch one frame at a time, not a series. A four hundred slice study is two
 * hundred megabytes; waiting for all of it before showing the first image is a
 * viewer nobody uses.
 *
 * Ask ahead, in the direction of travel. Somebody scrolling down will want the
 * next slice, and asking for it while they look at this one is free.
 *
 * Keep a bounded number. Unbounded is a study that grows until the page is
 * killed; too few and scrolling back up refetches everything.
 */
import type { Series } from '../../main/dicom/build-index';
import type { PixelLayout } from '../../main/dicom/read-header';

import type { Frame } from './gl-image';

/** One image in a stack: an instance, and which frame of it. */
export interface Slide {
  sopInstanceUid: string;
  /** One-based, the way DICOM counts frames. */
  frame: number;
  pixels: PixelLayout;
}

/**
 * The stack a series makes, flattened.
 *
 * A series is a list of instances, and an instance may itself hold many frames
 * — a cine loop is one file. Scrolling is over images, not files, so the two
 * are flattened into one list here and nothing downstream has to know the
 * difference.
 */
export function slidesOf(series: Series): Slide[] {
  return series.instances.flatMap(instance =>
    Array.from({ length: Math.max(1, instance.pixels.numberOfFrames) }, (_, i) => ({
      sopInstanceUid: instance.sopInstanceUid,
      frame: i + 1,
      pixels: instance.pixels,
    }))
  );
}

function urlOf(slide: Slide): string {
  return `dicom://instance/${encodeURIComponent(slide.sopInstanceUid)}/frames/${slide.frame}`;
}

function toFrame(slide: Slide, bytes: ArrayBuffer): Frame {
  const { pixels } = slide;
  const eightBit = (pixels.bitsAllocated ?? 16) <= 8;

  return {
    pixels: eightBit ? new Uint8Array(bytes) : new Uint16Array(bytes),
    columns: pixels.columns ?? 0,
    rows: pixels.rows ?? 0,
    signed: pixels.signed,
    bitsAllocated: pixels.bitsAllocated ?? 16,
    rescaleSlope: pixels.rescaleSlope,
    rescaleIntercept: pixels.rescaleIntercept,
    // MONOCHROME1 stores white as low. Ignoring it shows a negative of the
    // study, which on a chest film is not subtle and on a bone window is.
    invert: pixels.photometricInterpretation === 'MONOCHROME1',
    // Pixel spacing is [row spacing, column spacing] - down first, then
    // across, which is the opposite of the order everything else in this
    // file uses and a reliable way to draw an image transposed.
    spacing: {
      x: pixels.pixelSpacing?.[1] ?? 1,
      y: pixels.pixelSpacing?.[0] ?? 1,
    },
  };
}

export class FrameSource {
  readonly slides: Slide[];

  #cache = new Map<number, Frame>();
  #inFlight = new Map<number, Promise<Frame>>();
  #controller = new AbortController();
  #limit: number;

  constructor(slides: Slide[], limit = 96) {
    this.slides = slides;
    this.#limit = limit;
  }

  get length(): number {
    return this.slides.length;
  }

  /** What is already in memory, for a caller that must not wait. */
  ready(at: number): Frame | undefined {
    const frame = this.#cache.get(at);
    if (frame) {
      // Touched, so the least recently used is the one that leaves. A Map keeps
      // insertion order, so re-inserting is the whole of the bookkeeping.
      this.#cache.delete(at);
      this.#cache.set(at, frame);
    }
    return frame;
  }

  async get(at: number): Promise<Frame> {
    const cached = this.ready(at);
    if (cached) {
      return cached;
    }

    // Two requests for the same slice - the scroll and the prefetch behind it -
    // must not become two reads of the same file.
    const already = this.#inFlight.get(at);
    if (already) {
      return already;
    }

    const slide = this.slides[at];
    if (!slide) {
      throw new Error(`there is no image ${at + 1} in this series`);
    }

    const request = fetch(urlOf(slide), { signal: this.#controller.signal })
      .then(async response => {
        if (!response.ok) {
          throw new Error(`${response.status}: ${await response.text()}`);
        }
        const frame = toFrame(slide, await response.arrayBuffer());
        this.#remember(at, frame);
        return frame;
      })
      .finally(() => this.#inFlight.delete(at));

    this.#inFlight.set(at, request);
    return request;
  }

  /**
   * Asks for what is about to be looked at.
   *
   * Weighted in the direction of travel: somebody scrolling down wants the next
   * slice far more than the one they have just left, and a symmetric prefetch
   * spends half its work behind them.
   */
  prefetch(at: number, direction: number, ahead = 6): void {
    const step = direction >= 0 ? 1 : -1;
    for (let i = 1; i <= ahead; i++) {
      for (const candidate of [at + i * step, at - Math.ceil(i / 3) * step]) {
        if (candidate >= 0 && candidate < this.slides.length && !this.#cache.has(candidate)) {
          void this.get(candidate).catch(() => {
            // A prefetch that fails is not an error anybody asked about. The
            // same failure will be reported properly if the slice is reached.
          });
        }
      }
    }
  }

  #remember(at: number, frame: Frame): void {
    this.#cache.set(at, frame);
    while (this.#cache.size > this.#limit) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#cache.delete(oldest);
    }
  }

  /**
   * Stops everything in flight.
   *
   * Without this, closing a series while forty prefetches are outstanding
   * leaves forty responses arriving into a cache nobody will read, holding
   * their pixels until the collector gets to them.
   */
  dispose(): void {
    this.#controller.abort();
    this.#cache.clear();
    this.#inFlight.clear();
  }
}
