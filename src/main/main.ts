/**
 * The main process: one instance, one window, and nothing the renderer can
 * reach that it has not been handed.
 *
 * A reading workstation is opened by double-clicking a study, and it gets
 * double-clicked again while it is already open. Without the single instance
 * lock that means a second copy of the application fighting the first over the
 * same window layout and the same files. With it, the second launch hands its
 * arguments to the first and exits, which is also how a study opened from the
 * file manager arrives.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';

import { describe, readDesk, type Desk } from './display-topology';

/** Where the built renderer lives, relative to the compiled main process. */
const RENDERER = path.join(__dirname, 'renderer', 'index.html');

let mainWindow: BrowserWindow | undefined;

function createWindow(): BrowserWindow {
  // Opening at the size of the smallest sensible desk and letting the system
  // place it is wrong for this application: a reading window belongs on the
  // reporting monitor, which is rarely the primary one. For now it opens on the
  // primary at a workable size; placing it deliberately comes with layouts.
  const { workArea } = screen.getPrimaryDisplay();

  const window = new BrowserWindow({
    x: workArea.x + Math.round(workArea.width * 0.06),
    y: workArea.y + Math.round(workArea.height * 0.06),
    width: Math.min(1440, Math.round(workArea.width * 0.88)),
    height: Math.min(900, Math.round(workArea.height * 0.88)),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    show: false,
    title: 'DICOM Workstation',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Reading a study means scrolling a stack of images while the window may
      // not be the one in front. Throttled timers on a background window turn
      // that into a slideshow.
      backgroundThrottling: false,
    },
  });

  // Showing the window only once it has something in it avoids the flash of an
  // empty frame, which on a dark interface is a white rectangle.
  window.once('ready-to-show', () => window.show());

  // Nothing in this application opens a second window, and a page that tries is
  // either a mistake or a link someone clicked. Links go to the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  void window.loadFile(RENDERER);

  return window;
}

// A second launch is a study being opened, not a second application.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // The desk is read once the application is ready and again whenever it
    // changes: a monitor unplugged mid-session invalidates every placement, and
    // the fingerprint is how anything downstream notices.
    let desk: Desk = readDesk(screen);

    const reread = (): void => {
      const now = readDesk(screen);
      // A metrics event fires for things that move no window: a colour profile
      // change, a refresh rate switch. Sending only when the fingerprint moves
      // keeps the renderer from redrawing at nothing.
      if (now.fingerprint !== desk.fingerprint) {
        desk = now;
        mainWindow?.webContents.send('desk:changed', desk);
      }
    };

    screen.on('display-added', reread);
    screen.on('display-removed', reread);
    screen.on('display-metrics-changed', reread);

    ipcMain.handle('desk:read', () => desk);

    if (process.argv.includes('--print-desk')) {
      process.stdout.write(`\n${describe(desk)}\n\n`);
    }

    mainWindow = createWindow();

    // The screenshots in docs/ are taken by the application itself rather than
    // by a screen capture, so they are always the current build at a fixed size
    // and never a window with somebody's taskbar in the corner.
    const captureAt = process.argv.indexOf('--capture');
    if (captureAt !== -1) {
      const target = process.argv[captureAt + 1];
      const window = mainWindow;
      window.webContents.once('did-finish-load', () => {
        // A frame after load: React has mounted but the desk has not arrived
        // over IPC yet, and a screenshot of "Reading the desk..." is not a
        // screenshot of the application.
        setTimeout(() => {
          void window.webContents.capturePage().then(async image => {
            if (target) {
              await writeFile(target, image.toPNG());
              process.stdout.write(`${target}
`);
            }
            app.exit(0);
          });
        }, 1200);
      });
    }

    // On macOS closing the last window does not quit the application, and
    // clicking the dock icon is expected to bring it back.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
