/**
 * Where a window goes on a pane of glass.
 *
 * Separate from the code that opens windows so it can be checked without an
 * Electron process — which matters here more than usual, because the desks this
 * has to be right on are ones this machine does not have: a monitor to the left
 * of the primary and therefore at negative coordinates, a portrait pair, a
 * taskbar down one side.
 */
import type { Pane } from '../display-topology';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The rectangle a reading window should occupy on a pane.
 *
 * The work area, not the bounds: a window sized to the whole screen covers the
 * taskbar, and a window covering the taskbar is one somebody cannot get out
 * from behind.
 *
 * One pixel in on each side, deliberately. A window exactly the size of the
 * work area is treated by Windows as maximised and loses its border, which
 * makes two adjacent reading windows impossible to tell apart.
 */
export function boundsForPane(pane: Pane): Rect {
  return {
    x: pane.workArea.x + 1,
    y: pane.workArea.y + 1,
    width: Math.max(320, pane.workArea.width - 2),
    height: Math.max(240, pane.workArea.height - 2),
  };
}
