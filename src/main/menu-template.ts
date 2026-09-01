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
  closeStudy: () => void;
  showScreens: () => void;
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
        { label: 'Back to Worklist', accelerator: 'CmdOrCtrl+W', click: actions.closeStudy },
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
        ...(onMac ? [] : ([{ label: `About ${appName}`, click: actions.showAbout }] as MenuItemConstructorOptions[])),
        { label: 'Project on GitHub', click: actions.openProjectPage },
      ],
    },
  ];

  return template;
}
