/**
 * Installing the menu, and keeping a reading window from behaving like a
 * browser.
 *
 * Electron installs a default menu when an application does not set one, and
 * that default is built for developing Electron applications: Reload, Force
 * Reload, Toggle Developer Tools, and a Help entry that opens electronjs.org.
 * Reload in particular is not merely embarrassing — pressed by accident it
 * throws away the folder and the window, with nothing to undo it.
 *
 * The template itself is in menu-template.ts, where a test can read it.
 */
import { app, Menu, shell, type BrowserWindow } from 'electron';

import { menuTemplate, type MenuActions } from './menu-template';

export type { MenuActions } from './menu-template';

const PROJECT = 'https://github.com/riccardosapuppo/dicom-workstation';

export function buildMenu(
  actions: Omit<MenuActions, 'openProjectPage'>,
  debug: boolean
): Menu {
  return Menu.buildFromTemplate(
    menuTemplate({
      actions: { ...actions, openProjectPage: () => void shell.openExternal(PROJECT) },
      debug,
      appName: app.name,
      onMac: process.platform === 'darwin',
    })
  );
}

/**
 * What each window's title bar should say, kept by the main process.
 *
 * Weak, so a closed window is forgotten with everything else about it.
 */
const wanted = new WeakMap<BrowserWindow, string>();

/**
 * Sets the title bar, and remembers what it was set to.
 *
 * A subject is what the window is showing — a folder, a study. Without one it
 * is the application's name, which is what an empty window should say.
 */
export function titleWindow(window: BrowserWindow, subject?: string): void {
  const title = subject ? `${subject} — ${app.name}` : app.name;
  wanted.set(window, title);
  if (!window.isDestroyed()) {
    window.setTitle(title);
  }
}

/**
 * The title bar says what this application is, not what the page calls itself.
 *
 * The reading surface is a web page carrying a <title> of its own, and a window
 * takes its title from the page it is showing. Here that wrote "Medical DICOM
 * Viewer (Web)" across the top of a desktop window: the sibling project's name,
 * and the word "Web", on the application that is not it.
 *
 * Refusing the event is not enough on its own — the title still changed, which
 * is how this was found rather than assumed — so the title is put back as well.
 * Both, because they fail differently: the refusal stops the flicker, and
 * setting it back is what actually holds.
 */
export function ownTitle(window: BrowserWindow): void {
  titleWindow(window);

  window.webContents.on('page-title-updated', event => {
    event.preventDefault();
    const title = wanted.get(window) ?? app.name;
    if (!window.isDestroyed() && window.getTitle() !== title) {
      window.setTitle(title);
    }
  });
}

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
