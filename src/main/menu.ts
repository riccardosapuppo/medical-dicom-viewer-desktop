/**
 * The menu bar, which is the first thing that says whether this is a product or
 * a development build.
 *
 * Electron installs a default menu when an application does not set one. That
 * default is built for developing Electron applications: it carries Reload,
 * Force Reload, Toggle Developer Tools and a Help entry that opens
 * electronjs.org. Shipping it tells anyone who opens the View menu exactly what
 * they are looking at, and Reload in particular is not merely embarrassing —
 * pressed by accident it throws away the folder, the window, and every
 * measurement on screen, with no warning and nothing to undo it.
 *
 * So the menu is built here, from the commands this application actually has.
 * The developer tools are still reachable, deliberately, when the application is
 * started with --debug: they are useful and there is no reason to remove them,
 * only a reason not to hand them to a radiologist.
 */
import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  openFolder: () => void;
  openFiles: () => void;
  openSample: () => void;
  closeStudy: () => void;
  showScreens: () => void;
  showAbout: () => void;
  recent: string[];
  openRecent: (folder: string) => void;
}

const BACKSLASH = String.fromCharCode(92);

/** The last two segments of a path, which is the part that identifies a folder. */
function shortPath(full: string): string {
  const parts = full.split(BACKSLASH).join('/').split('/').filter(Boolean);
  if (parts.length <= 2) {
    return full;
  }
  const separator = full.includes(BACKSLASH) ? BACKSLASH : '/';
  return `…${separator}${parts.slice(-2).join(separator)}`;
}

export function buildMenu(actions: MenuActions, debug: boolean): Menu {
  const onMac = process.platform === 'darwin';

  const recent: MenuItemConstructorOptions[] = actions.recent.length
    ? [
        {
          label: 'Open Recent',
          submenu: actions.recent.map(folder => ({
            label: shortPath(folder),
            // The full path is the useful thing when two folders share a name,
            // and a menu is too narrow to show it.
            toolTip: folder,
            click: () => actions.openRecent(folder),
          })),
        },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...(onMac
      ? ([
          {
            label: app.name,
            submenu: [
              { label: `About ${app.name}`, click: actions.showAbout },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),

    {
      label: '&File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: actions.openFolder },
        { label: 'Open Files…', accelerator: 'CmdOrCtrl+Shift+O', click: actions.openFiles },
        ...recent,
        { type: 'separator' },
        { label: 'Open Sample Study', click: actions.openSample },
        { type: 'separator' },
        { label: 'Close Study', accelerator: 'CmdOrCtrl+W', click: actions.closeStudy },
        { type: 'separator' },
        onMac ? { role: 'close' } : { role: 'quit', label: 'Exit' },
      ],
    },

    {
      label: '&Edit',
      submenu: [
        { role: 'copy' },
        { role: 'selectAll' },
      ],
    },

    {
      label: '&View',
      submenu: [
        { label: 'Screens…', click: actions.showScreens },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Only with --debug. Reload is what makes this dangerous rather than
        // merely untidy: it discards the folder, the window and every
        // measurement on screen, and there is nothing to undo it with.
        ...(debug
          ? ([
              { type: 'separator' },
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },

    {
      label: '&Window',
      submenu: onMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'zoom' }],
    },

    {
      label: '&Help',
      submenu: [
        ...(onMac ? [] : ([{ label: `About ${app.name}`, click: actions.showAbout }] as MenuItemConstructorOptions[])),
        {
          label: 'Project on GitHub',
          click: () => {
            void shell.openExternal('https://github.com/riccardosapuppo/dicom-workstation');
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

/**
 * Stops the keyboard from reaching the things the menu no longer offers.
 *
 * Taking Reload out of the menu does not take it off the keyboard: Ctrl+R,
 * Ctrl+Shift+R and F5 still reload a BrowserWindow, and F12 still opens the
 * developer tools. In a viewer, reload is indistinguishable from a crash — the
 * study closes, the measurements go, and nothing says why.
 */
export function guardShortcuts(window: BrowserWindow, debug: boolean): void {
  if (debug) {
    return;
  }

  window.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase();
    const modified = input.control || input.meta;

    const reload = (modified && key === 'r') || key === 'f5';
    const devTools = key === 'f12' || (modified && input.shift && key === 'i');

    if (reload || devTools) {
      event.preventDefault();
    }
  });

  // A page that navigates is a page that has thrown its state away. Nothing in
  // this application navigates: every view is a state change inside one page.
  window.webContents.on('will-navigate', event => event.preventDefault());
}
