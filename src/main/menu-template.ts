/**
 * The menu bar, as data.
 *
 * Kept apart from the code that installs it, and taking nothing from Electron
 * but its types, so that it can be read by a test without an application
 * running. What is in this menu is the first thing that says whether this is a
 * product or a development build, and it had been wrong twice without anything
 * noticing — so it is now something a test can look at directly.
 */
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  openFolder: () => void;
  openFiles: () => void;
  openSample: () => void;
  /** Whether the demonstration studies have been downloaded yet. */
  hasDemoStudies: boolean;
  /** Back from the viewer to the worklist. */
  backToWorklist: () => void;
  /** Whether the window is showing a study, which is when that is possible. */
  readingStudy: boolean;
  /** Closes the folder and returns to the opening screen. */
  closeFolder: () => void;
  /** Puts the windows on the other screens back where this desk had them. */
  restoreArrangement: () => void;
  /** Whether there is an arrangement to put back, and screens to put it on. */
  canRestore: boolean;
  showAbout: () => void;
  recent: string[];
  openRecent: (folder: string) => void;
  /** Opens the repository in the system browser. */
  openProjectPage: () => void;
}

/** Everything the template needs that is not an action. */
export interface TemplateOptions {
  actions: MenuActions;
  /** Reload and the developer tools, which are only ever asked for by name. */
  debug: boolean;
  appName: string;
  onMac: boolean;
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

export function menuTemplate({
  actions,
  debug,
  appName,
  onMac,
}: TemplateOptions): MenuItemConstructorOptions[] {

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
            label: appName,
            submenu: [
              { label: `About ${appName}`, click: actions.showAbout },
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
        {
          label: 'Open Demonstration Studies',
          // Absent until they have been downloaded. An entry that does nothing
          // reads as a broken application; one that is greyed out reads as
          // something not set up yet, which is what it is.
          enabled: actions.hasDemoStudies,
          click: actions.openSample,
        },
        { type: 'separator' },
        {
          label: 'Back to Worklist',
          accelerator: 'CmdOrCtrl+W',
          // Only while a study is open. It used to be a message to the worklist
          // page, which stops existing the moment the window is handed to the
          // viewer — so from a study, the one place somebody would reach for
          // it, it did nothing at all.
          enabled: actions.readingStudy,
          click: actions.backToWorklist,
        },
        { label: 'Close Folder', click: actions.closeFolder },
        { type: 'separator' },
        onMac ? { role: 'close' } : { role: 'quit', label: 'Exit' },
      ],
    },

    {
      label: '&Window',
      submenu: [
        // Where the windows on the other screens are put back. It belongs in
        // the menu about windows; it was on the worklist, which is about
        // studies, and then in a panel of its own that had nothing else in it.
        {
          label: 'Restore Arrangement',
          enabled: actions.canRestore,
          click: actions.restoreArrangement,
        },
        { type: 'separator' },
        // Zoom is a macOS role — it is what the green button does there. On
        // Windows and Linux it is an entry that does nothing when clicked.
        ...(onMac
          ? ([
              { role: 'minimize' },
              { role: 'zoom' },
              { type: 'separator' },
              { role: 'front' },
            ] as MenuItemConstructorOptions[])
          : ([{ role: 'minimize' }] as MenuItemConstructorOptions[])),

        // Only with --debug, and never otherwise. Reload is what makes this
        // worth guarding rather than merely untidy: pressed by accident it
        // throws away the folder and the window, with nothing to undo it. They
        // used to live under View, which no longer exists — it had grown down
        // to one entry that opened a panel nobody had asked to see.
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
      label: '&Help',
      submenu: [
        ...(onMac ? [] : ([{ label: `About ${appName}`, click: actions.showAbout }] as MenuItemConstructorOptions[])),
        { label: 'Project on GitHub', click: actions.openProjectPage },
      ],
    },
  ];

  return template;
}
