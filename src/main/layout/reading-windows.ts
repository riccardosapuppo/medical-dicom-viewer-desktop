/**
 * Windows on other screens.
 *
 * A reading room has two or three monitors and the point of them is that a
 * series goes on one and stays there. So a window opened for a series is placed
 * on a pane by its position on the desk, not by any id the system handed out,
 * and it is placed inside that pane's work area rather than over the whole of
 * it — a window that covers the taskbar is a window somebody cannot get out
 * from behind.
 *
 * One window per series. Sending the same series somewhere else moves the
 * window that already exists rather than opening a second one showing the same
 * thing, which is a thing viewers do and nobody wants.
 */
import path from 'node:path';

import { BrowserWindow } from 'electron';

import type { Pane } from '../display-topology';

import { boundsForPane } from './panes';

/** Where the built renderer lives, relative to the compiled main process. */
const RENDERER = path.join(__dirname, 'renderer', 'index.html');

export interface Placed {
  seriesInstanceUid: string;
  pane: number;
}

export class ReadingWindows {
  #windows = new Map<string, { window: BrowserWindow; pane: number }>();

  /** What is open, so it can be written down as the arrangement. */
  get placed(): Placed[] {
    return [...this.#windows.entries()].map(([seriesInstanceUid, { pane }]) => ({
      seriesInstanceUid,
      pane,
    }));
  }

  has(seriesInstanceUid: string): boolean {
    return this.#windows.has(seriesInstanceUid);
  }

  /**
   * Opens a series on a pane, or moves the window that is already showing it.
   */
  open(seriesInstanceUid: string, pane: number, panes: Pane[]): void {
    const glass = panes[pane];
    if (!glass) {
      // Asked for a screen that is not there. Doing nothing is right: the
      // caller has a stale desk, and a window opened at coordinates nobody can
      // see is worse than a window that did not open.
      return;
    }

    const bounds = boundsForPane(glass);
    const existing = this.#windows.get(seriesInstanceUid);

    if (existing) {
      existing.window.setBounds(bounds);
      existing.window.focus();
      this.#windows.set(seriesInstanceUid, { window: existing.window, pane });
      return;
    }

    const window = new BrowserWindow({
      ...bounds,
      backgroundColor: '#000000',
      show: false,
      title: 'DICOM Workstation',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    window.once('ready-to-show', () => window.show());
    window.on('closed', () => this.#windows.delete(seriesInstanceUid));

    // The window is told what it is showing through the address, so it needs
    // nothing from the main process before it can start: the alternative is a
    // message that may arrive before or after the page is ready.
    void window.loadFile(RENDERER, { hash: `reading/${encodeURIComponent(seriesInstanceUid)}` });

    this.#windows.set(seriesInstanceUid, { window, pane });
  }

  close(seriesInstanceUid: string): void {
    this.#windows.get(seriesInstanceUid)?.window.close();
    this.#windows.delete(seriesInstanceUid);
  }

  /** Closes everything. Called when the folder changes, and when the application quits. */
  closeAll(): void {
    for (const { window } of this.#windows.values()) {
      if (!window.isDestroyed()) {
        window.close();
      }
    }
    this.#windows.clear();
  }
}
