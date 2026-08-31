/**
 * Draws one greyscale image with WebGL2.
 *
 * The stored numbers go to the graphics card untouched, as an integer texture,
 * and the sign correction, the rescale and the window are done in the fragment
 * shader. That is not an optimisation for its own sake: windowing on the
 * processor means rebuilding a quarter of a million pixels every time the mouse
 * moves one pixel, and window and level are dragged continuously. On the card
 * it is one uniform.
 *
 * Sampling is nearest, always. Integer textures cannot be filtered at all in
 * WebGL2, and that turns out to be the right constraint: interpolation invents
 * pixel values that were never measured, and a number someone reports on should
 * be one the scanner produced.
 */

import { place } from './transform';

/** One frame, as it came off the disk. */
export interface Frame {
  pixels: Uint8Array | Uint16Array;
  columns: number;
  rows: number;
  signed: boolean;
  bitsAllocated: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  /** MONOCHROME1 stores white as low, which is the opposite of everything else. */
  invert: boolean;
  /** Millimetres per pixel across and down. Equal unless the scanner says otherwise. */
  spacing: { x: number; y: number };
}

export interface View {
  windowCentre: number;
  windowWidth: number;
  /** 1 means the image fits the canvas. */
  zoom: number;
  /** Pan in canvas pixels, from the centre. */
  panX: number;
  panY: number;
}

const VERTEX = `#version 300 es
in vec2 aCorner;
uniform vec4 uTransform;   // xy scale, zw offset, in clip space
out vec2 vTexture;

void main() {
  // The quad is -1..1; the texture is 0..1 with v flipped, because DICOM rows
  // run down the image and clip space runs up.
  vTexture = vec2((aCorner.x + 1.0) * 0.5, (1.0 - aCorner.y) * 0.5);
  gl_Position = vec4(aCorner * uTransform.xy + uTransform.zw, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp usampler2D;

uniform usampler2D uPixels;
uniform float uSlope;
uniform float uIntercept;
uniform float uCentre;
uniform float uWidth;
uniform float uSignedSpan;   // 65536 for signed 16-bit, 0 when unsigned
uniform float uSignedLimit;  // 32767 for signed 16-bit
uniform float uInvert;

in vec2 vTexture;
out vec4 outColour;

void main() {
  float stored = float(texture(uPixels, vTexture).r);

  // Two's complement, undone with arithmetic: the raw bits arrive unsigned
  // whatever the file meant by them.
  if (uSignedSpan > 0.0 && stored > uSignedLimit) {
    stored -= uSignedSpan;
  }

  float value = stored * uSlope + uIntercept;

  // The linear VOI transformation, PS3.3 C.11.2.1.2. The half units are in the
  // standard; dropping them shifts everything by half a window step, which on a
  // brain window is most of a grey level.
  float usable = max(uWidth, 1.0);
  float grey = clamp((value - (uCentre - 0.5)) / (usable - 1.0) + 0.5, 0.0, 1.0);

  if (uInvert > 0.5) {
    grey = 1.0 - grey;
  }

  outColour = vec4(grey, grey, grey, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('the graphics context would not create a shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // The log is the only thing that says which line, and losing it turns a
    // typo in a shader into a blank screen with no explanation anywhere.
    const log = gl.getShaderInfoLog(shader) ?? 'no log';
    gl.deleteShader(shader);
    throw new Error(`shader would not compile: ${log}`);
  }

  return shader;
}

export interface ImageRenderer {
  /** Draws a frame, uploading the pixels only when they are not the ones already there. */
  draw(frame: Frame, view: View): void;
  /** Redraws whatever was last drawn, at the canvas's current size. */
  resize(): void;
  destroy(): void;
}

/**
 * Sets up the canvas, or returns undefined when the machine cannot do it.
 *
 * Undefined rather than an exception: a workstation without a usable graphics
 * context is a real situation — a remote desktop session, a virtual machine, a
 * driver that gave up — and the application has something more useful to say
 * about it than a stack trace.
 */
export function createImageRenderer(canvas: HTMLCanvasElement): ImageRenderer | undefined {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    // Kept, rather than thrown away once composited.
    //
    // Two reasons, one of them a feature and one of them honesty. Exporting the
    // image somebody is looking at means reading the buffer back, and without
    // this there is nothing to read. And what is on the screen is otherwise
    // unobservable: the interface check reported a uniformly black canvas while
    // the application was plainly drawing, because by the time anything could
    // read it the buffer had been cleared.
    //
    // The cost is one copy of the framebuffer per composite, which on a desktop
    // application drawing one image is not a cost worth a fragile alternative.
    preserveDrawingBuffer: true,
  });

  if (!gl) {
    return undefined;
  }

  const program = gl.createProgram();
  if (!program) {
    return undefined;
  }

  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`shaders would not link: ${gl.getProgramInfoLog(program) ?? 'no log'}`);
  }

  gl.useProgram(program);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const corner = gl.getAttribLocation(program, 'aCorner');
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

  const uniform = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);

  const uTransform = uniform('uTransform');
  const uSlope = uniform('uSlope');
  const uIntercept = uniform('uIntercept');
  const uCentre = uniform('uCentre');
  const uWidth = uniform('uWidth');
  const uSignedSpan = uniform('uSignedSpan');
  const uSignedLimit = uniform('uSignedLimit');
  const uInvert = uniform('uInvert');

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // Nearest is not a choice: an integer texture cannot be filtered. Clamping
  // keeps the edge of the image from wrapping round when it is panned.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Rows of an odd number of bytes are not padded in a DICOM file, and the
  // default of four would shear every 8-bit image of odd width.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  let uploaded: Uint8Array | Uint16Array | undefined;
  let last: { frame: Frame; view: View } | undefined;

  const upload = (frame: Frame): void => {
    const eightBit = frame.bitsAllocated <= 8;
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      eightBit ? gl.R8UI : gl.R16UI,
      frame.columns,
      frame.rows,
      0,
      gl.RED_INTEGER,
      eightBit ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT,
      frame.pixels
    );
    uploaded = frame.pixels;
  };

  const draw = (frame: Frame, view: View): void => {
    last = { frame, view };

    const width = canvas.width;
    const height = canvas.height;
    gl.viewport(0, 0, width, height);

    if (frame.pixels !== uploaded) {
      upload(frame);
    }

    // Where the image goes is worked out in one place, shared with whatever
    // draws over it. Two answers to that question drift apart the first time
    // one of them is changed, and a measurement a few pixels off the thing it
    // measures is the kind of wrong that gets believed.
    const placed = place({ width, height }, frame, view);

    gl.uniform4f(
      uTransform,
      placed.width / width,
      placed.height / height,
      (view.panX * 2) / width,
      (-view.panY * 2) / height
    );

    gl.uniform1f(uSlope, frame.rescaleSlope);
    gl.uniform1f(uIntercept, frame.rescaleIntercept);
    gl.uniform1f(uCentre, view.windowCentre);
    gl.uniform1f(uWidth, view.windowWidth);

    const bits = frame.bitsAllocated <= 8 ? 8 : 16;
    gl.uniform1f(uSignedSpan, frame.signed ? 2 ** bits : 0);
    gl.uniform1f(uSignedLimit, frame.signed ? 2 ** (bits - 1) - 1 : 0);
    gl.uniform1f(uInvert, frame.invert ? 1 : 0);

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  return {
    draw,
    resize() {
      if (last) {
        draw(last.frame, last.view);
      }
    },
    destroy() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
      // Without this the context lingers until the collector runs, and a page
      // that opens a few series in a row reaches the browser's limit of sixteen
      // and starts losing the oldest ones.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
