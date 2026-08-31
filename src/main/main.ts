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

import { app, BrowserWindow, dialog, ipcMain, protocol, screen, shell } from 'electron';

import { describe, readDesk, type Desk } from './display-topology';
import { Indexer } from './library/indexer-host';
import { PixelServer, SCHEME } from './library/pixel-server';
import { ReadingWindows } from './layout/reading-windows';
import { arrangement, load, recall, remember, save, type Layouts } from './layout/store';

/** Where the built renderer lives, relative to the compiled main process. */
const RENDERER = path.join(__dirname, 'renderer', 'index.html');

let mainWindow: BrowserWindow | undefined;

/**
 * The folder to open, from a command line.
 *
 * The renderer is asked to open it rather than the main process just reading
 * it: the window owns what it is showing, and a folder that appeared underneath
 * it without its knowledge is a list that cannot be cancelled or replaced.
 */
function folderFromArgs(argv: string[]): string | undefined {
  const at = argv.indexOf('--open');
  const given = at === -1 ? undefined : argv[at + 1];
  // Resolved here rather than wherever it is used: a relative path means
  // whatever the working directory happened to be, which for a packaged
  // application is not a thing anyone can point at.
  return given === undefined ? undefined : path.resolve(given);
}

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

  // Forgotten on close, so that nothing later sends to a window that is gone.
  // On macOS the application outlives its window, and every send after that
  // would throw on a destroyed object.
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });

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

// Declared before the application is ready, which is the only moment it can be:
// registered later the scheme still resolves, but fetch() refuses it and says
// nothing about why. Standard so that URLs parse into host and path; secure so
// a page served from file: may fetch it; stream so a frame arrives as it is
// read rather than after it is all in memory.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// A second launch is a study being opened, not a second application.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();

      // This is how a study opened from the file manager arrives: a second
      // launch that hands its arguments over instead of starting a rival copy.
      const folder = folderFromArgs(argv);
      if (folder) {
        mainWindow.webContents.send('library:open', folder);
      }
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

    // Reading a folder happens in a process of its own; everything the window
    // hears about it comes through here.
    const indexer = new Indexer();
    const pixels = new PixelServer();
    const reading = new ReadingWindows();

    const layoutFile = path.join(app.getPath('userData'), 'layouts.json');
    let layouts: Layouts = load(layoutFile);

    // The last folder that was read, kept so that a window opened on another
    // screen can ask what it is showing without the main window having to tell
    // it - a message that would arrive either before or after the page is ready.
    let current: Extract<Parameters<Parameters<Indexer['on']>[0]>[0], { type: 'done' }> | undefined;

    indexer.on(message => {
      // What the page may fetch is exactly what is in the folder it is looking
      // at, and it changes at the same moment the list does.
      if (message.type === 'done') {
        pixels.remember(message.index);
        current = message;
      } else if (message.type === 'failed') {
        pixels.forget();
        current = undefined;
      }

      // A window showing a series from the folder that has just been replaced
      // is a window showing something that is no longer open.
      if (message.type !== 'progress') {
        reading.closeAll();
      }

      mainWindow?.webContents.send('library:message', message);
    });

    ipcMain.handle('library:current', () => current);

    ipcMain.handle('reading:open', (_event, seriesInstanceUid: unknown, pane: unknown) => {
      if (typeof seriesInstanceUid !== 'string' || typeof pane !== 'number') {
        return;
      }
      reading.open(seriesInstanceUid, pane, desk.panes);
      layouts = remember(layouts, desk.fingerprint, seriesInstanceUid, pane, Date.now());
      save(layoutFile, layouts);
    });

    ipcMain.handle('reading:close', (_event, seriesInstanceUid: unknown) => {
      if (typeof seriesInstanceUid === 'string') {
        reading.close(seriesInstanceUid);
      }
    });

    /** Where this desk last had a series, if it had it anywhere it still has. */
    ipcMain.handle('reading:recall', (_event, seriesInstanceUid: unknown) =>
      typeof seriesInstanceUid === 'string'
        ? recall(layouts, desk.fingerprint, seriesInstanceUid, desk.panes.length)
        : undefined
    );

    /** Reopens everything this desk remembers, for series the open folder has. */
    ipcMain.handle('reading:restore', () => {
      const known = new Set(
        current?.index.patients.flatMap(patient =>
          patient.studies.flatMap(study => study.series.map(series => series.seriesInstanceUid))
        ) ?? []
      );

      let opened = 0;
      for (const placement of arrangement(layouts, desk.fingerprint, desk.panes.length)) {
        if (known.has(placement.seriesInstanceUid)) {
          reading.open(placement.seriesInstanceUid, placement.pane, desk.panes);
          opened++;
        }
      }
      return opened;
    });

    app.on('will-quit', () => reading.closeAll());

    protocol.handle(SCHEME, request => pixels.handle(request));

    app.on('will-quit', () => indexer.stop());

    ipcMain.handle('library:read', (_event, folder: unknown) => {
      if (typeof folder !== 'string' || folder.length === 0) {
        return;
      }
      indexer.read(folder);
    });

    ipcMain.handle('library:cancel', () => indexer.cancel());

    // The dialog belongs to the main process because it belongs to the window:
    // opened from the page it would be a modal with no owner, which on Windows
    // is a dialog that can end up behind the application that raised it.
    ipcMain.handle('library:choose', async () => {
      const owner = mainWindow;
      if (!owner) {
        return undefined;
      }
      const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
        title: 'Open a folder of DICOM studies',
        properties: ['openDirectory'],
        buttonLabel: 'Read',
      });
      return canceled ? undefined : filePaths[0];
    });

    if (process.argv.includes('--print-desk')) {
      process.stdout.write(`\n${describe(desk)}\n\n`);
    }

    mainWindow = createWindow();

    const opening = folderFromArgs(process.argv);
    if (opening && !process.argv.includes('--capture')) {
      mainWindow.webContents.once('did-finish-load', () =>
        mainWindow?.webContents.send('library:open', opening)
      );
    }

    // The screenshots in docs/ are taken by the application itself rather than
    // by a screen capture, so they are always the current build at a fixed size
    // and never a window with somebody's taskbar in the corner.
    const captureAt = process.argv.indexOf('--capture');
    if (captureAt !== -1) {
      const target = process.argv[captureAt + 1];
      const window = mainWindow;
      window.webContents.once('did-finish-load', () => {
        // Whatever --open asked for has to be on screen before the shutter, and
        // it is the renderer that starts that read.
        const folder = folderFromArgs(process.argv);
        if (folder) {
          window.webContents.send('library:open', folder);
        }
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
        }, folderFromArgs(process.argv) ? 2500 : 1200);
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
