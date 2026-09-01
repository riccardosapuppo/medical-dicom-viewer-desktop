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
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  screen,
  session,
  shell,
} from 'electron';

import { describe, readDesk, type Desk } from './display-topology';
import { Indexer } from './library/indexer-host';
import { buildMenu, guardShortcuts, ownTitle, titleWindow } from './menu';
import { ReadingWindows } from './layout/reading-windows';
import { startArchive, type Archive } from './dicomweb/server';
import { serveViewer, viewerPresent, VIEWER_PRIVILEGES, VIEWER_URL } from './viewer';
import {
  arrangement,
  load,
  recall,
  remember,
  rememberFolder,
  save,
  type Layouts,
} from './layout/store';

/** Where the built renderer lives, relative to the compiled main process. */
const RENDERER = path.join(__dirname, 'renderer', 'index.html');

/**
 * Where the viewer lives.
 *
 * Fetched and built by `npm run viewer` rather than kept in this repository:
 * it is the web viewer's own repository at a fixed commit, and copying it in
 * would mean it is never updated again.
 */
const VIEWER = path.join(__dirname, 'viewer');

/**
 * The icon, for the window and the taskbar.
 *
 * The packaged application gets its icon from electron-builder, which is why
 * this was missed: run from source it showed Electron's own, and that is how
 * most people will first see it.
 */
const ICON = path.join(__dirname, 'icon.png');

/**
 * The name the operating system uses: in the menu bar, in the About entry, in
 * the window list, and as the folder under which settings are kept.
 *
 * Without this it is taken from package.json and reads "dicom-workstation",
 * which is a repository name, not a product.
 */
app.setName('DICOM Workstation');

/**
 * Developer tools and reload are available only when asked for, by name.
 *
 * They are useful and there is no reason to remove them — only a reason not to
 * hand them to somebody reading a study, where Reload is indistinguishable from
 * a crash: it throws away the folder, the window and everything on screen, and
 * there is nothing to undo it with.
 *
 * This used to be true whenever the application was not packaged, which meant
 * every person who ran it from its own source got the debug build — which is
 * most people who will ever look at it, and the only build the author sees. The
 * flag has to be asked for:
 *
 *   npm start -- --debug
 */
const debug = process.argv.includes('--debug');

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
    icon: ICON,
    title: app.name,
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
  guardShortcuts(window, debug);
  ownTitle(window);

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
protocol.registerSchemesAsPrivileged([VIEWER_PRIVILEGES]);

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

    /**
     * Nothing leaves this machine.
     *
     * This reads a person's studies off a disc that may never have been
     * connected to anything, and the promise it makes is that opening one does
     * not tell anybody. A promise kept by nobody happening to add a request is
     * not a promise, so requests off the machine are refused outright: what is
     * left is the viewer's own scheme and the archive on loopback.
     *
     * It is also what makes the refusal visible. A reference left pointing at a
     * public network fails here, during a check, instead of silently working on
     * a developer's machine and failing in a reading room.
     */
    const CARRIED = ['viewer:', 'file:', 'data:', 'blob:', 'devtools:'];

    session.defaultSession.webRequest.onBeforeRequest((details, decide) => {
      const address = details.url;
      const scheme = address.slice(0, address.indexOf(':') + 1);
      const loopback =
        address.startsWith('http://127.0.0.1:') || address.startsWith('http://localhost:');

      decide({ cancel: !(CARRIED.includes(scheme) || loopback) });
    });

    // Reading a folder happens in a process of its own; everything the window
    // hears about it comes through here.
    const indexer = new Indexer();
    const reading = new ReadingWindows();

    /**
     * The archive the viewer reads studies from.
     *
     * Started empty and pointed at a folder once one is opened. It has to exist
     * before the window is ever told to load the viewer, because its address —
     * a port the system picks and a secret made at startup — is what the
     * viewer's configuration is rewritten to point at.
     */
    let archive: Archive | undefined;

    if (viewerPresent(VIEWER)) {
      void startArchive({ patients: [], duplicates: 0 }).then(started => {
        archive = started;
        serveViewer({ folder: VIEWER, archiveRoot: started.root });
      });
    }

    // The opening screen asks, so it can say what is missing instead of the
    // window going blank on someone who has not built the viewer yet.
    ipcMain.handle('viewer:present', () => viewerPresent(VIEWER));

    /**
     * What the title bar actually says.
     *
     * Asked by the interface check. The page carries a title of its own and the
     * document's title is not the window's, so reading the document proves
     * nothing about what somebody sees along the top.
     */
    ipcMain.handle('window:current', () => mainWindow?.getTitle() ?? '');

    /**
     * Hands this window over to the viewer, at a study.
     *
     * The address carries both names, so the viewer needs nothing else: the
     * study to open and the series to land on. Sent as a message instead, it
     * would arrive either before the page was ready or after it had already
     * chosen what to show.
     */
    ipcMain.handle('viewer:open', (_event, study: unknown, series: unknown) => {
      if (typeof study !== 'string' || !mainWindow) {
        return;
      }

      const address =
        `${VIEWER_URL}viewer?StudyInstanceUIDs=${encodeURIComponent(study)}` +
        (typeof series === 'string'
          ? `&initialSeriesInstanceUID=${encodeURIComponent(series)}`
          : '');

      // Set here rather than left to the page. Once the window is showing the
      // viewer, nothing in this application is asked what it is looking at any
      // more, and with three windows on three screens the title bar is the only
      // thing that tells them apart.
      titleWindow(mainWindow, describeStudy(study));

      void mainWindow.loadURL(address);
    });

    /** Back to the worklist: the folder is still open, the reading is done. */
    ipcMain.handle('viewer:leave', () => {
      void mainWindow?.loadFile(RENDERER);
    });

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
        archive?.serve(message.index);
        current = message;
        layouts = rememberFolder(layouts, message.folder);
        save(layoutFile, layouts);
        refreshMenu();
      } else if (message.type === 'failed') {
        archive?.serve({ patients: [], duplicates: 0 });
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

    /**
     * Which study a series belongs to.
     *
     * The viewer is addressed by study and then told which series to land on,
     * so sending a series to another screen needs both names. Only the index
     * knows the pairing, and it is here.
     */
    const studyOf = (seriesInstanceUid: string): string | undefined => {
      for (const patient of current?.index.patients ?? []) {
        for (const study of patient.studies) {
          if (study.series.some(one => one.seriesInstanceUid === seriesInstanceUid)) {
            return study.studyInstanceUid;
          }
        }
      }
      return undefined;
    };

    /** Who a study belongs to and what it is, for a title bar. */
    const describeStudy = (studyInstanceUid: string): string | undefined => {
      for (const patient of current?.index.patients ?? []) {
        for (const study of patient.studies) {
          if (study.studyInstanceUid === studyInstanceUid) {
            // The name is blank on anything a public archive published, so the
            // identifier is what there is to say.
            const who = patient.name || patient.patientId;
            return [who, study.description].filter(Boolean).join(' — ') || undefined;
          }
        }
      }
      return undefined;
    };

    ipcMain.handle('reading:open', (_event, seriesInstanceUid: unknown, pane: unknown) => {
      if (typeof seriesInstanceUid !== 'string' || typeof pane !== 'number') {
        return;
      }

      const study = studyOf(seriesInstanceUid);
      if (!study) {
        // A series that is not in the folder that is open. The window would come
        // up on an address the archive answers nothing for, which reads as the
        // application being broken rather than as the series being gone.
        return;
      }

      reading.open(seriesInstanceUid, study, pane, desk.panes, debug);
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
        const study = known.has(placement.seriesInstanceUid)
          ? studyOf(placement.seriesInstanceUid)
          : undefined;

        if (study) {
          reading.open(placement.seriesInstanceUid, study, placement.pane, desk.panes, debug);
          opened++;
        }
      }
      return opened;
    });

    app.on('will-quit', () => reading.closeAll());


    app.on('will-quit', () => indexer.stop());

    ipcMain.handle('library:read', (_event, folder: unknown) => {
      if (typeof folder !== 'string' || folder.length === 0) {
        return;
      }
      indexer.read(folder);
    });

    ipcMain.handle('library:cancel', () => indexer.cancel());

    /**
     * Asks the renderer to open a folder.
     *
     * The window owns what it is showing, so nothing here reads a folder behind
     * its back: a list that appeared underneath the page cannot be cancelled or
     * replaced by it. Both the menu and the page go through this.
     */
    const openFolder = (folder: string): void => {
      mainWindow?.webContents.send('library:open', folder);
    };

    // The dialogs belong to the main process because they belong to the window:
    // opened from the page they would be modals with no owner, which on Windows
    // is a dialog that can end up behind the application that raised it.
    const chooseFolder = async (): Promise<string | undefined> => {
      const owner = mainWindow;
      if (!owner) {
        return undefined;
      }
      const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
        title: 'Open a folder of studies',
        properties: ['openDirectory'],
        buttonLabel: 'Read',
      });
      return canceled ? undefined : filePaths[0];
    };

    /**
     * Choosing files rather than a folder.
     *
     * A study is often handed over as a handful of files rather than a folder,
     * and until now there was no way to open one. What comes back is the folder
     * they are in: the indexer reads folders, and the files somebody picked are
     * almost always the whole of what is there.
     */
    const chooseFiles = async (): Promise<string | undefined> => {
      const owner = mainWindow;
      if (!owner) {
        return undefined;
      }
      const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
        title: 'Open DICOM files',
        properties: ['openFile', 'multiSelections'],
        buttonLabel: 'Read',
        filters: [
          { name: 'DICOM', extensions: ['dcm', 'dicom', 'ima'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      const first = canceled ? undefined : filePaths[0];
      return first ? path.dirname(first) : undefined;
    };

    ipcMain.handle('library:choose', chooseFolder);
    ipcMain.handle('library:chooseFiles', chooseFiles);

    if (process.argv.includes('--print-desk')) {
      process.stdout.write(`\n${describe(desk)}\n\n`);
    }

    /**
     * The demonstration studies, if they have been downloaded.
     *
     * Nothing is shipped inside the application any more. What used to be here
     * was drawn from a formula, and a viewer whose only example is an ellipse
     * tells somebody nothing about whether it reads a study. `npm run demo-data`
     * fetches the same acquisitions the web viewer demonstrates — real ones,
     * de-identified by the archive that publishes them — and this points at
     * them when they are there and says nothing when they are not.
     */
    const demoFolder = app.isPackaged
      ? undefined
      : path.join(app.getAppPath(), 'demo-data');

    const demoStudies = (): string | undefined =>
      demoFolder && existsSync(demoFolder) ? demoFolder : undefined;

    ipcMain.handle('library:sample', () => demoStudies());

    ipcMain.handle('library:recent', () => layouts.recent ?? []);

    /**
     * What the window is showing, said where a person looks for it.
     *
     * A title bar that always reads the product name is a title bar nobody
     * reads. With three reading windows open on three screens, it is the only
     * thing that tells them apart in the task switcher.
     */
    ipcMain.handle('window:title', (_event, subject: unknown) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        titleWindow(mainWindow, typeof subject === 'string' && subject ? subject : undefined);
      }
    });

    const showAbout = (): void => {
      const owner = mainWindow;
      const lines = [
        `Version ${app.getVersion()}`,
        'Developed by Riccardo Sapuppo',
        '',
        `Electron ${process.versions.electron}`,
        `Chromium ${process.versions.chrome}`,
        `Node ${process.versions.node}`,
      ];
      const options = {
        type: 'info' as const,
        title: `About ${app.name}`,
        message: app.name,
        detail: lines.join('\n'),
        buttons: ['Close'],
      };
      if (owner && !owner.isDestroyed()) {
        void dialog.showMessageBox(owner, options);
      } else {
        void dialog.showMessageBox(options);
      }
    };

    const refreshMenu = (): void => {
      Menu.setApplicationMenu(
        buildMenu(
          {
            openFolder: () => {
              void chooseFolder().then(folder => folder && openFolder(folder));
            },
            openFiles: () => {
              void chooseFiles().then(folder => folder && openFolder(folder));
            },
            hasDemoStudies: demoStudies() !== undefined,
            openSample: () => {
              const folder = demoStudies();
              if (folder) {
                openFolder(folder);
              }
            },
            closeStudy: () => mainWindow?.webContents.send('library:close'),
            showScreens: () => mainWindow?.webContents.send('view:screens'),
            showAbout,
            recent: layouts.recent ?? [],
            openRecent: openFolder,
          },
          debug
        )
      );
    };

    refreshMenu();

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
