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
export function ownTitle(window: BrowserWindow, subject?: string): void {
  titleWindow(window, subject);

  window.webContents.on('page-title-updated', event => {
    event.preventDefault();
    const title = wanted.get(window) ?? app.name;
    if (!window.isDestroyed() && window.getTitle() !== title) {
      window.setTitle(title);
    }
  });
}

/** The schemes this application is made of. Anything else is somewhere else. */
const OURS = ['viewer:', 'file:'];

export function guardShortcuts(window: BrowserWindow, debug: boolean): void {
  // Kept out of the way of somebody who asked for them, and only them. This
  // used to be every unpackaged run, which is every run from source.
  if (!debug) {
    window.webContents.on('before-input-event', (event, input) => {
      const key = input.key.toLowerCase();
      const modified = input.control || input.meta;

      // Reload is what makes this worth guarding rather than merely untidy:
      // pressed by accident it throws away the folder and the window, with
      // nothing to undo it. F5 is matched with or without a modifier, which is
      // what Ctrl+F5 is.
      const reload = (modified && key === 'r') || key === 'f5';
      const devTools = key === 'f12' || (modified && input.shift && key === 'i');

      if (reload || devTools) {
        event.preventDefault();
      }
    });
  }

  /**
   * The window stays inside the application.
   *
   * This used to refuse every navigation, on the grounds that nothing here
   * navigates — which stopped being true the moment the reading surface became
   * a page with routing of its own. Refusing them all would leave the viewer
   * unable to move between its own screens, and it would look like the
   * application had frozen.
   *
   * So what is refused is leaving: a link to somewhere on the internet opens in
   * the browser, where a person can see what it is, rather than replacing the
   * study they were reading with a web page.
   */
  window.webContents.on('will-navigate', (event, url) => {
    if (OURS.some(scheme => url.startsWith(scheme))) {
      return;
    }

    event.preventDefault();
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
  });
}
